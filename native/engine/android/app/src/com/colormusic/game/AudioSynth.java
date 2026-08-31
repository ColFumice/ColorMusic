package com.colormusic.game;

import android.content.res.AssetManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Process;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * AudioSynth —— 实时音频合成器（方案 A：AudioTrack 流式输出，无需第三方库）。
 *
 * 使用设备原生输出采样率、双声道 16bit PCM，独立高优先级线程按小块低延迟输出。
 *
 * 音色模型（ARGB 四通道 → 音色）：
 *   R 通道 → 弦乐声部（锯齿波 + 低通 + 慢起音 + 颤音），增益 = r/255；
 *   G 通道 → 笛声部（正弦 + 少量第二谐波 + 起音呼吸噪声），增益 = g/255；
 *   B 通道 → 钢琴/铃声部（基频 + 0.5×2 倍频 + 0.25×3 倍频，快起音 + 指数衰减），增益 = b/255；
 *   RGB 平均值 avg → 全局质感：低通截止 18000-avg*17000、失真 tanh(avg*0.3)、噪声混合 avg*0.15；
 *   Alpha → 演奏表情：attack = lerp(0.2, 0.005, alpha)、回声量 = 1-alpha（JPEG 恒 255 → 干、快起音）。
 * 自适应归一化：sum = r+g+b > 1 时整体 ×1/sum，保证不同颜色响度平衡。
 *
 * 持续音：noteOn 创建/原位更新一个持续音符（滑音保持相位连续），noteOff 释放。
 * 最大复音数默认 8，超出时让最旧音符快速平滑退场。
 */
public class AudioSynth {

    private static final String TAG = "ColorMusicSynth";
    private static final int SAMPLE_RATE = resolveOutputSampleRate();
    private static final int CHANNEL_MASK = AudioFormat.CHANNEL_OUT_STEREO;
    private static final int BYTES_PER_FRAME = 4;
    /** 128 帧在 48kHz 下约 2.7ms，缩短触摸到下一次送入 AudioTrack 的等待。 */
    private static final int CHUNK = 128;
    private static final int MAX_VOICES_DEFAULT = 8;
    /** 再短的点击也至少合成这一段，避免 noteOn/noteOff 落在同一音频块时完全无声。 */
    private static final int MIN_TAP_SAMPLES = Math.max(1, SAMPLE_RATE * 12 / 1000);
    /** 末端使用约 8ms 的平滑窗，保证最后一个 PCM 采样精确回到零。 */
    private static final int DECLICK_SAMPLES = Math.max(2, SAMPLE_RATE * 8 / 1000);
    /** 复音增加时平滑预留峰值余量，避免同相波形叠加后进入非线性失真。 */
    private static final float MIX_GAIN_ATTACK = (float) (1.0 - Math.exp(-1.0 / (0.006 * SAMPLE_RATE)));
    private static final float MIX_GAIN_RELEASE = (float) (1.0 - Math.exp(-1.0 / (0.150 * SAMPLE_RATE)));
    private static final float LIMITER_CEILING = 0.92f;
    private static final float LIMITER_RELEASE_PER_BLOCK =
            (float) (1.0 - Math.exp(-CHUNK / (0.120 * SAMPLE_RATE)));
    /** 波表长度（单周期采样点数）。 */
    public static final int WAVE_N = 256;

    private static int resolveOutputSampleRate() {
        try {
            int nativeRate = AudioTrack.getNativeOutputSampleRate(AudioManager.STREAM_MUSIC);
            if (nativeRate >= 8000 && nativeRate <= 192000) return nativeRate;
        } catch (Exception ignored) { }
        return 48000;
    }
    /** 单个通道的波形与周期倍率必须一起替换，音频线程才能始终读到一致状态。 */
    private static final class WavetableState {
        final float[] samples;
        final float cycles;
        WavetableState(float[] samples, float cycles) {
            this.samples = samples;
            this.cycles = cycles;
        }
    }
    /** 三个通道的波表状态（0=R弦乐、1=G笛、2=B钢琴/铃）。 */
    private static volatile WavetableState[] wavetableStates = new WavetableState[3];

    private static final class DrumSample {
        final float[] samples;
        final int sampleRate;
        DrumSample(float[] samples, int sampleRate) {
            this.samples = samples;
            this.sampleRate = sampleRate;
        }
    }

    private static final class ChannelDrumState {
        final String id;
        final float volume;
        final float speed;
        ChannelDrumState(String id, float volume, float speed) {
            this.id = id;
            this.volume = volume;
            this.speed = speed;
        }
        boolean enabled() { return id != null && !"none".equals(id); }
    }

    private static volatile Map<String, DrumSample> drumSamples = Collections.emptyMap();
    private static volatile ChannelDrumState[] channelDrumStates = new ChannelDrumState[] {
            new ChannelDrumState("none", 1f, 1f), new ChannelDrumState("none", 1f, 1f),
            new ChannelDrumState("none", 1f, 1f)
    };
    private static final String[] DRUM_SAMPLE_IDS = new String[] {
            "tr808_kick", "tr808_snare", "tr808_hat", "tr909_kick", "tr909_snare", "tr909_hat",
            "tr606_kick", "tr606_snare", "tr606_hat", "acoustic_kick", "acoustic_snare", "acoustic_hat",
            "boombap_kick", "boombap_snare", "boombap_clap", "trap_kick", "trap_snare", "trap_hat",
            "lofi_kick", "lofi_snare", "lofi_hat"
    };

    static {
        for (int ch = 0; ch < 3; ch++) {
            float[] samples = new float[WAVE_N];
            for (int i = 0; i < WAVE_N; i++) {
                samples[i] = (float) Math.sin(2.0 * Math.PI * i / WAVE_N);
            }
            wavetableStates[ch] = new WavetableState(samples, 1f);
        }
    }

    /** 设置通道单周期波表及其周期倍率；整行一次替换，避免音频线程读到半更新波形。 */
    public static void setWavetable(int channel, float[] wave, float cycles) {
        if (channel < 0 || channel > 2 || wave == null || wave.length == 0) return;
        int n = Math.min(wave.length, WAVE_N);
        float[] row = new float[WAVE_N];
        for (int i = 0; i < WAVE_N; i++) row[i] = wave[i % n];
        float safeCycles = Float.isNaN(cycles) ? 1f : Math.max(1f, Math.min(8f, cycles));
        WavetableState[] next = wavetableStates.clone();
        next[channel] = new WavetableState(row, safeCycles);
        wavetableStates = next;
        Log.i(TAG, "setWavetable ch=" + channel + " n=" + n + " cycles=" + safeCycles);
    }

    public static void setChannelDrum(int channel, String id, float volume, float speed) {
        if (channel < 0 || channel > 2) return;
        String safeId = id == null ? "none" : id;
        float safeVolume = Float.isNaN(volume) ? 1f : Math.max(0f, Math.min(1.25f, volume));
        float safeSpeed = Float.isNaN(speed) ? 1f : Math.max(.5f, Math.min(2f, speed));
        ChannelDrumState[] next = channelDrumStates.clone();
        next[channel] = new ChannelDrumState(safeId, safeVolume, safeSpeed);
        channelDrumStates = next;
        Log.i(TAG, "setChannelDrum ch=" + channel + " id=" + safeId + " volume=" + safeVolume + " speed=" + safeSpeed);
    }

    /** Decode bundled one-shot WAV assets before the real-time audio thread starts. */
    public void loadDrumSamples(AssetManager assets) {
        if (assets == null || !drumSamples.isEmpty()) return;
        Map<String, DrumSample> loaded = new HashMap<>();
        for (String id : DRUM_SAMPLE_IDS) {
            try (InputStream in = assets.open("drums/" + id + ".wav")) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] block = new byte[16384];
                int read;
                while ((read = in.read(block)) >= 0) if (read > 0) out.write(block, 0, read);
                DrumSample sample = decodeWav(out.toByteArray());
                if (sample != null) loaded.put(id, sample);
            } catch (Exception e) {
                Log.e(TAG, "Unable to load drum sample " + id, e);
            }
        }
        drumSamples = Collections.unmodifiableMap(loaded);
        Log.i(TAG, "Loaded drum samples: " + loaded.size() + "/" + DRUM_SAMPLE_IDS.length);
    }

    private static DrumSample decodeWav(byte[] bytes) {
        if (bytes == null || bytes.length < 44 || le32(bytes, 0) != 0x46464952 || le32(bytes, 8) != 0x45564157) return null;
        int format = 1, channels = 1, sourceRate = SAMPLE_RATE, bits = 16, dataOffset = -1, dataSize = 0;
        int offset = 12;
        while (offset + 8 <= bytes.length) {
            int chunkId = le32(bytes, offset);
            int chunkSize = le32(bytes, offset + 4);
            int body = offset + 8;
            if (chunkSize < 0 || body + chunkSize > bytes.length) break;
            if (chunkId == 0x20746d66 && chunkSize >= 16) {
                format = le16(bytes, body); channels = Math.max(1, le16(bytes, body + 2));
                sourceRate = Math.max(8000, le32(bytes, body + 4)); bits = le16(bytes, body + 14);
            } else if (chunkId == 0x61746164) {
                dataOffset = body; dataSize = chunkSize;
            }
            offset = body + chunkSize + (chunkSize & 1);
        }
        int bytesPerSample = Math.max(1, bits / 8);
        int frameBytes = bytesPerSample * channels;
        if (dataOffset < 0 || dataSize < frameBytes || (format != 1 && format != 3)) return null;
        int frames = dataSize / frameBytes;
        float[] mono = new float[frames];
        for (int frame = 0; frame < frames; frame++) {
            float sum = 0f;
            for (int channel = 0; channel < channels; channel++) {
                int p = dataOffset + frame * frameBytes + channel * bytesPerSample;
                float value;
                if (format == 3 && bits == 32) value = Float.intBitsToFloat(le32(bytes, p));
                else if (bits == 8) value = ((bytes[p] & 255) - 128) / 128f;
                else if (bits == 16) value = (short) le16(bytes, p) / 32768f;
                else if (bits == 24) {
                    int raw = (bytes[p] & 255) | ((bytes[p + 1] & 255) << 8) | ((bytes[p + 2] & 255) << 16);
                    if ((raw & 0x800000) != 0) raw |= 0xff000000;
                    value = raw / 8388608f;
                } else if (bits == 32) value = le32(bytes, p) / 2147483648f;
                else return null;
                sum += value;
            }
            mono[frame] = Math.max(-1f, Math.min(1f, sum / channels));
        }
        return new DrumSample(mono, sourceRate);
    }

    private static int le16(byte[] bytes, int offset) {
        return (bytes[offset] & 255) | ((bytes[offset + 1] & 255) << 8);
    }

    private static int le32(byte[] bytes, int offset) {
        return (bytes[offset] & 255) | ((bytes[offset + 1] & 255) << 8)
                | ((bytes[offset + 2] & 255) << 16) | ((bytes[offset + 3] & 255) << 24);
    }

    private static float oneShot(String id, int elapsed, float speed) {
        DrumSample sample = drumSamples.get(id);
        if (sample == null || sample.samples.length == 0) return 0f;
        double position = elapsed * Math.max(.5f, Math.min(2f, speed)) * sample.sampleRate / SAMPLE_RATE;
        int i0 = (int) position;
        if (i0 < 0 || i0 >= sample.samples.length) return 0f;
        int i1 = Math.min(sample.samples.length - 1, i0 + 1);
        float fraction = (float) (position - i0);
        return sample.samples[i0] + (sample.samples[i1] - sample.samples[i0]) * fraction;
    }

    /** 波表读取：相位 0~1 → 波形采样（线性插值）。 */
    private static float wt(int ch, double ph) {
        WavetableState state = wavetableStates[ch];
        double scaledPhase = ph * state.cycles;
        return sampleWavetable(state.samples, scaledPhase);
    }

    /** 混色时忽略各通道周期倍率，让 RGB 波形在同一基频上融合为一个音色。 */
    private static float wtPitchLocked(int ch, double ph) {
        return sampleWavetable(wavetableStates[ch].samples, ph);
    }

    private static float sampleWavetable(float[] samples, double ph) {
        double scaledPhase = ph;
        double f = (scaledPhase - Math.floor(scaledPhase)) * WAVE_N;
        int i0 = (int) f;
        int i1 = (i0 + 1) % WAVE_N;
        float a = samples[i0];
        float b = samples[i1];
        return a + (float) (f - i0) * (b - a);
    }

    /**
     * 对平板扬声器和人耳的频率敏感度做温和补偿，使同一网格行的旋律声部保持接近的感知响度。
     * 只作用于 RGB 旋律声部，不作用于不随音高变化的黑/白鼓。
     */
    private static float pitchLoudnessGain(float freq) {
        double safeFreq = Math.max(55.0, Math.min(4200.0, freq));
        double gain = Math.pow(440.0 / safeFreq, 0.25);
        return (float) Math.max(0.72, Math.min(1.65, gain));
    }

    /**
     * 小扬声器难以重放低频基音；在 220Hz 以下平滑加入少量 2/3 次谐波，
     * 通过缺失基频效应保留原音高感，同时提升可听存在感。
     */
    private static float lowPitchPresence(float freq) {
        double safeFreq = Math.max(55.0, freq);
        double octavesBelow = Math.log(220.0 / safeFreq) / Math.log(2.0);
        return (float) Math.max(0.0, Math.min(1.0, octavesBelow / 1.75));
    }

    /* ---------------- 效果器插件槽位（8 个触发槽 + RGB 各 4 个全局槽） ---------------- */

    public static final int FX_SLOTS = 20;
    /** 0..7 为带触发条件的槽位；8..19 为 RGB 各 4 个全局槽。 */
    public static final int FX_TRIGGERED = 8;
    public static final int FX_GLOBAL_BASE = 8;
    public static final int FX_GLOBAL_COUNT = 3;
    public static final int FX_GLOBAL_PER_CHANNEL = 4;
    public static final int OUTPUT_FX_SLOTS = 4;

    /** 一个槽位的插件配置。 */
    private static final class FxState {
        String id = "none";
        boolean invert = false;
        float intensity = 0.5f;
        float[] params = new float[2];  // 由插件 id 决定的语义参数（0..2 个）
        float[] curve = new float[0];   // EQ(16 点)/ADSR(32 点) 绘制曲线
    }

    private static volatile FxState[] fxSlots;
    private static volatile FxState[] outputFxSlots;
    private static volatile int outputFxVersion = 1;

    /** 黑鼓（RGB 全 <55）/ 白鼓（RGB 全 >200）的采样 id。 */
    private static volatile String drumBlack = "tr808_kick";
    private static volatile String drumWhite = "tr808_snare";

    /** 设置黑鼓/白鼓元素（808 鼓组：kick/snare/clap/hihat/tom/maracas）。 */
    public static void setDrumIds(String black, String white) {
        if (black != null) drumBlack = black;
        if (white != null) drumWhite = white;
    }

    static {
        fxSlots = new FxState[FX_SLOTS];
        for (int i = 0; i < FX_SLOTS; i++) fxSlots[i] = new FxState();
        outputFxSlots = new FxState[OUTPUT_FX_SLOTS];
        for (int i = 0; i < OUTPUT_FX_SLOTS; i++) outputFxSlots[i] = new FxState();
    }

    /** 设置全部效果器槽位（JSON 数组：[{id,invert,intensity,params,curve}×8]）。 */
    public static void setEffectSlots(String json) {
        try {
            org.json.JSONArray arr = new org.json.JSONArray(json);
            FxState[] next = new FxState[FX_SLOTS];
            for (int i = 0; i < FX_SLOTS; i++) {
                FxState st = new FxState();
                if (i < arr.length()) {
                    org.json.JSONObject o = arr.optJSONObject(i);
                    if (o != null) {
                        st.id = o.optString("id", "none");
                        st.invert = o.optInt("invert", 0) != 0;
                        st.intensity = Math.max(0f, Math.min(1f, (float) o.optDouble("intensity", 0.5)));
                        st.params = paramsToArray(st.id, o.optJSONObject("params"));
                        org.json.JSONArray c = o.optJSONArray("curve");
                        if (c != null && c.length() > 4) {
                            float[] cv = new float[c.length()];
                            for (int j = 0; j < cv.length; j++) cv[j] = (float) Math.max(0, Math.min(1, c.optDouble(j, 0)));
                            st.curve = cv;
                        }
                    }
                }
                next[i] = st;
            }
            fxSlots = next;
            Log.i(TAG, "setEffectSlots ok");
        } catch (Exception e) {
            Log.e(TAG, "setEffectSlots failed", e);
        }
    }

    /** 设置最终输出效果链（RGB 与各自效果器合成之后再串联处理）。 */
    public static void setOutputEffectSlots(String json) {
        try {
            org.json.JSONArray arr = new org.json.JSONArray(json);
            FxState[] next = new FxState[OUTPUT_FX_SLOTS];
            for (int i = 0; i < OUTPUT_FX_SLOTS; i++) {
                FxState st = new FxState();
                if (i < arr.length()) {
                    org.json.JSONObject o = arr.optJSONObject(i);
                    if (o != null) {
                        st.id = o.optString("id", "none");
                        st.invert = o.optInt("invert", 0) != 0;
                        st.intensity = Math.max(0f, Math.min(1f, (float) o.optDouble("intensity", 0.5)));
                        st.params = paramsToArray(st.id, o.optJSONObject("params"));
                        org.json.JSONArray c = o.optJSONArray("curve");
                        if (c != null && c.length() > 4) {
                            st.curve = new float[c.length()];
                            for (int j = 0; j < st.curve.length; j++) st.curve[j] = (float) Math.max(0, Math.min(1, c.optDouble(j, 0)));
                        }
                    }
                }
                next[i] = st;
            }
            outputFxSlots = next;
            outputFxVersion++;
            Log.i(TAG, "setOutputEffectSlots ok");
        } catch (Exception e) {
            Log.e(TAG, "setOutputEffectSlots failed", e);
        }
    }

    /** 插件参数对象 → 固定语义数组 [p0, p1]。 */
    private static float[] paramsToArray(String id, org.json.JSONObject p) {
        float[] out = new float[2];
        if (p == null) return out;
        switch (id) {
            case "psy": case "liquid": out[0] = (float) p.optDouble("rate", 8); break;
            case "glitch": out[0] = (float) p.optDouble("duty", 0.5); break;
            case "pulse": out[0] = (float) p.optDouble("freq", 55); break;
            case "reese": out[0] = (float) p.optDouble("detune", 1.2); break;
            case "laser": out[0] = (float) p.optDouble("sweep", 1.6); break;
            case "filter": out[0] = (float) p.optDouble("mix", 1); break;
            case "env":
                out[0] = (float) p.optDouble("atkT", 0.1);
                out[1] = (float) p.optDouble("relT", 0.3);
                break;
            case "reverb": out[0] = (float) p.optDouble("size", 0.5); break;
            case "delay":
                out[0] = (float) p.optDouble("time", 0.18);
                out[1] = (float) p.optDouble("feedback", 0.4);
                break;
            case "chorus":
                out[0] = (float) p.optDouble("rate", 0.8);
                out[1] = (float) p.optDouble("depth", 0.3);
                break;
            case "compressor":
                out[0] = (float) p.optDouble("threshold", -18);
                out[1] = (float) p.optDouble("ratio", 4);
                break;
            case "air":
                out[0] = (float) p.optDouble("amount", 0.08);
                out[1] = (float) p.optDouble("tone", 0.55);
                break;
            default: break;
        }
        return out;
    }

    private AudioTrack track;
    private final List<Voice> voices = new ArrayList<>();
    private final Object voiceLock = new Object();
    private Thread renderThread;
    private volatile boolean running = false;
    private volatile int maxVoices = MAX_VOICES_DEFAULT;
    private final Voice.FxChain outputChain = new Voice.FxChain();
    private int appliedOutputFxVersion = 0;
    private long outputSampleClock = 0;
    private float voiceBusGain = 1f;
    private float outputLimiterGain = 1f;
    private final Object recordingLock = new Object();
    private BufferedOutputStream recordingStream;
    private File recordingFile;
    private long recordingBytes;
    /** 多指持续音：touchId → 持续音符（支持合奏） */
    private final java.util.Map<Integer, Voice> sustainedVoices = new java.util.HashMap<>();

    /** 启动渲染线程与 AudioTrack。 */
    public synchronized void start() {
        if (running) return;
        synchronized (voiceLock) {
            voices.clear();
            sustainedVoices.clear();
        }
        outputChain.setFx(new Voice.ActiveFx[0]);
        appliedOutputFxVersion = 0;
        outputSampleClock = 0;
        voiceBusGain = 1f;
        outputLimiterGain = 1f;
        try {
            track = createTrack();
            track.play();
        } catch (Exception e) {
            Log.e(TAG, "AudioTrack init failed", e);
            return;
        }
        running = true;
        renderThread = new Thread(this::renderLoop, "ColorMusicAudio");
        renderThread.setPriority(Thread.MAX_PRIORITY);
        renderThread.start();
        Log.i(TAG, "AudioSynth started");
    }

    /** 停止渲染线程并释放 AudioTrack。 */
    public synchronized void stop() {
        stopRecording();
        running = false;
        Thread t = renderThread;
        renderThread = null;
        if (t != null) {
            try { t.join(300); } catch (InterruptedException ignored) { }
        }
        synchronized (voiceLock) {
            voices.clear();
            sustainedVoices.clear();
        }
        if (track != null) {
            try {
                track.pause();
                track.flush();
                track.release();
            } catch (Exception ignored) { }
            track = null;
        }
    }

    /** 短音符（点按）。第 4 个 int 为 Alpha（0~255）。任意线程可调用。 */
    public void playNote(int r, int g, int b, int alpha, float freq, float volume, float durationMs) {
        if (!running) return;
        Voice v = new Voice(r, g, b, alpha, freq, volume, durationMs, false);
        synchronized (voiceLock) {
            dampReleasedRetrigger(freq);
            if (activeVoiceCount() >= maxVoices) {
                stealOldest();
            }
            voices.add(v);
        }
    }

    /** 持续音开始/原位更新（多指：按 touchId 区分；滑音更新频率/音色/音量，相位连续）。第 5 个 int 为 Alpha。 */
    public void noteOn(int touchId, int r, int g, int b, int alpha, float freq, float volume) {
        if (!running) return;
        synchronized (voiceLock) {
            Voice v = sustainedVoices.get(touchId);
            if (v != null) {
                v.updateParams(r, g, b, alpha, freq, volume);
                return;
            }
            dampReleasedRetrigger(freq);
            if (activeVoiceCount() >= maxVoices) {
                stealOldest();
            }
            Voice nv = new Voice(r, g, b, alpha, freq, volume, 0f, true);
            sustainedVoices.put(touchId, nv);
            voices.add(nv);
        }
    }

    /** 释放指定 touchId 的持续音。 */
    public void noteOff(int touchId) {
        if (!running) return;
        synchronized (voiceLock) {
            Voice v = sustainedVoices.remove(touchId);
            if (v != null) {
                v.release();
            }
        }
    }

    /** 播放默认测试音（中等混合色 + 不透明）。 */
    public void playTestNote() {
        playNote(150, 180, 210, 255, 523.25f, 0.7f, 300f);
    }

    public void setMaxVoices(int n) {
        maxVoices = Math.max(1, Math.min(16, n));
    }

    public boolean isRunning() {
        return running;
    }

    /** 将最终输出 PCM 录制为标准 WAV，返回文件路径；写入发生在音频线程，保持与实际听感一致。 */
    public String startRecording(File directory, String fileName) {
        if (directory == null) return "";
        synchronized (recordingLock) {
            stopRecordingLocked();
            try {
                if (!directory.exists() && !directory.mkdirs()) return "";
                recordingFile = new File(directory, fileName);
                recordingStream = new BufferedOutputStream(new FileOutputStream(recordingFile), 32768);
                writeWavHeader(recordingStream, 0);
                recordingBytes = 0;
                Log.i(TAG, "recording started: " + recordingFile.getAbsolutePath());
                return recordingFile.getAbsolutePath();
            } catch (Exception e) {
                Log.e(TAG, "startRecording failed", e);
                stopRecordingLocked();
                return "";
            }
        }
    }

    /** 停止录音并回填 WAV 长度字段，返回已完成文件路径。 */
    public String stopRecording() {
        synchronized (recordingLock) {
            return stopRecordingLocked();
        }
    }

    private String stopRecordingLocked() {
        if (recordingStream == null) return recordingFile == null ? "" : recordingFile.getAbsolutePath();
        final File done = recordingFile;
        try {
            recordingStream.flush();
            recordingStream.close();
            if (done != null) patchWavHeader(done, recordingBytes);
        } catch (Exception e) {
            Log.e(TAG, "stopRecording failed", e);
        } finally {
            recordingStream = null;
            recordingFile = null;
            recordingBytes = 0;
        }
        Log.i(TAG, "recording stopped: " + (done == null ? "" : done.getAbsolutePath()));
        return done == null ? "" : done.getAbsolutePath();
    }

    private static void writeWavHeader(java.io.OutputStream out, long dataBytes) throws java.io.IOException {
        byte[] h = new byte[44];
        h[0] = 'R'; h[1] = 'I'; h[2] = 'F'; h[3] = 'F';
        putLe32(h, 4, 36 + dataBytes);
        h[8] = 'W'; h[9] = 'A'; h[10] = 'V'; h[11] = 'E';
        h[12] = 'f'; h[13] = 'm'; h[14] = 't'; h[15] = ' ';
        putLe32(h, 16, 16); putLe16(h, 20, (short) 1); putLe16(h, 22, (short) 2);
        putLe32(h, 24, SAMPLE_RATE); putLe32(h, 28, SAMPLE_RATE * BYTES_PER_FRAME);
        putLe16(h, 32, (short) BYTES_PER_FRAME); putLe16(h, 34, (short) 16);
        h[36] = 'd'; h[37] = 'a'; h[38] = 't'; h[39] = 'a'; putLe32(h, 40, dataBytes);
        out.write(h);
    }

    private static void patchWavHeader(File file, long dataBytes) throws java.io.IOException {
        RandomAccessFile raf = new RandomAccessFile(file, "rw");
        raf.seek(4); raf.write(intLe(36 + dataBytes));
        raf.seek(40); raf.write(intLe(dataBytes));
        raf.close();
    }

    private static byte[] intLe(long value) {
        byte[] b = new byte[4]; putLe32(b, 0, value); return b;
    }
    private static void putLe16(byte[] b, int off, short value) {
        b[off] = (byte) (value & 255); b[off + 1] = (byte) ((value >> 8) & 255);
    }
    private static void putLe32(byte[] b, int off, long value) {
        b[off] = (byte) (value & 255); b[off + 1] = (byte) ((value >> 8) & 255);
        b[off + 2] = (byte) ((value >> 16) & 255); b[off + 3] = (byte) ((value >> 24) & 255);
    }

    private int activeVoiceCount() {
        int count = 0;
        for (Voice v : voices) if (!v.isDeClicking()) count++;
        return count;
    }

    /** 同音高再次触发时，只快速收掉已释放/非持续的旧尾音，保留真正的多指持续合奏。 */
    private void dampReleasedRetrigger(float freq) {
        for (Voice voice : voices) {
            if (!voice.isSustained() && voice.matchesPitch(freq)) voice.deClickStop();
        }
    }

    private void stealOldest() {
        Voice victim = null;
        // 优先让最旧的非持续音退场，再考虑仍被按住的持续音。
        for (Voice v : voices) {
            if (!v.isDeClicking() && !v.isSustained()) {
                victim = v;
                break;
            }
        }
        if (victim == null) {
            for (Voice v : voices) {
                if (!v.isDeClicking()) {
                    victim = v;
                    break;
                }
            }
        }
        if (victim == null) return;

        victim.deClickStop();
        final Voice retired = victim;
        sustainedVoices.entrySet().removeIf(entry -> entry.getValue() == retired);
    }

    /* ---------------- 渲染循环 ---------------- */

    private void renderLoop() {
        android.os.Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        float[] mixBuf = new float[CHUNK];
        float[] outputBuf = new float[CHUNK];
        short[] stereoBuf = new short[CHUNK * 2];
        while (running) {
            int mixedVoiceCount;
            synchronized (voiceLock) {
                java.util.Arrays.fill(mixBuf, 0f);
                mixedVoiceCount = 0;
                for (Voice v : voices) {
                    if (v.remaining > 0) mixedVoiceCount++;
                    v.render(mixBuf, CHUNK);
                }
                // 清理已结束的音符（释放后的持续音符 remaining 会递减到 0）
                voices.removeIf(v -> v.remaining <= 0);
            }
            syncOutputFx();
            float targetVoiceGain = 1f / (float) Math.sqrt(Math.max(1, mixedVoiceCount));
            float peak = 0f;
            for (int i = 0; i < CHUNK; i++) {
                float smoothing = targetVoiceGain < voiceBusGain ? MIX_GAIN_ATTACK : MIX_GAIN_RELEASE;
                voiceBusGain += (targetVoiceGain - voiceBusGain) * smoothing;
                float dry = mixBuf[i] * voiceBusGain;
                float wet = outputChain.process(dry, 440.0 / SAMPLE_RATE, outputSampleClock / (float) SAMPLE_RATE);
                if (Float.isNaN(wet) || Float.isInfinite(wet)) wet = 0f;
                outputBuf[i] = wet;
                peak = Math.max(peak, Math.abs(wet));
                outputSampleClock++;
            }
            float targetLimiterGain = peak > LIMITER_CEILING ? LIMITER_CEILING / peak : 1f;
            if (targetLimiterGain < outputLimiterGain) outputLimiterGain = targetLimiterGain;
            else outputLimiterGain += (targetLimiterGain - outputLimiterGain) * LIMITER_RELEASE_PER_BLOCK;
            for (int i = 0; i < CHUNK; i++) {
                float sample = outputBuf[i] * outputLimiterGain;
                sample = Math.max(-LIMITER_CEILING, Math.min(LIMITER_CEILING, sample));
                short pcm = (short) (sample * 32767f);
                stereoBuf[i * 2] = pcm;
                stereoBuf[i * 2 + 1] = pcm;
            }
            writeRecordingChunk(stereoBuf);
            if (track != null) {
                if (Build.VERSION.SDK_INT >= 23) {
                    track.write(stereoBuf, 0, stereoBuf.length, AudioTrack.WRITE_BLOCKING);
                } else {
                    track.write(stereoBuf, 0, stereoBuf.length);
                }
            }
        }
    }

    private void writeRecordingChunk(short[] stereoBuf) {
        synchronized (recordingLock) {
            if (recordingStream == null) return;
            try {
                byte[] bytes = new byte[stereoBuf.length * 2];
                for (int i = 0; i < stereoBuf.length; i++) {
                    short sample = stereoBuf[i];
                    bytes[i * 2] = (byte) (sample & 255);
                    bytes[i * 2 + 1] = (byte) ((sample >> 8) & 255);
                }
                recordingStream.write(bytes);
                recordingBytes += bytes.length;
            } catch (Exception e) {
                Log.e(TAG, "recording write failed", e);
                stopRecordingLocked();
            }
        }
    }

    private void syncOutputFx() {
        int ver = outputFxVersion;
        if (appliedOutputFxVersion == ver) return;
        FxState[] states = outputFxSlots;
        java.util.List<Voice.ActiveFx> list = new java.util.ArrayList<>();
        for (int i = 0; i < Math.min(states.length, OUTPUT_FX_SLOTS); i++) {
            FxState st = states[i];
            if (st == null || "none".equals(st.id)) continue;
            float depth = (st.invert ? 0f : 1f) * Math.max(0f, Math.min(1f, st.intensity));
            if (depth > 0.003f) list.add(new Voice.ActiveFx(st, depth));
        }
        outputChain.setFx(list.toArray(new Voice.ActiveFx[0]));
        appliedOutputFxVersion = ver;
    }

    /* ---------------- AudioTrack 创建 ---------------- */

    private static AudioTrack createTrack() {
        int minBuf = AudioTrack.getMinBufferSize(SAMPLE_RATE,
                CHANNEL_MASK, AudioFormat.ENCODING_PCM_16BIT);
        if (minBuf <= 0) minBuf = CHUNK * BYTES_PER_FRAME * 4;
        // getMinBufferSize 已返回字节数；旧实现又乘 2 且强制约 100ms，导致音频长期排队。
        int lowLatencyBytes = CHUNK * BYTES_PER_FRAME * 4;
        int bufferBytes = Build.VERSION.SDK_INT >= 26 ? lowLatencyBytes : Math.max(minBuf, lowLatencyBytes);
        if (Build.VERSION.SDK_INT >= 23) {
            AudioAttributes.Builder attrsBuilder = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_GAME)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION);
            if (Build.VERSION.SDK_INT >= 26) {
                attrsBuilder.setFlags(AudioAttributes.FLAG_LOW_LATENCY);
            }
            AudioAttributes attrs = attrsBuilder.build();
            AudioFormat fmt = new AudioFormat.Builder()
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(CHANNEL_MASK)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .build();
            AudioTrack.Builder builder = new AudioTrack.Builder()
                    .setAudioAttributes(attrs)
                    .setAudioFormat(fmt)
                    .setBufferSizeInBytes(bufferBytes)
                    .setTransferMode(AudioTrack.MODE_STREAM);
            if (Build.VERSION.SDK_INT >= 26) {
                builder.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY);
            }
            AudioTrack result = builder.build();
            int performanceMode = Build.VERSION.SDK_INT >= 26 ? result.getPerformanceMode() : -1;
            // FastMixer 可用时排队约 10ms；被厂商策略拒绝时使用系统最小稳定缓冲，避免欠载断音。
            int targetFrames = performanceMode == AudioTrack.PERFORMANCE_MODE_LOW_LATENCY
                    ? CHUNK * 4
                    : Math.max(CHUNK * 4, minBuf / BYTES_PER_FRAME);
            result.setBufferSizeInFrames(targetFrames);
            if (Build.VERSION.SDK_INT >= 31) {
                result.setStartThresholdInFrames(Math.min(CHUNK, result.getBufferCapacityInFrames()));
            }
            Log.i(TAG, "AudioTrack rate=" + SAMPLE_RATE
                    + " chunk=" + CHUNK
                    + " minBytes=" + minBuf
                    + " capacityFrames=" + result.getBufferCapacityInFrames()
                    + " bufferFrames=" + result.getBufferSizeInFrames()
                    + " performanceMode=" + performanceMode);
            return result;
        } else {
            @SuppressWarnings("deprecation")
            AudioTrack t = new AudioTrack(
                    AudioManager.STREAM_MUSIC, SAMPLE_RATE,
                    CHANNEL_MASK, AudioFormat.ENCODING_PCM_16BIT,
                    bufferBytes, AudioTrack.MODE_STREAM);
            return t;
        }
    }

    /* ---------------- 音符（Voice） ---------------- */

    /**
     * 一个活跃音符的渲染状态。
     * 每个音符把像素颜色(ARGB)合成出 弦乐/笛/钢琴铃 三个声部，再经全局低通/失真/噪声/回声处理。
     */
    private static class Voice {
        private int r, g, b, a;
        private float amp;
        private float pitchGain = 1f;
        private float lowPresence = 0f;
        private float frequency = 440f;
        private double step;
        private float attack;       // 音头时间（alpha 控制）
        private float release;      // 释放时间
        private int totalSamples;
        private int elapsed = 0;
        private int remaining;
        private boolean sustained;
        private boolean releasing = false;
        private boolean releasePending = false;
        private boolean deClicking = false;
        private float releaseStartLevel = 1f;
        private float adsrReleaseStartLevel = 1f;

        boolean isSustained() {
            return sustained && !releasing;
        }

        boolean isDeClicking() {
            return deClicking;
        }

        boolean matchesPitch(float otherFrequency) {
            float scale = Math.max(1f, Math.max(frequency, otherFrequency));
            return Math.abs(frequency - otherFrequency) / scale < 0.005f;
        }
        private double phase = 0;
        private long noiseState = 0x9E3779B97F4A7C15L; // 噪声 PRNG
        private float lastNoise = 0;   // 上一帧噪声（snare 带通差分）
        private double vibratoPhase = 0;
        private float vibratoRate;

        // 全局音色处理
        private float lpCoef;       // 全局低通系数（avg 控制：亮→高通、暗→低通）
        private double lpState = 0;
        private float drive;        // 失真量（tanh 过载，暗色更多）
        private float noiseMix;     // 暖噪声混合（大幅减小，且低通，避免白噪）
        private float noiseLpCoef;  // 噪声低通系数（暖噪声）
        private double noiseLpState = 0;
        private float sumNorm;      // 1/max(1, r+g+b)
        private float decayScale;   // 衰减倍率（暗/透明/蓝 → 余音更长）

        // 弦乐声部低通（基频 2 倍左右，大提琴更暖）
        private float stringLpCoef;
        private double stringLpState = 0;

        // 简易回声（空间感，alpha 越低回声越多）
        private final float[] delayBuf;
        private int delayIdx = 0;
        private float delayMix;

        // 声部增益
        private float gStr, gFlu, gBell;
        private float targetGStr, targetGFlu, targetGBell;
        private float mixLockBlend, targetMixLockBlend;
        private float targetSumNorm = 1f;
        private boolean voiceMixInitialized = false;
        /** 约 10ms 的参数交叉渐变，避免试听按钮松开时波形/增益瞬变。 */
        private static final float VOICE_MIX_SMOOTH = (float) (1.0 - Math.exp(-1.0 / (0.010 * SAMPLE_RATE)));
        // 释放起点（释放包络从 1 平滑淡出，避免瞬间切零的爆破声）
        private int releaseStartElapsed = -1;

        // 鼓组（snare/kick 叠加）
        private float snareWeight, kickWeight, drumWeight;
        private double drumPhase = 0;      // kick 扫频相位 / snare 音头
        private double kickFreq;

        // 效果器槽位（activeFx 在 updateParams 时按颜色重建；id/深度/参数引用）
        private static final class ActiveFx {
            final FxState st;
            final float depth;
            ActiveFx(FxState s, float d) { st = s; depth = d; }
        }
        private ActiveFx[] activeFx = new ActiveFx[0];
        /** 全局效果器链（0=R、1=G、2=B）：无触发条件，恒定作用于对应色相。每声道一条、状态独立。 */
        private final FxChain[] globalFx = { new FxChain(), new FxChain(), new FxChain() };
        private float envDepth = 0f;      // 包络器混合深度（与总体包络混合）
        private double fxPsyPhase = 0, fxGlitchPhase = 0, fxPulsePhase = 0;
        private double fxReesePhase = 0, fxLaserPhase = 0, fxLiquidPhase = 0, fxChorusPhase = 0;
        private float fxAirState = 0f;
        // 滤波器（EQ：低架 + 两峰 + 高架，RBJ biquad）
        private static final int EQ_BANDS = 4;
        private final float[][] eqCoef = new float[EQ_BANDS][5];   // b0 b1 b2 a1 a2
        private final double[][] eqState = new double[EQ_BANDS][4]; // x1 x2 y1 y2
        private boolean eqActive = false;
        private float eqMix = 1f;
        // 包络器 ADSR
        private boolean adsrActive = false;
        private float adsrAtkDur = 0.1f, adsrDecDur = 0.1f, adsrSus = 0.6f, adsrRelDur = 0.3f;
        // 混响（4 梳状 + 1 全通）
        private boolean reverbActive = false;
        private float reverbFb = 0.7f, reverbWet = 0.5f;
        private final float[][] combBuf;
        private final int[] combIdx;
        private final float[] apBuf;
        private int apIdx = 0;
        // 延迟/合唱共用 0.4s 延迟线
        private final float[] fxDelayBuf = new float[(int) (0.4f * SAMPLE_RATE)];
        private int fxDelayIdx = 0;

        Voice(int r, int g, int b, int a, float freq, float volume, float durationMs, boolean sustained) {
            this.sustained = sustained;
            delayBuf = new float[(int) (0.18 * SAMPLE_RATE)]; // 180ms 单延迟线
            // 混响：4 条梳状延迟（30/37/44/51ms）+ 全通（6.8ms）
            combBuf = new float[4][];
            combIdx = new int[4];
            int[] combLen = { (int) (0.030 * SAMPLE_RATE), (int) (0.037 * SAMPLE_RATE),
                    (int) (0.044 * SAMPLE_RATE), (int) (0.051 * SAMPLE_RATE) };
            for (int i = 0; i < 4; i++) combBuf[i] = new float[combLen[i]];
            apBuf = new float[(int) (0.0068 * SAMPLE_RATE)];
            updateParams(r, g, b, a, freq, volume);
            if (sustained) {
                totalSamples = Integer.MAX_VALUE; // 持续音符无固定时长
                remaining = Integer.MAX_VALUE - 1;
            } else {
                float durSec = Math.max(0.05f, durationMs / 1000f);
                // 衰减倍率：暗/透明/蓝 → 音符更长
                totalSamples = (int) ((durSec + release) * decayScale * SAMPLE_RATE);
                remaining = totalSamples;
            }
        }

        /** 原位更新合成参数（滑音/持续音换音色），保持相位连续。 */
        void updateParams(int r, int g, int b, int a, float freq, float volume) {
            this.r = r & 0xff;
            this.g = g & 0xff;
            this.b = b & 0xff;
            this.a = a & 0xff;
            float r01 = (r & 0xff) / 255f;
            float g01 = (g & 0xff) / 255f;
            float b01 = (b & 0xff) / 255f;
            float avg = (r01 + g01 + b01) / 3f;

            // 新 alpha：RGB 均匀度（Pielou/香农均匀度，0~1；越灰越大）
            float even = pielouEvenness(r & 0xff, g & 0xff, b & 0xff);

            // 声部增益（颜色通道 → 声部混合比例）
            targetGStr = r01;
            targetGFlu = g01;
            targetGBell = b01;
            float strongest = Math.max(targetGStr, Math.max(targetGFlu, targetGBell));
            float mixThreshold = Math.max(0.02f, strongest * 0.08f);
            int audibleChannels = (targetGStr >= mixThreshold ? 1 : 0)
                    + (targetGFlu >= mixThreshold ? 1 : 0)
                    + (targetGBell >= mixThreshold ? 1 : 0);
            targetMixLockBlend = audibleChannels >= 2 ? 1f : 0f;
            // 自适应归一化：避免颜色特别亮时爆音
            targetSumNorm = 1f / Math.max(1f, r01 + g01 + b01);
            if (!voiceMixInitialized) {
                gStr = targetGStr;
                gFlu = targetGFlu;
                gBell = targetGBell;
                sumNorm = targetSumNorm;
                mixLockBlend = targetMixLockBlend;
                voiceMixInitialized = true;
            }

            // 全局质感：平均值大（亮色）→ 清脆（高截止、少失真）；平均值小（暗色）→ 浊厚（低截止、多失真）
            float cutoff = 1000f + avg * 17000f;
            lpCoef = (float) (1.0 - Math.exp(-2.0 * Math.PI * cutoff / SAMPLE_RATE));

            // 鼓组权重：RGB 全 >200 → snare（纯白=1）；全 <55 → kick（纯黑=1）
            boolean allBright = (r & 0xff) > 200 && (g & 0xff) > 200 && (b & 0xff) > 200;
            boolean allDark = (r & 0xff) < 55 && (g & 0xff) < 55 && (b & 0xff) < 55;
            float avg255 = (r + g + b) / 3f;
            snareWeight = allBright ? Math.min(1f, Math.max(0f, (avg255 - 200f) / 55f)) : 0f;
            kickWeight = allDark ? Math.min(1f, Math.max(0f, (55f - avg255) / 55f)) : 0f;
            drumWeight = Math.max(snareWeight, kickWeight);
            kickFreq = 150.0;

            // 效果器槽位：按颜色输入重建启用列表（无固定特效，全部由用户配置的 8 个槽位驱动）
            rebuildActiveFx();

            // 暖噪声混合（基础音色，鼓组不加）
            noiseMix = (1f - avg) * 0.03f * (1f - drumWeight);
            noiseLpCoef = (float) (1.0 - Math.exp(-2.0 * Math.PI * 2500.0 / SAMPLE_RATE)); // 暖噪声

            // 保留低音波表的可听泛音；低截止会让小扬声器上的低音进一步消失。
            float sCut = Math.min(7000f, Math.max(500f, freq * 5f));
            stringLpCoef = (float) (1.0 - Math.exp(-2.0 * Math.PI * sCut / SAMPLE_RATE));

            // 衰减（新 alpha=均匀度）：色彩饱和/暗 → 余音更长更远
            decayScale = 0.6f + 1.2f * (1f - avg) + 0.5f * (1f - even) + 0.3f * b01;
            delayMix = 0f; // 基础回声并入"混响/延迟"效果器槽位（由用户配置）

            // 直接触摸使用 4~18ms 快速起音；测试短音仍保留原来的表现范围。
            attack = sustained
                    ? 0.018f + (0.004f - 0.018f) * even
                    : 0.2f + (0.005f - 0.2f) * even;
            release = (0.15f + (1f - even) * 0.25f) * decayScale;
            vibratoRate = 5f + even * 2f;

            amp = Math.min(1f, Math.max(0.001f, volume));
            frequency = Math.max(1f, freq);
            pitchGain = pitchLoudnessGain(freq);
            lowPresence = lowPitchPresence(freq);
            step = freq / SAMPLE_RATE;
        }

        /** Pielou 均匀度（香农均匀度）：纯色=0、灰色=1。 */
        private static float pielouEvenness(int r, int g, int b) {
            int sum = r + g + b;
            if (sum < 1) return 1f;
            double h = 0;
            for (int c : new int[]{r, g, b}) {
                if (c > 0) {
                    double p = c / (double) sum;
                    h -= p * Math.log(p);
                }
            }
            return (float) Math.min(1.0, Math.max(0.0, h / Math.log(3.0)));
        }

        /**
         * 按当前颜色重建启用的效果器槽位：计算 8 个触发输入（6 颜色槽 + 灰效 + 均效），
         * 深度 = (invert ? 1-input : input) × 强度 × (1-鼓权重)，>阈值才启用。
         */
        private void rebuildActiveFx() {
            // 通道规范化：高/低触发仅在“RGB 同时处于该极端区间 且 该颜色为最大/最小”时生效。
            // 这样纯色（如试音 R=255,0,0）不会触发其它通道的高低触发效果，只保留对应通道的“全局效果器”。
            boolean allHigh = r > 200 && g > 200 && b > 200;
            boolean allLow = r < 55 && g < 55 && b < 55;
            float inRHi = allHigh && r >= g && r >= b ? (r - 200) / 55f : 0f;
            float inRLo = allLow && r <= g && r <= b ? (55 - r) / 55f : 0f;
            float inGHi = allHigh && g >= r && g >= b ? (g - 200) / 55f : 0f;
            float inGLo = allLow && g <= r && g <= b ? (55 - g) / 55f : 0f;
            float inBHi = allHigh && b >= r && b >= g ? (b - 200) / 55f : 0f;
            float inBLo = allLow && b <= r && b <= g ? (55 - b) / 55f : 0f;
            float even = pielouEvenness(r, g, b);
            float avg = (r + g + b) / 255f / 3f;
            float[] inputs = { inRHi, inRLo, inGHi, inGLo, inBHi, inBLo, even, avg };

            FxState[] slots = fxSlots;
            java.util.List<ActiveFx> list = new java.util.ArrayList<>();
            float effScale = 1f - drumWeight;
            for (int i = 0; i < FX_TRIGGERED; i++) {
                FxState st = slots[i];
                if (st == null || "none".equals(st.id)) continue;
                float input = Math.max(0f, Math.min(1f, inputs[i]));
                float depth = (st.invert ? 1f - input : input)
                        * Math.max(0f, Math.min(1f, st.intensity)) * effScale;
                if (depth > 0.003f) list.add(new ActiveFx(st, depth));
            }
            activeFx = list.toArray(new ActiveFx[0]);

            // 全局效果器（无触发条件：input=1，depth=强度；作用于单色相，不受鼓权重门控）
            for (int g = 0; g < FX_GLOBAL_COUNT; g++) {
                java.util.List<ActiveFx> glist = new java.util.ArrayList<>();
                for (int j = 0; j < FX_GLOBAL_PER_CHANNEL; j++) {
                    FxState st = slots[FX_GLOBAL_BASE + g * FX_GLOBAL_PER_CHANNEL + j];
                    if (st != null && !"none".equals(st.id)) {
                        float depth = (st.invert ? 0f : 1f) * Math.max(0f, Math.min(1f, st.intensity));
                        if (depth > 0.003f) glist.add(new ActiveFx(st, depth));
                    }
                }
                globalFx[g].setFx(glist.toArray(new ActiveFx[0]));
            }

            // 由槽位初始化 EQ / ADSR / 混响参数
            eqActive = false;
            adsrActive = false;
            envDepth = 0f;
            reverbActive = false;
            for (ActiveFx f : activeFx) {
                FxState st = f.st;
                if ("filter".equals(st.id) && !eqActive) {
                    eqActive = true;
                    eqMix = st.params.length > 0 ? Math.max(0f, Math.min(1f, st.params[0])) : 1f;
                    buildEqCoeffs(st.curve);
                } else if ("env".equals(st.id)) {
                    adsrActive = true;
                    parseAdsr(st.curve);
                    float atkT = st.params.length > 0 ? st.params[0] : 0.1f;
                    float relT = st.params.length > 1 ? st.params[1] : 0.3f;
                    adsrAtkDur = Math.max(0.005f, adsrAtkDur * atkT);
                    adsrRelDur = Math.max(0.02f, adsrRelDur * relT);
                    if (f.depth > envDepth) envDepth = f.depth;
                } else if ("reverb".equals(st.id) && !reverbActive) {
                    reverbActive = true;
                    float size = st.params.length > 0 ? st.params[0] : 0.5f;
                    reverbFb = 0.5f + 0.35f * size;
                    reverbWet = 0.35f + 0.45f * size;
                }
            }
            for (double[] s : eqState) { s[0] = 0; s[1] = 0; s[2] = 0; s[3] = 0; }
            fxPsyPhase = fxGlitchPhase = fxPulsePhase = fxReesePhase = fxLaserPhase = fxLiquidPhase = fxChorusPhase = 0;
            fxDelayIdx = 0;
            for (int[] idx : new int[][]{combIdx}) for (int i = 0; i < idx.length; i++) idx[i] = 0;
            apIdx = 0;
        }

        /** EQ 曲线(16 点 0..1，中心 0.5=0dB，±12dB) → 4 段 biquad 系数。 */
        private void buildEqCoeffs(float[] curve) {
            float[] gaps = new float[EQ_BANDS];
            for (int i = 0; i < EQ_BANDS; i++) {
                float v = 0.5f;
                if (curve.length > 0) {
                    int idx = (int) ((i + 0.5f) / EQ_BANDS * curve.length);
                    idx = Math.min(curve.length - 1, idx);
                    v = curve[idx];
                }
                gaps[i] = (v - 0.5f) * 24f; // dB
            }
            float[] f0 = { 200f, 900f, 3400f, 11000f };
            for (int i = 0; i < EQ_BANDS; i++) {
                float[] c = eqCoef[i];
                float db = gaps[i];
                float A = (float) Math.pow(10, db / 40.0);
                float w0 = (float) (2.0 * Math.PI * f0[i] / SAMPLE_RATE);
                float cosw = (float) Math.cos(w0);
                float sinw = (float) Math.sin(w0);
                float Q = (i == 0 || i == EQ_BANDS - 1) ? 0.707f : 1.1f;
                float alpha = sinw / (2 * Q);
                float b0, b1, b2, a0, a1, a2;
                if (i == 0) { // low shelf
                    b0 = A * ((A + 1) - (A - 1) * cosw + 2 * (float) Math.sqrt(A) * alpha);
                    b1 = 2 * A * ((A - 1) - (A + 1) * cosw);
                    b2 = A * ((A + 1) - (A - 1) * cosw - 2 * (float) Math.sqrt(A) * alpha);
                    a0 = (A + 1) + (A - 1) * cosw + 2 * (float) Math.sqrt(A) * alpha;
                    a1 = -2 * ((A - 1) + (A + 1) * cosw);
                    a2 = (A + 1) + (A - 1) * cosw - 2 * (float) Math.sqrt(A) * alpha;
                } else if (i == EQ_BANDS - 1) { // high shelf
                    b0 = A * ((A + 1) + (A - 1) * cosw + 2 * (float) Math.sqrt(A) * alpha);
                    b1 = -2 * A * ((A - 1) + (A + 1) * cosw);
                    b2 = A * ((A + 1) + (A - 1) * cosw - 2 * (float) Math.sqrt(A) * alpha);
                    a0 = (A + 1) - (A - 1) * cosw + 2 * (float) Math.sqrt(A) * alpha;
                    a1 = 2 * ((A - 1) - (A + 1) * cosw);
                    a2 = (A + 1) - (A - 1) * cosw - 2 * (float) Math.sqrt(A) * alpha;
                } else { // peak
                    b0 = 1 + alpha * A;
                    b1 = -2 * cosw;
                    b2 = 1 - alpha * A;
                    a0 = 1 + alpha / A;
                    a1 = -2 * cosw;
                    a2 = 1 - alpha / A;
                }
                c[0] = b0 / a0; c[1] = b1 / a0; c[2] = b2 / a0; c[3] = a1 / a0; c[4] = a2 / a0;
            }
        }

        /** ADSR 曲线(32 点 0..1) → (attack比例, decay比例, sustain, release比例)，再与时长参数相乘。 */
        private void parseAdsr(float[] curve) {
            if (curve.length < 8) {
                adsrAtkDur = 0.1f; adsrDecDur = 0.1f; adsrSus = 0.6f; adsrRelDur = 0.3f;
                return;
            }
            // 峰位 → attack 比例
            int mx = 0;
            for (int i = 0; i < curve.length; i++) if (curve[i] > curve[mx]) mx = i;
            float xm = mx / (float) (curve.length - 1);
            float ym = curve[mx];
            // 峰后稳定均值 → sustain
            float sum = 0; int cnt = 0;
            for (int i = mx; i < curve.length; i++) { sum += curve[i]; cnt++; }
            float susRel = cnt > 0 ? sum / cnt : 0f;
            if (ym > 0.02f) susRel = Math.max(0f, Math.min(1f, susRel / ym));
            // 峰后下降到 sustain 90% 的位置 → decay 比例
            float xd = xm;
            float target = ym * (0.9f - 0.15f * (1f - susRel));
            for (int i = mx; i < curve.length; i++) {
                if (curve[i] <= target) { xd = i / (float) (curve.length - 1); break; }
            }
            if (xd <= xm) xd = Math.min(1f, xm + 0.1f);
            // 尾部开始明显下降 → release 起点
            float xr = 1f;
            for (int i = curve.length - 1; i > 1; i--) {
                if (curve[i - 1] - curve[i] < 0.05f) { xr = i / (float) (curve.length - 1); break; }
            }
            // 映射到秒（atkT/relT 参数倍率已在外层乘）
            adsrAtkDur = Math.max(0.005f, xm * 0.6f);
            adsrDecDur = Math.max(0.0f, (xd - xm) * 0.6f);
            adsrSus = susRel;
            adsrRelDur = Math.max(0.02f, (1f - Math.min(1f, xr)) * 1.2f + 0.05f);
        }

        /** ADSR 包络电平（时间 t 秒；持续音用 releaseStartElapsed 作释放起点）。 */
        private float adsrEnv(float t) {
            float base = releaseStartElapsed >= 0 ? releaseStartElapsed : -1;
            if (base >= 0) {
                // 释放段
                float rt = (elapsed - base) / (adsrRelDur * SAMPLE_RATE);
                if (rt >= 1f) return 0f;
                return adsrReleaseStartLevel * cosineRelease(rt);
            }
            if (t < adsrAtkDur) return t / adsrAtkDur;
            if (t < adsrAtkDur + adsrDecDur) {
                float d = (t - adsrAtkDur) / Math.max(0.001f, adsrDecDur);
                return 1f - (1f - adsrSus) * d;
            }
            return adsrSus;
        }

        /** 单段 biquad 滤波。 */
        private float biquad(float x, float[] c, double[] s) {
            float y = (float) (c[0] * x + c[1] * s[0] + c[2] * s[1] - c[3] * s[2] - c[4] * s[3]);
            s[1] = s[0]; s[0] = x;
            s[3] = s[2]; s[2] = y;
            return y;
        }

        void release() {
            if (releasing || releasePending) return;
            if (elapsed < MIN_TAP_SAMPLES) {
                releasePending = true;
                return;
            }
            beginRelease();
        }

        private void beginRelease() {
            float t = (float) elapsed / SAMPLE_RATE;
            releaseStartLevel = overallEnv(t);
            adsrReleaseStartLevel = adsrEnv(t);
            releasePending = false;
            releasing = true;
            releaseStartElapsed = elapsed; // 记录释放起点（包络从此平滑淡出）
            int relSamples = (int) (release * SAMPLE_RATE) + 1;
            if (sustained) {
                remaining = relSamples;
            } else {
                remaining = Math.min(remaining, relSamples);
            }
        }

        /** 复音超限时不直接删除声源，先在短窗内平滑退场。 */
        void deClickStop() {
            if (remaining <= 0 || deClicking) return;
            deClicking = true;
            remaining = Math.min(remaining, DECLICK_SAMPLES);
        }

        /** 在线性浮点总线上混合本音符，所有声部完成后再统一做峰值管理。 */
        void render(float[] buf, int count) {
            if (releasePending && elapsed >= MIN_TAP_SAMPLES) beginRelease();
            int n = Math.min(count, remaining);
            for (int i = 0; i < n; i++) {
                float t = (float) elapsed / SAMPLE_RATE;
                smoothVoiceMix();

                // 三个声部（各带自己的包络特征；先经各自通道的全局效果器塑形，再按通道增益混合）
                ChannelDrumState[] drumStates = channelDrumStates;
                ChannelDrumState drumR = drumStates[0], drumG = drumStates[1], drumB = drumStates[2];
                float string = drumR.enabled() ? oneShot(drumR.id, elapsed, drumR.speed) * drumR.volume : stringPart(t);
                float flute = drumG.enabled() ? oneShot(drumG.id, elapsed, drumG.speed) * drumG.volume : flutePart(t);
                float bell = drumB.enabled() ? oneShot(drumB.id, elapsed, drumB.speed) * drumB.volume : bellPart(t);
                if (Math.max(gStr, targetGStr) > 0.0005f) string = globalFx[0].process(string, step, t);
                if (Math.max(gFlu, targetGFlu) > 0.0005f) flute = globalFx[1].process(flute, step, t);
                if (Math.max(gBell, targetGBell) > 0.0005f) bell = globalFx[2].process(bell, step, t);
                float base = (string * gStr * (drumR.enabled() ? 1f : pitchGain)
                        + flute * gFlu * (drumG.enabled() ? 1f : pitchGain)
                        + bell * gBell * (drumB.enabled() ? 1f : pitchGain)) * sumNorm;

                // 鼓组：snare/kick 与基础音色按权重叠加（互斥，取大者；黑/白鼓元素可配置）
                float mixed = base;
                if (drumWeight > 0.001f) {
                    boolean bright = snareWeight > kickWeight;
                    String did = bright ? drumWhite : drumBlack;
                    float drum = drumSample(did, t);
                    mixed = drum * drumWeight + base * (1f - drumWeight);
                }

                // 全局低通（avg → 浊厚/清脆）
                lpState += lpCoef * (mixed - lpState);
                float out = (float) lpState;

                // 效果器槽位（用户配置的 8 个插件槽：按 id 应用，depth=触发强度）
                float fxFilterDry = out;
                float fxDelayWet = 0f;
                float fxDelayWrite = 0f;
                for (ActiveFx f : activeFx) {
                    FxState st = f.st;
                    float depth = f.depth;
                    String id = st.id;
                    if ("psy".equals(id)) {
                        float rate = st.params.length > 0 ? st.params[0] : 8f;
                        fxPsyPhase += rate / SAMPLE_RATE * Math.PI * 2;
                        float trem = 1f - depth * 0.8f * (0.5f - 0.5f * (float) Math.cos(fxPsyPhase));
                        out *= trem;
                    } else if ("glitch".equals(id)) {
                        float duty = st.params.length > 0 ? st.params[0] : 0.5f;
                        float rate = 8f + 26f * depth;
                        fxGlitchPhase += rate / SAMPLE_RATE;
                        float gp = (float) (fxGlitchPhase - Math.floor(fxGlitchPhase));
                        float gate = gp < duty ? 1f : (0.10f + 0.08f * depth);
                        out *= gate;
                    } else if ("pulse".equals(id)) {
                        float freq = st.params.length > 0 ? st.params[0] : 55f;
                        fxPulsePhase += freq / SAMPLE_RATE;
                        float sub = (float) Math.sin(2.0 * Math.PI * (fxPulsePhase - Math.floor(fxPulsePhase)));
                        out += sub * depth * 0.35f;
                    } else if ("reese".equals(id)) {
                        float detune = st.params.length > 0 ? st.params[0] : 1.2f;
                        fxReesePhase += step * (1f + detune * 0.03f);
                        double rp = fxReesePhase - Math.floor(fxReesePhase);
                        float det = (float) (2.0 * rp - 1.0);
                        out += det * depth * 0.2f;
                    } else if ("laser".equals(id)) {
                        float sweep = st.params.length > 0 ? st.params[0] : 1.6f;
                        float prog = Math.min(1f, t / 0.09f);
                        float lf = (float) ((2.6f - 1.6f * prog) * sweep * step);
                        fxLaserPhase += lf;
                        out += (float) Math.sin(2.0 * Math.PI * (fxLaserPhase - Math.floor(fxLaserPhase)))
                                * depth * 0.35f * (1f - prog);
                    } else if ("liquid".equals(id)) {
                        float rate = st.params.length > 0 ? st.params[0] : 0.8f;
                        fxLiquidPhase += rate / SAMPLE_RATE * Math.PI * 2;
                        float swell = 1f + depth * 0.18f * (float) Math.sin(fxLiquidPhase);
                        out *= swell;
                    } else if ("dist".equals(id)) {
                        float d = depth * 1.6f;
                        float x = out * (1f + d * 3f);
                        out = (float) Math.tanh(x) / (1f + d * 3f) * (1f + d);
                    } else if ("filter".equals(id)) {
                        float fout = out;
                        for (int bi = 0; bi < EQ_BANDS; bi++) fout = biquad(fout, eqCoef[bi], eqState[bi]);
                        out = fxFilterDry * (1f - depth * eqMix) + fout * (depth * eqMix);
                    } else if ("delay".equals(id)) {
                        float time = st.params.length > 0 ? st.params[0] : 0.18f;
                        float fb = st.params.length > 1 ? st.params[1] : 0.4f;
                        int dn = fxDelayBuf.length;
                        int read = (fxDelayIdx - (int) (time * SAMPLE_RATE) + dn) % dn;
                        float del = fxDelayBuf[read];
                        fxDelayWrite = out + del * fb;
                        out += del * depth * 0.8f;
                        fxDelayWet = 1f;
                    } else if ("reverb".equals(id)) {
                        float acc = 0f;
                        for (int ci = 0; ci < 4; ci++) {
                            int len = combBuf[ci].length;
                            float cb = combBuf[ci][combIdx[ci]];
                            float sc = out + cb * reverbFb;
                            combBuf[ci][combIdx[ci]] = sc;
                            combIdx[ci] = (combIdx[ci] + 1) % len;
                            acc += cb;
                        }
                        acc *= 0.25f;
                        int al = apBuf.length;
                        float ap = apBuf[(apIdx + al - 1) % al];
                        float apOut = -0.5f * acc + ap;
                        apBuf[apIdx] = acc + apOut * 0.5f;
                        apIdx = (apIdx + 1) % al;
                        out = out * (1f - depth * reverbWet) + apOut * depth * reverbWet * 1.4f;
                    } else if ("chorus".equals(id)) {
                        float rate = st.params.length > 0 ? st.params[0] : 0.8f;
                        float cdepth = st.params.length > 1 ? st.params[1] : 0.3f;
                        fxChorusPhase += rate / SAMPLE_RATE * Math.PI * 2;
                        int dn = fxDelayBuf.length;
                        int offset = (int) ((0.006 + 0.006 * cdepth * (0.5f + 0.5f * Math.sin(fxChorusPhase))) * SAMPLE_RATE);
                        int read = (fxDelayIdx - offset + dn) % dn;
                        float del = fxDelayBuf[read];
                        fxDelayWrite = out;
                        out = out * (1f - depth * 0.5f) + del * depth * 0.5f;
                        fxDelayWet = 1f;
                    } else if ("compressor".equals(id)) {
                        float threshold = (float) Math.pow(10.0, (st.params.length > 0 ? st.params[0] : -18f) / 20.0);
                        float ratio = st.params.length > 1 ? Math.max(1f, st.params[1]) : 4f;
                        float av = Math.abs(out);
                        if (av > threshold) {
                            float compressed = threshold + (av - threshold) / ratio;
                            out = Math.signum(out) * (out * (1f - depth) + compressed * depth);
                        }
                    } else if ("air".equals(id)) {
                        float amount = st.params.length > 0 ? st.params[0] : 0.08f;
                        float tone = st.params.length > 1 ? st.params[1] : 0.55f;
                        float nz = nextNoise();
                        fxAirState += (0.04f + tone * 0.75f) * (nz - fxAirState);
                        out += fxAirState * amount * depth;
                    }
                }
                // 延迟线统一写入（有 delay/chorus 才写；否则保持零避免爆音）
                int fxDN = fxDelayBuf.length;
                if (fxDelayWet > 0.001f) {
                    fxDelayBuf[fxDelayIdx] = fxDelayWrite;
                } else if (fxDelayBuf[fxDelayIdx] != 0f) {
                    fxDelayBuf[fxDelayIdx] = 0f;
                }
                fxDelayIdx = (fxDelayIdx + 1) % fxDN;

                // 【已删去暖噪声混合】

                // 总包络（attack 由均匀度控制；release 阶段淡出；包络器槽位可混合 ADSR）
                float env = overallEnv(t);
                if (envDepth > 0.001f && adsrActive) {
                    float aEnv = adsrEnv(t);
                    env = env * (1f - envDepth) + aEnv * envDepth;
                }
                int samplesLeft = remaining - i;
                if (samplesLeft <= DECLICK_SAMPLES) {
                    float p = (samplesLeft - 1f) / (DECLICK_SAMPLES - 1f);
                    p = Math.max(0f, Math.min(1f, p));
                    env *= p * p * (3f - 2f * p);
                }
                float sample = out * amp * env;

                buf[i] += sample;

                phase += step;
                vibratoPhase += vibratoRate / SAMPLE_RATE * Math.PI * 2;
                elapsed++;
            }
            remaining -= n;
        }

        private void smoothVoiceMix() {
            gStr += (targetGStr - gStr) * VOICE_MIX_SMOOTH;
            gFlu += (targetGFlu - gFlu) * VOICE_MIX_SMOOTH;
            gBell += (targetGBell - gBell) * VOICE_MIX_SMOOTH;
            sumNorm += (targetSumNorm - sumNorm) * VOICE_MIX_SMOOTH;
            mixLockBlend += (targetMixLockBlend - mixLockBlend) * VOICE_MIX_SMOOTH;
        }

        /** 军鼓：短促噪声（带通感）+ 180Hz 音头，快速衰减。 */
        private float snareSound(float t) {
            float decay = (float) Math.exp(-t * 26f);
            float noise = nextNoise();
            // 简单带通感：相邻差分
            float band = (noise - lastNoise) * 0.6f;
            lastNoise = noise;
            drumPhase += 180.0 / SAMPLE_RATE;
            float tone = (float) Math.sin(2.0 * Math.PI * drumPhase);
            return (band * 0.7f + tone * 0.3f) * decay;
        }

        /** 底鼓：正弦频率下扫 150→45Hz，快速衰减。 */
        private float kickSound(float t) {
            double f = 150.0 - 105.0 * Math.min(1.0, t / 0.12);
            drumPhase += f / SAMPLE_RATE;
            float decay = (float) Math.exp(-t * 15f);
            return (float) Math.sin(2.0 * Math.PI * drumPhase) * decay;
        }

        /** 黑/白像素鼓优先播放素材库采样；旧 id 保留程序化兼容路径。 */
        private float drumSample(String id, float t) {
            if (drumSamples.containsKey(id)) return oneShot(id, elapsed, 1f);
            switch (id) {
                case "snare": return snareSound(t);
                case "clap": {
                    // 掌声：3 段噪声脉冲
                    float env = (float) Math.exp(-t * 24f);
                    float pul = 0.6f + 0.4f * (float) Math.abs(Math.sin(Math.min(1f, t / 0.03f) * Math.PI * 1.5));
                    return nextNoise() * 0.7f * env * pul;
                }
                case "hihat": {
                    float decay = (float) Math.exp(-t * 40f);
                    float band = (nextNoise() - lastNoise) * 0.9f;
                    lastNoise = nextNoise() * 0.5f + lastNoise * 0.5f;
                    return band * 0.5f * decay;
                }
                case "tom": {
                    double f = 200.0 - 120.0 * Math.min(1.0, t / 0.15);
                    drumPhase += f / SAMPLE_RATE;
                    float decay = (float) Math.exp(-t * 12f);
                    return (float) Math.sin(2.0 * Math.PI * drumPhase) * decay;
                }
                case "maracas": {
                    float decay = (float) Math.exp(-t * 32f);
                    float band = (nextNoise() - lastNoise) * 0.8f;
                    lastNoise = nextNoise();
                    return band * 0.5f * decay;
                }
                default: return kickSound(t); // kick
            }
        }

        /** 弦乐声部：R 通道波表 + 低通 + 慢起音 + 极轻弓毛噪声。 */
        private float stringPart(float t) {
            float raw = presenceEnhancedWave(0);
            stringLpState += stringLpCoef * (raw - stringLpState);
            float atk = Math.min(1f, t / (sustained ? 0.018f : 0.18f));
            return (float) stringLpState * atk;
        }

        /** 笛声部：G 通道波表 + 起音呼吸噪声 + 轻微颤音。 */
        private float flutePart(float t) {
            float tone = presenceEnhancedWave(1);
            // 混色必须保持稳定，避免笛声部的振幅颤音让整体产生拍频感。
            float trem = 1f + (1f - mixLockBlend) * 0.012f * (float) Math.sin(vibratoPhase * 0.7);
            float atk = Math.min(1f, t / (sustained ? 0.012f : 0.05f));
            return tone * atk * trem;
        }

        /** 钢琴/铃声部：B 通道波表；持续音不衰减（释放由总包络淡出）；非持续按 decayScale 衰减。 */
        private float bellPart(float t) {
            float tone = presenceEnhancedWave(2);
            if (sustained) {
                // 含释放阶段：保持全幅，由总包络平滑淡出（杜绝瞬间切零的爆破声）
                float atk = Math.min(1f, t / 0.004f);
                return tone * atk;
            }
            float sc = Math.max(0.2f, decayScale);
            float d1 = (float) Math.exp(-t * (1.2f + 0.6f * (b / 255f)) / sc);
            return tone * d1;
        }

        private float presenceEnhancedWave(int channel) {
            float fundamental = voiceWave(channel, phase);
            if (lowPresence <= 0.0001f) return fundamental;
            float harmonics = voiceWave(channel, phase * 2.0) * 0.30f
                    + voiceWave(channel, phase * 3.0) * 0.10f;
            return (fundamental + harmonics * lowPresence) / (1f + 0.12f * lowPresence);
        }

        private float voiceWave(int channel, double ph) {
            if (mixLockBlend <= 0.0001f) return wt(channel, ph);
            if (mixLockBlend >= 0.9999f) return wtPitchLocked(channel, ph);
            float solo = wt(channel, ph);
            float mixed = wtPitchLocked(channel, ph);
            // 等功率交叉淡化，避免波长倍率切换时在任意相位产生阶跃。
            float angle = mixLockBlend * (float) Math.PI * 0.5f;
            return solo * (float) Math.cos(angle) + mixed * (float) Math.sin(angle);
        }

        /** 总包络（attack 由 alpha 控制；release 从释放起点平滑淡出，避免爆破声）。 */
        private float overallEnv(float t) {
            if (sustained) {
                if (releasing) {
                    float base = releaseStartElapsed >= 0 ? releaseStartElapsed : elapsed;
                    float rt = (elapsed - base) / (release * SAMPLE_RATE);
                    if (rt >= 1f) return 0f;
                    return releaseStartLevel * cosineRelease(rt);
                }
                if (t < attack) return t / attack;
                return 1f;
            }
            float atk = Math.min(1f, t / attack);
            float dur = totalSamples / (float) SAMPLE_RATE;
            float sustainEnd = dur - release;
            if (t < sustainEnd) return atk;
            float rt = (t - sustainEnd) / release;
            return atk * Math.max(0f, 1f - rt * rt);
        }

        /** 起点和终点斜率都为零，避免任意波形相位下释放产生宽频瞬态。 */
        private static float cosineRelease(float progress) {
            float p = Math.max(0f, Math.min(1f, progress));
            return 0.5f + 0.5f * (float) Math.cos(Math.PI * p);
        }

        private float nextNoise() {
            noiseState ^= (noiseState << 13);
            noiseState ^= (noiseState >>> 7);
            noiseState ^= (noiseState << 17);
            return (noiseState & 0xFFFF) / 32768f - 1f;
        }

        /** 一条效果链（供全局效果器使用）：状态独立，作用于单一色相采样流。无 ADSR 包络（包络仅对触发链/整体起作用）。 */
        private static final class FxChain {
            ActiveFx[] fx = new ActiveFx[0];
            double psyPhase = 0, glitchPhase = 0, pulsePhase = 0, reesePhase = 0, laserPhase = 0, liquidPhase = 0, chorusPhase = 0;
            boolean eqActive = false; float eqMix = 1f;
            final float[][] eqCoef = new float[EQ_BANDS][5];
            final double[][] eqState = new double[EQ_BANDS][4];
            boolean reverbActive = false; float reverbFb = 0.7f, reverbWet = 0.5f;
            float[][] combBuf; int[] combIdx; float[] apBuf; int apIdx = 0;
            float[] fxDelayBuf; int fxDelayIdx = 0;
            long noiseState = 0xD1B54A32D192ED03L;
            float airState = 0f;
            float inputActivity = 0f;

            FxChain() {
                int[] combLen = { (int) (0.030 * SAMPLE_RATE), (int) (0.037 * SAMPLE_RATE),
                        (int) (0.044 * SAMPLE_RATE), (int) (0.051 * SAMPLE_RATE) };
                combBuf = new float[4][]; combIdx = new int[4];
                for (int i = 0; i < 4; i++) combBuf[i] = new float[combLen[i]];
                apBuf = new float[(int) (0.0068 * SAMPLE_RATE)];
                fxDelayBuf = new float[(int) (0.4f * SAMPLE_RATE)];
            }

            void setFx(ActiveFx[] list) {
                fx = list;
                eqActive = false; reverbActive = false;
                for (ActiveFx f : list) {
                    FxState st = f.st;
                    if ("filter".equals(st.id) && !eqActive) {
                        eqActive = true;
                        eqMix = st.params.length > 0 ? Math.max(0f, Math.min(1f, st.params[0])) : 1f;
                        buildEqCoeffs(st.curve);
                    } else if ("reverb".equals(st.id) && !reverbActive) {
                        reverbActive = true;
                        float size = st.params.length > 0 ? st.params[0] : 0.5f;
                        reverbFb = 0.5f + 0.35f * size;
                        reverbWet = 0.35f + 0.45f * size;
                    }
                }
                for (double[] s : eqState) { s[0] = 0; s[1] = 0; s[2] = 0; s[3] = 0; }
                psyPhase = glitchPhase = pulsePhase = reesePhase = laserPhase = liquidPhase = chorusPhase = 0;
                fxDelayIdx = 0; apIdx = 0;
                inputActivity = 0f; airState = 0f;
                for (int i = 0; i < combIdx.length; i++) combIdx[i] = 0;
                java.util.Arrays.fill(fxDelayBuf, 0f);
                for (float[] cb : combBuf) java.util.Arrays.fill(cb, 0f);
                java.util.Arrays.fill(apBuf, 0f);
            }

            /** EQ 曲线(16 点 0..1，中心 0.5=0dB) → 4 段 biquad 系数。 */
            private void buildEqCoeffs(float[] curve) {
                float[] gaps = new float[EQ_BANDS];
                for (int i = 0; i < EQ_BANDS; i++) {
                    float v = 0.5f;
                    if (curve.length > 0) {
                        int idx = (int) ((i + 0.5f) / EQ_BANDS * curve.length);
                        idx = Math.min(curve.length - 1, idx);
                        v = curve[idx];
                    }
                    gaps[i] = (v - 0.5f) * 24f;
                }
                float[] f0 = { 200f, 900f, 3400f, 11000f };
                for (int i = 0; i < EQ_BANDS; i++) {
                    float[] c = eqCoef[i];
                    float db = gaps[i];
                    float A = (float) Math.pow(10, db / 40.0);
                    float w0 = (float) (2.0 * Math.PI * f0[i] / SAMPLE_RATE);
                    float cosw = (float) Math.cos(w0);
                    float sinw = (float) Math.sin(w0);
                    float Q = (i == 0 || i == EQ_BANDS - 1) ? 0.707f : 1.1f;
                    float alpha = sinw / (2 * Q);
                    float b0, b1, b2, a0, a1, a2;
                    if (i == 0) { // low shelf
                        b0 = A * ((A + 1) - (A - 1) * cosw + 2 * (float) Math.sqrt(A) * alpha);
                        b1 = 2 * A * ((A - 1) - (A + 1) * cosw);
                        b2 = A * ((A + 1) - (A - 1) * cosw - 2 * (float) Math.sqrt(A) * alpha);
                        a0 = (A + 1) + (A - 1) * cosw + 2 * (float) Math.sqrt(A) * alpha;
                        a1 = -2 * ((A - 1) + (A + 1) * cosw);
                        a2 = (A + 1) + (A - 1) * cosw - 2 * (float) Math.sqrt(A) * alpha;
                    } else if (i == EQ_BANDS - 1) { // high shelf
                        b0 = A * ((A + 1) + (A - 1) * cosw + 2 * (float) Math.sqrt(A) * alpha);
                        b1 = -2 * A * ((A - 1) + (A + 1) * cosw);
                        b2 = A * ((A + 1) + (A - 1) * cosw - 2 * (float) Math.sqrt(A) * alpha);
                        a0 = (A + 1) - (A - 1) * cosw + 2 * (float) Math.sqrt(A) * alpha;
                        a1 = 2 * ((A - 1) - (A + 1) * cosw);
                        a2 = (A + 1) - (A - 1) * cosw - 2 * (float) Math.sqrt(A) * alpha;
                    } else { // peak
                        b0 = 1 + alpha * A;
                        b1 = -2 * cosw;
                        b2 = 1 - alpha * A;
                        a0 = 1 + alpha / A;
                        a1 = -2 * cosw;
                        a2 = 1 - alpha / A;
                    }
                    c[0] = b0 / a0; c[1] = b1 / a0; c[2] = b2 / a0; c[3] = a1 / a0; c[4] = a2 / a0;
                }
            }

            private float biquad(float x, float[] c, double[] s) {
                float y = (float) (c[0] * x + c[1] * s[0] + c[2] * s[1] - c[3] * s[2] - c[4] * s[3]);
                s[1] = s[0]; s[0] = x;
                s[3] = s[2]; s[2] = y;
                return y;
            }

            /** 应用该链（无 ADSR 包络），返回处理后采样。 */
            float process(float in, double step, float t) {
                float out = in;
                // Generator-style effects must shape an existing signal, not
                // become free-running oscillators while the app is idle.
                float detected = Math.min(1f, Math.abs(in) * 24f);
                inputActivity = Math.max(detected, inputActivity * 0.9995f);
                float fxFilterDry = out;
                float fxDelayWet = 0f;
                float fxDelayWrite = 0f;
                for (ActiveFx f : fx) {
                    FxState st = f.st;
                    float depth = f.depth;
                    String id = st.id;
                    if ("psy".equals(id)) {
                        float rate = st.params.length > 0 ? st.params[0] : 8f;
                        psyPhase += rate / SAMPLE_RATE * Math.PI * 2;
                        float trem = 1f - depth * 0.8f * (0.5f - 0.5f * (float) Math.cos(psyPhase));
                        out *= trem;
                    } else if ("glitch".equals(id)) {
                        float duty = st.params.length > 0 ? st.params[0] : 0.5f;
                        float rate = 8f + 26f * depth;
                        glitchPhase += rate / SAMPLE_RATE;
                        float gp = (float) (glitchPhase - Math.floor(glitchPhase));
                        float gate = gp < duty ? 1f : (0.10f + 0.08f * depth);
                        out *= gate;
                    } else if ("pulse".equals(id)) {
                        float freq = st.params.length > 0 ? st.params[0] : 55f;
                        pulsePhase += freq / SAMPLE_RATE;
                        float sub = (float) Math.sin(2.0 * Math.PI * (pulsePhase - Math.floor(pulsePhase)));
                        out += sub * depth * 0.35f * inputActivity;
                    } else if ("reese".equals(id)) {
                        float detune = st.params.length > 0 ? st.params[0] : 1.2f;
                        reesePhase += step * (1f + detune * 0.03f);
                        double rp = reesePhase - Math.floor(reesePhase);
                        float det = (float) (2.0 * rp - 1.0);
                        out += det * depth * 0.2f * inputActivity;
                    } else if ("laser".equals(id)) {
                        float sweep = st.params.length > 0 ? st.params[0] : 1.6f;
                        float prog = Math.min(1f, t / 0.09f);
                        float lf = (float) ((2.6f - 1.6f * prog) * sweep * step);
                        laserPhase += lf;
                        out += (float) Math.sin(2.0 * Math.PI * (laserPhase - Math.floor(laserPhase)))
                                * depth * 0.35f * (1f - prog) * inputActivity;
                    } else if ("liquid".equals(id)) {
                        float rate = st.params.length > 0 ? st.params[0] : 0.8f;
                        liquidPhase += rate / SAMPLE_RATE * Math.PI * 2;
                        float swell = 1f + depth * 0.18f * (float) Math.sin(liquidPhase);
                        out *= swell;
                    } else if ("dist".equals(id)) {
                        float d = depth * 1.6f;
                        float x = out * (1f + d * 3f);
                        out = (float) Math.tanh(x) / (1f + d * 3f) * (1f + d);
                    } else if ("filter".equals(id)) {
                        float fout = out;
                        for (int bi = 0; bi < EQ_BANDS; bi++) fout = biquad(fout, eqCoef[bi], eqState[bi]);
                        out = fxFilterDry * (1f - depth * eqMix) + fout * (depth * eqMix);
                    } else if ("delay".equals(id)) {
                        float time = st.params.length > 0 ? st.params[0] : 0.18f;
                        float fb = st.params.length > 1 ? st.params[1] : 0.4f;
                        int dn = fxDelayBuf.length;
                        int read = (fxDelayIdx - (int) (time * SAMPLE_RATE) + dn) % dn;
                        float del = fxDelayBuf[read];
                        fxDelayWrite = out + del * fb;
                        out += del * depth * 0.8f;
                        fxDelayWet = 1f;
                    } else if ("reverb".equals(id)) {
                        float acc = 0f;
                        for (int ci = 0; ci < 4; ci++) {
                            int len = combBuf[ci].length;
                            float cb = combBuf[ci][combIdx[ci]];
                            float sc = out + cb * reverbFb;
                            combBuf[ci][combIdx[ci]] = sc;
                            combIdx[ci] = (combIdx[ci] + 1) % len;
                            acc += cb;
                        }
                        acc *= 0.25f;
                        int al = apBuf.length;
                        float ap = apBuf[(apIdx + al - 1) % al];
                        float apOut = -0.5f * acc + ap;
                        apBuf[apIdx] = acc + apOut * 0.5f;
                        apIdx = (apIdx + 1) % al;
                        out = out * (1f - depth * reverbWet) + apOut * depth * reverbWet * 1.4f;
                    } else if ("chorus".equals(id)) {
                        float rate = st.params.length > 0 ? st.params[0] : 0.8f;
                        float cdepth = st.params.length > 1 ? st.params[1] : 0.3f;
                        chorusPhase += rate / SAMPLE_RATE * Math.PI * 2;
                        int dn = fxDelayBuf.length;
                        int offset = (int) ((0.006 + 0.006 * cdepth * (0.5f + 0.5f * Math.sin(chorusPhase))) * SAMPLE_RATE);
                        int read = (fxDelayIdx - offset + dn) % dn;
                        float del = fxDelayBuf[read];
                        fxDelayWrite = out;
                        out = out * (1f - depth * 0.5f) + del * depth * 0.5f;
                        fxDelayWet = 1f;
                    } else if ("compressor".equals(id)) {
                        float threshold = (float) Math.pow(10.0, (st.params.length > 0 ? st.params[0] : -18f) / 20.0);
                        float ratio = st.params.length > 1 ? Math.max(1f, st.params[1]) : 4f;
                        float av = Math.abs(out);
                        if (av > threshold) {
                            float compressed = threshold + (av - threshold) / ratio;
                            out = Math.signum(out) * (out * (1f - depth) + compressed * depth);
                        }
                    } else if ("air".equals(id)) {
                        float amount = st.params.length > 0 ? st.params[0] : 0.08f;
                        float tone = st.params.length > 1 ? st.params[1] : 0.55f;
                        noiseState ^= (noiseState << 13); noiseState ^= (noiseState >>> 7); noiseState ^= (noiseState << 17);
                        float nz = (noiseState & 0xFFFF) / 32768f - 1f;
                        airState += (0.04f + tone * 0.75f) * (nz - airState);
                        out += airState * amount * depth * inputActivity;
                    }
                }
                int dn = fxDelayBuf.length;
                if (fxDelayWet > 0.001f) {
                    fxDelayBuf[fxDelayIdx] = fxDelayWrite;
                } else if (fxDelayBuf[fxDelayIdx] != 0f) {
                    fxDelayBuf[fxDelayIdx] = 0f;
                }
                fxDelayIdx = (fxDelayIdx + 1) % dn;
                return out;
            }
        }
    }
}
