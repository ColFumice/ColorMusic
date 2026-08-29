import { sys } from 'cc';

export type AppLanguage = 'en' | 'zh';

const LANGUAGE_KEY = 'cm_language';
const DEFAULT_LANGUAGE: AppLanguage = 'en';

/** Static UI translations shared by all programmatically-created panels. */
const EN: Record<string, string> = {
    '选择图片': 'Choose Image', '测试音': 'Test Tone', '校准': 'Calibrate', '游玩说明': 'How to Play', '设置': 'Settings',
    '波表': 'Wavetable', '网格': 'Grid', '输出效果器': 'Output FX', '关闭': 'Close', '重置': 'Reset', '撤回': 'Undo',
    '随机生成': 'Randomize', '随机': 'Randomize', '经典预设': 'Classic Preset', '经典': 'Classic',
    '试听': 'Preview', '试听 R': 'Preview R', '试听 G': 'Preview G', '试听 B': 'Preview B',
    '全部重置': 'Reset All', '自定义': 'Custom', '无': 'None',
    '快速开始': 'Quick Start', '触摸演奏': 'Touch Performance', '颜色与音色': 'Color & Timbre',
    '波表编辑器': 'Wavetable Editor', '效果器': 'Effects', '菜单与校准': 'Menu & Calibration',
    '网格设置': 'Grid Settings', '显示网格线': 'Show Grid Lines', '显示音色提示': 'Show Tone Info',
    '横线颜色': 'Horizontal Color', '横线透明度': 'Horizontal Opacity', '竖线颜色': 'Vertical Color', '竖线透明度': 'Vertical Opacity',
    '左右音阶范围（MIDI）': 'Pitch Range (MIDI)', '上下音量范围（%）': 'Volume Range (%)',
    '横向疏密（列）': 'Horizontal Density (Cols)', '纵向疏密（行）': 'Vertical Density (Rows)', '输入': 'Enter',
    '黑': 'Black', '白': 'White', '红': 'Red', '黄': 'Yellow', '绿': 'Green', '蓝': 'Blue', '青': 'Cyan', '紫': 'Purple',
    '钢琴': 'Piano', '铃': 'Bell', '小提琴': 'Violin', '大提琴': 'Cello', '长笛': 'Flute', '短笛': 'Piccolo',
    '贝斯': 'Bass', '吉他': 'Guitar', '萨克斯': 'Saxophone', '长号': 'Trombone', '人声': 'Voice',
    '808 底鼓': 'Kick', '808 军鼓': 'Snare', '808 拍手': 'Clap',
    '808 踩镲': 'Hi-hat', '808 通鼓': 'Tom', '808 沙锤': 'Maracas',
    '暗震颤': 'Dark Tremolo', '卡顿': 'Glitch Gate', '低频脉冲': 'Sub Pulse', '失谐叠加': 'Reese Detune',
    '激光扫频': 'Laser Sweep', '液态摆动': 'Liquid Motion', '失真': 'Distortion', '滤波器': 'Filter', '包络器': 'Envelope',
    '混响': 'Reverb', '延迟': 'Delay', '合唱': 'Chorus', '压缩器': 'Compressor', '气息/擦弦': 'Air / Bow Noise',
    '震颤速度': 'Tremolo Rate', '占空比': 'Duty Cycle', '脉冲频率': 'Pulse Frequency', '失谐量': 'Detune',
    '扫频范围': 'Sweep Range', '摆动速率': 'Motion Rate', '干湿混合': 'Dry / Wet', '攻击时长': 'Attack Time',
    '释放时长': 'Release Time', '空间大小': 'Room Size', '延迟时间': 'Delay Time', '反馈': 'Feedback',
    '速率': 'Rate', '深度': 'Depth', '阈值(dB)': 'Threshold (dB)', '压缩比': 'Ratio', '噪声量': 'Noise Amount', '明亮度': 'Brightness',
    '反向': 'Invert', '效果强度': 'Effect Intensity',
    '选中后点击此槽内的文本即可设置此效果器': 'After selecting, tap the text in this slot to edit the effect.',
    'EQ 曲线：手指绘制（中间=平直，上=增益，下=衰减）': 'EQ curve: draw with your finger (center=flat, up=boost, down=cut)',
    'ADSR 包络：绘制——从 0 快升到峰值→衰减→保持→释放；横轴时间、纵轴电平': 'ADSR envelope: draw attack, decay, sustain and release; X=time, Y=level',
    '输出效果器 · RGB 合成后的最终 4 槽串联处理': 'Output FX · Four serial slots after RGB mixing',
    '波表编辑器 · RGB 三通道基础波形（256 点 · 自动保存）': 'Wavetable Editor · RGB base waves (256 points · autosaved)',
    'R 高（>200）': 'R High (>200)', 'R 低（<55）': 'R Low (<55)', 'G 高（>200）': 'G High (>200)', 'G 低（<55）': 'G Low (<55)',
    'B 高（>200）': 'B High (>200)', 'B 低（<55）': 'B Low (<55)', '灰效（均匀度）': 'Gray FX (Evenness)', '均效（平均值）': 'Mean FX (Average)',
    '全局 R 1': 'Global R 1', '全局 R 2': 'Global R 2', '全局 R 3': 'Global R 3', '全局 R 4': 'Global R 4',
    '全局 G 1': 'Global G 1', '全局 G 2': 'Global G 2', '全局 G 3': 'Global G 3', '全局 G 4': 'Global G 4',
    '全局 B 1': 'Global B 1', '全局 B 2': 'Global B 2', '全局 B 3': 'Global B 3', '全局 B 4': 'Global B 4',
    '槽位作用：当 RGB 值同时超出 200 且该颜色为最大值时触发此下拉所选的效果。': 'Trigger: all RGB values are above 200 and this channel is the largest.',
    '槽位作用：当 RGB 值同时低于 55 且该颜色为最小值时触发此下拉所选的效果。': 'Trigger: all RGB values are below 55 and this channel is the smallest.',
    '槽位作用：由 RGB 三通道的香农均匀度（越灰越趋近 1）控制触发此下拉所选的效果。': 'Trigger depth follows RGB Shannon evenness; neutral gray approaches 1.',
    '槽位作用：由 RGB 三通道的平均值（越亮越大）控制触发此下拉所选的效果。': 'Trigger depth follows the RGB average; brighter pixels produce a larger value.',
    '槽位作用：无触发条件，恒定处理 R 通道音色；多个槽位按显示顺序串联。': 'Always processes the R channel. Multiple slots run in display order.',
    '槽位作用：无触发条件，恒定处理 G 通道音色；多个槽位按显示顺序串联。': 'Always processes the G channel. Multiple slots run in display order.',
    '槽位作用：无触发条件，恒定处理 B 通道音色；多个槽位按显示顺序串联。': 'Always processes the B channel. Multiple slots run in display order.',
    '清脆': 'Bright', '中等': 'Balanced', '浊厚': 'Warm', '军鼓': ' Snare ', '底鼓': ' Kick ',
    '波表编辑器：绘制波形或拖动坐标轴实时塑形': 'Wavetable Editor: draw waves or drag the axes to shape them live',
    '合成器尚未就绪，请稍候再试': 'The synthesizer is not ready yet. Please try again shortly.',
    '测试音 C5（松开停止）': 'Test tone C5 (release to stop)',
    '波表编辑器：在色块上滑动绘制 R/G/B 基础波形（横线=静音，自绘振幅）': 'Wavetable Editor: draw the RGB base waves (center line=silence)',
    '已关闭波表编辑器': 'Wavetable Editor closed', '没有可撤回的操作': 'Nothing to undo', '已撤回上一步操作': 'Last operation undone',
    '已全部重置（波形=正弦、预设=自定义、效果器=无、鼓=kick/snare）': 'Reset complete (sine waves, Custom presets, no effects, kick/snare drums)',
    '已关闭游玩说明': 'How to Play closed', '输出效果器没有可撤回的操作': 'No Output FX operation to undo',
    '已打开系统图片选择器…': 'System image picker opened…', '正在加载图片…': 'Loading image…', '请先选择一张图片！': 'Choose an image first!',
};

export function getLanguage(): AppLanguage {
    try { return sys.localStorage.getItem(LANGUAGE_KEY) === 'zh' ? 'zh' : DEFAULT_LANGUAGE; }
    catch (e) { return DEFAULT_LANGUAGE; }
}

export function isEnglish(): boolean { return getLanguage() === 'en'; }

export function setLanguage(language: AppLanguage) {
    try { sys.localStorage.setItem(LANGUAGE_KEY, language); } catch (e) { /* ignore */ }
}

export function toggleLanguage(): AppLanguage {
    const next: AppLanguage = isEnglish() ? 'zh' : 'en';
    setLanguage(next);
    return next;
}

/** Translate a Chinese source string, optionally using an explicit English version. */
export function t(chinese: string, english?: string): string {
    if (!isEnglish()) return chinese;
    return english ?? EN[chinese] ?? chinese;
}
