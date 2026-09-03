/**
 * NativeBridge.ts
 * JS ↔ Android 原生通信层（Cocos 3.8 的 native.reflection 反射桥）。
 *
 * 原生类：com.colormusic.game.NativeBridge（JNI 斜杠类名 + 方法签名，见各调用）
 *   - openImagePicker()                          打开系统图片选择器
 *   - playNote(int,int,int,int,float,float,float) 短音符（R,G,B,Alpha,频率,音量,时长ms）
 *   - noteOn(int,int,int,int,int,float,float)     持续音开始/原位更新（touchId,R,G,B,Alpha,频率,音量）
 *   - noteOff(int)                               释放持续音
 *   - playTestNote()                             播放测试音
 *   - setMaxVoices(int)                          设置最大复音数
 *
 * 音色模型（ARGB → 音色，与原生 AudioSynth 一致）：
 *   R/G/B → 弦乐/笛/钢琴铃 三声部混合增益；
 *   RGB 平均值 → 全局低通/失真/噪声（浊厚↔清脆）；
 *   Alpha → 音头力度与回声（空间感，JPEG 恒 255 → 干、快起音）。
 *
 * 原生 → JS 回调（evalString 注入全局函数）：
 *   - __colormusic_onImagePicked(json)  图片选择完成（含 RGBA 颜色网格 + 图片字节 base64）
 *   - __colormusic_synthReady = true    合成器就绪
 *
 * 非安卓环境（编辑器预览/浏览器）自动回退到 WebSynth（WebAudio 实时合成），保证桌面预览可玩。
 */
import { sys } from 'cc';
import { toneFromARGB } from './SynthMapping';

export interface PickedImageInfo {
    /** 应用缓存内的图片绝对路径（file:// 或 /data/...） */
    path: string;
    /** 图片宽（像素） */
    width: number;
    /** 图片高（像素） */
    height: number;
    /** 颜色网格宽 */
    gridW: number;
    /** 颜色网格高 */
    gridH: number;
    /** base64 编码的 RGBA 网格（gridW*gridH*4 字节，行序从上到下） */
    gridBase64: string;
    /** base64 编码的图片字节（JPEG，供 ImageAsset({_data}) 内存加载显示） */
    imageBase64?: string;
}

/** JNI 格式类名（斜杠分隔，Cocos 反射桥要求）。 */
export const NATIVE_CLASS = 'com/colormusic/game/NativeBridge';
export const JS_CALLBACK_NAME = '__colormusic_onImagePicked';
export const JS_SYNTH_READY_FLAG = '__colormusic_synthReady';
export const JS_TEXT_INPUT_CALLBACK = '__colormusic_onTextInput';
export const JS_STYLE_IMPORT_CALLBACK = '__colormusic_onStyleImported';
export const JS_CONFIRM_CALLBACK = '__colormusic_onConfirm';
export const JS_AUDIO_FORMAT_CALLBACK = '__colormusic_onAudioFormat';
export const JS_METRONOME_CALLBACK = '__colormusic_onMetronomeSettings';
export const JS_MIX_EXPORT_CALLBACK = '__colormusic_onMixExport';
export const JS_SAVE_ROOT_CALLBACK = '__colormusic_onSaveRootChosen';
export const JS_TRACK_EXPORT_CALLBACK = '__colormusic_onTrackExport';

export class NativeBridge {
    private static textCallbacks = new Map<string, (value: string) => void>();
    private static confirmCallbacks = new Map<string, (confirmed: boolean) => void>();
    private static audioFormatCallbacks = new Map<string, (format: 'wav' | 'mp3' | '') => void>();
    private static metronomeCallbacks = new Map<string, (beats: number, unit: number, bpm: number) => void>();
    private static mixExportCallbacks = new Map<string, (path: string) => void>();
    private static trackExportCallbacks = new Map<string, (value: { name: string; start: number; end: number } | null) => void>();
    private static saveRootCallback: ((path: string) => void) | null = null;
    private static styleImportCallback: ((json: string) => void) | null = null;
    /** 当前是否运行在原生环境（本项目只构建 Android，isNative 即安卓）。 */
    static get isAndroidNative(): boolean {
        return sys.isNative;
    }

    /** 注册原生 → JS 的图片回调。 */
    static registerImageCallback(cb: (info: PickedImageInfo) => void): void {
        const g = globalThis as any;
        g[JS_CALLBACK_NAME] = (json: string) => {
            try {
                const info: PickedImageInfo = JSON.parse(json);
                cb(info);
            } catch (e) {
                console.error('[ColorMusic] 解析原生图片回调失败:', e);
            }
        };
    }

    static registerUtilityCallbacks(): void {
        const g = globalThis as any;
        g[JS_TEXT_INPUT_CALLBACK] = (requestId: string, value: string) => {
            const cb = NativeBridge.textCallbacks.get(requestId);
            NativeBridge.textCallbacks.delete(requestId);
            if (cb) cb(value);
        };
        g[JS_STYLE_IMPORT_CALLBACK] = (json: string) => {
            const cb = NativeBridge.styleImportCallback;
            NativeBridge.styleImportCallback = null;
            if (cb) cb(json);
        };
        g[JS_CONFIRM_CALLBACK] = (requestId: string, confirmed: boolean) => {
            const cb = NativeBridge.confirmCallbacks.get(requestId);
            NativeBridge.confirmCallbacks.delete(requestId);
            if (cb) cb(confirmed === true);
        };
        g[JS_AUDIO_FORMAT_CALLBACK] = (requestId: string, format: string) => {
            const cb = NativeBridge.audioFormatCallbacks.get(requestId);
            NativeBridge.audioFormatCallbacks.delete(requestId);
            if (cb) cb(format === 'wav' || format === 'mp3' ? format : '');
        };
        g[JS_METRONOME_CALLBACK] = (requestId: string, beats: number, unit: number, bpm: number) => {
            const cb = NativeBridge.metronomeCallbacks.get(requestId);
            NativeBridge.metronomeCallbacks.delete(requestId);
            if (cb) cb(Number(beats), Number(unit), Number(bpm));
        };
        g[JS_MIX_EXPORT_CALLBACK] = (requestId: string, path: string) => {
            const cb = NativeBridge.mixExportCallbacks.get(requestId);
            NativeBridge.mixExportCallbacks.delete(requestId);
            if (cb) cb(String(path ?? ''));
        };
        g[JS_SAVE_ROOT_CALLBACK] = (path: string) => {
            const cb = NativeBridge.saveRootCallback; NativeBridge.saveRootCallback = null;
            if (cb) cb(String(path ?? ''));
        };
        g[JS_TRACK_EXPORT_CALLBACK] = (requestId: string, json: string) => {
            const cb = NativeBridge.trackExportCallbacks.get(requestId); NativeBridge.trackExportCallbacks.delete(requestId);
            if (!cb) return;
            try { const value = json ? JSON.parse(json) : null; cb(value && !value.error ? value : null); } catch (e) { cb(null); }
        };
    }

    static promptText(title: string, initial: string, cb: (value: string) => void): void {
        if (!NativeBridge.isAndroidNative) {
            const value = typeof globalThis.prompt === 'function' ? globalThis.prompt(title, initial) : initial;
            if (value !== null) cb(value);
            return;
        }
        const requestId = `text_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        NativeBridge.textCallbacks.set(requestId, cb);
        NativeBridge.call('promptText', '(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V', requestId, title, initial);
    }

    static promptMetronome(beats: number, unit: number, bpm: number, cb: (beats: number, unit: number, bpm: number) => void): void {
        if (!NativeBridge.isAndroidNative) {
            const value = typeof globalThis.prompt === 'function'
                ? globalThis.prompt('Metronome (signature, BPM)', `${beats}/${unit}, ${bpm}`) : `${beats}/${unit}, ${bpm}`;
            const match = value && /^\s*(\d+)\s*\/\s*(\d+)\s*[, ]+\s*(\d+)\s*$/.exec(value);
            if (match) cb(Number(match[1]), Number(match[2]), Number(match[3]));
            return;
        }
        const requestId = `metronome_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        NativeBridge.metronomeCallbacks.set(requestId, cb);
        NativeBridge.call('promptMetronome', '(Ljava/lang/String;III)V', requestId, Math.round(beats), Math.round(unit), Math.round(bpm));
    }

    static confirm(title: string, message: string, cb: (confirmed: boolean) => void): void {
        if (!NativeBridge.isAndroidNative) {
            cb(typeof globalThis.confirm === 'function' ? globalThis.confirm(message) : false);
            return;
        }
        const requestId = `confirm_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        NativeBridge.confirmCallbacks.set(requestId, cb);
        NativeBridge.call('confirmAction', '(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V', requestId, title, message);
    }

    static importStylePackage(cb: (json: string) => void): void {
        NativeBridge.styleImportCallback = cb;
        NativeBridge.call('openStyleImporter', '()V');
    }

    static exportStylePackage(fileName: string, json: string): string {
        if (!NativeBridge.isAndroidNative) return '';
        const ref = NativeBridge.reflection;
        try {
            const out = ref?.callStaticMethod(NATIVE_CLASS, 'exportStylePackage', '(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;', fileName, json);
            return typeof out === 'string' ? out : String(out ?? '');
        } catch (e) { console.error('[ColorMusic] exportStylePackage 失败:', e); return ''; }
    }

    static clearStylePackages(): number {
        if (!NativeBridge.isAndroidNative) return 0;
        try {
            const out = NativeBridge.reflection?.callStaticMethod(NATIVE_CLASS, 'clearStylePackages', '()I');
            return Number(out) || 0;
        } catch (e) { console.error('[ColorMusic] clearStylePackages 失败:', e); return -1; }
    }

    static openExportDirectory(): void {
        NativeBridge.call('openExportDirectory', '()V');
    }

    static chooseSaveRoot(cb: (path: string) => void): void {
        NativeBridge.saveRootCallback = cb;
        NativeBridge.call('chooseSaveRoot', '()V');
    }

    static getSaveRootLabel(): string {
        if (!NativeBridge.isAndroidNative) return 'Neuro_Save';
        try { return String(NativeBridge.reflection?.callStaticMethod(NATIVE_CLASS, 'getSaveRootLabel', '()Ljava/lang/String;') ?? 'Neuro_Save'); }
        catch (e) { return 'Neuro_Save'; }
    }

    static listManagedEntries(category: 'style' | 'flow' | 'track' | 'audio'): any[] {
        if (!NativeBridge.isAndroidNative) return [];
        try { const raw = NativeBridge.reflection?.callStaticMethod(NATIVE_CLASS, 'listManagedEntries', '(Ljava/lang/String;)Ljava/lang/String;', category); const value = JSON.parse(String(raw ?? '[]')); return Array.isArray(value) ? value : []; }
        catch (e) { console.error('[ColorMusic] listManagedEntries 失败:', e); return []; }
    }

    static saveManagedJson(category: 'style' | 'flow' | 'track', name: string, json: string): string {
        if (!NativeBridge.isAndroidNative) return '';
        try { return String(NativeBridge.reflection?.callStaticMethod(NATIVE_CLASS, 'saveManagedJson', '(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;', category, name, json) ?? ''); }
        catch (e) { console.error('[ColorMusic] saveManagedJson 失败:', e); return ''; }
    }

    static updateManagedJson(key: string, json: string): boolean {
        if (!NativeBridge.isAndroidNative) return false;
        try { return !!NativeBridge.reflection?.callStaticMethod(NATIVE_CLASS, 'updateManagedJson', '(Ljava/lang/String;Ljava/lang/String;)Z', key, json); }
        catch (e) { return false; }
    }

    static renameManagedEntry(key: string, name: string): string {
        if (!NativeBridge.isAndroidNative) return '';
        try { return String(NativeBridge.reflection?.callStaticMethod(NATIVE_CLASS, 'renameManagedEntry', '(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;', key, name) ?? ''); }
        catch (e) { return ''; }
    }

    static deleteManagedEntry(key: string): boolean {
        if (!NativeBridge.isAndroidNative) return false;
        try { return !!NativeBridge.reflection?.callStaticMethod(NATIVE_CLASS, 'deleteManagedEntry', '(Ljava/lang/String;)Z', key); }
        catch (e) { return false; }
    }

    static clearManagedCategory(category: 'style' | 'flow' | 'track' | 'audio'): number {
        if (!NativeBridge.isAndroidNative) return 0;
        try { return Number(NativeBridge.reflection?.callStaticMethod(NATIVE_CLASS, 'clearManagedCategory', '(Ljava/lang/String;)I', category)); }
        catch (e) { return -1; }
    }

    static openManagedDirectory(category: 'style' | 'flow' | 'track' | 'audio'): void {
        NativeBridge.call('openManagedDirectory', '(Ljava/lang/String;)V', category);
    }

    static promptTrackExport(defaultName: string, start: number, end: number, format: 'wav' | 'mp3', cb: (value: { name: string; start: number; end: number } | null) => void): void {
        const requestId = `track_export_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        NativeBridge.trackExportCallbacks.set(requestId, cb);
        NativeBridge.call('promptTrackExport', '(Ljava/lang/String;Ljava/lang/String;IILjava/lang/String;)V', requestId, defaultName, Math.round(start), Math.round(end), format);
    }

    static playManagedAudio(path: string, startSeconds: number): void { NativeBridge.call('playManagedAudio', '(Ljava/lang/String;I)V', path, Math.max(0, Math.round(startSeconds * 1000))); }
    static stopManagedAudio(): void { NativeBridge.call('stopManagedAudio', '()V'); }
    static convertManagedAudio(path: string, name: string, format: 'wav' | 'mp3'): string {
        if (!NativeBridge.isAndroidNative) return '';
        try { return String(NativeBridge.reflection?.callStaticMethod(NATIVE_CLASS, 'convertManagedAudio', '(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;', path, name, format) ?? ''); }
        catch (e) { return 'ERROR:音频转换失败'; }
    }

    static chooseAudioExportFormat(cb: (format: 'wav' | 'mp3' | '') => void): void {
        if (!NativeBridge.isAndroidNative) { cb(''); return; }
        const requestId = `audio_format_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        NativeBridge.audioFormatCallbacks.set(requestId, cb);
        NativeBridge.call('chooseAudioExportFormat', '(Ljava/lang/String;)V', requestId);
    }

    static exportAudio(path: string, name: string, format: 'wav' | 'mp3'): string {
        if (!NativeBridge.isAndroidNative) return '';
        const ref = NativeBridge.reflection;
        try {
            const out = ref?.callStaticMethod(NATIVE_CLASS, 'exportAudio', '(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;', path, name, format);
            return typeof out === 'string' ? out : String(out ?? '');
        } catch (e) { console.error('[ColorMusic] exportAudio 失败:', e); return ''; }
    }

    static mixAndExportAudio(clips: Array<{ path: string; enabled: boolean; volume: number; trimStart: number; trimEnd: number; duration: number; startBeat?: number; bpm?: number; speed?: number; volumeAutomation?: number[]; pitchAutomation?: number[]; panAutomation?: number[] }>, name: string, format: 'wav' | 'mp3'): string {
        if (!NativeBridge.isAndroidNative) return '';
        try {
            const out = NativeBridge.reflection?.callStaticMethod(NATIVE_CLASS, 'mixAndExportAudio',
                '(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;', JSON.stringify(clips), name, format);
            return typeof out === 'string' ? out : String(out ?? '');
        } catch (e) { console.error('[ColorMusic] mixAndExportAudio 失败:', e); return ''; }
    }

    static mixAndExportAudioAsync(clips: Array<{ path: string; enabled: boolean; volume: number; trimStart: number; trimEnd: number; duration: number; startBeat?: number; bpm?: number; speed?: number; volumeAutomation?: number[]; pitchAutomation?: number[]; panAutomation?: number[] }>, name: string, format: 'wav' | 'mp3', cb: (path: string) => void): void {
        if (!NativeBridge.isAndroidNative) { cb(''); return; }
        const requestId = `mix_export_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        NativeBridge.mixExportCallbacks.set(requestId, cb);
        NativeBridge.call('mixAndExportAudioAsync', '(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V', requestId, JSON.stringify(clips), name, format);
    }

    static showAudioExportResult(path: string): void {
        NativeBridge.call('showAudioExportResult', '(Ljava/lang/String;)V', path);
    }

    static playTimeline(blocks: Array<{ path: string; volume: number; trimStart: number; trimEnd: number; startBeat: number; speed?: number; trackId?: string; trackAudible?: boolean; volumeAutomation?: number[]; pitchAutomation?: number[]; panAutomation?: number[] }>, bpm: number): void {
        NativeBridge.call('playTimeline', '(Ljava/lang/String;I)V', JSON.stringify(blocks), Math.max(20, Math.min(320, Math.round(bpm))));
    }

    static setTimelineTrackAudibility(states: Record<string, boolean>): void {
        NativeBridge.call('setTimelineTrackAudibility', '(Ljava/lang/String;)V', JSON.stringify(states));
    }

    static consumeDebugPanel(): string {
        if (!NativeBridge.isAndroidNative) return '';
        try {
            const out = NativeBridge.reflection?.callStaticMethod(NATIVE_CLASS, 'consumeDebugPanel', '()Ljava/lang/String;');
            return typeof out === 'string' ? out : '';
        } catch (e) { return ''; }
    }

    /** 原生合成器是否已就绪（原生侧在 AudioSynth 启动后置 true）。 */
    static get synthReady(): boolean {
        if (!NativeBridge.isAndroidNative) return true;
        return (globalThis as any)[JS_SYNTH_READY_FLAG] === true;
    }

    /** 反射桥是否可用（兼容 native.reflection 与 jsb.reflection 两个全局别名）。 */
    static get reflectionAvailable(): boolean {
        return typeof NativeBridge.reflection?.callStaticMethod === 'function';
    }

    private static get reflection(): any {
        const g = globalThis as any;
        return g.native?.reflection ?? g.jsb?.reflection;
    }

    /**
     * 统一的反射调用入口：className(JNI 斜杠) + methodName + JNI 签名 + 参数。
     * 出错时打印错误（真机可用 adb logcat 查看）。
     */
    private static call(method: string, sig: string, ...args: any[]): void {
        if (!NativeBridge.isAndroidNative) return;
        const ref = NativeBridge.reflection;
        if (!ref?.callStaticMethod) {
            console.warn('[ColorMusic] native.reflection 不可用');
            return;
        }
        try {
            ref.callStaticMethod(NATIVE_CLASS, method, sig, ...args);
        } catch (e) {
            console.error(`[ColorMusic] callStaticMethod ${method} 失败:`, e);
        }
    }

    /** 打开系统图片选择器。 */
    static pickImage(): void {
        NativeBridge.call('openImagePicker', '()V');
    }

    /** 原生实时合成器播放一个短音符。第 4 个 int 为 Alpha（0~255）。 */
    static playNote(r: number, g: number, b: number, alpha: number, freq: number, volume: number, durationMs: number): void {
        NativeBridge.call('playNote', '(IIIIFFF)V',
            Math.round(r), Math.round(g), Math.round(b), Math.round(alpha),
            freq, volume, durationMs);
    }

    /** 持续音开始/原位更新（多指合奏：按 touchId 区分；滑音更新频率/音色/音量，相位连续）。第 5 个 int 为 Alpha。 */
    static noteOn(touchId: number, r: number, g: number, b: number, alpha: number, freq: number, volume: number): void {
        NativeBridge.call('noteOn', '(IIIIIFF)V',
            touchId, Math.round(r), Math.round(g), Math.round(b), Math.round(alpha),
            freq, volume);
    }

    /** 释放指定 touchId 的持续音。 */
    static noteOff(touchId: number): void {
        NativeBridge.call('noteOff', '(I)V', touchId);
    }

    static releaseAllNotes(): void {
        NativeBridge.call('releaseAllNotes', '()V');
    }

    static setMetronome(enabled: boolean, beatsPerBar: number, beatUnit: number, bpm = 120): void {
        NativeBridge.call('setMetronome', '(ZIII)V', !!enabled,
            Math.max(1, Math.min(32, Math.round(beatsPerBar))), Math.round(beatUnit),
            Math.max(20, Math.min(320, Math.round(bpm))));
    }

    /** Physical display density used to keep touch effects at a real-world size. */
    static displayPixelsPerCm(): number {
        if (!NativeBridge.isAndroidNative) return 96 / 2.54;
        try {
            const value = Number(NativeBridge.reflection?.callStaticMethod(NATIVE_CLASS, 'getDisplayPixelsPerCm', '()F'));
            return Number.isFinite(value) && value > 0 ? value : 96 / 2.54;
        } catch (e) { return 96 / 2.54; }
    }

    /** 播放一个 C5 测试音（验证 JS→原生 链路）。 */
    static playTestNote(): void {
        NativeBridge.call('playTestNote', '()V');
    }

    /** 设置原生合成器最大复音数。 */
    static setMaxVoices(n: number): void {
        NativeBridge.call('setMaxVoices', '(I)V', Math.max(1, Math.min(16, Math.round(n))));
    }

    /** 录制原生合成器最终输出，返回 WAV 文件路径。 */
    static startRecording(fileName: string): string {
        if (!NativeBridge.isAndroidNative) return '';
        const ref = NativeBridge.reflection;
        if (!ref?.callStaticMethod) return '';
        try {
            const out = ref.callStaticMethod(NATIVE_CLASS, 'startRecording', '(Ljava/lang/String;)Ljava/lang/String;', fileName);
            return typeof out === 'string' ? out : String(out ?? '');
        } catch (e) { console.error('[ColorMusic] startRecording 失败:', e); return ''; }
    }

    /** 停止录音并完成 WAV 文件头。 */
    static stopRecording(): string {
        if (!NativeBridge.isAndroidNative) return '';
        const ref = NativeBridge.reflection;
        if (!ref?.callStaticMethod) return '';
        try {
            const out = ref.callStaticMethod(NATIVE_CLASS, 'stopRecording', '()Ljava/lang/String;');
            return typeof out === 'string' ? out : String(out ?? '');
        } catch (e) { console.error('[ColorMusic] stopRecording 失败:', e); return ''; }
    }

    /** 同时播放多个录音片段，用于混音/循环播放。 */
    static playAudioFiles(clips: Array<string | { path: string; volume: number; trimStart: number; trimEnd: number; duration: number }>, loop: boolean): void {
        NativeBridge.call('playAudioFiles', '(Ljava/lang/String;Z)V', JSON.stringify(clips), !!loop);
    }

    /** 停止所有录音片段播放。 */
    static stopAudioFiles(): void {
        NativeBridge.call('stopAudioFiles', '()V');
    }

    /** 设置通道单周期波表及其周期倍率（0=R、1=G、2=B）。 */
    static setWavetable(channel: number, wave: number[], cycles = 1): void {
        const json = JSON.stringify(wave);
        NativeBridge.call('setWavetable', '(ILjava/lang/String;F)V', channel, json,
            Math.max(1, Math.min(8, cycles)));
    }

    /** 设置 8 个效果器插件槽位（JSON 字符串，见 Effects.fxSlotsToJson）。 */
    static setEffectSlots(json: string): void {
        NativeBridge.call('setEffectSlots', '(Ljava/lang/String;)V', json);
    }

    /** 设置 RGB 混音后的最终 4 槽输出效果链。 */
    static setOutputEffectSlots(json: string): void {
        NativeBridge.call('setOutputEffectSlots', '(Ljava/lang/String;)V', json);
    }

    /** 设置黑鼓/白鼓元素 id（808 鼓组：kick/snare/clap/hihat/tom/maracas）。 */
    static setDrumIds(black: string, white: string): void {
        NativeBridge.call('setDrumIds', '(Ljava/lang/String;Ljava/lang/String;)V', black, white);
    }

    static setChannelDrum(channel: number, id: string, volume: number, speed: number): void {
        NativeBridge.call('setChannelDrum', '(ILjava/lang/String;FF)V', Math.max(0, Math.min(2, Math.round(channel))), id,
            Math.max(0, Math.min(1.25, volume)), Math.max(.5, Math.min(2, speed)));
    }

    /** 保存启动幕布图片（base64 JPEG）到应用缓存目录，返回文件绝对路径；非原生/失败返回空串。 */
    static saveSplashImage(b64: string): string {
        if (!NativeBridge.isAndroidNative) return '';
        const ref = NativeBridge.reflection;
        if (!ref?.callStaticMethod) return '';
        try {
            const out = ref.callStaticMethod(NATIVE_CLASS, 'saveSplashImage', '(Ljava/lang/String;)Ljava/lang/String;', b64);
            return typeof out === 'string' ? out : String(out ?? '');
        } catch (e) {
            console.error('[ColorMusic] saveSplashImage 失败:', e);
            return '';
        }
    }

    static saveInvertedSplashImage(b64: string): string {
        if (!NativeBridge.isAndroidNative) return '';
        try {
            const out = NativeBridge.reflection?.callStaticMethod(NATIVE_CLASS, 'saveInvertedSplashImage', '(Ljava/lang/String;)Ljava/lang/String;', b64);
            return typeof out === 'string' ? out : String(out ?? '');
        } catch (e) { console.error('[ColorMusic] saveInvertedSplashImage failed:', e); return ''; }
    }
}

/* ------------------------------------------------------------------ */
/* WebAudio 回退合成器：仅用于编辑器预览/浏览器调试，真机走原生合成。   */
/* 音色规则与原生 Java 合成器一致（ARGB 三声部 + 全局质感 + Alpha）。  */
/* ------------------------------------------------------------------ */

interface SynthGraph {
    bus: GainNode;
    filter: BiquadFilterNode;
    shaper: WaveShaperNode;
    modGain: GainNode;
    sub: OscillatorNode;
    s1: OscillatorNode;
    s2: OscillatorNode;
    s3: OscillatorNode;
    s4: OscillatorNode;
    strGain: GainNode;
    strEnv: GainNode;
    f1: OscillatorNode;
    f2: OscillatorNode;
    fluteGain: GainNode;
    fluteEnv: GainNode;
    bellOscs: OscillatorNode[];
    bellGains: GainNode[];
    bellGain: GainNode;
    echo: DelayNode | null;
    echoMix: GainNode | null;
    echoFB: GainNode | null;
    noiseGain: GainNode | null;
    noiseSrc: AudioBufferSourceNode | null;
    drumBus: GainNode | null;
    drumNodes: (OscillatorNode | AudioBufferSourceNode)[];
    psyLfo: OscillatorNode | null;
    liqLfo: OscillatorNode | null;
    glLfo: OscillatorNode | null;
    reeseOsc: OscillatorNode | null;
    laserOsc: OscillatorNode | null;
    pulseOsc: OscillatorNode | null;
}

export class WebSynth {
    private ctx: AudioContext | null = null;
    private master: GainNode | null = null;
    private limiter: DynamicsCompressorNode | null = null;
    /** 多指持续音：touchId → 持续音符图 */
    private sustainedMap = new Map<number, { graph: SynthGraph; stopNodes: (stopAt: number) => void }>();

    private pitchLoudnessGain(freq: number): number {
        const safeFreq = Math.max(55, Math.min(4200, freq));
        return Math.max(0.72, Math.min(1.65, Math.pow(440 / safeFreq, 0.25)));
    }

    ensure(): void {
        if (this.ctx) return;
        const AC: any = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.limiter = this.ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -6;
        this.limiter.knee.value = 6;
        this.limiter.ratio.value = 16;
        this.limiter.attack.value = 0.003;
        this.limiter.release.value = 0.15;
        this.master.connect(this.limiter);
        this.limiter.connect(this.ctx.destination);
    }

    private makeNoise(): AudioBufferSourceNode {
        const ctx = this.ctx!;
        const len = Math.floor(ctx.sampleRate * 0.25);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        return src;
    }

    /** tanh 过载曲线（drive 0~0.3）。 */
    private makeTanhCurve(drive: number): Float32Array {
        const n = 1024;
        const curve = new Float32Array(n);
        const g = 1 + drive * 4;
        const norm = Math.tanh(g);
        for (let i = 0; i < n; i++) {
            const x = (i / (n - 1)) * 2 - 1;
            curve[i] = Math.tanh(x * g) / norm;
        }
        return curve;
    }

    /** 构建一次演奏的完整节点图（短音符/持续音共用）。 */
    private buildGraph(r: number, g: number, b: number, alpha: number, freq: number, volume: number, t0: number): SynthGraph {
        const ctx = this.ctx!;
        const t = toneFromARGB(r, g, b, alpha);
        const amp = Math.min(1, Math.max(0.001, volume)) * 0.4;

        // 主总线 → 调制门（psy/liquid/glitch LFO 在此叠加）→ 全局低通 → 失真 → （回声）→ 主输出
        const bus = ctx.createGain();
        const modGain = ctx.createGain();
        modGain.gain.value = 1;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = t.cutoff;
        const shaper = ctx.createWaveShaper();
        shaper.curve = this.makeTanhCurve(t.drive);
        bus.connect(modGain);
        modGain.connect(filter);
        filter.connect(shaper);
        shaper.connect(this.master!);

        // 特效 LFO：psy（暗区 R，震颤）/ liquid（亮区 B，慢速摆动）/ glitch（暗区 G，卡顿门）
        let psyLfo: OscillatorNode | null = null;
        let liqLfo: OscillatorNode | null = null;
        let glLfo: OscillatorNode | null = null;
        if (t.psyRatio > 0.001) {
            psyLfo = ctx.createOscillator();
            psyLfo.frequency.value = 10 * (1 - t.psyRatio) + 0.5;
            const lg = ctx.createGain();
            lg.gain.value = -t.psyRatio * 0.8;
            psyLfo.connect(lg);
            lg.connect(modGain.gain);
        }
        if (t.liquidRatio > 0.001) {
            liqLfo = ctx.createOscillator();
            liqLfo.frequency.value = 0.8;
            const lg = ctx.createGain();
            lg.gain.value = t.liquidRatio * 0.18;
            liqLfo.connect(lg);
            lg.connect(modGain.gain);
        }
        if (t.glitchRatio > 0.001) {
            glLfo = ctx.createOscillator();
            glLfo.type = 'square';
            glLfo.frequency.value = 8 + 30 * t.glitchRatio;
            const lg = ctx.createGain();
            lg.gain.value = -t.glitchRatio * 0.85;
            glLfo.connect(lg);
            lg.connect(modGain.gain);
        }

        // 低频脉冲（暗区 B）：0.5×freq 亚正弦
        let pulseOsc: OscillatorNode | null = null;
        if (t.pulseRatio > 0.001) {
            pulseOsc = ctx.createOscillator();
            pulseOsc.type = 'sine';
            pulseOsc.frequency.value = freq * 0.5;
            const pg = ctx.createGain();
            pg.gain.value = t.pulseRatio * 0.35;
            pulseOsc.connect(pg);
            pg.connect(bus);
        }

        // reese（亮区 R）：失谐锯齿叠加
        let reeseOsc: OscillatorNode | null = null;
        if (t.reeseRatio > 0.001) {
            reeseOsc = ctx.createOscillator();
            reeseOsc.type = 'sawtooth';
            reeseOsc.frequency.value = freq * 1.012;
            const rg = ctx.createGain();
            rg.gain.value = t.reeseRatio * 0.2;
            reeseOsc.connect(rg);
            rg.connect(bus);
        }

        // laser（亮区 G）：起音 90ms 高频下滑
        let laserOsc: OscillatorNode | null = null;
        if (t.laserRatio > 0.001) {
            laserOsc = ctx.createOscillator();
            laserOsc.type = 'sine';
            laserOsc.frequency.setValueAtTime(freq * 2.6, t0);
            laserOsc.frequency.exponentialRampToValueAtTime(Math.max(20, freq), t0 + 0.09);
            const lg2 = ctx.createGain();
            lg2.gain.setValueAtTime(t.laserRatio * 0.35, t0);
            lg2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
            laserOsc.connect(lg2);
            lg2.connect(bus);
        }

        // 鼓组（snare/kick）：绕过失真（直接到主输出），鼓组不使用失真效果
        let drumBus: GainNode | null = null;
        const drumNodes: (OscillatorNode | AudioBufferSourceNode)[] = [];
        if (t.drumWeight > 0.001) {
            drumBus = ctx.createGain();
            drumBus.gain.value = t.drumWeight * 0.9;
            drumBus.connect(this.master!);
            if (t.kickWeight > t.snareWeight) {
                const ko = ctx.createOscillator();
                ko.type = 'sine';
                ko.frequency.setValueAtTime(150, t0);
                ko.frequency.exponentialRampToValueAtTime(45, t0 + 0.12);
                const kg = ctx.createGain();
                kg.gain.setValueAtTime(1, t0);
                kg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
                ko.connect(kg);
                kg.connect(drumBus);
                drumNodes.push(ko);
            } else {
                const noise = this.makeNoise();
                const ng = ctx.createGain();
                ng.gain.setValueAtTime(0.7, t0);
                ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
                const bp = ctx.createBiquadFilter();
                bp.type = 'bandpass';
                bp.frequency.value = 1800;
                bp.Q.value = 0.8;
                noise.connect(bp);
                bp.connect(ng);
                ng.connect(drumBus);
                drumNodes.push(noise);
                const to = ctx.createOscillator();
                to.type = 'sine';
                to.frequency.value = 180;
                const tg = ctx.createGain();
                tg.gain.setValueAtTime(0.3, t0);
                tg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
                to.connect(tg);
                tg.connect(drumBus);
                drumNodes.push(to);
            }
        }

        // 回声（alpha 越低空间感越强）
        let echo: DelayNode | null = null;
        let echoMix: GainNode | null = null;
        let echoFB: GainNode | null = null;
        if (t.reverbMix > 0.01) {
            echo = ctx.createDelay(0.6);
            echo.delayTime.value = 0.18;
            echoMix = ctx.createGain();
            echoMix.gain.value = t.reverbMix * 0.45;
            echoFB = ctx.createGain();
            echoFB.gain.value = 0.5;
            shaper.connect(echoMix);
            echoMix.connect(echo);
            echo.connect(echoFB);
            echoFB.connect(echo);
            echo.connect(this.master!);
        }

        // 弦乐声部：大提琴式 —— 次八度共鸣 + 4 谐波（柔和衰减，无揉弦）+ 低通 + 慢起音
        const strFilter = ctx.createBiquadFilter();
        strFilter.type = 'lowpass';
        strFilter.frequency.value = Math.min(7000, Math.max(500, freq * 5));
        const strGain = ctx.createGain();
        strGain.gain.value = (r / 255) * t.sumNorm;
        const strEnv = ctx.createGain();
        strEnv.gain.setValueAtTime(0, t0);
        strEnv.gain.linearRampToValueAtTime(1, t0 + 0.18);
        const sub = ctx.createOscillator();
        sub.type = 'sine';
        sub.frequency.value = freq * 0.5;
        const s1 = ctx.createOscillator();
        s1.type = 'sine';
        s1.frequency.value = freq;
        const s2 = ctx.createOscillator();
        s2.type = 'sine';
        s2.frequency.value = freq * 2;
        const s3 = ctx.createOscillator();
        s3.type = 'sine';
        s3.frequency.value = freq * 3;
        const s4 = ctx.createOscillator();
        s4.type = 'sine';
        s4.frequency.value = freq * 4;
        const gSub = ctx.createGain();
        gSub.gain.value = 0.25;
        const g1 = ctx.createGain();
        g1.gain.value = 1;
        const g2 = ctx.createGain();
        g2.gain.value = 0.4;
        const g3 = ctx.createGain();
        g3.gain.value = 0.18;
        const g4 = ctx.createGain();
        g4.gain.value = 0.08;
        sub.connect(gSub);
        gSub.connect(strFilter);
        s1.connect(g1);
        g1.connect(strFilter);
        s2.connect(g2);
        g2.connect(strFilter);
        s3.connect(g3);
        g3.connect(strFilter);
        s4.connect(g4);
        g4.connect(strFilter);
        strFilter.connect(strGain);
        strGain.connect(strEnv);
        strEnv.connect(bus);

        // 笛声部：近纯正弦 + 极弱谐波 + 起音呼吸噪声（低通）+ 轻微颤音，突出气息感
        const fluteGain = ctx.createGain();
        fluteGain.gain.value = (g / 255) * t.sumNorm;
        const fluteEnv = ctx.createGain();
        fluteEnv.gain.setValueAtTime(0, t0);
        fluteEnv.gain.linearRampToValueAtTime(1, t0 + 0.05);
        const f1 = ctx.createOscillator();
        f1.type = 'sine';
        f1.frequency.value = freq;
        const f2 = ctx.createOscillator();
        f2.type = 'sine';
        f2.frequency.value = freq * 2;
        const h2 = ctx.createGain();
        h2.gain.value = 0.12;
        const f4 = ctx.createOscillator();
        f4.type = 'sine';
        f4.frequency.value = freq * 4;
        const h4 = ctx.createGain();
        h4.gain.value = 0.04;
        f1.connect(fluteGain);
        f2.connect(h2);
        h2.connect(fluteGain);
        f4.connect(h4);
        h4.connect(fluteGain);
        fluteGain.connect(fluteEnv);
        fluteEnv.connect(bus);

        // 钢琴/铃声部：基频 + 0.5×2 倍频 + 0.25×3 倍频，增益 b（包络在总线做）
        const bellGain = ctx.createGain();
        bellGain.gain.value = (b / 255) * t.sumNorm;
        const bellOscs: OscillatorNode[] = [];
        const bellGains: GainNode[] = [];
        [1, 2, 3].forEach((mult, i) => {
            const o = ctx.createOscillator();
            o.type = 'sine';
            o.frequency.value = freq * mult;
            const og = ctx.createGain();
            og.gain.value = [1, 0.5, 0.25][i];
            o.connect(og);
            og.connect(bellGain);
            bellOscs.push(o);
            bellGains.push(og);
        });
        bellGain.connect(bus);

        // 暖噪声混合（低通，暗色更多；量已大幅减小避免白噪）
        let noiseGain: GainNode | null = null;
        let noiseSrc: AudioBufferSourceNode | null = null;
        if (t.noiseMix > 0.001) {
            noiseSrc = this.makeNoise();
            noiseGain = ctx.createGain();
            noiseGain.gain.value = t.noiseMix;
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 2500;
            noiseSrc.connect(lp);
            lp.connect(noiseGain);
            noiseGain.connect(this.master!);
        }

        return { bus, filter, shaper, modGain, sub, s1, s2, s3, s4, strGain, strEnv, f1, f2, fluteGain, fluteEnv, bellOscs, bellGains, bellGain, echo, echoMix, echoFB, noiseGain, noiseSrc, drumBus, drumNodes, psyLfo, liqLfo, glLfo, reeseOsc, laserOsc, pulseOsc };
    }

    /** 短音符（点按）。 */
    playNote(r: number, g: number, b: number, alpha: number, freq: number, volume: number, durationMs: number): void {
        this.ensure();
        if (!this.ctx || !this.master) return;
        const ctx = this.ctx;
        const t0 = ctx.currentTime;
        const t = toneFromARGB(r, g, b, alpha);
        const amp = Math.min(1, Math.max(0.001, volume)) * 0.4;
        const graph = this.buildGraph(r, g, b, alpha, freq, volume, t0);
        const dur = Math.max(0.05, durationMs / 1000) * t.decayScale;
        const stopAt = t0 + dur + 0.4;

        // 总包络：均匀度控制的 attack + 结尾释放；鼓组激活时基础声部按 (1-鼓权重) 衰减
        const baseAmp = amp * this.pitchLoudnessGain(freq) * (1 - t.drumWeight);
        graph.bus.gain.setValueAtTime(0.0001, t0);
        graph.bus.gain.linearRampToValueAtTime(baseAmp, t0 + t.attack);
        graph.bus.gain.setValueAtTime(baseAmp, t0 + Math.max(t.attack, dur - 0.15));
        graph.bus.gain.exponentialRampToValueAtTime(0.0001, stopAt);

        // 钢琴/铃声部自己的指数衰减：高频谐波衰减更快（钢琴感，非持续）
        graph.bellGain.gain.cancelScheduledValues(t0);
        graph.bellGain.gain.setValueAtTime(graph.bellGain.gain.value, t0);
        graph.bellGain.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.5, dur + 0.2));
        const bellEnd = t0 + Math.max(0.5, dur + 0.2);
        [1, 2, 3].forEach((mult, i) => {
            const og = graph.bellGains[i];
            if (!og) return;
            og.gain.cancelScheduledValues(t0);
            og.gain.setValueAtTime([1, 0.5, 0.25][i], t0);
            og.gain.exponentialRampToValueAtTime(0.0001, t0 + bellEnd / ((1 + i * 0.6) * t.decayScale));
        });

        const stop = () => {
            const nodes: OscillatorNode[] = [graph.sub, graph.s1, graph.s2, graph.s3, graph.s4, graph.f1, graph.f2, ...graph.bellOscs];
            if (graph.psyLfo) nodes.push(graph.psyLfo);
            if (graph.liqLfo) nodes.push(graph.liqLfo);
            if (graph.glLfo) nodes.push(graph.glLfo);
            if (graph.reeseOsc) nodes.push(graph.reeseOsc);
            if (graph.laserOsc) nodes.push(graph.laserOsc);
            if (graph.pulseOsc) nodes.push(graph.pulseOsc);
            for (const o of nodes) { try { o.stop(stopAt); } catch (e) { /* 已停止 */ } }
            if (graph.noiseSrc) { try { graph.noiseSrc.stop(t0 + 0.06); } catch (e) { /* 已停止 */ } }
            for (const d of graph.drumNodes) { try { d.stop(stopAt); } catch (e) { /* 已停止 */ } }
        };
        stop();
    }

    /** 持续音开始/原位更新（多指合奏，按 touchId 区分；滑音更新频率/音色/音量，相位连续）。 */
    noteOn(touchId: number, r: number, g: number, b: number, alpha: number, freq: number, volume: number): void {
        this.ensure();
        if (!this.ctx || !this.master) return;
        const ctx = this.ctx;
        const t0 = ctx.currentTime;
        const t = toneFromARGB(r, g, b, alpha);
        const amp = Math.min(1, Math.max(0.001, volume)) * 0.4;

        const existing = this.sustainedMap.get(touchId);
        if (!existing) {
            const graph = this.buildGraph(r, g, b, alpha, freq, volume, t0);
            const baseAmp = amp * this.pitchLoudnessGain(freq) * (1 - t.drumWeight);
            graph.bus.gain.setValueAtTime(0.0001, t0);
            graph.bus.gain.linearRampToValueAtTime(baseAmp, t0 + t.attack);
            // 铃声部持续（无衰减），弦乐/笛包络已建立
            const stopNodes = (stopAt: number) => {
                const nodes: OscillatorNode[] = [graph.sub, graph.s1, graph.s2, graph.s3, graph.s4, graph.f1, graph.f2, ...graph.bellOscs];
                if (graph.psyLfo) nodes.push(graph.psyLfo);
                if (graph.liqLfo) nodes.push(graph.liqLfo);
                if (graph.glLfo) nodes.push(graph.glLfo);
                if (graph.reeseOsc) nodes.push(graph.reeseOsc);
                if (graph.laserOsc) nodes.push(graph.laserOsc);
                if (graph.pulseOsc) nodes.push(graph.pulseOsc);
                for (const o of nodes) {
                    try { o.stop(stopAt); } catch (e) { /* 已停止 */ }
                }
                for (const d of graph.drumNodes) { try { d.stop(stopAt); } catch (e) { /* 已停止 */ } }
                if (graph.noiseSrc) { try { graph.noiseSrc.stop(stopAt); } catch (e) { /* 已停止 */ } }
            };
            this.sustainedMap.set(touchId, { graph, stopNodes });
        } else {
            // 原位更新
            const graph = existing.graph;
            graph.filter.frequency.setTargetAtTime(t.cutoff, t0, 0.05);
            graph.shaper.curve = this.makeTanhCurve(t.drive);
            graph.strGain.gain.setTargetAtTime((r / 255) * t.sumNorm, t0, 0.02);
            graph.fluteGain.gain.setTargetAtTime((g / 255) * t.sumNorm, t0, 0.02);
            graph.bellGain.gain.setTargetAtTime((b / 255) * t.sumNorm, t0, 0.02);
            graph.sub.frequency.setTargetAtTime(freq * 0.5, t0, 0.02);
            graph.s1.frequency.setTargetAtTime(freq, t0, 0.02);
            graph.s2.frequency.setTargetAtTime(freq * 2, t0, 0.02);
            graph.s3.frequency.setTargetAtTime(freq * 3, t0, 0.02);
            graph.s4.frequency.setTargetAtTime(freq * 4, t0, 0.02);
            graph.f1.frequency.setTargetAtTime(freq, t0, 0.02);
            graph.f2.frequency.setTargetAtTime(freq * 2, t0, 0.02);
            [1, 2, 3].forEach((mult, i) => {
                graph.bellOscs[i]?.frequency.setTargetAtTime(freq * mult, t0, 0.02);
            });
            graph.bus.gain.cancelScheduledValues(t0);
            graph.bus.gain.setTargetAtTime(amp * this.pitchLoudnessGain(freq) * (1 - t.drumWeight), t0, 0.05);
            // 回声量（alpha 变化时）
            if (graph.echoMix && graph.echo) {
                graph.echoMix.gain.setTargetAtTime(t.reverbMix * 0.45, t0, 0.05);
            }
            // 特效频率随颜色/音高更新
            if (graph.psyLfo) graph.psyLfo.frequency.setTargetAtTime(10 * (1 - t.psyRatio) + 0.5, t0, 0.05);
            if (graph.glLfo) graph.glLfo.frequency.setTargetAtTime(8 + 30 * t.glitchRatio, t0, 0.05);
            if (graph.reeseOsc) graph.reeseOsc.frequency.setTargetAtTime(freq * 1.012, t0, 0.02);
            if (graph.pulseOsc) graph.pulseOsc.frequency.setTargetAtTime(freq * 0.5, t0, 0.02);
            if (graph.laserOsc) {
                graph.laserOsc.frequency.cancelScheduledValues(t0);
                graph.laserOsc.frequency.setValueAtTime(freq * 2.6, t0);
                graph.laserOsc.frequency.exponentialRampToValueAtTime(Math.max(20, freq), t0 + 0.09);
            }
        }
    }

    /** 释放指定 touchId 的持续音。 */
    noteOff(touchId: number): void {
        if (!this.ctx) return;
        const existing = this.sustainedMap.get(touchId);
        if (!existing) return;
        const t0 = this.ctx.currentTime;
        const releaseSeconds = 0.05;
        const gain = existing.graph.bus.gain;
        if (typeof gain.cancelAndHoldAtTime === 'function') {
            gain.cancelAndHoldAtTime(t0);
        } else {
            gain.cancelScheduledValues(t0);
            gain.setValueAtTime(Math.max(0, gain.value), t0);
        }
        gain.linearRampToValueAtTime(0, t0 + releaseSeconds);
        existing.stopNodes(t0 + releaseSeconds + 0.01);
        this.sustainedMap.delete(touchId);
    }
}
