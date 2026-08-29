/**
 * Effects.ts
 * 效果器插件库 + 槽位配置（8 个槽位：6 个颜色槽 + 灰效(均匀度) + 均效(平均值)）。
 * - 插件库共享给所有槽位；
 * - 每个槽位：插件 id、反向勾选、效果强度、专属参数、绘制曲线（EQ/ADSR）；
 * - 配置持久化到 localStorage，启动时自动加载并推送给原生合成器。
 *
 * 触发器输入（0..1）：
 *   0..5  R高/R低/G高/G低/B高/B低 —— 通道色 >200 → (ch-200)/55；<55 → (55-ch)/55
 *   6     灰效 —— RGB 香农均匀度（Pielou evenness，灰色趋近 1）
 *   7     均效 —— RGB 平均值 (r+g+b)/(3*255)
 */

import { sys } from 'cc';

export const FX_TRIGGERED_COUNT = 8;
export const FX_GLOBAL_CHANNELS = 3;
export const FX_GLOBAL_SLOTS_PER_CHANNEL = 4;
export const FX_SLOT_COUNT = FX_TRIGGERED_COUNT + FX_GLOBAL_CHANNELS * FX_GLOBAL_SLOTS_PER_CHANNEL;

/** 全局效果器槽位起始下标（8=全局R、9=全局G、10=全局B）。 */
export const FX_GLOBAL_BASE = FX_TRIGGERED_COUNT;

export function globalFxIndex(channel: number, slot: number): number {
    return FX_GLOBAL_BASE + channel * FX_GLOBAL_SLOTS_PER_CHANNEL + slot;
}

/** 槽位名称（UI 显示）。 */
export const FX_SLOT_NAMES = [
    'R 高（>200）', 'R 低（<55）', 'G 高（>200）', 'G 低（<55）',
    'B 高（>200）', 'B 低（<55）', '灰效（均匀度）', '均效（平均值）',
    '全局 R 1', '全局 R 2', '全局 R 3', '全局 R 4',
    '全局 G 1', '全局 G 2', '全局 G 3', '全局 G 4',
    '全局 B 1', '全局 B 2', '全局 B 3', '全局 B 4',
];

/** 槽位本身触发条件说明（下拉展开时显示）。 */
export const FX_SLOT_CONCEIT = [
    '槽位作用：当 RGB 值同时超出 200 且该颜色为最大值时触发此下拉所选的效果。',
    '槽位作用：当 RGB 值同时低于 55 且该颜色为最小值时触发此下拉所选的效果。',
    '槽位作用：当 RGB 值同时超出 200 且该颜色为最大值时触发此下拉所选的效果。',
    '槽位作用：当 RGB 值同时低于 55 且该颜色为最小值时触发此下拉所选的效果。',
    '槽位作用：当 RGB 值同时超出 200 且该颜色为最大值时触发此下拉所选的效果。',
    '槽位作用：当 RGB 值同时低于 55 且该颜色为最小值时触发此下拉所选的效果。',
    '槽位作用：由 RGB 三通道的香农均匀度（越灰越趋近 1）控制触发此下拉所选的效果。',
    '槽位作用：由 RGB 三通道的平均值（越亮越大）控制触发此下拉所选的效果。',
    ...new Array(4).fill('槽位作用：无触发条件，恒定处理 R 通道音色；多个槽位按显示顺序串联。'),
    ...new Array(4).fill('槽位作用：无触发条件，恒定处理 G 通道音色；多个槽位按显示顺序串联。'),
    ...new Array(4).fill('槽位作用：无触发条件，恒定处理 B 通道音色；多个槽位按显示顺序串联。'),
];

/** 效果器插件定义。 */
export interface FxDef {
    id: string;
    label: string;
    /** 专属滑块参数：key/名称/范围/默认值。 */
    sliders?: { key: string; label: string; min: number; max: number; def: number }[];
    /** 可绘制曲线类型（filter=EQ 16 点；env=ADSR 32 点）。 */
    curveType?: 'eq' | 'adsr';
}

/** 一个效果器槽位的配置。 */
export interface FxSlot {
    id: string;
    invert: boolean;
    intensity: number;               // 0..1 效果强度
    params: Record<string, number>;  // 专属参数
    curve: number[];                 // 绘制曲线（EQ: 16 点 0..1；ADSR: 32 点 0..1）
}

/** 插件库（共享）：无 + 原来 9 种 + 新增混响/延迟/合唱。 */
export const FX_LIBRARY: FxDef[] = [
    { id: 'none', label: '无' },
    { id: 'psy', label: '暗震颤', sliders: [{ key: 'rate', label: '震颤速度', min: 0.5, max: 20, def: 8 }] },
    { id: 'glitch', label: '卡顿', sliders: [{ key: 'duty', label: '占空比', min: 0.1, max: 0.9, def: 0.5 }] },
    { id: 'pulse', label: '低频脉冲', sliders: [{ key: 'freq', label: '脉冲频率', min: 20, max: 150, def: 55 }] },
    { id: 'reese', label: '失谐叠加', sliders: [{ key: 'detune', label: '失谐量', min: 0.2, max: 4, def: 1.2 }] },
    { id: 'laser', label: '激光扫频', sliders: [{ key: 'sweep', label: '扫频范围', min: 0.5, max: 3, def: 1.6 }] },
    { id: 'liquid', label: '液态摆动', sliders: [{ key: 'rate', label: '摆动速率', min: 0.2, max: 8, def: 0.8 }] },
    { id: 'dist', label: '失真' },
    {
        id: 'filter', label: '滤波器', curveType: 'eq',
        sliders: [{ key: 'mix', label: '干湿混合', min: 0, max: 1, def: 1 }],
    },
    {
        id: 'env', label: '包络器', curveType: 'adsr',
        sliders: [
            { key: 'atkT', label: '攻击时长', min: 0.05, max: 0.6, def: 0.1 },
            { key: 'relT', label: '释放时长', min: 0.05, max: 1.5, def: 0.3 },
        ],
    },
    { id: 'reverb', label: '混响', sliders: [{ key: 'size', label: '空间大小', min: 0.05, max: 1, def: 0.5 }] },
    {
        id: 'delay', label: '延迟',
        sliders: [
            { key: 'time', label: '延迟时间', min: 0.05, max: 0.5, def: 0.18 },
            { key: 'feedback', label: '反馈', min: 0, max: 0.9, def: 0.4 },
        ],
    },
    {
        id: 'chorus', label: '合唱',
        sliders: [
            { key: 'rate', label: '速率', min: 0.1, max: 8, def: 0.8 },
            { key: 'depth', label: '深度', min: 0.05, max: 1, def: 0.3 },
        ],
    },
    {
        id: 'compressor', label: '压缩器',
        sliders: [
            { key: 'threshold', label: '阈值(dB)', min: -36, max: -3, def: -18 },
            { key: 'ratio', label: '压缩比', min: 1, max: 12, def: 4 },
        ],
    },
    {
        id: 'air', label: '气息/擦弦',
        sliders: [
            { key: 'amount', label: '噪声量', min: 0, max: 0.35, def: 0.08 },
            { key: 'tone', label: '明亮度', min: 0, max: 1, def: 0.55 },
        ],
    },
];

export function fxDefOf(id: string): FxDef {
    return FX_LIBRARY.find((d) => d.id === id) ?? FX_LIBRARY[0];
}

export function fxLabelOf(id: string): string {
    return fxDefOf(id).label;
}

/** 生成某插件的默认参数。 */
export function defaultParams(id: string): Record<string, number> {
    const def = fxDefOf(id);
    const p: Record<string, number> = {};
    if (def.sliders) for (const s of def.sliders) p[s.key] = s.def;
    return p;
}

/** 默认曲线：EQ 平直（0.5，即 0dB）；ADSR 一尖锐峰（快攻击→衰减→平稳→快释放）。 */
export function defaultCurve(id: string): number[] {
    if (fxDefOf(id).curveType === 'adsr') {
        const c: number[] = [];
        for (let i = 0; i < 32; i++) {
            const x = i / 31;
            // max 处 ~0.15
            const peak = Math.exp(-Math.pow((x - 0.15) / 0.07, 2));
            const tail = 0.45 * Math.exp(-Math.pow((x - 0.72) / 0.22, 2));
            const rel = x > 0.82 ? (1 - (x - 0.82) / 0.18) * 0.6 : 0.6;
            const v = Math.max(peak, tail) * rel;
            c.push(Math.max(0, Math.min(1, v)));
        }
        return c;
    }
    return new Array(16).fill(0.5);
}

/** 新建一个槽位配置（默认：无 / 强度 0.5 / 参数默认 / 曲线默认）。 */
export function newSlot(id: string): FxSlot {
    return { id, invert: false, intensity: 0.5, params: defaultParams(id), curve: defaultCurve(id) };
}

/** 默认 11 槽：颜色槽=无；灰效=失真；均效=滤波器；全局 R/G/B=钢琴/长笛/铃推荐。 */
export function defaultSlots(): FxSlot[] {
    const s: FxSlot[] = [];
    for (let i = 0; i < FX_SLOT_COUNT; i++) {
        s.push(defaultSlotAt(i));
    }
    return s;
}

/** 从 localStorage 读取槽位配置；旧 11 槽会迁移为每通道 4 个全局槽。 */
export function loadFxSlots(): FxSlot[] {
    try {
        const raw = sys.localStorage.getItem('cm_fx_slots');
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                const migrated: any[] = arr.length <= 11
                    ? [...arr.slice(0, 8), arr[8], null, null, null, arr[9], null, null, null, arr[10], null, null, null]
                    : arr;
                const out: FxSlot[] = [];
                for (let i = 0; i < FX_SLOT_COUNT; i++) {
                    const it = migrated[i] as Partial<FxSlot>;
                    if (!it) { out.push(defaultSlotAt(i)); continue; }
                    const id = typeof it?.id === 'string' ? it.id : 'none';
                    out.push({
                        id,
                        invert: !!it?.invert,
                        intensity: Math.max(0, Math.min(1, Number(it?.intensity) || 0.5)),
                        params: { ...defaultParams(id), ...(it?.params ?? {}) },
                        curve: Array.isArray(it?.curve) && it.curve.length > 4 ? it.curve.map((v) => Math.max(0, Math.min(1, Number(v) || 0))) : defaultCurve(id),
                    });
                }
                return out;
            }
        }
    } catch (e) { /* 忽略 */ }
    return defaultSlots();
}

export function saveFxSlots(slots: FxSlot[]) {
    try { sys.localStorage.setItem('cm_fx_slots', JSON.stringify(slots)); } catch (e) { /* 忽略 */ }
}

/** 槽位配置 → 原生 JSON 字符串。 */
export function fxSlotsToJson(slots: FxSlot[]): string {
    return JSON.stringify(slots.map((s) => ({
        id: s.id,
        invert: s.invert ? 1 : 0,
        intensity: Math.max(0, Math.min(1, s.intensity)),
        params: s.params,
        curve: s.curve,
    })));
}

/* ---------------- 预设音色 → 推荐“全局效果器” ----------------
 * 每个乐器预设除替换该通道波表外，还会把对应通道的“全局效果器”槽位（无触发条件，作用于单色相）
 * 设为适合该音色的插件与参数，使试音时更贴近真实乐器声。
 */
export interface FxRecipe { id: string; intensity: number; params?: Record<string, number>; curve?: number[]; }

export const INST_GLOBAL_FX: Record<string, FxRecipe[]> = {
    piano: [
        { id: 'env', intensity: .88, params: { atkT: .06, relT: .55 } },
        { id: 'filter', intensity: .42, params: { mix: .72 }, curve: [.54,.56,.58,.57,.55,.53,.51,.49,.47,.46,.45,.44,.43,.42,.40,.38] },
        { id: 'compressor', intensity: .30, params: { threshold: -16, ratio: 2.6 } },
        { id: 'reverb', intensity: .28, params: { size: .34 } },
    ],
    bell: [
        { id: 'filter', intensity: .48, params: { mix: .9 }, curve: [.42,.43,.45,.48,.52,.58,.64,.68,.70,.68,.64,.60,.56,.52,.48,.44] },
        { id: 'chorus', intensity: .22, params: { rate: .22, depth: .18 } },
        { id: 'delay', intensity: .22, params: { time: .24, feedback: .28 } },
        { id: 'reverb', intensity: .58, params: { size: .78 } },
    ],
    violin: [
        { id: 'filter', intensity: .50, params: { mix: .82 }, curve: [.48,.52,.57,.61,.63,.62,.60,.58,.56,.54,.52,.49,.46,.43,.40,.38] },
        { id: 'air', intensity: .16, params: { amount: .045, tone: .58 } },
        { id: 'chorus', intensity: .28, params: { rate: .45, depth: .20 } },
        { id: 'reverb', intensity: .38, params: { size: .44 } },
    ],
    cello: [
        { id: 'filter', intensity: .58, params: { mix: .9 }, curve: [.62,.64,.63,.60,.57,.53,.49,.46,.43,.40,.38,.36,.34,.32,.30,.28] },
        { id: 'air', intensity: .12, params: { amount: .035, tone: .35 } },
        { id: 'compressor', intensity: .30, params: { threshold: -20, ratio: 3.2 } },
        { id: 'reverb', intensity: .32, params: { size: .38 } },
    ],
    flute: [
        { id: 'filter', intensity: .46, params: { mix: .78 }, curve: [.40,.43,.48,.55,.60,.62,.60,.56,.51,.47,.44,.42,.40,.38,.36,.34] },
        { id: 'air', intensity: .25, params: { amount: .09, tone: .72 } },
        { id: 'compressor', intensity: .18, params: { threshold: -22, ratio: 2.0 } },
        { id: 'reverb', intensity: .36, params: { size: .50 } },
    ],
    piccolo: [
        { id: 'filter', intensity: .42, params: { mix: .8 }, curve: [.28,.30,.34,.40,.48,.56,.62,.66,.65,.61,.56,.51,.47,.43,.39,.35] },
        { id: 'air', intensity: .22, params: { amount: .075, tone: .88 } },
        { id: 'compressor', intensity: .16, params: { threshold: -20, ratio: 2.2 } },
        { id: 'reverb', intensity: .26, params: { size: .38 } },
    ],
    bass: [
        { id: 'filter', intensity: .62, params: { mix: .9 }, curve: [.68,.66,.62,.56,.50,.45,.41,.38,.35,.32,.30,.28,.27,.26,.25,.24] },
        { id: 'dist', intensity: .20 },
        { id: 'compressor', intensity: .55, params: { threshold: -24, ratio: 5.5 } },
        { id: 'none', intensity: 0 },
    ],
    guitar: [
        { id: 'env', intensity: .78, params: { atkT: .05, relT: .42 } },
        { id: 'filter', intensity: .38, params: { mix: .68 }, curve: [.48,.52,.58,.62,.63,.61,.57,.53,.50,.47,.44,.41,.38,.35,.32,.30] },
        { id: 'chorus', intensity: .24, params: { rate: .38, depth: .26 } },
        { id: 'reverb', intensity: .25, params: { size: .32 } },
    ],
    sax: [
        { id: 'filter', intensity: .48, params: { mix: .82 }, curve: [.46,.52,.60,.64,.62,.58,.55,.52,.49,.47,.45,.43,.41,.39,.36,.34] },
        { id: 'air', intensity: .18, params: { amount: .055, tone: .48 } },
        { id: 'dist', intensity: .12 },
        { id: 'reverb', intensity: .26, params: { size: .36 } },
    ],
    trombone: [
        { id: 'filter', intensity: .54, params: { mix: .88 }, curve: [.58,.62,.64,.61,.57,.54,.51,.49,.47,.45,.43,.41,.39,.37,.35,.33] },
        { id: 'air', intensity: .12, params: { amount: .035, tone: .36 } },
        { id: 'compressor', intensity: .28, params: { threshold: -18, ratio: 3.0 } },
        { id: 'reverb', intensity: .32, params: { size: .45 } },
    ],
    vox: [
        { id: 'filter', intensity: .52, params: { mix: .88 }, curve: [.40,.46,.55,.64,.68,.64,.58,.55,.58,.62,.58,.50,.44,.40,.37,.34] },
        { id: 'chorus', intensity: .16, params: { rate: .32, depth: .15 } },
        { id: 'compressor', intensity: .42, params: { threshold: -20, ratio: 3.5 } },
        { id: 'reverb', intensity: .30, params: { size: .42 } },
    ],
};

/** 某预设乐器对应的推荐全局效果器配置（FxSlot）。 */
export function recommendedGlobalFx(instId: string): FxSlot {
    const rec = INST_GLOBAL_FX[instId]?.[0];
    const id = rec?.id ?? 'none';
    const slot = newSlot(id);
    slot.intensity = rec?.intensity ?? 0.5;
    if (rec?.params) slot.params = { ...slot.params, ...rec.params };
    return slot;
}

export function recommendedGlobalFxChain(instId: string): FxSlot[] {
    const recipes = INST_GLOBAL_FX[instId] ?? [];
    const out: FxSlot[] = [];
    for (let i = 0; i < FX_GLOBAL_SLOTS_PER_CHANNEL; i++) {
        const rec = recipes[i];
        if (!rec) { out.push(newSlot('none')); continue; }
        const slot = newSlot(rec.id);
        slot.intensity = rec.intensity;
        if (rec.params) slot.params = { ...slot.params, ...rec.params };
        if (rec.curve) slot.curve = rec.curve.slice();
        out.push(slot);
    }
    return out;
}

export function loadOutputFxSlots(): FxSlot[] {
    try {
        const raw = sys.localStorage.getItem('cm_output_fx_slots');
        const arr = raw ? JSON.parse(raw) : [];
        return new Array(4).fill(0).map((_, i) => {
            const it = arr[i] as Partial<FxSlot> | undefined;
            if (!it) return newSlot('none');
            const id = typeof it.id === 'string' ? it.id : 'none';
            return {
                id, invert: !!it.invert,
                intensity: Math.max(0, Math.min(1, Number(it.intensity) || .5)),
                params: { ...defaultParams(id), ...(it.params ?? {}) },
                curve: Array.isArray(it.curve) && it.curve.length > 4 ? it.curve.slice() : defaultCurve(id),
            };
        });
    } catch (e) { return new Array(4).fill(0).map(() => newSlot('none')); }
}

export function saveOutputFxSlots(slots: FxSlot[]) {
    try { sys.localStorage.setItem('cm_output_fx_slots', JSON.stringify(slots.slice(0, 4))); } catch (e) { /* 忽略 */ }
}

/** 生成第 i 个槽位的默认配置（区别于 defaultSlots 的一次性数组）。 */
function defaultSlotAt(i: number): FxSlot {
    if (i === 6) return newSlot('dist');        // 灰效默认失真
    if (i === 7) return newSlot('filter');      // 均效默认滤波器
    return newSlot('none');                      // 其余（含全局 R/G/B）默认无，启动时按预设补足
}

/* ---------------- 音色预设（波表） ---------------- */

export interface InstDef {
    id: string;
    label: string;
    /** 谐波强度（index k-1 为第 k 次谐波，0..1）。 */
    harm: number[];
    desc: string;
}

/** 音色预设：11 种乐器 → 各通道基础波表。desc：作用 + 谐波合成算法说明。 */
export const PRESET_INST: InstDef[] = [
    { id: 'piano', label: '钢琴', harm: [1, .5, .33, .25, .2, .12, .08], desc: '作用：把该通道基础波表替换为钢琴音色（R/G/B 三通道的基波）。算法：基频+2/3/4/5 谐波按 1/k 衰减叠加为正弦叠幅，再归一化。' },
    { id: 'bell', label: '铃', harm: [0, .4, 1, .8, .6, .4, .25], desc: '作用：该通道基础波表→金属铃/钟音色。算法：高次(3/4/5)谐波强于基频叠加，突出明亮铃感。' },
    { id: 'violin', label: '小提琴', harm: [1, .6, .4, .3, .22, .15, .1], desc: '作用：该通道基础波表→圆润小提琴。算法：基频+谐波平缓衰减，柔和少棱角。' },
    { id: 'cello', label: '大提琴', harm: [1, .45, .3, .18, .1, .05], desc: '作用：该通道基础波表→温暖大提琴。算法：低频谐波权重大，高次极少，厚实低音。' },
    { id: 'flute', label: '长笛', harm: [1, .15, .05], desc: '作用：该通道基础波表→空灵长笛。算法：几乎纯基频+极轻重二次谐波。' },
    { id: 'piccolo', label: '短笛', harm: [.5, 1, .5, .3, .15], desc: '作用：该通道基础波表→高音短笛。算法：二次谐波为主，音域高而尖亮。' },
    { id: 'bass', label: '贝斯', harm: [1, .3, .15, .1, .05], desc: '作用：该通道基础波表→低频贝斯。算法：基频主导+少量低次谐波，深沉。' },
    { id: 'guitar', label: '吉他', harm: [1, .6, .4, .25, .18, .1], desc: '作用：该通道基础波表→拨弦吉他。算法：基频+2/3 次泛音较强，明亮拨弦感。' },
    { id: 'sax', label: '萨克斯', harm: [1, .35, .35, .2, .12], desc: '作用：该通道基础波表→smooth 管乐萨克斯。算法：奇次谐波较明显，略带方波感。' },
    { id: 'trombone', label: '长号', harm: [1, .5, .3, .18, .1], desc: '作用：该通道基础波表→铜管长号。算法：基频+平滑泛音，饱满圆润。' },
    { id: 'vox', label: '人声', harm: [1, .7, .5, .3, .2, .1], desc: '作用：该通道基础波表→近似人声共鸣。算法：基频+前几谐波强，近似元音叠加。' },
];

export function presetWaveFor(id: string): number[] {
    const inst = PRESET_INST.find((d) => d.id === id) ?? PRESET_INST[0];
    const w = new Array(256).fill(0);
    for (let k = 1; k <= inst.harm.length; k++) {
        const amp = inst.harm[k - 1];
        if (amp <= 0) continue;
        for (let i = 0; i < 256; i++) {
            w[i] += amp * Math.sin((2 * Math.PI * k * i) / 256);
        }
    }
    // 去直流 + 归一化
    let mean = 0;
    for (let i = 0; i < 256; i++) mean += w[i];
    mean /= 256;
    let maxA = 0;
    for (let i = 0; i < 256; i++) {
        w[i] -= mean;
        maxA = Math.max(maxA, Math.abs(w[i]));
    }
    if (maxA > 0) for (let i = 0; i < 256; i++) w[i] /= maxA;
    return w;
}

/* ---------------- 808 鼓组元素（黑鼓/白鼓） ---------------- */

export interface DrumDef {
    id: string;
    label: string;
    desc: string;
}

export const DRUM_808: DrumDef[] = [
    { id: 'kick', label: '808 底鼓', desc: '作用：该鼓（黑鼓=RGB全<55、白鼓=全>200）触发时播放的底鼓。算法：150→45Hz 正弦频率下扫+快速衰减。' },
    { id: 'snare', label: '808 军鼓', desc: '作用：该鼓触发时播放的军鼓。算法：带通噪声（相邻差分）+180Hz 音头，短促。' },
    { id: 'clap', label: '808 拍手', desc: '作用：该鼓触发时播放的拍手。算法：多段噪声脉冲（掌声感）。' },
    { id: 'hihat', label: '808 踩镲', desc: '作用：该鼓触发时播放的踩镲。算法：高通细噪声（微分）+快速衰减，清脆。' },
    { id: 'tom', label: '808 通鼓', desc: '作用：该鼓触发时播放的通鼓。算法：200→80Hz 频率下扫，中低频圆润。' },
    { id: 'maracas', label: '808 沙锤', desc: '作用：该鼓触发时播放的沙锤。算法：短促带通噪声，沙沙声。' },
];
