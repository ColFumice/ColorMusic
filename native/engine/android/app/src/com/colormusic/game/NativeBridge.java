package com.colormusic.game;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;

import com.cocos.lib.CocosHelper;
import com.cocos.lib.CocosJavascriptJavaBridge;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * NativeBridge —— Cocos JS 与 Android 原生的桥接入口（com.colormusic.game.NativeBridge）。
 *
 * JS 侧通过 native.reflection.callStaticMethod 调用（见 assets/scripts/NativeBridge.ts）：
 *   - openImagePicker()                       打开系统图片选择器
 *   - playNote(int,int,int,float,float,float) 实时合成一个音符（R,G,B,频率,音量,时长ms）
 *   - playTestNote()                          播放 C5 测试音
 *   - setMaxVoices(int)                       设置最大复音数（可扩展插件接口）
 *
 * 原生 → JS 回调（evalString 注入，须在游戏线程执行）：
 *   - __colormusic_onImagePicked(json)        图片选择完成，json 含 path/width/height/grid
 *   - __colormusic_synthReady = true          合成器就绪
 *
 * 图片流程：ACTION_GET_CONTENT → ContentResolver 读入流 → 等比缩放（最长边 ≤ 2048，两段式
 * 解码防 OOM）→ 存 PNG 到应用缓存 → 采样 96×96 RGB 颜色网格（行序从上到下）base64 一并回传，
 * 供 JS 端免 GPU 回读、方向一致地快速查色。
 */
public class NativeBridge {

    private static final String TAG = "ColorMusicBridge";
    private static final int REQ_PICK_IMAGE = 0x4372; // "CM" 魔数
    private static final int GRID_SIZE = 96;           // 颜色网格分辨率
    private static final int MAX_DIM = 1280;           // 显示/采样图片最长边限制（越小 payload 越小、加载越快）

    private static Activity sActivity;
    private static final AudioSynth sSynth = new AudioSynth();

    private NativeBridge() { }

    /** 由 AppActivity.onCreate 调用。 */
    public static void init(Activity activity) {
        sActivity = activity;
        sSynth.start();
        evalToJs("globalThis.__colormusic_synthReady = true;");
    }

    /** 由 AppActivity.onPause / onResume 调用（后台时释放音频）。 */
    public static void onAppPause() {
        sSynth.stop();
    }

    public static void onAppResume() {
        sSynth.start();
    }

    /* ---------------- JS → 原生（反射桥） ---------------- */

    /** 打开系统图片选择器。 */
    public static void openImagePicker() {
        if (sActivity == null) return;
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("image/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            sActivity.startActivityForResult(
                    Intent.createChooser(intent, "选择图片"), REQ_PICK_IMAGE);
        } catch (Exception e) {
            Log.e(TAG, "openImagePicker failed", e);
        }
    }

    /** 实时合成一个音符（任意线程可调用，内部同步入队）。 */
    public static void playNote(int r, int g, int b, int instrument, float freq, float volume, float durationMs) {
        sSynth.playNote(r, g, b, instrument, freq, volume, durationMs);
    }

    /** 持续音开始/原位更新（多指合奏：按 touchId 区分）。 */
    public static void noteOn(int touchId, int r, int g, int b, int instrument, float freq, float volume) {
        sSynth.noteOn(touchId, r, g, b, instrument, freq, volume);
    }

    /** 释放指定 touchId 的持续音。 */
    public static void noteOff(int touchId) {
        sSynth.noteOff(touchId);
    }

    /** 播放 C5 测试音（验证 JS→原生→AudioTrack 链路）。 */
    public static void playTestNote() {
        sSynth.playTestNote();
    }

    /** 设置最大复音数（1~16）。 */
    public static void setMaxVoices(int n) {
        sSynth.setMaxVoices(n);
    }

    /** 设置通道波表（0=R、1=G、2=B）。waveJson 为 JSON 数组（长度 ≤256，浮点数）。 */
    public static void setWavetable(int channel, String waveJson) {
        try {
            org.json.JSONArray arr = new org.json.JSONArray(waveJson);
            int n = Math.min(arr.length(), AudioSynth.WAVE_N);
            float[] wave = new float[n];
            for (int i = 0; i < n; i++) wave[i] = (float) arr.getDouble(i);
            AudioSynth.setWavetable(channel, wave);
        } catch (Exception e) {
            Log.e(TAG, "setWavetable failed", e);
        }
    }

    /** 设置 8 个效果器插件槽位（JSON 数组：[{id,invert,intensity,params,curve}×8]）。 */
    public static void setEffectSlots(String slotsJson) {
        AudioSynth.setEffectSlots(slotsJson);
    }

    /** 设置最终输出的 4 槽串联效果器。 */
    public static void setOutputEffectSlots(String slotsJson) {
        AudioSynth.setOutputEffectSlots(slotsJson);
    }

    /** 设置黑鼓/白鼓元素 id（808 鼓组）。 */
    public static void setDrumIds(String black, String white) {
        AudioSynth.setDrumIds(black, white);
    }

    /** 保存启动幕布 JPEG（base64）到应用缓存目录，返回文件绝对路径；失败返回空串。 */
    public static String saveSplashImage(String base64Data) {
        if (sActivity == null || base64Data == null || base64Data.isEmpty()) return "";
        try {
            byte[] data = android.util.Base64.decode(base64Data, android.util.Base64.DEFAULT);
            File f = new File(sActivity.getCacheDir(), "cm_splash.jpg");
            FileOutputStream fos = new FileOutputStream(f);
            fos.write(data);
            fos.flush();
            fos.close();
            return f.getAbsolutePath();
        } catch (Exception e) {
            Log.e(TAG, "saveSplashImage failed", e);
            return "";
        }
    }

    /* ---------------- 图片选择结果（主线程回调） ---------------- */

    /** 由 AppActivity.onActivityResult 调用。 */
    public static void onActivityResult(Activity activity, int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_PICK_IMAGE) return;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            evalToJs("globalThis.__colormusic_onImagePicked && "
                    + "globalThis.__colormusic_onImagePicked(JSON.stringify({error:'cancel'}));");
            return;
        }
        final Uri uri = data.getData();
        new Thread(() -> handlePickedUri(uri), "ColorMusicImage").start();
    }

    private static void handlePickedUri(Uri uri) {
        try {
            Bitmap bitmap = decodeAndScale(uri, MAX_DIM);
            if (bitmap == null) throw new IllegalStateException("图片解码失败");

            // 1) 显示用图片：JPEG 压缩（体积小，便于 base64 回传），存缓存
            File out = new File(sActivity.getCacheDir(),
                    "picked_" + System.currentTimeMillis() + ".jpg");
            FileOutputStream fos = new FileOutputStream(out);
            bitmap.compress(Bitmap.CompressFormat.JPEG, 88, fos);
            fos.flush();
            fos.close();

            // 2) 采样颜色网格（行序：从上到下，与显示一致）
            byte[] grid = sampleGrid(bitmap);

            // 3) 图片字节 base64（JS 侧用 ImageAsset({_data}) 内存加载，绕开 loadRemote 二次加载失效问题）
            byte[] imgBytes = readAllBytes(out);
            String imageBase64 = Base64.encodeToString(imgBytes, Base64.NO_WRAP);

            String json = "{"
                    + "\"path\":\"" + out.getAbsolutePath() + "\","
                    + "\"width\":" + bitmap.getWidth() + ","
                    + "\"height\":" + bitmap.getHeight() + ","
                    + "\"gridW\":" + GRID_SIZE + ","
                    + "\"gridH\":" + GRID_SIZE + ","
                    + "\"gridBase64\":\"" + Base64.encodeToString(grid, Base64.NO_WRAP) + "\","
                    + "\"imageBase64\":\"" + imageBase64 + "\""
                    + "}";
            bitmap.recycle();
            evalToJs("globalThis.__colormusic_onImagePicked && "
                    + "globalThis.__colormusic_onImagePicked('" + json + "');");
        } catch (Exception e) {
            Log.e(TAG, "handlePickedUri failed", e);
            evalToJs("globalThis.__colormusic_onImagePicked && "
                    + "globalThis.__colormusic_onImagePicked(JSON.stringify({error:'decode'}));");
        }
    }

    private static byte[] readAllBytes(File f) throws java.io.IOException {
        java.io.FileInputStream in = new java.io.FileInputStream(f);
        byte[] data = new byte[(int) f.length()];
        int off = 0;
        while (off < data.length) {
            int n = in.read(data, off, data.length - off);
            if (n < 0) break;
            off += n;
        }
        in.close();
        return data;
    }

    /** 解码并等比缩放到最长边 ≤ maxDim（先读边界定采样率，防大图 OOM）。 */
    private static Bitmap decodeAndScale(Uri uri, int maxDim) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        InputStream in1 = sActivity.getContentResolver().openInputStream(uri);
        if (in1 == null) return null;
        BitmapFactory.decodeStream(in1, null, bounds);
        in1.close();
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;

        int sample = 1;
        while (bounds.outWidth / (sample * 2) >= maxDim || bounds.outHeight / (sample * 2) >= maxDim) {
            sample *= 2;
        }
        BitmapFactory.Options opt = new BitmapFactory.Options();
        opt.inSampleSize = sample;
        opt.inPreferredConfig = Bitmap.Config.ARGB_8888;
        InputStream in2 = sActivity.getContentResolver().openInputStream(uri);
        if (in2 == null) return null;
        Bitmap bmp = BitmapFactory.decodeStream(in2, null, opt);
        in2.close();
        if (bmp == null) return null;

        // inSampleSize 是 2 的幂近似，再做一次精确缩放
        if (bmp.getWidth() > maxDim || bmp.getHeight() > maxDim) {
            float scale = Math.min((float) maxDim / bmp.getWidth(), (float) maxDim / bmp.getHeight());
            Bitmap scaled = Bitmap.createScaledBitmap(bmp,
                    Math.max(1, Math.round(bmp.getWidth() * scale)),
                    Math.max(1, Math.round(bmp.getHeight() * scale)), true);
            if (scaled != bmp) {
                bmp.recycle();
                bmp = scaled;
            }
        }
        return bmp;
    }

    /** 采样 GRID_SIZE×GRID_SIZE 的 RGBA 网格（getPixels 行 0 = 图片顶部；PNG 保留 Alpha，JPEG 恒 255）。 */
    private static byte[] sampleGrid(Bitmap bmp) {
        int w = bmp.getWidth();
        int h = bmp.getHeight();
        int[] pixels = new int[w * h];
        bmp.getPixels(pixels, 0, w, 0, 0, w, h);
        byte[] grid = new byte[GRID_SIZE * GRID_SIZE * 4];
        for (int gy = 0; gy < GRID_SIZE; gy++) {
            int srcY = Math.min(h - 1, (int) (((gy + 0.5f) / GRID_SIZE) * h));
            for (int gx = 0; gx < GRID_SIZE; gx++) {
                int srcX = Math.min(w - 1, (int) (((gx + 0.5f) / GRID_SIZE) * w));
                int c = pixels[srcY * w + srcX];
                int off = (gy * GRID_SIZE + gx) * 4;
                grid[off] = (byte) ((c >> 16) & 0xff);
                grid[off + 1] = (byte) ((c >> 8) & 0xff);
                grid[off + 2] = (byte) (c & 0xff);
                grid[off + 3] = (byte) ((c >> 24) & 0xff);
            }
        }
        return grid;
    }

    /** 在游戏线程执行 JS 代码（evalString 非线程安全，必须切线程）。 */
    private static void evalToJs(final String code) {
        CocosHelper.runOnGameThread(() -> CocosJavascriptJavaBridge.evalString(code));
    }
}
