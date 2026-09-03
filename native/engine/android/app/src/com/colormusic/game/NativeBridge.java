package com.colormusic.game;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.ContentResolver;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Paint;
import android.media.MediaPlayer;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Handler;
import android.os.Environment;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.widget.EditText;
import android.text.InputType;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.cocos.lib.CocosHelper;
import com.cocos.lib.CocosJavascriptJavaBridge;

import java.io.File;
import java.io.BufferedOutputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
    private static final int REQ_CHOOSE_SAVE_ROOT = 0x4374;
    private static final String SAVE_PREFS = "neuro_save_location";
    private static final String SAVE_TREE_URI = "tree_uri";
    private static final String SAVE_ROOT_DOCUMENT = "root_document";
    private static final String SAVE_ROOT_NAME = "Neuro_Save";
    private static final int GRID_SIZE = 96;           // 颜色网格分辨率
    private static final int MAX_DIM = 1280;           // 显示/采样图片最长边限制（越小 payload 越小、加载越快）

    private static Activity sActivity;
    private static final AudioSynth sSynth = new AudioSynth();
    private static final List<MediaPlayer> sClipPlayers = new ArrayList<>();
    private static MediaPlayer sManagedAudioPlayer;
    private static final Map<MediaPlayer, TimelinePlayerState> sTimelinePlayers = new HashMap<>();
    private static final Map<String, Boolean> sTimelineTrackAudible = new HashMap<>();
    private static final Handler sPlaybackHandler = new Handler(Looper.getMainLooper());
    private static Runnable sLoopRestart;
    private static final List<Runnable> sScheduledPlayback = new ArrayList<>();
    private static final ExecutorService sMixExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "ColorMusicMixExport");
        thread.setPriority(Thread.NORM_PRIORITY);
        return thread;
    });
    private static int sPlaybackGeneration = 0;
    private static boolean sTimelineAutomationScheduled = false;

    private static final class TimelinePlayerState {
        final String trackId;
        final float baseVolume;
        final float[] volumeAutomation;
        final long startMs;
        final long endMs;

        TimelinePlayerState(String trackId, float baseVolume, float[] volumeAutomation, long startMs, long endMs) {
            this.trackId = trackId;
            this.baseVolume = baseVolume;
            this.volumeAutomation = volumeAutomation;
            this.startMs = startMs;
            this.endMs = endMs;
        }
    }

    private static final Runnable sTimelineAutomationTick = new Runnable() {
        @Override public void run() {
            synchronized (NativeBridge.class) {
                sTimelineAutomationScheduled = false;
                if (sTimelinePlayers.isEmpty()) return;
                for (Map.Entry<MediaPlayer, TimelinePlayerState> entry : sTimelinePlayers.entrySet()) {
                    applyTimelinePlayerVolume(entry.getKey(), entry.getValue());
                }
                sTimelineAutomationScheduled = true;
                sPlaybackHandler.postDelayed(this, 16);
            }
        }
    };

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

    /** 单窗口编辑节拍器拍号与 BPM。 */
    public static void promptMetronome(String requestId, int beats, int unit, int bpm) {
        if (sActivity == null) return;
        sActivity.runOnUiThread(() -> {
            final LinearLayout root = new LinearLayout(sActivity);
            root.setOrientation(LinearLayout.VERTICAL);
            root.setPadding(36, 8, 36, 0);

            final LinearLayout signature = new LinearLayout(sActivity);
            signature.setGravity(Gravity.CENTER_VERTICAL);
            final EditText numerator = numberInput(String.valueOf(beats), 2);
            final EditText denominator = numberInput(String.valueOf(unit), 2);
            final TextView slash = new TextView(sActivity);
            slash.setText("/");
            slash.setTextSize(22);
            slash.setGravity(Gravity.CENTER);
            signature.addView(numerator, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
            signature.addView(slash, new LinearLayout.LayoutParams(42, LinearLayout.LayoutParams.WRAP_CONTENT));
            signature.addView(denominator, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
            root.addView(signature, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

            final LinearLayout bpmRow = new LinearLayout(sActivity);
            bpmRow.setGravity(Gravity.CENTER_VERTICAL);
            final TextView bpmLabel = new TextView(sActivity);
            bpmLabel.setText("BPM");
            bpmLabel.setTextSize(17);
            bpmLabel.setPadding(0, 18, 22, 0);
            final EditText bpmInput = numberInput(String.valueOf(bpm), 3);
            bpmRow.addView(bpmLabel, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
            bpmRow.addView(bpmInput, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
            root.addView(bpmRow, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

            new AlertDialog.Builder(sActivity)
                    .setTitle("节拍器")
                    .setView(root)
                    .setPositiveButton("确定", (dialog, which) -> sendMetronomeResult(requestId,
                            parseInt(numerator, beats), parseInt(denominator, unit), parseInt(bpmInput, bpm)))
                    .setNegativeButton("取消", (dialog, which) -> sendMetronomeResult(requestId, beats, unit, bpm))
                    .setOnCancelListener(dialog -> sendMetronomeResult(requestId, beats, unit, bpm))
                    .show();
        });
    }

    private static EditText numberInput(String value, int digits) {
        EditText input = new EditText(sActivity);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_NUMBER);
        input.setText(value);
        input.setSelectAllOnFocus(true);
        input.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(digits)});
        return input;
    }

    private static int parseInt(EditText input, int fallback) {
        try { return Integer.parseInt(input.getText().toString().trim()); } catch (Exception ignored) { return fallback; }
    }

    private static void sendMetronomeResult(String requestId, int beats, int unit, int bpm) {
        evalToJs("globalThis.__colormusic_onMetronomeSettings && globalThis.__colormusic_onMetronomeSettings("
                + org.json.JSONObject.quote(requestId == null ? "" : requestId) + ","
                + beats + "," + unit + "," + bpm + ");");
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

    /** 轨道导出窗口：名称、起始拍和结束拍。 */
    public static void promptTrackExport(String requestId, String defaultName, int startBeat, int endBeat, String format) {
        if (sActivity == null) return;
        sActivity.runOnUiThread(() -> {
            LinearLayout root = new LinearLayout(sActivity); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(36, 8, 36, 0);
            EditText name = new EditText(sActivity); name.setSingleLine(true); name.setHint("音频名称"); name.setText(defaultName); root.addView(name);
            EditText from = new EditText(sActivity); from.setSingleLine(true); from.setHint("从第几拍"); from.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL); from.setText(String.valueOf(startBeat)); root.addView(from);
            EditText to = new EditText(sActivity); to.setSingleLine(true); to.setHint("到第几拍"); to.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL); to.setText(String.valueOf(endBeat)); root.addView(to);
            Runnable cancel = () -> evalToJs("globalThis.__colormusic_onTrackExport && globalThis.__colormusic_onTrackExport("
                    + org.json.JSONObject.quote(requestId) + ",'');");
            new AlertDialog.Builder(sActivity).setTitle("导出 " + format.toUpperCase() + " 音频").setView(root)
                    .setPositiveButton("开始导出", (dialog, which) -> {
                        org.json.JSONObject value = new org.json.JSONObject();
                        try { value.put("name", name.getText().toString().trim()); value.put("start", Double.parseDouble(from.getText().toString())); value.put("end", Double.parseDouble(to.getText().toString())); }
                        catch (Exception error) { try { value.put("error", true); } catch (Exception ignored) { } }
                        evalToJs("globalThis.__colormusic_onTrackExport && globalThis.__colormusic_onTrackExport("
                                + org.json.JSONObject.quote(requestId) + "," + org.json.JSONObject.quote(value.toString()) + ");");
                    }).setNegativeButton("取消", (dialog, which) -> cancel.run()).setOnCancelListener(dialog -> cancel.run()).show();
        });
    }

    public static void playManagedAudio(String path, int startMs) {
        if (sActivity == null || path == null) return;
        sActivity.runOnUiThread(() -> {
            stopManagedAudio();
            try {
                sManagedAudioPlayer = new MediaPlayer(); sManagedAudioPlayer.setDataSource(path); sManagedAudioPlayer.prepare();
                sManagedAudioPlayer.seekTo(Math.max(0, Math.min(startMs, Math.max(0, sManagedAudioPlayer.getDuration() - 1))));
                sManagedAudioPlayer.setOnCompletionListener(player -> stopManagedAudio()); sManagedAudioPlayer.start();
            } catch (Exception error) { Log.e(TAG, "playManagedAudio failed", error); stopManagedAudio(); }
        });
    }

    public static void stopManagedAudio() {
        if (sManagedAudioPlayer != null) { try { sManagedAudioPlayer.stop(); } catch (Exception ignored) { } try { sManagedAudioPlayer.release(); } catch (Exception ignored) { } sManagedAudioPlayer = null; }
    }

    public static String convertManagedAudio(String sourcePath, String displayName, String targetFormat) {
        if (sourcePath == null) return "ERROR:找不到音频";
        String lower = sourcePath.toLowerCase();
        if ("mp3".equalsIgnoreCase(targetFormat) && lower.endsWith(".wav")) return exportAudio(sourcePath, displayName, "mp3");
        if ("wav".equalsIgnoreCase(targetFormat) && lower.endsWith(".mp3")) {
            File wav = new File(sActivity.getCacheDir(), "decoded_" + System.nanoTime() + ".wav");
            try { decodeAudioToWav(new File(sourcePath), wav); return publishManagedAudio(wav, sanitizeFileName(displayName) + ".wav"); }
            catch (Exception error) { Log.e(TAG, "MP3 to WAV failed", error); return "ERROR:MP3 转 WAV 失败"; }
            finally { wav.delete(); }
        }
        return "ERROR:只支持 WAV 与 MP3 互相转换";
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

    private static String categoryFolder(String category) {
        if ("style".equals(category)) return "Neuro_Style";
        if ("flow".equals(category)) return "Neuro_Style_Flow";
        if ("track".equals(category)) return "Neuro_Track";
        return "Neuro_Music";
    }

    private static final class ManagedDirectory {
        final File file;
        final Uri treeUri;
        final String documentId;
        ManagedDirectory(File file, Uri treeUri, String documentId) {
            this.file = file; this.treeUri = treeUri; this.documentId = documentId;
        }
        boolean isSaf() { return treeUri != null && documentId != null; }
        Uri uri() { return isSaf() ? DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId) : Uri.fromFile(file); }
    }

    private static ManagedDirectory managedRoot(boolean create) {
        if (sActivity == null) return null;
        android.content.SharedPreferences prefs = sActivity.getSharedPreferences(SAVE_PREFS, Activity.MODE_PRIVATE);
        String tree = prefs.getString(SAVE_TREE_URI, "");
        String rootId = prefs.getString(SAVE_ROOT_DOCUMENT, "");
        if (!tree.isEmpty() && !rootId.isEmpty()) return new ManagedDirectory(null, Uri.parse(tree), rootId);
        File root = new File(sActivity.getExternalFilesDir(null), SAVE_ROOT_NAME);
        if (create && !root.exists()) root.mkdirs();
        return new ManagedDirectory(root, null, null);
    }

    private static ManagedDirectory managedCategory(String category, boolean create) {
        ManagedDirectory root = managedRoot(create);
        if (root == null) return null;
        String name = categoryFolder(category);
        if (!root.isSaf()) {
            File folder = new File(root.file, name);
            if (create && !folder.exists()) folder.mkdirs();
            return new ManagedDirectory(folder, null, null);
        }
        try {
            String id = findChildDocumentId(root.treeUri, root.documentId, name);
            if (id == null && create) {
                Uri created = DocumentsContract.createDocument(sActivity.getContentResolver(), root.uri(),
                        DocumentsContract.Document.MIME_TYPE_DIR, name);
                if (created != null) id = DocumentsContract.getDocumentId(created);
            }
            return id == null ? null : new ManagedDirectory(null, root.treeUri, id);
        } catch (Exception error) {
            Log.e(TAG, "managedCategory failed", error);
            return null;
        }
    }

    private static String findChildDocumentId(Uri treeUri, String parentId, String name) {
        Cursor cursor = null;
        try {
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId);
            cursor = sActivity.getContentResolver().query(children,
                    new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME},
                    null, null, null);
            while (cursor != null && cursor.moveToNext()) {
                if (name.equalsIgnoreCase(cursor.getString(1))) return cursor.getString(0);
            }
        } catch (Exception error) {
            Log.w(TAG, "findChildDocumentId failed for " + name, error);
        } finally { if (cursor != null) cursor.close(); }
        return null;
    }

    private static Uri childUri(ManagedDirectory parent, String name) {
        String id = findChildDocumentId(parent.treeUri, parent.documentId, name);
        return id == null ? null : DocumentsContract.buildDocumentUriUsingTree(parent.treeUri, id);
    }

    private static Uri createUniqueDocument(ManagedDirectory parent, String name, String mimeType, boolean directory) throws IOException {
        String clean = sanitizeFileName(name);
        String extension = "";
        String base = clean;
        if (!directory) {
            int dot = clean.lastIndexOf('.');
            if (dot > 0) { base = clean.substring(0, dot); extension = clean.substring(dot); }
        }
        String candidate = clean;
        int index = 2;
        while (childUri(parent, candidate) != null) candidate = base + "_" + index++ + extension;
        Uri created = DocumentsContract.createDocument(sActivity.getContentResolver(), parent.uri(),
                directory ? DocumentsContract.Document.MIME_TYPE_DIR : mimeType, candidate);
        if (created == null) throw new IOException("无法创建 " + candidate);
        return created;
    }

    private static void writeUri(Uri uri, byte[] data) throws IOException {
        try (OutputStream out = sActivity.getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new IOException("无法写入文件");
            out.write(data); out.flush();
        }
    }

    private static byte[] readUri(Uri uri) throws IOException {
        try (InputStream in = sActivity.getContentResolver().openInputStream(uri);
             java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
            if (in == null) throw new IOException("无法读取文件");
            byte[] buffer = new byte[16384]; int count;
            while ((count = in.read(buffer)) >= 0) out.write(buffer, 0, count);
            return out.toByteArray();
        }
    }

    /** 选择 Neuro_Save 的保存位置，并持久化目录授权。 */
    public static void chooseSaveRoot() {
        if (sActivity == null) return;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        sActivity.startActivityForResult(Intent.createChooser(intent, "选择 Neuro_Save 的保存位置"), REQ_CHOOSE_SAVE_ROOT);
    }

    public static String getSaveRootLabel() {
        ManagedDirectory root = managedRoot(true);
        if (root == null) return "Neuro_Save";
        return root.isSaf() ? root.uri().toString() : root.file.getAbsolutePath();
    }

    public static String saveManagedJson(String category, String displayName, String json) {
        if (sActivity == null || json == null) return "";
        try {
            ManagedDirectory categoryDir = managedCategory(category, true);
            if (categoryDir == null) return "";
            String name = sanitizeFileName(displayName == null ? "Untitled" : displayName);
            if (!categoryDir.isSaf()) {
                File packageDir = uniqueFile(categoryDir.file, name, "", false);
                if (!packageDir.mkdirs()) return "";
                try (FileOutputStream out = new FileOutputStream(new File(packageDir, "manifest.json"))) {
                    out.write(json.getBytes(StandardCharsets.UTF_8));
                }
                if ("track".equals(category)) saveTrackAssetsToFilePackage(packageDir, json);
                return Uri.fromFile(packageDir).toString();
            }
            Uri packageUri = createUniqueDocument(categoryDir, name, DocumentsContract.Document.MIME_TYPE_DIR, true);
            ManagedDirectory packageDir = new ManagedDirectory(null, categoryDir.treeUri, DocumentsContract.getDocumentId(packageUri));
            Uri manifest = DocumentsContract.createDocument(sActivity.getContentResolver(), packageUri, "application/json", "manifest.json");
            if (manifest == null) return "";
            String storedJson = "track".equals(category) ? saveTrackAssetsToSafPackage(packageDir, json) : json;
            writeUri(manifest, storedJson.getBytes(StandardCharsets.UTF_8));
            return packageUri.toString();
        } catch (Exception error) {
            Log.e(TAG, "saveManagedJson failed", error);
            return "";
        }
    }

    public static boolean updateManagedJson(String key, String json) {
        if (sActivity == null || key == null || json == null) return false;
        try {
            Uri uri = Uri.parse(key);
            if ("file".equalsIgnoreCase(uri.getScheme())) {
                File folder = new File(uri.getPath());
                try (FileOutputStream out = new FileOutputStream(new File(folder, "manifest.json"))) {
                    out.write(json.getBytes(StandardCharsets.UTF_8));
                }
                return true;
            }
            String treeText = sActivity.getSharedPreferences(SAVE_PREFS, Activity.MODE_PRIVATE).getString(SAVE_TREE_URI, "");
            if (treeText.isEmpty()) return false;
            Uri tree = Uri.parse(treeText);
            ManagedDirectory folder = new ManagedDirectory(null, tree, DocumentsContract.getDocumentId(uri));
            Uri manifest = childUri(folder, "manifest.json");
            if (manifest == null) return false;
            writeUri(manifest, json.getBytes(StandardCharsets.UTF_8));
            return true;
        } catch (Exception error) { Log.e(TAG, "updateManagedJson failed", error); return false; }
    }

    public static String renameManagedEntry(String key, String newName) {
        if (sActivity == null || key == null) return "";
        try {
            Uri uri = Uri.parse(key); String clean = sanitizeFileName(newName);
            if ("file".equalsIgnoreCase(uri.getScheme())) {
                File file = new File(uri.getPath());
                String suffix = file.isFile() && file.getName().contains(".") ? file.getName().substring(file.getName().lastIndexOf('.')) : "";
                File target = new File(file.getParentFile(), clean.toLowerCase().endsWith(suffix.toLowerCase()) ? clean : clean + suffix);
                if (target.exists() || !file.renameTo(target)) return "";
                return Uri.fromFile(target).toString();
            }
            Uri renamed = DocumentsContract.renameDocument(sActivity.getContentResolver(), uri, clean);
            return renamed == null ? "" : renamed.toString();
        } catch (Exception error) { Log.e(TAG, "renameManagedEntry failed", error); return ""; }
    }

    public static boolean deleteManagedEntry(String key) {
        if (sActivity == null || key == null) return false;
        try {
            Uri uri = Uri.parse(key);
            if ("file".equalsIgnoreCase(uri.getScheme())) return deleteRecursively(new File(uri.getPath()));
            return DocumentsContract.deleteDocument(sActivity.getContentResolver(), uri);
        } catch (Exception error) { Log.e(TAG, "deleteManagedEntry failed", error); return false; }
    }

    public static int clearManagedCategory(String category) {
        ManagedDirectory dir = managedCategory(category, true);
        if (dir == null) return -1;
        int removed = 0;
        try {
            if (!dir.isSaf()) {
                File[] files = dir.file.listFiles(); if (files == null) return 0;
                for (File file : files) if (deleteRecursively(file)) removed++;
                return removed;
            }
            for (org.json.JSONObject item : listDocumentChildren(dir)) {
                Uri uri = Uri.parse(item.optString("uri"));
                if (DocumentsContract.deleteDocument(sActivity.getContentResolver(), uri)) removed++;
            }
            return removed;
        } catch (Exception error) { Log.e(TAG, "clearManagedCategory failed", error); return -1; }
    }

    private static List<org.json.JSONObject> listDocumentChildren(ManagedDirectory dir) throws Exception {
        List<org.json.JSONObject> result = new ArrayList<>(); Cursor cursor = null;
        try {
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(dir.treeUri, dir.documentId);
            cursor = sActivity.getContentResolver().query(children, new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_LAST_MODIFIED}, null, null, null);
            while (cursor != null && cursor.moveToNext()) {
                org.json.JSONObject item = new org.json.JSONObject();
                item.put("id", cursor.getString(0)); item.put("name", cursor.getString(1)); item.put("mime", cursor.getString(2)); item.put("modified", cursor.getLong(3));
                item.put("uri", DocumentsContract.buildDocumentUriUsingTree(dir.treeUri, cursor.getString(0)).toString()); result.add(item);
            }
        } finally { if (cursor != null) cursor.close(); }
        return result;
    }

    public static String listManagedEntries(String category) {
        org.json.JSONArray result = new org.json.JSONArray();
        try {
            ManagedDirectory dir = managedCategory(category, true); if (dir == null) return "[]";
            if (!dir.isSaf()) {
                File[] entries = dir.file.listFiles(); if (entries == null) return "[]";
                java.util.Arrays.sort(entries, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
                for (File entry : entries) appendManagedFile(result, category, entry);
            } else {
                List<org.json.JSONObject> entries = listDocumentChildren(dir);
                Collections.sort(entries, (a, b) -> Long.compare(b.optLong("modified"), a.optLong("modified")));
                for (org.json.JSONObject entry : entries) appendManagedDocument(result, category, dir, entry);
            }
        } catch (Exception error) { Log.e(TAG, "listManagedEntries failed", error); }
        return result.toString();
    }

    private static void appendManagedFile(org.json.JSONArray result, String category, File entry) throws Exception {
        if ("audio".equals(category)) {
            if (!entry.isFile() || !(entry.getName().toLowerCase().endsWith(".wav") || entry.getName().toLowerCase().endsWith(".mp3"))) return;
            org.json.JSONObject item = new org.json.JSONObject(); item.put("key", Uri.fromFile(entry).toString()); item.put("name", stripExtension(entry.getName()));
            item.put("format", extensionOf(entry.getName())); item.put("path", entry.getAbsolutePath()); item.put("duration", audioDuration(entry.getAbsolutePath())); result.put(item); return;
        }
        File manifest = entry.isDirectory() ? new File(entry, "manifest.json") : entry;
        if (!manifest.isFile()) return;
        String json = new String(readAllBytes(manifest), StandardCharsets.UTF_8);
        if ("track".equals(category) && entry.isDirectory()) json = hydrateTrackFilePackage(entry, json);
        org.json.JSONObject item = new org.json.JSONObject(); item.put("key", Uri.fromFile(entry).toString()); item.put("name", entry.getName()); item.put("json", json); result.put(item);
    }

    private static void appendManagedDocument(org.json.JSONArray result, String category, ManagedDirectory parent, org.json.JSONObject entry) throws Exception {
        String name = entry.optString("name"); Uri uri = Uri.parse(entry.optString("uri")); String mime = entry.optString("mime");
        if ("audio".equals(category)) {
            String lower = name.toLowerCase(); if (!(lower.endsWith(".wav") || lower.endsWith(".mp3"))) return;
            File cached = cacheUriFile(uri, name); org.json.JSONObject item = new org.json.JSONObject(); item.put("key", uri.toString()); item.put("name", stripExtension(name));
            item.put("format", extensionOf(name)); item.put("path", cached.getAbsolutePath()); item.put("duration", audioDuration(cached.getAbsolutePath())); result.put(item); return;
        }
        if (!DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) return;
        ManagedDirectory packageDir = new ManagedDirectory(null, parent.treeUri, entry.optString("id")); Uri manifest = childUri(packageDir, "manifest.json"); if (manifest == null) return;
        String json = new String(readUri(manifest), StandardCharsets.UTF_8);
        if ("track".equals(category)) json = hydrateTrackSafPackage(packageDir, json);
        org.json.JSONObject item = new org.json.JSONObject(); item.put("key", uri.toString()); item.put("name", name); item.put("json", json); result.put(item);
    }

    private static String stripExtension(String name) { int dot = name.lastIndexOf('.'); return dot > 0 ? name.substring(0, dot) : name; }
    private static String extensionOf(String name) { int dot = name.lastIndexOf('.'); return dot >= 0 ? name.substring(dot + 1).toLowerCase() : ""; }
    private static long audioDuration(String path) { MediaMetadataRetriever r = new MediaMetadataRetriever(); try { r.setDataSource(path); return Long.parseLong(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)) / 1000L; } catch (Exception ignored) { return 0; } finally { try { r.release(); } catch (Exception ignored) { } } }
    private static File cacheUriFile(Uri uri, String name) throws IOException { File out = new File(sActivity.getCacheDir(), "managed_" + Integer.toHexString(uri.toString().hashCode()) + "_" + sanitizeFileName(name)); try (InputStream in = sActivity.getContentResolver().openInputStream(uri); OutputStream target = new FileOutputStream(out)) { if (in == null) throw new IOException("无法读取文件"); byte[] b = new byte[32768]; int n; while ((n = in.read(b)) >= 0) target.write(b, 0, n); } return out; }

    private static void saveTrackAssetsToFilePackage(File packageDir, String json) throws Exception {
        org.json.JSONObject root = new org.json.JSONObject(json); org.json.JSONArray clips = root.optJSONArray("clips");
        if (clips != null) for (int i = 0; i < clips.length(); i++) {
            org.json.JSONObject clip = clips.optJSONObject(i); if (clip == null) continue;
            File source = new File(clip.optString("path", "")); if (!source.isFile()) continue;
            String extension = source.getName().toLowerCase().endsWith(".mp3") ? ".mp3" : ".wav";
            String asset = sanitizeFileName(clip.optString("id", "audio_" + i)) + extension;
            File target = new File(packageDir, asset); copyFile(source, target); clip.put("assetFile", asset); clip.put("path", "");
        }
        try (FileOutputStream out = new FileOutputStream(new File(packageDir, "manifest.json"))) { out.write(root.toString().getBytes(StandardCharsets.UTF_8)); }
    }

    private static String saveTrackAssetsToSafPackage(ManagedDirectory packageDir, String json) throws Exception {
        org.json.JSONObject root = new org.json.JSONObject(json); org.json.JSONArray clips = root.optJSONArray("clips");
        if (clips != null) for (int i = 0; i < clips.length(); i++) {
            org.json.JSONObject clip = clips.optJSONObject(i); if (clip == null) continue;
            File source = new File(clip.optString("path", "")); if (!source.isFile()) continue;
            String extension = source.getName().toLowerCase().endsWith(".mp3") ? ".mp3" : ".wav";
            String asset = sanitizeFileName(clip.optString("id", "audio_" + i)) + extension;
            Uri target = DocumentsContract.createDocument(sActivity.getContentResolver(), packageDir.uri(),
                    ".mp3".equals(extension) ? "audio/mpeg" : "audio/wav", asset);
            if (target == null) continue;
            try (InputStream in = new FileInputStream(source); OutputStream out = sActivity.getContentResolver().openOutputStream(target, "wt")) {
                if (out == null) continue; byte[] buffer = new byte[32768]; int count; while ((count = in.read(buffer)) >= 0) out.write(buffer, 0, count);
            }
            clip.put("assetFile", asset); clip.put("path", "");
        }
        return root.toString();
    }

    private static String hydrateTrackFilePackage(File packageDir, String json) {
        try {
            org.json.JSONObject root = new org.json.JSONObject(json); org.json.JSONArray clips = root.optJSONArray("clips");
            if (clips != null) for (int i = 0; i < clips.length(); i++) {
                org.json.JSONObject clip = clips.optJSONObject(i); if (clip == null) continue; String asset = clip.optString("assetFile", "");
                if (!asset.isEmpty()) { File source = new File(packageDir, asset); if (source.isFile()) clip.put("path", source.getAbsolutePath()); }
            }
            return root.toString();
        } catch (Exception ignored) { return json; }
    }

    private static String hydrateTrackSafPackage(ManagedDirectory packageDir, String json) {
        try {
            org.json.JSONObject root = new org.json.JSONObject(json); org.json.JSONArray clips = root.optJSONArray("clips");
            if (clips != null) for (int i = 0; i < clips.length(); i++) {
                org.json.JSONObject clip = clips.optJSONObject(i); if (clip == null) continue; String asset = clip.optString("assetFile", "");
                if (!asset.isEmpty()) { Uri uri = childUri(packageDir, asset); if (uri != null) clip.put("path", cacheUriFile(uri, asset).getAbsolutePath()); }
            }
            return root.toString();
        } catch (Exception ignored) { return json; }
    }

    public static void openManagedDirectory(String category) {
        ManagedDirectory dir = managedCategory(category, true); if (dir == null) return;
        if (!dir.isSaf()) {
            Uri initial = externalStorageDocumentUri(dir.file);
            if (initial != null) { launchDirectoryView(initial); return; }
            sActivity.runOnUiThread(() -> { try { sActivity.startActivity(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)); } catch (Exception error) { Log.e(TAG, "Open managed directory failed", error); } });
            return;
        }
        launchDirectoryView(dir.uri());
    }

    private static void launchDirectoryView(Uri directoryUri) {
        if (sActivity == null) return;
        sActivity.runOnUiThread(() -> {
            try {
                Intent view = new Intent(Intent.ACTION_VIEW);
                view.setDataAndType(directoryUri, DocumentsContract.Document.MIME_TYPE_DIR);
                view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                sActivity.startActivity(view);
            } catch (Exception error) {
                Log.w(TAG, "Direct directory view failed", error);
                // This vendor's DocumentsUI crashes when EXTRA_INITIAL_URI is
                // supplied, so the fallback deliberately opens at its default.
                launchSystemDirectoryPicker(null);
            }
        });
    }

    /** 导出为文件夹数据包，manifest.json 内保存完整样式。 */
    public static String exportStylePackage(String baseName, String json) {
        try { org.json.JSONObject value = new org.json.JSONObject(json); String category = "flow".equals(value.optString("kind")) ? "flow" : "style"; return saveManagedJson(category, value.optString("name", baseName), json); }
        catch (Exception error) { Log.e(TAG, "exportStylePackage failed", error); return ""; }
    }

    /** 清除游戏导出目录中的所有样式/样式流数据包，保留录音与导出的音频。 */
    public static int clearStylePackages() {
        int styles = clearManagedCategory("style"), flows = clearManagedCategory("flow");
        return styles < 0 || flows < 0 ? -1 : styles + flows;
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
        sActivity.runOnUiThread(() -> {
            try {
                Intent tree = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                if (directoryUri != null && "content".equalsIgnoreCase(directoryUri.getScheme())) tree.putExtra(DocumentsContract.EXTRA_INITIAL_URI, directoryUri);
                tree.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                sActivity.startActivity(tree);
            } catch (Exception error) {
                Log.e(TAG, "System directory picker failed", error);
                // Some vendor document providers reject EXTRA_INITIAL_URI. Retry
                // with a plain picker so this action can never take down the game.
                try { sActivity.startActivity(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)); }
                catch (Exception fallback) { Log.e(TAG, "Plain directory picker failed", fallback); }
            }
        });
    }

    private static Uri externalStorageDocumentUri(File directory) {
        if (directory == null) return null;
        try {
            String root = Environment.getExternalStorageDirectory().getCanonicalPath();
            String path = directory.getCanonicalPath();
            if (!path.startsWith(root + "/")) return null;
            String relative = path.substring(root.length() + 1).replace(File.separatorChar, '/');
            return DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:" + relative);
        } catch (Exception error) { return null; }
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
        String baseName = sanitizeFileName(displayName == null ? "audio" : displayName);
        if ("wav".equalsIgnoreCase(requestedFormat)) {
            File output = new File(sActivity.getCacheDir(), "export_" + System.nanoTime() + ".wav");
            try {
                copyFile(source, output);
                return publishManagedAudio(output, baseName + ".wav");
            } catch (Exception error) {
                Log.e(TAG, "WAV export failed", error);
                return "ERROR:WAV 导出失败";
            } finally {
                output.delete();
            }
        }
        if (!"mp3".equalsIgnoreCase(requestedFormat)) return "ERROR:不支持的音频格式";

        File output = new File(sActivity.getCacheDir(), "export_" + System.nanoTime() + ".mp3");
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
            return publishManagedAudio(output, baseName + ".mp3");
        } catch (Exception e) {
            Log.e(TAG, "AndroidLame MP3 export failed", e);
            output.delete();
            return "ERROR:MP3 转换失败，请改选 WAV";
        } finally {
            raw.delete();
            output.delete();
        }
    }

    private static String publishManagedAudio(File source, String fileName) throws IOException {
        ManagedDirectory dir = managedCategory("audio", true); if (dir == null) throw new IOException("无法创建 Neuro_Music");
        if (!dir.isSaf()) {
            String ext = fileName.toLowerCase().endsWith(".mp3") ? ".mp3" : ".wav";
            File output = uniqueFile(dir.file, stripExtension(fileName), ext, false); copyFile(source, output); return output.getAbsolutePath();
        }
        String mime = fileName.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/wav";
        Uri output = createUniqueDocument(dir, fileName, mime, false);
        try (InputStream in = new FileInputStream(source); OutputStream out = sActivity.getContentResolver().openOutputStream(output, "wt")) {
            if (out == null) throw new IOException("无法写入 Neuro_Music"); byte[] buffer = new byte[32768]; int count; while ((count = in.read(buffer)) >= 0) out.write(buffer, 0, count);
        }
        return output.toString();
    }

    /** Mix enabled mixer rows with their trim/volume settings, then export the rendered bus. */
    public static String mixAndExportAudio(String clipsJson, String displayName, String requestedFormat) {
        if (sActivity == null) return "ERROR:应用尚未就绪";
        File mixed = new File(sActivity.getCacheDir(), "colormusic_mix_" + System.nanoTime() + ".wav");
        List<MixInput> inputs = new ArrayList<>();
        try {
            org.json.JSONArray clips = new org.json.JSONArray(clipsJson == null ? "[]" : clipsJson);
            int sampleRate = 0;
            long longestFrames = 0;
            for (int i = 0; i < clips.length(); i++) {
                org.json.JSONObject clip = clips.optJSONObject(i);
                if (clip == null || !clip.optBoolean("enabled", true)) continue;
                MixInput input = new MixInput(clip);
                if (sampleRate == 0) sampleRate = input.sampleRate;
                if (input.sampleRate != sampleRate) throw new IOException("轨道采样率不一致");
                inputs.add(input);
                longestFrames = Math.max(longestFrames, input.startFrames + input.totalFrames);
            }
            if (inputs.isEmpty() || longestFrames <= 0) return "ERROR:没有已启用的有效轨道";
            renderMixWav(mixed, inputs, sampleRate, longestFrames);
            return exportAudio(mixed.getAbsolutePath(), displayName, requestedFormat);
        } catch (Exception error) {
            Log.e(TAG, "Mix export failed", error);
            return "ERROR:混音导出失败";
        } finally {
            for (MixInput input : inputs) input.close();
            mixed.delete();
        }
    }

    /** 后台分块混音，避免大文件导出阻塞 Cocos/UI 线程。 */
    public static void mixAndExportAudioAsync(String requestId, String clipsJson, String displayName, String requestedFormat) {
        sMixExecutor.execute(() -> {
            String result = mixAndExportAudio(clipsJson, displayName, requestedFormat);
            evalToJs("globalThis.__colormusic_onMixExport && globalThis.__colormusic_onMixExport("
                    + org.json.JSONObject.quote(requestId == null ? "" : requestId) + ","
                    + org.json.JSONObject.quote(result == null ? "" : result) + ");");
        });
    }

    private static final class MixInput {
        final RandomAccessFile file;
        final int channels;
        final int sampleRate;
        final int frameBytes;
        final float volume;
        final float[] volumeAutomation;
        final long startFrames;
        final long totalFrames;
        long framesRemaining;
        long framesRead;
        byte[] block = new byte[0];

        MixInput(org.json.JSONObject clip) throws IOException {
            String path = clip.optString("path", "");
            file = new RandomAccessFile(path, "r");
            try {
                byte[] header = new byte[44];
                file.readFully(header);
                if (header[0] != 'R' || header[8] != 'W' || little16(header, 20) != 1 || little16(header, 34) != 16) {
                    throw new IOException("仅支持 16 位 PCM WAV 轨道");
                }
                channels = little16(header, 22);
                sampleRate = little32(header, 24);
                if (channels < 1 || channels > 2 || sampleRate < 8000) throw new IOException("无效 WAV 参数");
                frameBytes = channels * 2;
                long sourceTotalFrames = Math.min(Math.max(0, little32(header, 40)), Math.max(0, file.length() - 44)) / frameBytes;
                long start = Math.max(0, Math.round(clip.optDouble("trimStart", 0) * sampleRate));
                long requestedEnd = Math.round(clip.optDouble("trimEnd", 0) * sampleRate);
                long end = requestedEnd > start ? Math.min(sourceTotalFrames, requestedEnd) : sourceTotalFrames;
                start = Math.min(start, end);
                framesRemaining = Math.max(0, end - start);
                this.totalFrames = framesRemaining;
                volume = Math.max(0f, Math.min(1f, (float) clip.optDouble("volume", 1)));
                volumeAutomation = timelineAutomation(clip);
                int bpm = Math.max(20, Math.min(320, clip.optInt("bpm", 120)));
                startFrames = Math.max(0, Math.round(clip.optDouble("startBeat", 0) * 60.0 / bpm * sampleRate));
                file.seek(44 + start * frameBytes);
            } catch (IOException | RuntimeException error) {
                try { file.close(); } catch (Exception ignored) { }
                throw error;
            }
        }

        int mixInto(float[] left, float[] right, int requestedFrames) throws IOException {
            return mixInto(left, right, requestedFrames, 0);
        }

        int mixInto(float[] left, float[] right, int requestedFrames, int outputOffset) throws IOException {
            int frames = (int) Math.min(framesRemaining, requestedFrames);
            int bytes = frames * frameBytes;
            if (block.length < bytes) block = new byte[bytes];
            int offset = 0;
            while (offset < bytes) {
                int read = file.read(block, offset, bytes - offset);
                if (read < 0) break;
                offset += read;
            }
            int actualFrames = offset / frameBytes;
            for (int frame = 0; frame < actualFrames; frame++) {
                int at = frame * frameBytes;
                float l = (short) little16(block, at) / 32768f;
                float r = channels == 1 ? l : (short) little16(block, at + 2) / 32768f;
                float gain = volume * timelineAutomationGain(volumeAutomation, (framesRead + frame) / (float) Math.max(1, totalFrames - 1));
                left[frame + outputOffset] += l * gain;
                right[frame + outputOffset] += r * gain;
            }
            framesRemaining -= actualFrames;
            framesRead += actualFrames;
            return actualFrames;
        }

        void close() { try { file.close(); } catch (Exception ignored) { } }
    }

    private static void renderMixWav(File target, List<MixInput> inputs, int sampleRate, long totalFrames) throws IOException {
        try (BufferedOutputStream out = new BufferedOutputStream(new FileOutputStream(target), 65536)) {
            writeMixHeader(out, sampleRate, totalFrames * 4);
            final int framesPerBlock = 1024;
            float[] left = new float[framesPerBlock];
            float[] right = new float[framesPerBlock];
            byte[] pcm = new byte[framesPerBlock * 4];
            float busGain = 1f / (float) Math.sqrt(Math.max(1, inputs.size()));
            float limiterGain = 1f;
            for (long rendered = 0; rendered < totalFrames; rendered += framesPerBlock) {
                int frames = (int) Math.min(framesPerBlock, totalFrames - rendered);
                java.util.Arrays.fill(left, 0, frames, 0f);
                java.util.Arrays.fill(right, 0, frames, 0f);
                for (MixInput input : inputs) {
                    if (rendered + frames <= input.startFrames || input.framesRemaining <= 0) continue;
                    int offset = (int) Math.max(0, input.startFrames - rendered);
                    input.mixInto(left, right, frames - offset, offset);
                }
                float peak = 0f;
                for (int i = 0; i < frames; i++) peak = Math.max(peak, Math.max(Math.abs(left[i]), Math.abs(right[i])) * busGain);
                float targetGain = peak > .95f ? .95f / peak : 1f;
                limiterGain = targetGain < limiterGain ? targetGain : limiterGain + (targetGain - limiterGain) * .12f;
                for (int i = 0; i < frames; i++) {
                    short l = (short) (Math.max(-.95f, Math.min(.95f, left[i] * busGain * limiterGain)) * 32767f);
                    short r = (short) (Math.max(-.95f, Math.min(.95f, right[i] * busGain * limiterGain)) * 32767f);
                    int at = i * 4;
                    pcm[at] = (byte) (l & 255); pcm[at + 1] = (byte) ((l >> 8) & 255);
                    pcm[at + 2] = (byte) (r & 255); pcm[at + 3] = (byte) ((r >> 8) & 255);
                }
                out.write(pcm, 0, frames * 4);
            }
        }
    }

    private static void writeMixHeader(java.io.OutputStream out, int sampleRate, long dataBytes) throws IOException {
        byte[] h = new byte[44];
        h[0] = 'R'; h[1] = 'I'; h[2] = 'F'; h[3] = 'F'; putLittle32(h, 4, 36 + dataBytes);
        h[8] = 'W'; h[9] = 'A'; h[10] = 'V'; h[11] = 'E'; h[12] = 'f'; h[13] = 'm'; h[14] = 't'; h[15] = ' ';
        putLittle32(h, 16, 16); putLittle16(h, 20, 1); putLittle16(h, 22, 2);
        putLittle32(h, 24, sampleRate); putLittle32(h, 28, sampleRate * 4L); putLittle16(h, 32, 4); putLittle16(h, 34, 16);
        h[36] = 'd'; h[37] = 'a'; h[38] = 't'; h[39] = 'a'; putLittle32(h, 40, dataBytes);
        out.write(h);
    }

    private static void decodeAudioToWav(File source, File target) throws Exception {
        MediaExtractor extractor = new MediaExtractor(); MediaCodec codec = null;
        File raw = new File(sActivity.getCacheDir(), "decode_" + System.nanoTime() + ".pcm");
        int sampleRate = 44100, channels = 2;
        try {
            extractor.setDataSource(source.getAbsolutePath()); int track = -1; MediaFormat format = null;
            for (int i = 0; i < extractor.getTrackCount(); i++) { MediaFormat candidate = extractor.getTrackFormat(i); String mime = candidate.getString(MediaFormat.KEY_MIME); if (mime != null && mime.startsWith("audio/")) { track = i; format = candidate; break; } }
            if (track < 0 || format == null) throw new IOException("没有音频轨道");
            extractor.selectTrack(track); sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE); channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)); codec.configure(format, null, null, 0); codec.start();
            boolean inputDone = false, outputDone = false; MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            try (BufferedOutputStream pcm = new BufferedOutputStream(new FileOutputStream(raw), 65536)) {
                while (!outputDone) {
                    if (!inputDone) {
                        int inputIndex = codec.dequeueInputBuffer(10000);
                        if (inputIndex >= 0) {
                            ByteBuffer input = codec.getInputBuffer(inputIndex); int size = input == null ? -1 : extractor.readSampleData(input, 0);
                            if (size < 0) { codec.queueInputBuffer(inputIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputDone = true; }
                            else { codec.queueInputBuffer(inputIndex, 0, size, extractor.getSampleTime(), 0); extractor.advance(); }
                        }
                    }
                    int outputIndex = codec.dequeueOutputBuffer(info, 10000);
                    if (outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { MediaFormat out = codec.getOutputFormat(); sampleRate = out.getInteger(MediaFormat.KEY_SAMPLE_RATE); channels = out.getInteger(MediaFormat.KEY_CHANNEL_COUNT); }
                    else if (outputIndex >= 0) {
                        ByteBuffer output = codec.getOutputBuffer(outputIndex);
                        if (output != null && info.size > 0) { byte[] bytes = new byte[info.size]; output.position(info.offset); output.limit(info.offset + info.size); output.get(bytes); pcm.write(bytes); }
                        outputDone = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0; codec.releaseOutputBuffer(outputIndex, false);
                    }
                }
            }
            try (BufferedOutputStream wav = new BufferedOutputStream(new FileOutputStream(target), 65536); InputStream pcm = new FileInputStream(raw)) {
                writePcmHeader(wav, sampleRate, channels, raw.length()); byte[] buffer = new byte[65536]; int count; while ((count = pcm.read(buffer)) >= 0) wav.write(buffer, 0, count);
            }
        } finally {
            try { extractor.release(); } catch (Exception ignored) { }
            if (codec != null) { try { codec.stop(); } catch (Exception ignored) { } try { codec.release(); } catch (Exception ignored) { } }
            raw.delete();
        }
    }

    private static void writePcmHeader(OutputStream out, int sampleRate, int channels, long dataBytes) throws IOException {
        byte[] h = new byte[44]; h[0] = 'R'; h[1] = 'I'; h[2] = 'F'; h[3] = 'F'; putLittle32(h, 4, 36 + dataBytes);
        h[8] = 'W'; h[9] = 'A'; h[10] = 'V'; h[11] = 'E'; h[12] = 'f'; h[13] = 'm'; h[14] = 't'; h[15] = ' ';
        putLittle32(h, 16, 16); putLittle16(h, 20, 1); putLittle16(h, 22, channels); putLittle32(h, 24, sampleRate);
        putLittle32(h, 28, sampleRate * channels * 2L); putLittle16(h, 32, channels * 2); putLittle16(h, 34, 16);
        h[36] = 'd'; h[37] = 'a'; h[38] = 't'; h[39] = 'a'; putLittle32(h, 40, dataBytes); out.write(h);
    }

    private static void putLittle16(byte[] b, int at, int value) { b[at] = (byte) value; b[at + 1] = (byte) (value >> 8); }
    private static void putLittle32(byte[] b, int at, long value) { b[at] = (byte) value; b[at + 1] = (byte) (value >> 8); b[at + 2] = (byte) (value >> 16); b[at + 3] = (byte) (value >> 24); }

    /** Export completion dialog with a direct path to the app's export directory. */
    public static void showAudioExportResult(String path) {
        if (sActivity == null || path == null || path.isEmpty()) return;
        sActivity.runOnUiThread(() -> new AlertDialog.Builder(sActivity)
                .setTitle("导出成功")
                .setMessage("音频已保存至：\n" + path)
                .setPositiveButton("查看目录", (dialog, which) -> openExportDirectory())
                .setNegativeButton("完成", null)
                .show());
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

    public static void releaseAllNotes() {
        sSynth.releaseAllNotes();
    }

    public static void setMetronome(boolean enabled, int beatsPerBar, int beatUnit, int bpm) {
        sSynth.setMetronome(enabled, beatsPerBar, beatUnit, bpm);
    }

    public static float getDisplayPixelsPerCm() {
        if (sActivity == null) return 96f / 2.54f;
        DisplayMetrics metrics = sActivity.getResources().getDisplayMetrics();
        float dpi = (metrics.xdpi > 0f && metrics.ydpi > 0f)
                ? (metrics.xdpi + metrics.ydpi) * .5f : metrics.densityDpi;
        return dpi > 0f ? dpi / 2.54f : 96f / 2.54f;
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

    private static float[] timelineAutomation(org.json.JSONObject block) {
        org.json.JSONArray values = block.optJSONArray("volumeAutomation");
        if (values == null || values.length() == 0) return new float[] { 1f };
        float[] result = new float[values.length()];
        for (int i = 0; i < result.length; i++) result[i] = Math.max(0f, Math.min(1f, (float) values.optDouble(i, 1)));
        return result;
    }

    private static float timelineAutomationGain(float[] values, float ratio) {
        if (values == null || values.length == 0) return 1f;
        if (values.length == 1) return values[0] <= .005f ? 0f : values[0];
        float position = Math.max(0f, Math.min(1f, ratio)) * (values.length - 1);
        int left = Math.min(values.length - 1, (int) Math.floor(position));
        int right = Math.min(values.length - 1, left + 1);
        float gain = values[left] + (values[right] - values[left]) * (position - left);
        return gain <= .005f ? 0f : gain;
    }

    private static void applyTimelinePlayerVolume(MediaPlayer player, TimelinePlayerState state) {
        try {
            float ratio = (player.getCurrentPosition() - state.startMs) / (float) Math.max(1, state.endMs - state.startMs);
            float gain = timelineAutomationGain(state.volumeAutomation, ratio);
            boolean audible = state.trackId.isEmpty() || Boolean.TRUE.equals(sTimelineTrackAudible.get(state.trackId));
            float volume = audible ? state.baseVolume * gain : 0f;
            player.setVolume(volume, volume);
        } catch (Exception ignored) { }
    }

    private static void ensureTimelineAutomationTick() {
        if (sTimelineAutomationScheduled) return;
        sTimelineAutomationScheduled = true;
        sPlaybackHandler.post(sTimelineAutomationTick);
    }

    /** Play timeline blocks at beat offsets without blocking the Cocos thread. */
    public static synchronized void playTimeline(String blocksJson, int requestedBpm) {
        stopAudioFiles();
        final int generation = ++sPlaybackGeneration;
        final int bpm = Math.max(20, Math.min(320, requestedBpm));
        try {
            org.json.JSONArray blocks = new org.json.JSONArray(blocksJson == null ? "[]" : blocksJson);
            for (int i = 0; i < blocks.length(); i++) {
                final org.json.JSONObject block = blocks.optJSONObject(i);
                if (block == null || block.optString("path", "").isEmpty()) continue;
                String trackId = block.optString("trackId", "");
                if (!trackId.isEmpty() && !sTimelineTrackAudible.containsKey(trackId)) {
                    sTimelineTrackAudible.put(trackId, block.optBoolean("trackAudible", true));
                }
                long delayMs = Math.max(0, Math.round(block.optDouble("startBeat", 0) * 60000.0 / bpm));
                Runnable scheduled = () -> {
                    synchronized (NativeBridge.class) {
                        if (generation != sPlaybackGeneration) return;
                        startTimelinePlayer(block, generation);
                    }
                };
                sScheduledPlayback.add(scheduled);
                sPlaybackHandler.postDelayed(scheduled, delayMs);
            }
        } catch (Exception error) {
            Log.e(TAG, "playTimeline failed", error);
            stopAudioFiles();
        }
    }

    private static void startTimelinePlayer(org.json.JSONObject block, int generation) {
        MediaPlayer player = new MediaPlayer();
        try {
            player.setDataSource(block.optString("path", ""));
            player.setLooping(false);
            player.setOnErrorListener((failed, what, extra) -> {
                synchronized (NativeBridge.class) {
                    sClipPlayers.remove(failed);
                    sTimelinePlayers.remove(failed);
                    try { failed.reset(); } catch (Exception ignored) { }
                    try { failed.release(); } catch (Exception ignored) { }
                }
                Log.e(TAG, "timeline MediaPlayer error: " + what + "/" + extra);
                return true;
            });
            player.setOnCompletionListener(p -> {
                synchronized (NativeBridge.class) {
                    try { p.release(); } catch (Exception ignored) { }
                    sClipPlayers.remove(p);
                    sTimelinePlayers.remove(p);
                }
            });
            player.setOnPreparedListener(prepared -> {
                synchronized (NativeBridge.class) {
                    if (generation != sPlaybackGeneration) {
                        sClipPlayers.remove(prepared);
                        sTimelinePlayers.remove(prepared);
                        try { prepared.release(); } catch (Exception ignored) { }
                        return;
                    }
                    float volume = Math.max(0f, Math.min(1f, (float) block.optDouble("volume", 1)));
                    String trackId = block.optString("trackId", "");
                    float speed = Math.max(.25f, Math.min(4f, (float) block.optDouble("speed", 1)));
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M && Math.abs(speed - 1f) > .001f) {
                        try { prepared.setPlaybackParams(prepared.getPlaybackParams().setSpeed(speed)); } catch (Exception ignored) { }
                    }
                    long startMs = Math.max(0, Math.round(block.optDouble("trimStart", 0) * 1000));
                    long requestedEnd = Math.round(block.optDouble("trimEnd", 0) * 1000);
                    long endMs = requestedEnd > startMs ? Math.min(requestedEnd, prepared.getDuration()) : prepared.getDuration();
                    long playMs = Math.max(1, Math.round((endMs - startMs) / speed));
                    TimelinePlayerState state = new TimelinePlayerState(trackId, volume, timelineAutomation(block), startMs, endMs);
                    sTimelinePlayers.put(prepared, state);
                    applyTimelinePlayerVolume(prepared, state);
                    ensureTimelineAutomationTick();
                    Runnable begin = () -> beginPreparedTimelinePlayer(prepared, generation, endMs, playMs);
                    if (startMs > 0) {
                        prepared.setOnSeekCompleteListener(seeked -> begin.run());
                        prepared.seekTo((int) Math.min(startMs, Integer.MAX_VALUE));
                    } else begin.run();
                }
            });
            sClipPlayers.add(player);
            player.prepareAsync();
        } catch (Exception error) {
            sClipPlayers.remove(player);
            sTimelinePlayers.remove(player);
            try { player.release(); } catch (Exception ignored) { }
            Log.e(TAG, "timeline block failed", error);
        }
    }

    private static void beginPreparedTimelinePlayer(MediaPlayer player, int generation, long endMs, long playMs) {
        synchronized (NativeBridge.class) {
            if (generation != sPlaybackGeneration || !sClipPlayers.contains(player)) return;
            try { player.start(); } catch (Exception error) {
                sClipPlayers.remove(player);
                sTimelinePlayers.remove(player);
                try { player.release(); } catch (Exception ignored) { }
                Log.e(TAG, "timeline start failed", error);
                return;
            }
            if (endMs < player.getDuration()) {
                Runnable stop = () -> {
                    synchronized (NativeBridge.class) {
                        if (generation != sPlaybackGeneration || !sClipPlayers.remove(player)) return;
                        sTimelinePlayers.remove(player);
                        try { player.pause(); } catch (Exception ignored) { }
                        try { player.release(); } catch (Exception ignored) { }
                    }
                };
                sScheduledPlayback.add(stop);
                sPlaybackHandler.postDelayed(stop, playMs);
            }
        }
    }

    public static synchronized void setTimelineTrackAudibility(String statesJson) {
        try {
            org.json.JSONObject states = new org.json.JSONObject(statesJson == null ? "{}" : statesJson);
            java.util.Iterator<String> keys = states.keys();
            while (keys.hasNext()) {
                String trackId = keys.next();
                sTimelineTrackAudible.put(trackId, states.optBoolean(trackId, true));
            }
            for (Map.Entry<MediaPlayer, TimelinePlayerState> entry : sTimelinePlayers.entrySet()) {
                TimelinePlayerState state = entry.getValue();
                applyTimelinePlayerVolume(entry.getKey(), state);
            }
        } catch (Exception error) {
            Log.e(TAG, "setTimelineTrackAudibility failed", error);
        }
    }

    /** 停止所有录音片段播放。 */
    public static synchronized void stopAudioFiles() {
        sPlaybackGeneration++;
        if (sLoopRestart != null) sPlaybackHandler.removeCallbacks(sLoopRestart);
        for (Runnable scheduled : sScheduledPlayback) sPlaybackHandler.removeCallbacks(scheduled);
        sScheduledPlayback.clear();
        sLoopRestart = null;
        sPlaybackHandler.removeCallbacks(sTimelineAutomationTick);
        sTimelineAutomationScheduled = false;
        for (MediaPlayer player : sClipPlayers) {
            try { player.stop(); } catch (Exception ignored) { }
            try { player.release(); } catch (Exception ignored) { }
        }
        sClipPlayers.clear();
        sTimelinePlayers.clear();
        sTimelineTrackAudible.clear();
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

    /** 保存逐像素反色的启动幕布，供导出进度从左向右揭示。 */
    public static String saveInvertedSplashImage(String base64Data) {
        if (sActivity == null || base64Data == null || base64Data.isEmpty()) return "";
        try {
            byte[] data = android.util.Base64.decode(base64Data, android.util.Base64.DEFAULT);
            Bitmap source = BitmapFactory.decodeByteArray(data, 0, data.length);
            if (source == null) return "";
            Bitmap inverted = Bitmap.createBitmap(source.getWidth(), source.getHeight(), Bitmap.Config.ARGB_8888);
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            paint.setColorFilter(new ColorMatrixColorFilter(new ColorMatrix(new float[]{
                    -1, 0, 0, 0, 255,
                    0, -1, 0, 0, 255,
                    0, 0, -1, 0, 255,
                    0, 0, 0, 1, 0
            })));
            new Canvas(inverted).drawBitmap(source, 0, 0, paint);
            File file = new File(sActivity.getCacheDir(), "cm_splash_inverted.jpg");
            FileOutputStream output = new FileOutputStream(file);
            inverted.compress(Bitmap.CompressFormat.JPEG, 94, output); output.flush(); output.close();
            source.recycle(); inverted.recycle(); return file.getAbsolutePath();
        } catch (Exception error) { Log.e(TAG, "saveInvertedSplashImage failed", error); return ""; }
    }

    /* ---------------- 图片选择结果（主线程回调） ---------------- */

    /** 由 AppActivity.onActivityResult 调用。 */
    public static void onActivityResult(Activity activity, int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_CHOOSE_SAVE_ROOT) {
            if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
                evalToJs("globalThis.__colormusic_onSaveRootChosen && globalThis.__colormusic_onSaveRootChosen('');");
                return;
            }
            handleSaveRootSelection(activity, data);
            return;
        }
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

    private static void handleSaveRootSelection(Activity activity, Intent data) {
        Uri treeUri = data.getData();
        try {
            int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            activity.getContentResolver().takePersistableUriPermission(treeUri, flags);
            String selectedId = DocumentsContract.getTreeDocumentId(treeUri);
            String selectedName = documentDisplayName(DocumentsContract.buildDocumentUriUsingTree(treeUri, selectedId));
            String rootId = selectedId;
            if (!SAVE_ROOT_NAME.equalsIgnoreCase(selectedName)) {
                rootId = findChildDocumentId(treeUri, selectedId, SAVE_ROOT_NAME);
                if (rootId == null) {
                    Uri created = DocumentsContract.createDocument(activity.getContentResolver(),
                            DocumentsContract.buildDocumentUriUsingTree(treeUri, selectedId),
                            DocumentsContract.Document.MIME_TYPE_DIR, SAVE_ROOT_NAME);
                    if (created == null) throw new IOException("无法创建 Neuro_Save");
                    rootId = DocumentsContract.getDocumentId(created);
                }
            }
            activity.getSharedPreferences(SAVE_PREFS, Activity.MODE_PRIVATE).edit()
                    .putString(SAVE_TREE_URI, treeUri.toString()).putString(SAVE_ROOT_DOCUMENT, rootId).apply();
            managedCategory("style", true); managedCategory("flow", true); managedCategory("track", true); managedCategory("audio", true);
            evalToJs("globalThis.__colormusic_onSaveRootChosen && globalThis.__colormusic_onSaveRootChosen("
                    + org.json.JSONObject.quote(getSaveRootLabel()) + ");");
        } catch (Exception error) {
            Log.e(TAG, "handleSaveRootSelection failed", error);
            evalToJs("globalThis.__colormusic_onSaveRootChosen && globalThis.__colormusic_onSaveRootChosen('');");
        }
    }

    private static String documentDisplayName(Uri uri) {
        Cursor cursor = null;
        try {
            cursor = sActivity.getContentResolver().query(uri, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null);
            return cursor != null && cursor.moveToFirst() ? cursor.getString(0) : "";
        } catch (Exception ignored) { return ""; }
        finally { if (cursor != null) cursor.close(); }
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
