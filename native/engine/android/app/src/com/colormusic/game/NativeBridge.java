package com.colormusic.game;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.util.Log;
import android.widget.EditText;

import com.cocos.lib.CocosHelper;
import com.cocos.lib.CocosJavascriptJavaBridge;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import mobi.cangol.mobile.utils.LameUtils;

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
    private static final int REQ_IMPORT_STYLE = 0x4373;
    private static final int GRID_SIZE = 96;           // 颜色网格分辨率
    private static final int MAX_DIM = 1280;           // 显示/采样图片最长边限制（越小 payload 越小、加载越快）

    private static Activity sActivity;
    private static final AudioSynth sSynth = new AudioSynth();
    private static final List<MediaPlayer> sClipPlayers = new ArrayList<>();
    private static final Handler sPlaybackHandler = new Handler(Looper.getMainLooper());
    private static Runnable sLoopRestart;
    private static int sPlaybackGeneration = 0;

    private NativeBridge() { }

    /** 由 AppActivity.onCreate 调用。 */
    public static void init(Activity activity) {
        sActivity = activity;
        sSynth.loadDrumSamples(activity.getAssets());
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

    /** 使用系统输入控件，避免 Cocos 缩放节点中的 Android EditBox 坐标错位。 */
    public static void promptText(String requestId, String title, String initial) {
        if (sActivity == null) return;
        sActivity.runOnUiThread(() -> {
            final EditText input = new EditText(sActivity);
            input.setSingleLine(true);
            input.setText(initial == null ? "" : initial);
            input.setSelection(input.getText().length());
            new AlertDialog.Builder(sActivity)
                    .setTitle(title == null ? "输入" : title)
                    .setView(input)
                    .setPositiveButton("确定", (dialog, which) -> sendTextResult(requestId, input.getText().toString()))
                    .setNegativeButton("取消", (dialog, which) -> sendTextResult(requestId, initial == null ? "" : initial))
                    .setOnCancelListener(dialog -> sendTextResult(requestId, initial == null ? "" : initial))
                    .show();
        });
    }

    private static void sendTextResult(String requestId, String value) {
        evalToJs("globalThis.__colormusic_onTextInput && globalThis.__colormusic_onTextInput("
                + org.json.JSONObject.quote(requestId == null ? "" : requestId) + ","
                + org.json.JSONObject.quote(value == null ? "" : value) + ");");
    }

    /** 显示原生确认框，并将结果回传给对应的 JS 请求。 */
    public static void confirmAction(String requestId, String title, String message) {
        if (sActivity == null) return;
        sActivity.runOnUiThread(() -> new AlertDialog.Builder(sActivity)
                .setTitle(title == null ? "确认操作" : title)
                .setMessage(message == null ? "是否继续？" : message)
                .setPositiveButton("确定", (dialog, which) -> sendConfirmResult(requestId, true))
                .setNegativeButton("取消", (dialog, which) -> sendConfirmResult(requestId, false))
                .setOnCancelListener(dialog -> sendConfirmResult(requestId, false))
                .show());
    }

    private static void sendConfirmResult(String requestId, boolean confirmed) {
        evalToJs("globalThis.__colormusic_onConfirm && globalThis.__colormusic_onConfirm("
                + org.json.JSONObject.quote(requestId == null ? "" : requestId) + ","
                + (confirmed ? "true" : "false") + ");");
    }

    /** 让玩家明确选择导出 WAV 或 MP3，取消时回传空字符串。 */
    public static void chooseAudioExportFormat(String requestId) {
        if (sActivity == null) return;
        sActivity.runOnUiThread(() -> new AlertDialog.Builder(sActivity)
                .setTitle("选择音频格式")
                .setItems(new String[]{"WAV（无损）", "MP3（便于分享）"},
                        (dialog, which) -> sendAudioFormatResult(requestId, which == 0 ? "wav" : "mp3"))
                .setNegativeButton("取消", (dialog, which) -> sendAudioFormatResult(requestId, ""))
                .setOnCancelListener(dialog -> sendAudioFormatResult(requestId, ""))
                .show());
    }

    private static void sendAudioFormatResult(String requestId, String format) {
        evalToJs("globalThis.__colormusic_onAudioFormat && globalThis.__colormusic_onAudioFormat("
                + org.json.JSONObject.quote(requestId == null ? "" : requestId) + ","
                + org.json.JSONObject.quote(format == null ? "" : format) + ");");
    }

    /** 选择一个已导出的数据包文件夹。 */
    public static void openStyleImporter() {
        if (sActivity == null) return;
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            sActivity.startActivityForResult(Intent.createChooser(intent, "选择样式数据包文件夹"), REQ_IMPORT_STYLE);
        } catch (Exception e) {
            Log.e(TAG, "openStyleImporter failed", e);
        }
    }

    /** 仅 Debug APK 使用：自动化真机截图时绕过系统顶部手势区。 */
    public static String consumeDebugPanel() {
        if (sActivity == null || (sActivity.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) == 0 || sActivity.getIntent() == null) return "";
        String panel = sActivity.getIntent().getStringExtra("cm_debug_panel");
        sActivity.getIntent().removeExtra("cm_debug_panel");
        return panel == null ? "" : panel;
    }

    /** 导出为文件夹数据包，manifest.json 内保存完整样式。 */
    public static String exportStylePackage(String baseName, String json) {
        if (sActivity == null || json == null) return "";
        try {
            File root = new File(sActivity.getExternalFilesDir(null), "ColorMusic");
            if (!root.exists() && !root.mkdirs()) return "";
            String base = sanitizeFileName(baseName == null ? "Neuro_Deta_Style" : baseName);
            File folder = uniqueFile(root, base, "", true);
            if (!folder.mkdirs()) return "";
            File manifest = new File(folder, "manifest.json");
            try (FileOutputStream out = new FileOutputStream(manifest)) {
                out.write(json.getBytes(StandardCharsets.UTF_8));
            }
            return folder.getAbsolutePath();
        } catch (Exception e) {
            Log.e(TAG, "exportStylePackage failed", e);
            return "";
        }
    }

    /** 清除游戏导出目录中的所有样式/样式流数据包，保留录音与导出的音频。 */
    public static int clearStylePackages() {
        if (sActivity == null) return -1;
        File root = new File(sActivity.getExternalFilesDir(null), "ColorMusic");
        File[] entries = root.listFiles();
        if (entries == null) return 0;
        int removed = 0;
        for (File entry : entries) {
            if (entry.isDirectory() && entry.getName().startsWith("Neuro_Deta_Style") && deleteRecursively(entry)) removed++;
        }
        return removed;
    }

    /** 优先借助内置的 MT 文件提供器授权 MT 直达导出目录；未安装 MT 时让玩家选择文件管理器。 */
    public static void openExportDirectory() {
        if (sActivity == null) return;
        File root = new File(sActivity.getExternalFilesDir(null), "ColorMusic");
        if (!root.exists()) root.mkdirs();
        final Uri directoryUri = getProvidedExportDirectoryUri();
        if (isPackageInstalled("bin.mt.plus")) {
            openMtProviderStorage();
            return;
        }

        Intent probe = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        List<ResolveInfo> handlers = sActivity.getPackageManager().queryIntentActivities(probe, PackageManager.MATCH_DEFAULT_ONLY);
        if (handlers.isEmpty()) {
            launchSystemDirectoryPicker(directoryUri);
            return;
        }
        String[] labels = new String[handlers.size()];
        for (int i = 0; i < handlers.size(); i++) {
            CharSequence label = handlers.get(i).loadLabel(sActivity.getPackageManager());
            labels[i] = label == null ? handlers.get(i).activityInfo.packageName : label.toString();
        }
        sActivity.runOnUiThread(() -> new AlertDialog.Builder(sActivity)
                .setTitle("选择文件夹打开方式")
                .setItems(labels, (dialog, which) -> {
                    ResolveInfo selected = handlers.get(which);
                    String packageName = selected.activityInfo.packageName;
                    String className = selected.activityInfo.name;
                    if (!launchDirectoryPicker(directoryUri, packageName, className)) {
                        launchPackageHome(packageName);
                    }
                })
                .setNegativeButton("取消", null)
                .show());
    }

    private static Uri getProvidedExportDirectoryUri() {
        String packageName = sActivity.getPackageName();
        String authority = packageName + ".MTDataFilesProvider";
        String documentId = packageName + "/android_data/files/ColorMusic";
        return DocumentsContract.buildDocumentUri(authority, documentId);
    }

    private static boolean isPackageInstalled(String packageName) {
        try {
            sActivity.getPackageManager().getPackageInfo(packageName, 0);
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    private static void openMtProviderStorage() {
        boolean explained = sActivity.getPreferences(Activity.MODE_PRIVATE)
                .getBoolean("mt_provider_explained", false);
        if (explained) {
            launchPackageHome("bin.mt.plus");
            return;
        }
        sActivity.runOnUiThread(() -> new AlertDialog.Builder(sActivity)
                .setTitle("MT 文件提供器已启用")
                .setMessage("首次使用请在 MT 左侧栏右上角选择“添加本地存储”，再选择 ColorMusic。"
                        + "添加后进入 android_data/files/ColorMusic，即可查看和分享导出的数据包。")
                .setPositiveButton("打开 MT 管理器", (dialog, which) -> {
                    sActivity.getPreferences(Activity.MODE_PRIVATE).edit()
                            .putBoolean("mt_provider_explained", true).apply();
                    launchPackageHome("bin.mt.plus");
                })
                .setNegativeButton("取消", null)
                .show());
    }

    private static boolean launchDirectoryPicker(Uri directoryUri, String packageName, String className) {
        try {
            Intent tree = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            tree.setClassName(packageName, className);
            tree.putExtra(DocumentsContract.EXTRA_INITIAL_URI, directoryUri);
            tree.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            sActivity.startActivity(tree);
            return true;
        } catch (Exception error) {
            Log.w(TAG, "Directory picker launch failed for " + packageName, error);
            return false;
        }
    }

    private static void launchSystemDirectoryPicker(Uri directoryUri) {
        try {
            Intent tree = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            tree.putExtra(DocumentsContract.EXTRA_INITIAL_URI, directoryUri);
            tree.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            sActivity.startActivity(tree);
        } catch (Exception error) {
            Log.e(TAG, "System directory picker failed", error);
        }
    }

    private static void launchPackageHome(String packageName) {
        try {
            Intent home = sActivity.getPackageManager().getLaunchIntentForPackage(packageName);
            if (home != null) {
                home.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                sActivity.startActivity(home);
            }
        } catch (Exception error) {
            Log.e(TAG, "File manager home launch failed for " + packageName, error);
        }
    }

    /** 按玩家选择复制 WAV，或使用 AndroidLame 将 PCM 音频转为 MP3。 */
    public static String exportAudio(String wavPath, String displayName, String requestedFormat) {
        if (sActivity == null || wavPath == null) return "ERROR:无效音频";
        File source = new File(wavPath);
        if (!source.isFile()) return "ERROR:找不到录音文件";
        File root = new File(sActivity.getExternalFilesDir(null), "ColorMusic");
        if (!root.exists() && !root.mkdirs()) return "ERROR:无法创建导出目录";
        String baseName = sanitizeFileName(displayName == null ? "audio" : displayName);
        if ("wav".equalsIgnoreCase(requestedFormat)) {
            File output = uniqueFile(root, baseName, ".wav", false);
            try {
                copyFile(source, output);
                return output.getAbsolutePath();
            } catch (Exception error) {
                Log.e(TAG, "WAV export failed", error);
                output.delete();
                return "ERROR:WAV 导出失败";
            }
        }
        if (!"mp3".equalsIgnoreCase(requestedFormat)) return "ERROR:不支持的音频格式";

        File output = uniqueFile(root, baseName, ".mp3", false);
        File raw = new File(sActivity.getCacheDir(), "wavtomp3_" + System.nanoTime() + ".raw");
        try (FileInputStream input = new FileInputStream(source); FileOutputStream rawOut = new FileOutputStream(raw)) {
            byte[] header = new byte[44];
            if (input.read(header) != header.length || header[0] != 'R' || header[8] != 'W') throw new IOException("不是支持的 WAV 文件");
            int channels = little16(header, 22); int sampleRate = little32(header, 24); int bits = little16(header, 34);
            if (channels < 1 || channels > 2 || sampleRate < 8000 || bits != 16) throw new IOException("仅支持 16 位 PCM WAV");
            byte[] frame = new byte[channels * 2];
            while (true) {
                int offset = 0;
                while (offset < frame.length) {
                    int count = input.read(frame, offset, frame.length - offset);
                    if (count < 0) break;
                    offset += count;
                }
                if (offset < frame.length) break;
                // AndroidLame 的 raw2mp3 输入使用大端 short；录音为同声道立体声，取左声道即可。
                rawOut.write(frame[1]);
                rawOut.write(frame[0]);
            }
            rawOut.flush();
            LameUtils converter = new LameUtils(1, sampleRate, 192);
            converter.raw2mp3(raw.getAbsolutePath(), output.getAbsolutePath());
            if (!output.isFile() || output.length() < 128) throw new IOException("LAME 编码器没有产生有效数据");
            return output.getAbsolutePath();
        } catch (Exception e) {
            Log.e(TAG, "AndroidLame MP3 export failed", e);
            output.delete();
            return "ERROR:MP3 转换失败，请改选 WAV";
        } finally {
            raw.delete();
        }
    }

    private static int little16(byte[] b, int p) { return (b[p] & 255) | ((b[p + 1] & 255) << 8); }
    private static int little32(byte[] b, int p) { return little16(b, p) | (little16(b, p + 2) << 16); }
    private static String sanitizeFileName(String name) { String value = name.replaceAll("[\\\\/:*?\"<>|]", "_").trim(); return value.isEmpty() ? "ColorMusic" : value; }
    private static File uniqueFile(File parent, String base, String suffix, boolean alwaysNumber) { int i = alwaysNumber ? 1 : 0; File f; do { f = new File(parent, base + (i == 0 ? "" : "_" + i) + suffix); i++; } while (f.exists()); return f; }
    private static void copyFile(File source, File target) throws IOException { try (FileInputStream in = new FileInputStream(source); FileOutputStream out = new FileOutputStream(target)) { byte[] buffer = new byte[32768]; int count; while ((count = in.read(buffer)) >= 0) out.write(buffer, 0, count); } }
    private static boolean deleteRecursively(File file) { File[] children = file.listFiles(); if (children != null) for (File child : children) if (!deleteRecursively(child)) return false; return file.delete(); }

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

    /** 开始录制合成器最终输出，文件保存到应用外部 ColorMusic 目录。 */
    public static String startRecording(String fileName) {
        if (sActivity == null) return "";
        File root = new File(sActivity.getExternalFilesDir(null), "ColorMusic");
        return sSynth.startRecording(root, fileName == null || fileName.isEmpty() ? "audio.wav" : fileName);
    }

    /** 停止录音并返回 WAV 路径。 */
    public static String stopRecording() {
        return sSynth.stopRecording();
    }

    /** 播放一个或多个录音片段；多片段同时开始，用于混音台试听/播放。 */
    public static synchronized void playAudioFiles(String pathsJson, boolean loop) {
        stopAudioFiles();
        final int generation = ++sPlaybackGeneration;
        try {
            org.json.JSONArray paths = new org.json.JSONArray(pathsJson == null ? "[]" : pathsJson);
            long longestMs = 0;
            for (int i = 0; i < paths.length(); i++) {
                Object item = paths.opt(i);
                org.json.JSONObject clip = item instanceof org.json.JSONObject ? (org.json.JSONObject) item : null;
                String path = clip == null ? paths.optString(i, "") : clip.optString("path", "");
                if (path.isEmpty()) continue;
                MediaPlayer player = new MediaPlayer();
                player.setDataSource(path);
                player.setLooping(false);
                player.setOnCompletionListener(p -> {
                    synchronized (NativeBridge.class) {
                        try { p.release(); } catch (Exception ignored) { }
                        sClipPlayers.remove(p);
                    }
                });
                player.prepare();
                float volume = clip == null ? 1f : (float) clip.optDouble("volume", 1);
                volume = Math.max(0f, Math.min(1f, volume));
                player.setVolume(volume, volume);
                long startMs = clip == null ? 0 : Math.max(0, Math.round(clip.optDouble("trimStart", 0) * 1000));
                long requestedEnd = clip == null ? 0 : Math.round(clip.optDouble("trimEnd", 0) * 1000);
                long endMs = requestedEnd > startMs ? Math.min(requestedEnd, player.getDuration()) : player.getDuration();
                long playMs = Math.max(1, endMs - startMs);
                longestMs = Math.max(longestMs, playMs);
                if (startMs > 0) player.seekTo((int) Math.min(startMs, Integer.MAX_VALUE));
                player.start();
                sClipPlayers.add(player);
                if (endMs < player.getDuration()) {
                    sPlaybackHandler.postDelayed(() -> {
                        synchronized (NativeBridge.class) {
                            if (generation != sPlaybackGeneration || !sClipPlayers.remove(player)) return;
                            try { player.pause(); } catch (Exception ignored) { }
                            try { player.release(); } catch (Exception ignored) { }
                        }
                    }, playMs);
                }
            }
            if (loop && longestMs > 0) {
                final String replayJson = pathsJson;
                sLoopRestart = () -> {
                    synchronized (NativeBridge.class) {
                        if (generation == sPlaybackGeneration) playAudioFiles(replayJson, true);
                    }
                };
                sPlaybackHandler.postDelayed(sLoopRestart, longestMs);
            }
        } catch (Exception e) {
            Log.e(TAG, "playAudioFiles failed", e);
            stopAudioFiles();
        }
    }

    /** 停止所有录音片段播放。 */
    public static synchronized void stopAudioFiles() {
        sPlaybackGeneration++;
        if (sLoopRestart != null) sPlaybackHandler.removeCallbacks(sLoopRestart);
        sLoopRestart = null;
        for (MediaPlayer player : sClipPlayers) {
            try { player.stop(); } catch (Exception ignored) { }
            try { player.release(); } catch (Exception ignored) { }
        }
        sClipPlayers.clear();
    }

    /** 设置通道单周期波表及其周期倍率（0=R、1=G、2=B）。 */
    public static void setWavetable(int channel, String waveJson, float cycles) {
        try {
            org.json.JSONArray arr = new org.json.JSONArray(waveJson);
            int n = Math.min(arr.length(), AudioSynth.WAVE_N);
            float[] wave = new float[n];
            for (int i = 0; i < n; i++) wave[i] = (float) arr.getDouble(i);
            AudioSynth.setWavetable(channel, wave, cycles);
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

    /** 设置 RGB 通道的鼓采样；id=none 时恢复该通道波表合成。 */
    public static void setChannelDrum(int channel, String id, float volume, float speed) {
        AudioSynth.setChannelDrum(channel, id, volume, speed);
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
        if (requestCode == REQ_IMPORT_STYLE) {
            if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) return;
            final Uri treeUri = data.getData();
            try { activity.getContentResolver().takePersistableUriPermission(treeUri, data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION)); } catch (Exception ignored) { }
            new Thread(() -> handleStyleFolder(treeUri), "ColorMusicStyleImport").start();
            return;
        }
        if (requestCode != REQ_PICK_IMAGE) return;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            evalToJs("globalThis.__colormusic_onImagePicked && "
                    + "globalThis.__colormusic_onImagePicked(JSON.stringify({error:'cancel'}));");
            return;
        }
        final Uri uri = data.getData();
        new Thread(() -> handlePickedUri(uri), "ColorMusicImage").start();
    }

    private static void handleStyleFolder(Uri treeUri) {
        Cursor cursor = null;
        try {
            String treeId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, treeId);
            cursor = sActivity.getContentResolver().query(children,
                    new String[] { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null);
            Uri manifestUri = null;
            while (cursor != null && cursor.moveToNext()) {
                if ("manifest.json".equalsIgnoreCase(cursor.getString(1))) { manifestUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, cursor.getString(0)); break; }
            }
            if (manifestUri == null) throw new IOException("文件夹中没有 manifest.json");
            byte[] data;
            try (InputStream in = sActivity.getContentResolver().openInputStream(manifestUri); java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
                if (in == null) throw new IOException("无法读取 manifest.json"); byte[] buf = new byte[8192]; int n; while ((n = in.read(buf)) >= 0) out.write(buf, 0, n); data = out.toByteArray();
            }
            String json = new String(data, StandardCharsets.UTF_8);
            evalToJs("globalThis.__colormusic_onStyleImported && globalThis.__colormusic_onStyleImported(" + org.json.JSONObject.quote(json) + ");");
        } catch (Exception e) {
            Log.e(TAG, "handleStyleFolder failed", e);
            evalToJs("globalThis.__colormusic_onStyleImported && globalThis.__colormusic_onStyleImported('');");
        } finally { if (cursor != null) cursor.close(); }
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
