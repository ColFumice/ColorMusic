package com.colormusic.game;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Process;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * AudioSynth —— 实时音频合成器（方案 A：AudioTrack 流式输出，无需第三方库）。
 *
 * 采样率 44100Hz、单声道、16bit PCM，独立渲染线程按 512 采样/块混合所有活跃音符。
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
 * 最大复音数默认 8（持续音符不受淘汰），超出时替换最旧的非持续音符。
 */
public class AudioSynth {

    private static final String TAG = "ColorMusicSynth";
    private static final int SAMPLE_RATE = 44100;
    private static final int CHUNK = 512;
    private static final int MAX_VOICES_DEFAULT = 8;
    /** 末端使用约 8ms 的平滑窗，保证最后一个 PCM 采样精确回到零。 */
    private static final int DECLICK_SAMPLES = Math.max(2, SAMPLE_RATE * 8 / 1000);
    /** 波表长度（单周期采样点数）。 */
    public static final int WAVE_N = 256;
    /** 三个通道的波表（0=R弦乐、1=G笛、2=B钢琴/铃），默认正弦波。 */
    private static float[][] wavetables = new float[3][WAVE_N];

    static {
        for (int ch = 0; ch < 3; ch++) {
            for (int i = 0; i < WAVE_N; i++) {
                wavetables[ch][i] = (float) Math.sin(2.0 * Math.PI * i / WAVE_N);
            }
        }
    }

    /** 设置通道波表（0=R、1=G、2=B），长度须为 WAVE_N。 */
    public static void setWavetable(int channel, float[] wave) {
        if (channel < 0 || channel > 2 || wave == null) return;
        int n = Math.min(wave.length, WAVE_N);
        for (int i = 0; i < n; i++) wavetables[channel][i] = wave[i];
        for (int i = n; i < WAVE_N; i++) wavetables[channel][i] = wavetables[channel][i - n];
        Log.i(TAG, "setWavetable ch=" + channel + " n=" + n);
    }

    /** 波表读取：相位 0~1 → 波形采样（线性插值）。 */
    private static float wt(int ch, double ph) {
        double f = (ph - Math.floor(ph)) * WAVE_N;
        int i0 = (int) f;
        int i1 = (i0 + 1) % WAVE_N;
        float a = wavetables[ch][i0];
        float b = wavetables[ch][i1];
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

    /** 黑鼓（RGB 全 <55）/ 白鼓（RGB 全 >200）的元素 id（808 鼓组）。 */
    private static volatile String drumBlack = "kick";
    private static volatile String drumWhite = "snare";

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

    private int activeVoiceCount() {
        int count = 0;
        for (Voice v : voices) if (!v.isDeClicking()) count++;
        return count;
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
        short[] buf = new short[CHUNK];
        while (running) {
            synchronized (voiceLock) {
                java.util.Arrays.fill(buf, (short) 0);
                for (Voice v : voices) {
                    v.render(buf, CHUNK);
                }
                // 清理已结束的音符（释放后的持续音符 remaining 会递减到 0）
                voices.removeIf(v -> v.remaining <= 0);
            }
            syncOutputFx();
            for (int i = 0; i < CHUNK; i++) {
                float dry = buf[i] / 32767f;
                float wet = outputChain.process(dry, 440.0 / SAMPLE_RATE, outputSampleClock / (float) SAMPLE_RATE);
                buf[i] = (short) ((float) Math.tanh(wet) * 0.95f * 32767f);
                outputSampleClock++;
            }
            if (track != null) {
                track.write(buf, 0, CHUNK);
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
                AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        int bufSize = Math.max(minBuf, SAMPLE_RATE / 10);
        if (Build.VERSION.SDK_INT >= 23) {
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_GAME)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build();
            AudioFormat fmt = new AudioFormat.Builder()
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .build();
            return new AudioTrack.Builder()
                    .setAudioAttributes(attrs)
                    .setAudioFormat(fmt)
                    .setBufferSizeInBytes(bufSize * 2)
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build();
        } else {
            @SuppressWarnings("deprecation")
            AudioTrack t = new AudioTrack(
                    AudioManager.STREAM_MUSIC, SAMPLE_RATE,
                    AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
                    bufSize * 2, AudioTrack.MODE_STREAM);
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
        private double step;
        private float attack;       // 音头时间（alpha 控制）
        private float release;      // 释放时间
        private int totalSamples;
        private int elapsed = 0;
        private int remaining;
        private boolean sustained;
        private boolean releasing = false;
        private boolean deClicking = false;
        private float releaseStartLevel = 1f;
        private float adsrReleaseStartLevel = 1f;

        boolean isSustained() {
            return sustained && !releasing;
        }

        boolean isDeClicking() {
            return deClicking;
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
            gStr = r01;
            gFlu = g01;
            gBell = b01;
            // 自适应归一化：避免颜色特别亮时爆音
            sumNorm = 1f / Math.max(1f, r01 + g01 + b01);

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

            // 音头力度（新 alpha=均匀度）：均匀（灰）→ 快起音
            attack = 0.2f + (0.005f - 0.2f) * even;
            release = (0.15f + (1f - even) * 0.25f) * decayScale;
            vibratoRate = 5f + even * 2f;

            amp = Math.min(1f, Math.max(0.001f, volume));
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
                return adsrReleaseStartLevel * (1f - rt) * (1f - rt);
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
            if (releasing) return;
            float t = (float) elapsed / SAMPLE_RATE;
            releaseStartLevel = overallEnv(t);
            adsrReleaseStartLevel = adsrEnv(t);
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

        /** 向 buf 中混合本音符的采样。 */
        void render(short[] buf, int count) {
            int n = Math.min(count, remaining);
            for (int i = 0; i < n; i++) {
                float t = (float) elapsed / SAMPLE_RATE;

                // 三个声部（各带自己的包络特征；先经各自通道的全局效果器塑形，再按通道增益混合）
                float string = stringPart(t);
                float flute = flutePart(t);
                float bell = bellPart(t);
                if (gStr > 0.0005f) string = globalFx[0].process(string, step, t);
                if (gFlu > 0.0005f) flute = globalFx[1].process(flute, step, t);
                if (gBell > 0.0005f) bell = globalFx[2].process(bell, step, t);
                float base = (string * gStr + flute * gFlu + bell * gBell) * sumNorm * pitchGain;

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

                float mixedSample = buf[i] + sample * 32767f;
                float x = mixedSample / 32767f;
                float clipped = (float) Math.tanh(x) * 0.95f;
                buf[i] = (short) (clipped * 32767f);

                phase += step;
                vibratoPhase += vibratoRate / SAMPLE_RATE * Math.PI * 2;
                elapsed++;
            }
            remaining -= n;
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

        /** 808 鼓组元素采样（黑/白鼓可选）。 */
        private float drumSample(String id, float t) {
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
            float atk = Math.min(1f, t / 0.18f); // 慢起音（弓触弦渐入）
            return (float) stringLpState * atk;
        }

        /** 笛声部：G 通道波表 + 起音呼吸噪声 + 轻微颤音。 */
        private float flutePart(float t) {
            float tone = presenceEnhancedWave(1);
            // 轻微空气柱颤音（AM，4.5Hz 左右，很浅）
            float trem = 1f + 0.012f * (float) Math.sin(vibratoPhase * 0.7);
            float atk = Math.min(1f, t / 0.05f);
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
            float fundamental = wt(channel, phase);
            if (lowPresence <= 0.0001f) return fundamental;
            float harmonics = wt(channel, phase * 2.0) * 0.30f + wt(channel, phase * 3.0) * 0.10f;
            return (fundamental + harmonics * lowPresence) / (1f + 0.12f * lowPresence);
        }

        /** 总包络（attack 由 alpha 控制；release 从释放起点平滑淡出，避免爆破声）。 */
        private float overallEnv(float t) {
            if (sustained) {
                if (releasing) {
                    float base = releaseStartElapsed >= 0 ? releaseStartElapsed : elapsed;
                    float rt = (elapsed - base) / (release * SAMPLE_RATE);
                    if (rt >= 1f) return 0f;
                    return releaseStartLevel * (1f - rt) * (1f - rt);
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
