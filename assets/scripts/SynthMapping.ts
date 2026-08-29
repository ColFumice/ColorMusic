/**
 * SynthMapping.ts
 * 位置 → 音高/音量、颜色(ARGB) → 音色参数的映射规则（纯函数，无引擎依赖）。
 *
 * 玩法规则：
 *   - X 坐标（u，0~1，左→右）→ 音高：左低右高，映射到 MIDI 36(C2) ~ 96(C7)，共 5 个八度；
 *   - Y 坐标（vTop，0~1，下→上）→ 音量：下小上大，振幅 0.06 ~ 1.0；
 *   - R 通道 → 弦乐声部增益（锯齿波 + 低通 + 慢起音 + 颤音）；
 *   - G 通道 → 笛声部增益（正弦波 + 少量呼吸噪声）；
 *   - B 通道 → 钢琴/铃声部增益（基频 + 2/3 倍谐波，快起音 + 指数衰减）；
 *   - RGB 平均值 avg → 音色质感：浊厚↔清脆（全局低通截止、失真量、噪声混合）；
 *   - Alpha 通道 → 演奏表情：起音时间、混响/延迟量（JPEG 恒为 255，即“干、快起音”）。
 */

/** 一次“按键”的完整合成参数。 */
import { t as tr } from './I18n';

export interface NoteParams {
    r: number;      // 0~255 弦乐声部增益
    g: number;      // 0~255 笛声部增益
    b: number;      // 0~255 钢琴/铃声部增益
    a: number;      // 0~255 透明度（空间感/音头）
    freq: number;   // 基频 Hz
    volume: number; // 振幅 0~1
    durationMs: number;
}

/** 由颜色派生的全局音色处理参数（JS/原生共用同一套公式）。 */
export interface ToneParams {
    avg: number;     // RGB 平均值 0~1
    even: number;    // Pielou 均匀度（新 alpha，0~1；越灰越大）
    cutoff: number;  // 全局低通截止频率 Hz（1000 + avg*17000）
    drive: number;   // 失真强度（tanh 过载；暗色更多 + 均匀度越大越强；鼓组为 0）
    noiseMix: number;// 噪声混合比例（暗色少量暖噪声）
    attack: number;  // 音头时间（秒，新 alpha（均匀度）从 0→1 时 0.2→0.005）
    reverbMix: number; // 混响/回声量（均匀度与暗度共同决定）
    decayScale: number; // 衰减倍率（暗/透明/蓝 → 余音更长）
    sumNorm: number; // 自适应归一化系数 1/max(1, r+g+b)
    snareWeight: number; // 军鼓权重（RGB 全 >200，纯白=1）
    kickWeight: number;  // 底鼓权重（RGB 全 <55，纯黑=1）
    drumWeight: number;  // 鼓组总权重（snare 或 kick，取大者）
    psyRatio: number;    // 暗区 R：psy 震颤速度比（0~1）
    glitchRatio: number; // 暗区 G：glitch 卡顿比
    pulseRatio: number;  // 暗区 B：低频脉冲力度比
    reeseRatio: number;  // 亮区 R：reese 强度比
    laserRatio: number;  // 亮区 G：laser 强度比
    liquidRatio: number; // 亮区 B：liquid 强度比
}

/** Pielou 均匀度（香农均匀度）：J = H/Hmax，H = -Σ p·ln(p)，Hmax = ln3。纯色=0、灰色=1。 */
export function pielouEvenness(r: number, g: number, b: number): number {
    const rs = Math.max(0, Math.min(255, r));
    const gs = Math.max(0, Math.min(255, g));
    const bs = Math.max(0, Math.min(255, b));
    const sum = rs + gs + bs;
    if (sum < 1) return 1; // 纯黑：三个通道相等 → 均匀度视为 1
    let h = 0;
    for (const c of [rs, gs, bs]) {
        const p = c / sum;
        if (p > 0) h -= p * Math.log(p);
    }
    return Math.min(1, Math.max(0, h / Math.log(3)));
}

/** 由像素颜色(ARGB)派生全局音色处理参数（JS/原生共用同一套公式）。 */
export function toneFromARGB(r: number, g: number, b: number, a: number): ToneParams {
    const r01 = Math.min(1, Math.max(0, r / 255));
    const g01 = Math.min(1, Math.max(0, g / 255));
    const b01 = Math.min(1, Math.max(0, b / 255));
    const a01 = Math.min(1, Math.max(0, a / 255));
    const avg = (r01 + g01 + b01) / 3;
    const even = pielouEvenness(r, g, b); // 新 alpha：RGB 均匀度（JPEG 无真实 alpha）

    // 鼓组权重（snare 亮区 / kick 暗区，互斥）
    const allBright = r > 200 && g > 200 && b > 200;
    const allDark = r < 55 && g < 55 && b < 55;
    const snareWeight = allBright ? Math.min(1, Math.max(0, ((r + g + b) / 3 - 200) / 55)) : 0;
    const kickWeight = allDark ? Math.min(1, Math.max(0, (55 - (r + g + b) / 3) / 55)) : 0;
    const drumWeight = Math.max(snareWeight, kickWeight);

    // 特效比值：暗区只触发 RGB 最低通道对应的音效；亮区只触发 RGB 最高通道对应的音效
    let psyRatio = 0, glitchRatio = 0, pulseRatio = 0;
    if (allDark) {
        if (r <= g && r <= b) psyRatio = (55 - r) / 55;
        else if (g <= b) glitchRatio = (55 - g) / 55;
        else pulseRatio = (55 - b) / 55;
    }
    let reeseRatio = 0, laserRatio = 0, liquidRatio = 0;
    if (allBright) {
        if (r >= g && r >= b) reeseRatio = (r - 200) / 55;
        else if (g >= b) laserRatio = (g - 200) / 55;
        else liquidRatio = (b - 200) / 55;
    }
    // 鼓组激活时（纯白=纯军鼓、纯黑=纯底鼓）特效归零，避免叠加出怪音
    const effScale = 1 - drumWeight;
    psyRatio *= effScale;
    glitchRatio *= effScale;
    pulseRatio *= effScale;
    reeseRatio *= effScale;
    laserRatio *= effScale;
    liquidRatio *= effScale;

    // 失真：暗色更浊 + 均匀度越大（越灰）越强；鼓组不使用失真
    let drive = (1 - avg) * 0.3 + even * 0.25;
    drive *= 1 - drumWeight;

    return {
        avg,
        even,
        cutoff: 1000 + avg * 17000,          // 平均值大（亮色）→ 清脆（高截止）；小（暗色）→ 浊厚（低截止）
        drive,
        noiseMix: (1 - avg) * 0.03 * (1 - drumWeight), // 鼓组也不加噪声
        attack: 0.2 + (0.005 - 0.2) * even, // lerp(0.2, 0.005, 均匀度)
        // 混响量：均匀度低（1-even，色彩饱和）→ 越远越多回声；颜色越暗 → 空间越深
        reverbMix: (1 - even) * (0.6 + 0.4 * (1 - avg)),
        // 衰减倍率：颜色越暗、越透明、蓝色越强 → 余音越长
        decayScale: 0.6 + 1.2 * (1 - avg) + 0.5 * (1 - even) + 0.3 * b01,
        sumNorm: 1 / Math.max(1, r01 + g01 + b01),
        snareWeight, kickWeight, drumWeight,
        psyRatio, glitchRatio, pulseRatio, reeseRatio, laserRatio, liquidRatio,
    };
}

export const MIDI_MIN = 36;  // C2
export const MIDI_MAX = 96;  // C7

/** u(0~1, 左→右) → MIDI 音符号（四舍五入取最近半音）。 */
export function uvToMidi(u: number): number {
    const clamped = Math.min(1, Math.max(0, u));
    return MIDI_MIN + Math.round(clamped * (MIDI_MAX - MIDI_MIN));
}

/** MIDI 音符号 → 频率(Hz)，A4 = 440Hz。 */
export function midiToFreq(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12);
}

/** vTop(0~1, 下→上) → 音量振幅。 */
export function uvToVolume(vTop: number): number {
    const clamped = Math.min(1, Math.max(0, vTop));
    return 0.06 + clamped * 0.94;
}

/** MIDI 音符号 → 唱名，如 60 → 'C4'，61 → 'C#4'。 */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function midiToName(midi: number): string {
    const n = NOTE_NAMES[midi % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${n}${octave}`;
}

/** 由 u、vTop、颜色(ARGB)构造完整音符参数（音高/音量取自屏幕坐标，音色取自颜色）。 */
export function buildNoteParams(r: number, g: number, b: number, a: number, u: number, vTop: number): NoteParams {
    const midi = uvToMidi(u);
    return {
        r: Math.round(r), g: Math.round(g), b: Math.round(b), a: Math.round(a),
        freq: midiToFreq(midi),
        volume: uvToVolume(vTop),
        durationMs: 280,
    };
}

/** 简单文本摘要：R/G/B 混合比例 + 亮度质感 + 鼓组（用于信息栏；旧版自动特效已改为手动效果器槽位，不再显示）。 */
export function colorToneSummary(r: number, g: number, b: number, a: number): string {
    const t = toneFromARGB(r, g, b, a);
    const str = (x: number) => Math.round(x * 100);
    const thick = t.avg > 0.5 ? tr('清脆') : (t.avg > 0.2 ? tr('中等') : tr('浊厚'));
    let extra = '';
    if (t.drumWeight > 0.01) {
        extra = t.snareWeight > t.kickWeight ? tr('军鼓') + str(t.snareWeight) + '%' : tr('底鼓') + str(t.kickWeight) + '%';
    }
    return `R${str(r / 255)}% G${str(g / 255)}% B${str(b / 255)}% · ${thick}${extra}`;
}
