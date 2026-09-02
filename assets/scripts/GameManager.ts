/**
 * GameManager.ts
 * 主逻辑：程序化构建 UI、图片选择/加载、触摸→声音（点按/持续/滑音）、
 * 色相→乐器家族映射、陀螺仪横竖屏旋转显示。
 *
 * 玩法规则：
 *   - 屏幕 X（左→右）→ 音高，屏幕 Y（下→上）→ 音量；
 *   - 像素颜色 → 音色（ARGB：R=弦乐、G=笛、B=钢琴/铃三声部混合；亮度→浊厚/清脆；透明度→音头与空间感）；
 *   - 按住 = 持续发声（noteOn/noteOff），滑动 = 连续滑音（原位更新音高，相位连续）；
 *   - 陀螺仪判定横/竖持机，图片实时平滑旋转（像相册一样），保持图片不拉伸铺满。
 */
import {
    _decorator, Component, Node, Sprite, SpriteFrame, UITransform, Button, Label, Graphics,
    Color, Vec3, UIOpacity, assetManager, ImageAsset, Texture2D, game, Game, tween, Tween, EventTouch,
    Layers, sys, profiler, input, Input, EventAcceleration, Mask, director, EditBox, screen,
} from 'cc';
import { ImageStore } from './ImageStore';
import { NativeBridge, WebSynth, PickedImageInfo, JS_SYNTH_READY_FLAG } from './NativeBridge';
import { buildNoteParams, uvToMidi, midiToName, midiToFreq, colorToneSummary } from './SynthMapping';
import { FxUI } from './FxUI';
import {
    FxSlot, loadFxSlots, saveFxSlots, fxSlotsToJson, PRESET_INST, presetWaveFor,
    recommendedGlobalFxChain, FX_SLOT_COUNT, newSlot, globalFxIndex, FX_GLOBAL_SLOTS_PER_CHANNEL,
    FX_LIBRARY, fxDefOf, loadOutputFxSlots, saveOutputFxSlots,
} from './Effects';
import { Dropdown } from './Dropdown';
import { SPLASH_B64 } from './SplashData';
import {
    GridSettingsUI, GridState, GRID_COLORS, loadGridState, saveGridState, defaultGridState,
    DEFAULT_GRID_COLUMNS, DEFAULT_GRID_ROWS,
} from './GridSettings';
import { isEnglish, t, toggleLanguage } from './I18n';
import { DRUM_CUSTOM_ID, DRUM_NONE_ID, DRUM_PRESETS, DrumPresetDef } from './DrumLibrary';

const { ccclass } = _decorator;

function loadStr(key: string, def: string): string {
    try { return sys.localStorage.getItem(key) ?? def; } catch (e) { return def; }
}
function saveStr(key: string, v: string) {
    try { sys.localStorage.setItem(key, v); } catch (e) { /* 忽略 */ }
}

/** Keep untouched, renameable defaults in the language currently used by the UI. */
function localizeMutableDefaultName(name: string): string {
    const exact: Record<string, [string, string]> = {
        '新音频': ['新音频', 'New Audio'], 'New Audio': ['新音频', 'New Audio'],
        '新样式': ['新样式', 'New Style'], 'New Style': ['新样式', 'New Style'],
        '新样式流': ['新样式流', 'New Style Flow'], 'New Style Flow': ['新样式流', 'New Style Flow'],
    };
    const match = exact[name];
    if (match) return match[isEnglish() ? 1 : 0];
    if (name.endsWith(' 副本')) return `${localizeMutableDefaultName(name.slice(0, -3))}${isEnglish() ? ' Copy' : ' 副本'}`;
    if (name.endsWith(' Copy')) return `${localizeMutableDefaultName(name.slice(0, -5))}${isEnglish() ? ' Copy' : ' 副本'}`;
    return name;
}

// 设计分辨率 2000×900（20:9，EXACT_FIT 下在 20:9 屏上正好铺满、不变形、无黑边）
const DESIGN_W = 2000;
const DESIGN_H = 900;
const IMG_MAX_W = 2000;          // 横屏播放/显示区：设为整个画布宽度，铺满（去掉内边距）
const IMG_MAX_H = 900;           // 高度铺满
// 竖屏显示区：注意节点旋转 90° 后 局部宽→屏幕高、局部高→屏幕宽，故竖屏模式局部尺寸要"换位"
const IMG_MAX_W_PORTRAIT = 900;  // 竖屏旋转后宽度铺满
const IMG_MAX_H_PORTRAIT = 2000; // 竖屏旋转后高度铺满
const SLIDE_MIN_DIST = 12;       // 滑音最小移动距离（设计单位）
const TOUCH_AUDIO_INTERVAL_MS = 16;
const TOUCH_VISUAL_INTERVAL_MS = 33;
const TOUCH_INFO_INTERVAL_MS = 50;

/** “自定义”预设：玩家自绘波形或点击重置后，预设槽显示该项。 */
const CUSTOM_INST = { id: 'custom', label: '自定义' };
/** 旋转过渡补间时长（秒），≤2 秒。 */
const ROT_TWEEN = 1.0;
/** 低分辨率设备仅放大游戏主界面控件；大分辨率平板保持原尺寸。 */
const MAIN_UI_SCALE_SHORT_SIDE = 1700;
const MAIN_UI_MAX_SCALE = 1.35;
const MAIN_MENU_BUTTON_SIZE = 68;
const LANGUAGE_BUTTON_SIZE = 34;
const MENU_LANGUAGE_GAP = 6;
/** 默认网格线宽及其最细限制；密集网格也至少保留默认粗细的一半。 */
const DEFAULT_GRID_LINE_WIDTH = 1.6;
const MIN_GRID_LINE_WIDTH = DEFAULT_GRID_LINE_WIDTH / 2;
const DEFAULT_GRID_LABEL_FONT_SIZE = 9;
const MIN_GRID_LABEL_FONT_SIZE = 4;
const MAX_GRID_LABEL_FONT_SIZE = 24;
/** 屏幕状态边框约 2mm 的设计坐标圆角。 */
const SCREEN_EDGE_RADIUS = 16;
const MIXER_TRACK_HEAD_WIDTH = 36;
/** 轨道音频块约 1mm 的设计坐标圆角。 */
const MIXER_BLOCK_CORNER_RADIUS = 8;
const MIXER_CONTENT_INSET = MIXER_TRACK_HEAD_WIDTH + 20;
const MIXER_COLLAPSED_RESTORE_VISUAL_SCALE = .62;
const LEGACY_DRUM_IDS: Record<string, string> = {
    kick: 'tr808_kick', snare: 'tr808_snare', clap: 'boombap_clap',
    hihat: 'tr808_hat', tom: 'percussion_tom', maracas: 'percussion_maracas',
};

interface CachedPickedImage {
    url: string;
    nativeInfo?: PickedImageInfo;
}

/** 场景切换不会清空模块状态，用于语言切换后恢复玩家已选择的图片。 */
let cachedPickedImage: CachedPickedImage | null = null;

interface AudioClipMeta {
    id: string;
    name: string;
    path: string;
    duration: number;
    enabled: boolean;
    volume: number;
    trimStart: number;
    trimEnd: number;
    color?: string;
}

interface MixerBlock {
    id: string;
    clipId: string;
    startBeat: number;
    color: string;
    speed?: number;
    trimStart?: number;
    trimEnd?: number;
    trimRanges?: Array<{ start: number; end: number }>;
    volumeAutomation?: number[];
    pitchAutomation?: number[];
    panAutomation?: number[];
    volumeAutomationPoints?: AutomationPoint[];
    pitchAutomationPoints?: AutomationPoint[];
    panAutomationPoints?: AutomationPoint[];
}

interface AutomationPoint { x: number; y: number; }

interface MixerEditorSnapshot {
    tracks: MixerTrack[];
    clips: AudioClipMeta[];
}

interface MixerTrack {
    id: string;
    muted: boolean;
    solo: boolean;
    blocks: MixerBlock[];
}

interface StyleSnapshot {
    id: string;
    name: string;
    kind: 'style' | 'flow';
    createdAt: number;
    waves: { baseWave: number[]; amplitude: number; cycles: number; instId: string; drumId?: string; drumSourceId?: string; drumSpeed?: number }[];
    grid: GridState;
    fxSlots: FxSlot[];
    outputFxSlots: FxSlot[];
    drumBlackId: string;
    drumWhiteId: string;
    metronome?: { enabled: boolean; beatsPerBar: number; beatUnit: number; bpm: number };
    flowNodes?: Array<{ styleId: string; delaySec: number }>;
}

@ccclass('GameManager')
export class GameManager extends Component {
    private canvas!: Node;
    private canvasTransform!: UITransform;
    /** UI 根容器：整体随陀螺仪旋转（图片/按钮/信息栏一起转） */
    private uiRoot!: Node;
    private imageDisplay!: Node;
    private pickBtn!: Node;
    private testBtn!: Node;
    private calibBtn!: Node;
    private guideBtn!: Node;
    private waveBtn!: Node;
    private mainMenuBtn!: Node;
    private languageBtn!: Node;
    private recordBtn!: Node;
    private mixerBtn!: Node;
    private playOnceBtn!: Node;
    private playLoopBtn!: Node;
    private styleBtn!: Node;
    private metronomeBtn!: Node;
    private metronomeIconGfx!: Graphics;
    private metronomeEnabled = false;
    private metronomeBeatsPerBar = Math.max(1, Math.min(32, Number(loadStr('cm_metronome_beats', '4')) || 4));
    private metronomeBeatUnit = (() => {
        const unit = Number(loadStr('cm_metronome_unit', '4')) || 4;
        return [1, 2, 4, 8, 16, 32].indexOf(unit) >= 0 ? unit : 4;
    })();
    private metronomeBpm = Math.max(20, Math.min(320, Number(loadStr('cm_metronome_bpm', '120')) || 120));
    private lockBtn!: Node;
    private lockIconGfx!: Graphics;
    private consoleButtons: Node[] = [];
    private uiLocked = false;
    private edgeMode: 'idle' | 'record' | 'play' | 'both' = 'idle';
    private styleTransition = false;
    private isRecording = false;
    private recordingPath = '';
    private recordingStartedAt = 0;
    private recordedClips: AudioClipMeta[] = [];
    private audioPanel: Node | null = null;
    private stylePanel: Node | null = null;
    private audioPanelOpen = false;
    private stylePanelOpen = false;
    private clipRows: Node[] = [];
    private mixerTracks: MixerTrack[] = this.loadMixerTracks();
    private mixerViewport: Node | null = null;
    private mixerTimeline: Node | null = null;
    private mixerSourcePane: Node | null = null;
    private mixerSourcePaneBackground: Node | null = null;
    private mixerCollapsedSourceDots: Node[] = [];
    private mixerConnectionLayer: Node | null = null;
    private mixerConnectionSourceId = '';
    private mixerConnectionBlockId = '';
    private mixerSourcePanelCollapsed = false;
    private mixerCollapsedContentInsetExtra = 0;
    private mixerSourcePaneAnimating = false;
    private mixerSelectedBlockId = '';
    private mixerSelectionBorderTransition: Node | null = null;
    private mixerMultiSelectMode = false;
    private mixerMultiSelectedBlockIds = new Set<string>();
    private mixerMultiSelectOverlay: Node | null = null;
    private mixerMultiLeftVeil: Node | null = null;
    private mixerMultiModeGeneration = 0;
    private mixerMultiBoxTouchId = -1;
    private mixerMultiBoxStart: Vec3 | null = null;
    private mixerMultiBoxCurrent: Vec3 | null = null;
    private mixerPlaying = false;
    private mixerPlayheadBeat = 0;
    private mixerPlayheadTouchOffsetX = 0;
    private mixerPlaybackAnchorBeat = 0;
    private mixerPlaybackEndBeat = 0;
    private mixerFollowPlayhead = false;
    private mixerFollowPlayheadX = 0;
    private mixerPlayTimer: number | null = null;
    private mixerBeatWidth = 20;
    private mixerRowHeight = 80;
    private mixerScrollX = 0;
    private mixerScrollY = 0;
    private mixerRenderedScrollX = 0;
    private mixerRenderedScrollY = 0;
    private mixerRenderedBeatWidth = 20;
    private mixerMagnet = false;
    private mixerUndoStack: MixerTrack[][] = [];
    private mixerLastBlockTap = { id: '', at: 0 };
    private mixerTrackTapTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private mixerGestureTouches = new Map<number, Vec3>();
    private mixerAnimateFrom = new Map<string, Vec3>();
    private mixerLastPinchDistance = 0;
    private mixerLastPanCenter = new Vec3();
    private mixerGestureMoved = false;
    private mixerGestureStartPoint = new Vec3();
    private mixerGestureStartScrollX = 0;
    private mixerGestureStartScrollY = 0;
    private mixerGestureStartBeatWidth = 20;
    private mixerGestureVisualBasePosition = new Vec3();
    private mixerGestureVisualBaseScaleX = 1;
    private mixerPinchAnchorBeat = 0;
    private mixerGestureLastPoint = new Vec3();
    private mixerGestureLastAt = 0;
    private mixerPanVelocity = new Vec3();
    private mixerInertiaFrame: number | null = null;
    private mixerInertiaGeneration = 0;
    private mixerReturnFrame: number | null = null;
    private mixerReturnGeneration = 0;
    private mixerDeferredRedrawGeneration = 0;
    private mixerLiveRedrawTimer: ReturnType<typeof setTimeout> | null = null;
    /** 时间线采用只追加的分段缓存：初始 200 拍，之后每次追加 100 拍。 */
    private mixerTimelineLoadedThroughBeat = 0;
    private mixerTimelineCacheSignature = '';
    private mixerTimelineCacheBeatWidth = 0;
    private mixerTimelineCacheInset = -1;
    private mixerTimelineCacheViewportWidth = 0;
    private mixerTimelineCacheReady = false;
    private mixerTimelineVisualDirty = false;
    private mixerTimelinePendingTransitionPosition: Vec3 | null = null;
    private mixerTimelineViewportHeight = 0;
    private mixerRetainedTimelineNodes: Node[] = [];
    private mixerDraggingBlockId = '';
    private mixerDraggingPlayhead = false;
    private mixerEditor: Node | null = null;
    private mixerColorPalette: Node | null = null;
    private mixerExpandedSourceId = '';
    private mixerRedrawQueued = false;
    private mixerDragGhost: Node | null = null;
    private mixerEditorMode: 'volume' | 'pitch' | 'pan' = 'volume';
    private mixerEditorUndo: MixerEditorSnapshot[] = [];
    private mixerEditorInitial: MixerEditorSnapshot | null = null;
    private mixerEditorCropping = false;
    private mixerEditorCropStart = -1;
    private mixerEditorCropEnd = -1;
    private styles: StyleSnapshot[] = [];
    private styleRows: Node[] = [];
    private expandedStyleId = '';
    private flowEditorPanel: Node | null = null;
    private flowEditorNodes: Array<{ styleId: string; delaySec: number }> = [];
    private flowEditorDynamic: Node[] = [];
    private activeStyleFlow: StyleSnapshot | null = null;
    private styleFlowToken = 0;
    private activePlaybackLoop = false;
    private clipsPlaying = false;
    private mainMenuOpen = false;
    private mainMenuButtonPositions: Array<[number, number]> = [];
    private mainMenuCollapsedPosition: [number, number] = [0, 0];
    private settingsMenu!: Node;
    private infoNode!: Node;
    /** 游玩说明：分类导航 + 详细玩法提示的全屏双栏面板。 */
    private guidePanel: Node | null = null;
    private guideContentLabel: Label | null = null;
    private guideChoiceButtons: Node[] = [];
    private guideEntries: Array<{ title: string; content: string }> = [];
    private guideSelected = 0;

    /** 波表编辑器（RGB 三通道自定义波形） */
    private wavePanel!: Node;
    private wavePanelOpen = false;
    private wavePanelTransform!: UITransform;
    private waveTitle!: Node;
    private waveTitleLabel!: Label;
    private panelBtnBgs: { btn: Node; w: number; h: number; color: Color }[] = [];
    private waveAreas: Array<{
        ch: number; node: Node; gfx: Graphics; transform: UITransform; labelNode: Node;
        points: { x: number; y: number }[]; wave: number[]; baseWave: number[];
        amplitude: number; cycles: number; drumSpeed: number; ampAxis: Node; waveAxis: Node;
        ampGfx: Graphics; waveGfx: Graphics;
    }> = [];
    /** 效果器插件槽位 UI（8 槽下拉 + 设置弹窗） */
    private fxUI: FxUI | null = null;
    private fxSlots: FxSlot[] = loadFxSlots();
    /** 音色预设下拉（R/G/B 各一） */
    private instDds: Dropdown[] = [];
    private instIds: string[] = ['piano', 'flute', 'bell'];
    /** RGB 通道的鼓采样状态；custom 保留 sourceId 与调节后的音量/速度。 */
    private drumDds: Dropdown[] = [];
    private channelDrumIds: string[] = [DRUM_NONE_ID, DRUM_NONE_ID, DRUM_NONE_ID];
    private channelDrumSourceIds: string[] = ['tr808_kick', 'tr808_snare', 'tr808_hat'];
    /** 撤销栈：记录波形+预设状态快照（绘制/选预设/随机/经典/重置前压栈）。 */
    private undoStack: { waves: number[][]; baseWaves: number[][]; amplitudes: number[]; cycles: number[]; drumSpeeds: number[]; instIds: string[]; drumIds: string[]; drumSourceIds: string[]; fxSlots: FxSlot[] }[] = [];
    /** 波表编辑器“撤回”按钮（左下角）。 */
    private undoBtn: Node | null = null;
    private undoBgGfx: Graphics | null = null;
    /** 黑鼓/白鼓下拉 */
    private blackDd: Dropdown | null = null;
    private whiteDd: Dropdown | null = null;
    private drumBlackId = 'tr808_kick';
    private drumWhiteId = 'tr808_snare';
    private waveDrawn = false;
    /** 当前绘制中的触摸 ID（每个区域最多一根手指） */
    private waveTouchIds = new Map<number, number>(); // areaIndex → touchId
    private waveAxisTouchIds = new Map<string, number>();
    private waveAxisLastNativeMs = new Map<string, number>();
    /** 同时按住多个通道试听时共用一个音符，仅混合音色，不叠加独立音高。 */
    private previewChannels = new Set<number>();
    private imageSprite!: Sprite;
    private imageTransform!: UITransform;
    private imageVisualTransform!: UITransform;
    private placeholder!: Node;
    private placeholderTransform!: UITransform;
    private placeholderGfx!: Graphics;
    private placeholderLabelNode!: Node;
    private placeholderLabel!: Label;
    /** 每根演奏手指拥有独立光点，避免多指位置/颜色/动画互相覆盖。 */
    private touchRipples = new Map<number, {
        node: Node;
        gfx: Graphics;
        opacity: UIOpacity;
    }>();
    private infoLabel!: Label;
    private infoText = '';
    private infoColor = new Color(220, 225, 235, 255);
    private gridResizeInfoActive = false;
    private splashNode: Node | null = null;
    private store = new ImageStore();
    private webSynth: WebSynth | null = null;

    /** 游玩网格：显示可关闭，但音高/音量量化始终生效。 */
    private gridNode!: Node;
    private gridGfx!: Graphics;
    private gridTransform!: UITransform;
    private gridNoteLabels: Node[] = [];
    private gridVolumeLabels: Node[] = [];
    private gridState: GridState = loadGridState();
    private gridSettings: GridSettingsUI | null = null;
    private gridResizeTouches = new Map<number, {
        edge: 'left' | 'right' | 'top' | 'bottom';
        startCoord: number;
        currentCoord: number;
        baseLines: number[];
        basePeriod: number;
    }>();
    private gridPinch: {
        edge: 'left' | 'right' | 'top' | 'bottom';
        ids: [number, number];
        startDistance: number;
        baseLines: number[];
        basePeriod: number;
    } | null = null;

    /** RGB 混音后的最终输出效果器。 */
    private outputPanel: Node | null = null;
    private outputFxUI: FxUI | null = null;
    private outputFxSlots: FxSlot[] = loadOutputFxSlots();
    private outputUndoStack: FxSlot[][] = [];

    /** 多指持续音/滑音状态：touchId → 该手指上一次发声的图片局部坐标 */
    private activeTouches = new Map<number, Vec3>();
    private touchAudioUpdateMs = new Map<number, number>();
    private touchVisualUpdateMs = new Map<number, number>();
    private lastTouchInfoMs = 0;
    private repeatedGridCache = new WeakMap<number[], { period: number; result: number[] }>();

    /** 图片自然尺寸（用于旋转后按比例重新铺满） */
    private imgNaturalW = 0;
    private imgNaturalH = 0;

    /** 陀螺仪旋转状态（绝对重力方向判定 + 手动微调，避免反向与抽搐） */
    private deviceAngleSmoothed = 0;
    private calibOffset = 0;        // 手动校准微调（度）
    private calibrationCount = 0;
    private calibrated = false;
    private appWasHidden = false;   // 应用是否进入过后台（用于区分启动 SHOW / 恢复 SHOW）
    private diagCounter = 0;
    private currentSnapped = 0;    // 当前吸附的绝对方向（0/90/180/270）
    private currentTarget = 0;     // 图片当前角度（-90/0/90/180）
    private startupLandscapePending = true;

    onLoad() {
        console.warn('[CM] onLoad start, isNative=', sys.isNative);
        // 隐藏 Cocos 调试统计面板
        try { profiler.hideStats(); } catch (e) { /* 忽略 */ }
        // 帧率上限 60
        try { game.frameRate = 60; } catch (e) { /* 忽略 */ }

        this.canvas = this.node.parent ?? this.node;
        this.canvasTransform = this.canvas.getComponent(UITransform)!;
        this.recordedClips = this.loadAudioClips();
        this.styles = this.loadStyles();
        // 必须在主 UI 构建前创建不透明遮罩，避免异步加载幕布图片时漏出一帧游戏界面。
        this.prepareSplashCover();
        console.warn('[CM] canvas=', this.canvas.name,
            'size=', this.canvasTransform.contentSize.toString(),
            'worldPos=', this.canvas.worldPosition.toString());
        this.buildUI();
        this.splashNode?.setSiblingIndex(this.canvas.children.length - 1);
        this.applyRotation(0, false);
        console.warn('[CM] buildUI 完成, pickBtn 局部坐标=', this.pickBtn.position.toString());
        this.registerNativeCallbacks();
        this.attachTouch();
        this.refreshSynthStatus();
        this.restoreCachedImage();
        // 启动幕布：全屏放映 Neuro 标志约 1.33s 后淡出进入游戏界面
        this.showSplash();
        const debugPanel = NativeBridge.consumeDebugPanel();
        if (debugPanel) this.scheduleOnce(() => {
            if (debugPanel === 'mixer') this.openAudioPanel();
            else if (debugPanel === 'style') this.openStylePanel();
            else if (debugPanel === 'flow') { if (!this.styles.some((s) => s.kind === 'style')) this.saveCurrentStyle(); this.openStylePanel(); this.scheduleOnce(() => this.openStyleFlowEditor(), .15); }
            else if (debugPanel === 'wave') this.openWavePanel();
        }, 1.7);

        // 陀螺仪：横竖屏判定（锁横屏的 Activity 下传感器仍能反映物理姿态）
        try { input.setAccelerometerInterval(100); input.setAccelerometerEnabled(true); } catch (e) { /* 忽略 */ }
        input.on(Input.EventType.DEVICEMOTION, this.onDeviceMotion, this);
        this.schedule(this.updateOrientation, 0.1);

        // 应用从后台恢复（如选图返回）后，传感器可能已停止：重新启用并重新校零。
        // 用 HIDE/SHOW 配对判断：启动时的 SHOW（无 HIDE）不重启传感器，避免校零被打断。
        game.on(Game.EVENT_HIDE, this.onAppHide, this);
        game.on(Game.EVENT_SHOW, this.onAppShow, this);
        this.node.on(Node.EventType.NODE_DESTROYED, () => {
            game.off(Game.EVENT_HIDE, this.onAppHide, this);
            game.off(Game.EVENT_SHOW, this.onAppShow, this);
            input.off(Input.EventType.TOUCH_END, this.onGlobalTouchEnd, this);
            input.off(Input.EventType.TOUCH_CANCEL, this.onGlobalTouchEnd, this);
            this.stopMixerInertia();
            this.stopMixerTimelineReturnAnimation();
            if (this.mixerLiveRedrawTimer) clearTimeout(this.mixerLiveRedrawTimer);
            this.releaseAllActiveNotes();
        }, this);
        console.warn('[CM] onLoad 完成');
    }

    /** 应用进入后台：标记，用于区分"启动时的 SHOW"与"从后台恢复的 SHOW"。 */
    private onAppHide() {
        this.appWasHidden = true;
        this.releaseAllActiveNotes();
        if (this.isRecording) {
            NativeBridge.stopRecording();
            this.isRecording = false;
            this.setEdgeMode(this.activePlaybackLoop ? 'play' : 'idle');
        }
        if (this.clipsPlaying) {
            NativeBridge.stopAudioFiles();
            this.styleFlowToken++;
            this.activePlaybackLoop = false;
            this.clipsPlaying = false;
        }
        this.setEdgeMode('idle');
    }

    /** 应用恢复（如选图返回）：重启加速度计并重新校零（修复选图返回后旋转失效）。 */
    private onAppShow() {
        if (!this.appWasHidden) {
            console.warn('[CM] 启动时 SHOW，忽略（避免打断校零）');
            return;
        }
        this.appWasHidden = false;
        console.warn('[CM] 应用恢复，重启陀螺仪');
        try { input.setAccelerometerEnabled(false); } catch (e) { /* 忽略 */ }
        try { input.setAccelerometerEnabled(true); } catch (e) { /* 忽略 */ }
        this.calibrated = false;
        this.calibrationCount = 0;
        this.calibOffset = 0;
        this.deviceAngleSmoothed = 0;
    }

    /* ============================== UI 构建 ============================== */

    private buildUI() {
        // ---- UI 根容器（居中，随陀螺仪整体旋转） ----
        const root = new Node('UIRoot');
        root.layer = Layers.Enum.UI_2D;
        root.addComponent(UITransform).setContentSize(DESIGN_W, DESIGN_H);
        this.canvas.addChild(root);
        this.uiRoot = root;
        root.setScale(this.rootScaleFor(false));
        const initialView = this.userViewport(false);

        // ---- 图片显示区（居中，随陀螺仪旋转） ----
        const img = new Node('ImageDisplay');
        img.layer = Layers.Enum.UI_2D;
        this.imageTransform = img.addComponent(UITransform);
        this.imageTransform.setContentSize(initialView.w, initialView.h);
        // ImageDisplay 始终铺满屏幕以承接演奏与边缘手势；实际图片由独立子节点
        // 等比完整显示，避免宽高比不同的图片被拉伸或裁出屏幕。
        const imageVisual = new Node('ImageVisual');
        imageVisual.layer = Layers.Enum.UI_2D;
        this.imageVisualTransform = imageVisual.addComponent(UITransform);
        this.imageVisualTransform.setContentSize(initialView.w, initialView.h);
        this.imageSprite = imageVisual.addComponent(Sprite);
        this.imageSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        img.addChild(imageVisual);
        img.setPosition(0, 0);
        root.addChild(img);
        this.imageDisplay = img;

        // 占位提示（未选图时显示）
        const ph = new Node('Placeholder');
        ph.layer = Layers.Enum.UI_2D;
        this.placeholderTransform = ph.addComponent(UITransform);
        this.placeholderTransform.setContentSize(initialView.w, initialView.h);
        this.placeholderGfx = ph.addComponent(Graphics);
        this.drawPlaceholderBorder();
        const placeholderLabelNode = this.makeLabel('占位提示',
            t('① 点击右上菜单 →「选择图片」\n② 按住发声 / 滑动滑音 / 点按演奏\n\n屏幕 X=音高（左低右高）  Y=音量（下小上大）\n旋转设备 → 图片像相册一样旋转',
                '① Open the top-right menu → Choose Image\n② Hold to play / drag to glide / tap notes\n\nScreen X = pitch (low to high)   Y = volume (quiet to loud)\nRotate the device → the image rotates like a photo viewer'),
            17, 24, new Color(160, 170, 190, 255), 1100, 500);
        this.placeholderLabelNode = placeholderLabelNode;
        this.placeholderLabel = placeholderLabelNode.getComponent(Label)!;
        this.placeholderLabel.enableWrapText = true;
        this.placeholderLabel.overflow = Label.Overflow.SHRINK;
        const placeholderOpacity = placeholderLabelNode.addComponent(UIOpacity);
        placeholderOpacity.opacity = 0;
        tween(placeholderOpacity).repeatForever(
            tween<UIOpacity>().to(2, { opacity: 255 }, { easing: 'sineInOut' })
                .to(2, { opacity: 0 }, { easing: 'sineInOut' }),
        ).start();
        ph.addChild(placeholderLabelNode);
        img.addChild(ph);
        this.placeholder = ph;

        // 演奏网格覆盖层：不拦截常规触摸；边缘缩放手势由 ImageDisplay 统一处理。
        const grid = new Node('PlayGrid');
        grid.layer = Layers.Enum.UI_2D;
        this.gridTransform = grid.addComponent(UITransform);
        this.gridTransform.setContentSize(initialView.w, initialView.h);
        this.gridGfx = grid.addComponent(Graphics);
        root.addChild(grid);
        this.gridNode = grid;
        this.redrawPlayGrid();

        // ---- 右上角折叠菜单：四个功能按钮由圆形菜单按钮呼出 ----
        this.pickBtn = this.makeButton('PickButton', '选择图片', 930, 415, 115, 35,
            () => { this.hideMainMenu(); this.onPickPressed(); },
            { bgColor: new Color(0, 0, 0, 255), opacity: 204, fontSize: 13, borderColor: new Color(255, 255, 255, 255), borderWidth: 1.5 });
        this.testBtn = this.makeButton('TestButton', '测试音', 930, 376, 115, 35,
            () => { /* 按住试听由触摸开始/结束控制 */ },
            { bgColor: new Color(0, 0, 0, 255), opacity: 204, fontSize: 13, borderColor: new Color(255, 255, 255, 255), borderWidth: 1.5 });
        this.calibBtn = this.makeButton('CalibButton', '校准', 930, 337, 115, 35,
            () => { this.hideMainMenu(); this.onCalibratePressed(); },
            { bgColor: new Color(0, 0, 0, 255), opacity: 204, fontSize: 13, borderColor: new Color(255, 255, 255, 255), borderWidth: 1.5 });
        this.guideBtn = this.makeButton('GuideButton', '游玩说明', 930, 298, 115, 35,
            () => { this.hideMainMenu(); this.openGuidePanel(); },
            { bgColor: new Color(0, 0, 0, 255), opacity: 204, fontSize: 13, borderColor: new Color(255, 255, 255, 255), borderWidth: 1.5 });
        this.waveBtn = this.makeButton('SettingsButton', '设置', 930, 259, 115, 35,
            () => { this.hideMainMenu(false); this.toggleSettingsMenu(); },
            { bgColor: new Color(0, 0, 0, 255), opacity: 204, fontSize: 13, borderColor: new Color(255, 255, 255, 255), borderWidth: 1.5 });
        this.attachHoldTest(this.testBtn);
        this.buildSettingsMenu();
        this.buildMainMenuButton();
        this.buildLanguageButton();
        this.buildConsoleButtons();
        this.buildLockButton();
        for (const button of [this.pickBtn, this.testBtn, this.calibBtn, this.guideBtn, this.waveBtn]) {
            button.getComponent(UIOpacity)!.opacity = 0;
            button.setScale(.001, .001, 1);
        }

        // ---- 左上信息栏（宽度 700，保证横竖屏都在屏幕内） ----
        const info = new Node('InfoLabel');
        info.layer = Layers.Enum.UI_2D;
        const infoTransform = info.addComponent(UITransform);
        infoTransform.setContentSize(700, 64);
        infoTransform.setAnchorPoint(0, .5);
        this.infoLabel = info.addComponent(Label);
        this.infoLabel.fontSize = 26;
        this.infoLabel.lineHeight = 32;
        this.infoLabel.isSystemFontUsed = true;
        this.infoLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
        this.infoLabel.verticalAlign = Label.VerticalAlign.CENTER;
        this.infoLabel.color = new Color(220, 225, 235, 255);
        info.setPosition(-640, 425);
        root.addChild(info);
        this.infoNode = info;
        this.infoNode.active = this.gridState.showToneInfo && !this.uiLocked;
    }

    /** 右上角控制台按钮：节拍器位于原五按钮右侧。 */
    private buildConsoleButtons() {
        this.recordBtn = this.makeConsoleButton('RecordButton', '●', () => this.toggleRecording(), new Color(235, 55, 65, 255));
        this.mixerBtn = this.makeConsoleButton('MixerButton', '', () => this.openAudioPanel(), new Color(255, 255, 255, 255));
        const speakerIcon = new Node('MixerSpeakerIcon'); speakerIcon.layer = Layers.Enum.UI_2D; speakerIcon.addComponent(UITransform).setContentSize(24, 22); this.mixerBtn.addChild(speakerIcon);
        const speaker = speakerIcon.addComponent(Graphics); speaker.fillColor = new Color(255, 255, 255, 255); speaker.strokeColor = new Color(255, 255, 255, 255); speaker.lineWidth = 1.6;
        speaker.rect(-10, -3, 3, 6); speaker.fill(); speaker.moveTo(-7, -3); speaker.lineTo(-3, -6); speaker.lineTo(-3, 6); speaker.lineTo(-7, 3); speaker.close(); speaker.fill();
        speaker.moveTo(-1, -4); speaker.bezierCurveTo(1.5, -2.5, 1.5, 2.5, -1, 4); speaker.stroke();
        speaker.moveTo(3, -7); speaker.bezierCurveTo(6.5, -4, 6.5, 4, 3, 7); speaker.stroke();
        this.playOnceBtn = this.makeConsoleButton('PlayOnceButton', '▶', () => this.toggleClipPlayback(false), new Color(255, 255, 255, 255));
        this.playLoopBtn = this.makeConsoleButton('PlayLoopButton', '▶▶', () => this.toggleClipPlayback(true), new Color(255, 255, 255, 255));
        this.styleBtn = this.makeConsoleButton('StyleButton', '', () => this.openStylePanel(), new Color(255, 255, 255, 255));
        const styleIcon = new Node('StyleButtonLines'); styleIcon.layer = Layers.Enum.UI_2D; styleIcon.addComponent(UITransform).setContentSize(20, 20); this.styleBtn.addChild(styleIcon);
        const styleGlyph = styleIcon.addComponent(Graphics);
        styleGlyph.lineWidth = 1.5; styleGlyph.strokeColor = new Color(255, 255, 255, 255);
        for (const y of [-6, 0, 6]) { styleGlyph.moveTo(-7, y); styleGlyph.lineTo(7, y); styleGlyph.stroke(); }
        this.metronomeBtn = this.makeConsoleButton('MetronomeButton', '', () => this.toggleMetronome(), new Color(255, 255, 255, 255));
        const metronomeIcon = new Node('MetronomeTridentIcon'); metronomeIcon.layer = Layers.Enum.UI_2D; metronomeIcon.addComponent(UITransform).setContentSize(24, 24); this.metronomeBtn.addChild(metronomeIcon);
        this.metronomeIconGfx = metronomeIcon.addComponent(Graphics);
        this.redrawMetronomeButton();
        this.consoleButtons = [this.metronomeBtn, this.recordBtn, this.mixerBtn, this.playOnceBtn, this.playLoopBtn, this.styleBtn];
    }

    private redrawMetronomeButton() {
        if (!this.metronomeBtn || !this.metronomeIconGfx) return;
        const bg = this.metronomeBtn.getComponent(Graphics)!;
        bg.clear(); bg.circle(0, 0, 15.5); bg.fillColor = this.metronomeEnabled ? new Color(255, 255, 255, 255) : new Color(0, 0, 0, 255); bg.fill();
        const g = this.metronomeIconGfx; g.clear(); g.lineWidth = 1.8; g.lineCap = Graphics.LineCap.ROUND;
        g.strokeColor = this.metronomeEnabled ? new Color(0, 0, 0, 255) : new Color(255, 255, 255, 255);
        g.moveTo(0, 9); g.lineTo(0, -9); g.moveTo(0, -3); g.lineTo(-7, -9); g.moveTo(0, -3); g.lineTo(7, -9);
        g.moveTo(-7, -9); g.lineTo(-7, -5); g.moveTo(7, -9); g.lineTo(7, -5); g.stroke();
    }

    private toggleMetronome() {
        this.metronomeEnabled = !this.metronomeEnabled;
        NativeBridge.setMetronome(this.metronomeEnabled, this.metronomeBeatsPerBar, this.metronomeBeatUnit, this.metronomeBpm);
        this.redrawMetronomeButton();
        this.setInfo(this.metronomeEnabled
            ? t(`节拍器已开启（${this.metronomeBeatsPerBar}/${this.metronomeBeatUnit}）`, `Metronome on (${this.metronomeBeatsPerBar}/${this.metronomeBeatUnit})`)
            : t('节拍器已关闭', 'Metronome off'), new Color(220, 225, 235, 255));
    }

    /** 沉浸模式锁：位于控制台最右按钮和菜单按钮的正中间。 */
    private buildLockButton() {
        const node = new Node('ImmersiveLockButton');
        node.layer = Layers.Enum.UI_2D;
        node.addComponent(UITransform).setContentSize(34, 34);
        const button = node.addComponent(Button);
        button.transition = Button.Transition.SCALE;
        button.zoomScale = 1.08;
        const bg = node.addComponent(Graphics);
        bg.circle(0, 0, 15.5); bg.fillColor = new Color(0, 0, 0, 255); bg.fill();
        node.addComponent(UIOpacity).opacity = 204;
        const icon = new Node('LockIcon');
        icon.layer = Layers.Enum.UI_2D;
        icon.addComponent(UITransform).setContentSize(24, 24);
        this.lockIconGfx = icon.addComponent(Graphics);
        node.addChild(icon);
        this.uiRoot.addChild(node);
        node.on(Button.EventType.CLICK, () => this.setUiLocked(!this.uiLocked), this);
        this.lockBtn = node;
        this.redrawLockIcon();
    }

    private redrawLockIcon() {
        if (!this.lockIconGfx) return;
        const g = this.lockIconGfx;
        g.clear();
        g.lineWidth = 1.8;
        g.strokeColor = new Color(255, 255, 255, 255);
        g.roundRect(-7, -8, 14, 12, 2);
        g.stroke();
        if (this.uiLocked) {
            g.moveTo(-5, 4); g.lineTo(-5, 7);
            g.bezierCurveTo(-5, 12, 5, 12, 5, 7);
            g.lineTo(5, 4); g.stroke();
        } else {
            g.moveTo(-5, 4); g.lineTo(-3, 9);
            g.bezierCurveTo(-1, 13, 7, 11, 7, 6); g.stroke();
        }
    }

    private setUiLocked(locked: boolean) {
        this.uiLocked = locked;
        this.settingsMenu.active = false;
        this.mainMenuOpen = false;
        const menuControls = [this.pickBtn, this.testBtn, this.calibBtn, this.guideBtn, this.waveBtn];
        for (const node of menuControls) {
            tween(node).stop();
            node.active = true;
            node.setScale(.001, .001, 1);
            const opacity = node.getComponent(UIOpacity);
            if (opacity) { tween(opacity).stop(); opacity.opacity = 0; }
            const button = node.getComponent(Button);
            if (button) button.interactable = !locked;
        }
        for (const node of [this.mainMenuBtn, this.languageBtn, ...this.consoleButtons]) {
            node.active = true;
            const opacity = node.getComponent(UIOpacity);
            if (opacity) opacity.opacity = locked ? 0 : 204;
            const button = node.getComponent(Button);
            if (button) button.interactable = !locked;
        }
        this.placeholderLabelNode.active = !locked;
        if (locked) this.infoNode.active = false;
        else this.refreshInfoVisibility();
        this.redrawLockIcon();
        this.applyRotation(this.currentTarget, false);
        this.lockBtn.setSiblingIndex(this.uiRoot.children.length - 1);
    }

    private makeConsoleButton(name: string, glyph: string, cb: () => void, glyphColor: Color): Node {
        const node = new Node(name);
        node.layer = Layers.Enum.UI_2D;
        node.addComponent(UITransform).setContentSize(34, 34);
        const button = node.addComponent(Button);
        button.transition = Button.Transition.SCALE;
        button.zoomScale = 1.08;
        const bg = node.addComponent(Graphics);
        bg.circle(0, 0, 15.5); bg.fillColor = new Color(0, 0, 0, 255); bg.fill();
        const labelNode = this.makeLabel(name + 'Glyph', glyph, glyph === '▶▶' ? 9 : 16, 18, glyphColor, 30, 30);
        node.addChild(labelNode);
        node.addComponent(UIOpacity).opacity = 204;
        this.uiRoot.addChild(node);
        node.on(Button.EventType.CLICK, cb, this);
        return node;
    }

    private drawPlaceholderBorder() {
        const w = this.placeholderTransform.contentSize.width;
        const h = this.placeholderTransform.contentSize.height;
        this.placeholderGfx.clear();
        // 播放区铺满整屏（大于节点，覆盖到屏幕边缘，无内边距缝隙）
        this.placeholderGfx.roundRect(-3000, -3000, 6000, 6000, 0);
        this.placeholderGfx.fillColor = new Color(11, 16, 30, 255);
        this.placeholderGfx.fill();
        // 播放区边界（沿节点尺寸，视觉提示可点击区）
        this.placeholderGfx.roundRect(-w / 2, -h / 2, w, h, SCREEN_EDGE_RADIUS);
        this.placeholderGfx.lineWidth = 2;
        this.placeholderGfx.strokeColor = new Color(90, 100, 130, 255);
        this.placeholderGfx.stroke();
    }

    private makeLabel(name: string, text: string, fontSize: number, lineHeight: number, color: Color, w = 1000, h = 500): Node {
        const node = new Node(name);
        node.layer = Layers.Enum.UI_2D;
        node.addComponent(UITransform).setContentSize(w, h);
        const label = node.addComponent(Label);
        label.string = t(text);
        label.fontSize = fontSize;
        label.lineHeight = lineHeight;
        label.isSystemFontUsed = true;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.color = color;
        return node;
    }

    private makeButton(
        name: string, text: string, x: number, y: number, w: number, h: number, cb: () => void,
        opts: { bgColor?: Color; textColor?: Color; opacity?: number; fontSize?: number; borderColor?: Color; borderWidth?: number } = {},
    ) {
        const btn = new Node(name);
        btn.layer = Layers.Enum.UI_2D;
        btn.addComponent(UITransform).setContentSize(w, h);
        const button = btn.addComponent(Button);
        button.transition = Button.Transition.SCALE;
        button.zoomScale = 1.08;

        if (opts.borderColor) {
            const border = new Node('Border');
            border.layer = Layers.Enum.UI_2D;
            border.addComponent(UITransform).setContentSize(w, h);
            const borderGfx = border.addComponent(Graphics);
            borderGfx.roundRect(-w / 2, -h / 2, w, h, Math.min(9, h / 2));
            borderGfx.fillColor = opts.borderColor;
            borderGfx.fill();
            btn.addChild(border);
        }

        const bg = new Node('Bg');
        bg.layer = Layers.Enum.UI_2D;
        bg.addComponent(UITransform).setContentSize(w, h);
        const bgGfx = bg.addComponent(Graphics);
        const inset = opts.borderColor ? Math.max(1, opts.borderWidth ?? 2) : 0;
        bgGfx.roundRect(-w / 2 + inset, -h / 2 + inset, w - inset * 2, h - inset * 2, Math.max(1, Math.min(9, h / 2) - inset));
        bgGfx.fillColor = opts.bgColor ?? new Color(58, 110, 235, 255);
        bgGfx.fill();
        btn.addChild(bg);

        const lblNode = new Node('Text');
        lblNode.layer = Layers.Enum.UI_2D;
        lblNode.addComponent(UITransform).setContentSize(w, h);
        const label = lblNode.addComponent(Label);
        label.string = t(text);
        label.fontSize = opts.fontSize ?? (h >= 70 ? 30 : 24);
        label.isSystemFontUsed = true;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.SHRINK;
        label.enableWrapText = false;
        label.color = opts.textColor ?? new Color(255, 255, 255, 255);
        btn.addChild(lblNode);

        // 整按钮透明度（40%）
        if (opts.opacity !== undefined) {
            btn.addComponent(UIOpacity).opacity = opts.opacity;
        }

        btn.setPosition(x, y);
        this.uiRoot.addChild(btn);
        btn.on(Button.EventType.CLICK, cb, this);
        return btn;
    }

    private buildMainMenuButton() {
        const menu = new Node('MainMenuButton');
        menu.layer = Layers.Enum.UI_2D;
        menu.addComponent(UITransform).setContentSize(MAIN_MENU_BUTTON_SIZE, MAIN_MENU_BUTTON_SIZE);
        const button = menu.addComponent(Button);
        button.transition = Button.Transition.SCALE;
        button.zoomScale = 1.08;
        const g = menu.addComponent(Graphics);
        g.circle(0, 0, 31);
        g.fillColor = new Color(0, 0, 0, 245); g.fill();
        g.lineWidth = 2.5; g.strokeColor = new Color(255, 255, 255, 255); g.stroke();
        menu.addComponent(UIOpacity).opacity = 204;
        const labelNode = this.makeLabel('MainMenuGlyph', '∏', 34, 40, new Color(255, 255, 255, 255), 56, 56);
        menu.addChild(labelNode);
        this.uiRoot.addChild(menu);
        menu.on(Button.EventType.CLICK, () => this.toggleMainMenu(), this);
        this.mainMenuBtn = menu;
    }

    /** Language toggle beside the main menu. The flag art is clipped by a circular mask. */
    private buildLanguageButton() {
        const buttonNode = new Node('LanguageButton');
        buttonNode.layer = Layers.Enum.UI_2D;
        buttonNode.addComponent(UITransform).setContentSize(34, 34);
        const button = buttonNode.addComponent(Button);
        button.transition = Button.Transition.SCALE;
        button.zoomScale = 1.08;

        const clip = new Node('FlagClip');
        clip.layer = Layers.Enum.UI_2D;
        clip.addComponent(UITransform).setContentSize(30, 30);
        const mask = clip.addComponent(Mask);
        mask.type = Mask.Type.ELLIPSE;
        mask.segments = 64;
        buttonNode.addChild(clip);

        const art = new Node('FlagArt');
        art.layer = Layers.Enum.UI_2D;
        art.addComponent(UITransform).setContentSize(30, 30);
        clip.addChild(art);
        const g = art.addComponent(Graphics);
        if (isEnglish()) this.drawUsFlag(g); else this.drawChinaFlag(g);

        const border = new Node('FlagBorder');
        border.layer = Layers.Enum.UI_2D;
        border.addComponent(UITransform).setContentSize(34, 34);
        const borderGfx = border.addComponent(Graphics);
        borderGfx.circle(0, 0, 15.5);
        borderGfx.lineWidth = 1.5;
        borderGfx.strokeColor = new Color(255, 255, 255, 128);
        borderGfx.stroke();
        buttonNode.addChild(border);
        buttonNode.addComponent(UIOpacity).opacity = 204;

        buttonNode.on(Button.EventType.CLICK, () => {
            this.releaseAllActiveNotes();
            for (const id of [-9000, -9100, -9101, -9102]) {
                if (NativeBridge.isAndroidNative) NativeBridge.noteOff(id); else this.webSynth?.noteOff(id);
            }
            if (this.isRecording) { NativeBridge.stopRecording(); this.isRecording = false; }
            NativeBridge.stopAudioFiles();
            toggleLanguage();
            director.loadScene('Main');
        }, this);
        this.uiRoot.addChild(buttonNode);
        this.languageBtn = buttonNode;
    }

    private drawUsFlag(g: Graphics) {
        g.clear();
        const stripeH = 30 / 13;
        for (let i = 0; i < 13; i++) {
            const x = i < 7 ? -1 : -15;
            g.rect(x, 15 - (i + 1) * stripeH, 15 - x, stripeH);
            g.fillColor = i % 2 === 0
                ? new Color(190, 25, 45, 128)
                : new Color(255, 255, 255, 128);
            g.fill();
        }
        g.rect(-15, 15 - stripeH * 7, 14, stripeH * 7);
        g.fillColor = new Color(30, 55, 120, 128); g.fill();
        for (let row = 0; row < 5; row++) {
            for (let col = 0; col < 5; col++) {
                g.circle(-13.5 + col * 2.65, 13.2 - row * 2.7, .48);
                g.fillColor = new Color(255, 255, 255, 128); g.fill();
            }
        }
    }

    private drawChinaFlag(g: Graphics) {
        g.clear();
        g.rect(-15, -15, 30, 30); g.fillColor = new Color(220, 25, 35, 128); g.fill();
        this.drawFlagStar(g, -8.7, 7.5, 4.1, -Math.PI / 2);
        const smallStars: Array<[number, number, number]> = [[-2.5, 10.2, -2.7], [0.2, 6.4, -2.9], [.2, 1.7, 2.9], [-2.6, -1.8, 2.6]];
        for (const [x, y, a] of smallStars) this.drawFlagStar(g, x, y, 1.45, a);
    }

    private drawFlagStar(g: Graphics, cx: number, cy: number, radius: number, rotation: number) {
        for (let i = 0; i < 10; i++) {
            const r = i % 2 === 0 ? radius : radius * .382;
            const a = rotation + i * Math.PI / 5;
            const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
            if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.close(); g.fillColor = new Color(255, 222, 40, 128); g.fill();
    }

    private toggleMainMenu() {
        if (this.mainMenuOpen) this.hideMainMenu();
        else this.showMainMenu();
    }

    private showMainMenu() {
        this.mainMenuOpen = true;
        this.settingsMenu.active = false;
        const controls = [this.pickBtn, this.testBtn, this.calibBtn, this.guideBtn, this.waveBtn];
        const mainScale = this.mainUiControlScale();
        for (let i = 0; i < controls.length; i++) {
            const node = controls[i];
            tween(node).stop();
            node.active = true;
            node.setPosition(this.mainMenuCollapsedPosition[0], this.mainMenuCollapsedPosition[1]);
            node.setScale(.72 * mainScale, .72 * mainScale, 1);
            const opacity = node.getComponent(UIOpacity)!;
            tween(opacity).stop(); opacity.opacity = 0;
            tween(node).delay(i * .035).to(.22, {
                position: new Vec3(this.mainMenuButtonPositions[i][0], this.mainMenuButtonPositions[i][1], 0),
                scale: new Vec3(mainScale, mainScale, 1),
            }, { easing: 'quadOut' }).start();
            tween(opacity).delay(i * .035).to(.17, { opacity: 204 }, { easing: 'quadOut' }).start();
        }
        this.mainMenuBtn.setSiblingIndex(this.uiRoot.children.length - 1);
    }

    private hideMainMenu(closeSettings = true) {
        if (closeSettings) this.settingsMenu.active = false;
        if (!this.mainMenuOpen) return;
        this.mainMenuOpen = false;
        const mainScale = this.mainUiControlScale();
        for (const node of [this.pickBtn, this.testBtn, this.calibBtn, this.guideBtn, this.waveBtn]) {
            tween(node).stop();
            const opacity = node.getComponent(UIOpacity)!;
            tween(opacity).stop();
            tween(node).to(.18, {
                position: new Vec3(this.mainMenuCollapsedPosition[0], this.mainMenuCollapsedPosition[1], 0),
                scale: new Vec3(.72 * mainScale, .72 * mainScale, 1),
            }, { easing: 'quadIn' }).call(() => {
                if (!this.mainMenuOpen) node.setScale(.001, .001, 1);
            }).start();
            tween(opacity).to(.14, { opacity: 0 }, { easing: 'quadIn' }).start();
        }
    }

    private buildSettingsMenu() {
        const menu = new Node('SettingsMenu');
        menu.layer = Layers.Enum.UI_2D;
        menu.addComponent(UITransform).setContentSize(230, 249);
        const g = menu.addComponent(Graphics);
        g.roundRect(-115, -124.5, 230, 249, 8);
        g.fillColor = new Color(10, 16, 30, 245); g.fill();
        g.lineWidth = 1.5; g.strokeColor = new Color(120, 140, 180, 255); g.stroke();
        this.uiRoot.addChild(menu);
        const entries: Array<[string, number, () => void]> = [
            ['波表', 91.5, () => { menu.active = false; this.openWavePanel(); }],
            ['网格', 30.5, () => { menu.active = false; this.openGridSettings(); }],
            ['输出效果器', -30.5, () => { menu.active = false; this.openOutputPanel(); }],
            ['节拍器', -91.5, () => { menu.active = false; this.editMetronomeSignature(); }],
        ];
        for (const [text, y, cb] of entries) {
            const b = this.makeButton('Settings' + text, text, 0, y, 210, 52, cb,
                { bgColor: new Color(34, 48, 78, 255), opacity: 255, fontSize: 22 });
            menu.addChild(b);
            b.setPosition(0, y);
        }
        menu.active = false;
        this.settingsMenu = menu;
    }

    private toggleSettingsMenu() {
        this.settingsMenu.active = !this.settingsMenu.active;
        if (this.settingsMenu.active) {
            this.redrawSettingsMenu();
            this.settingsMenu.setSiblingIndex(this.uiRoot.children.length - 1);
        }
    }

    private redrawSettingsMenu() {
        const g=this.settingsMenu.getComponent(Graphics)!;g.clear();g.roundRect(-115,-124.5,230,249,8);g.fillColor=new Color(10,16,30,245);g.fill();g.lineWidth=1.5;g.strokeColor=new Color(120,140,180,255);g.stroke();
        for(const b of this.settingsMenu.children){const bg=b.getChildByName('Bg')?.getComponent(Graphics);if(!bg)continue;bg.clear();bg.roundRect(-105,-26,210,52,10);bg.fillColor=new Color(34,48,78,255);bg.fill();}
    }

    private editMetronomeSignature() {
        NativeBridge.promptMetronome(this.metronomeBeatsPerBar, this.metronomeBeatUnit, this.metronomeBpm, (beats, unit, bpm) => {
                if (beats < 1 || beats > 32 || [1, 2, 4, 8, 16, 32].indexOf(unit) < 0) {
                    this.setInfo(t('拍号格式无效，请输入如 4/4 或 6/8', 'Invalid signature. Enter a value such as 4/4 or 6/8.'), new Color(255, 190, 120, 255));
                    return;
                }
                bpm = Math.round(bpm);
                if (!Number.isFinite(bpm) || bpm < 20 || bpm > 320) {
                    this.setInfo(t('BPM 必须在 20 到 320 之间', 'BPM must be between 20 and 320.'), new Color(255, 190, 120, 255));
                    return;
                }
                this.metronomeBeatsPerBar = beats;
                this.metronomeBeatUnit = unit;
                this.metronomeBpm = bpm;
                saveStr('cm_metronome_beats', String(beats)); saveStr('cm_metronome_unit', String(unit)); saveStr('cm_metronome_bpm', String(bpm));
                if (this.metronomeEnabled) NativeBridge.setMetronome(true, beats, unit, bpm);
                this.setInfo(t(`节拍器已设为 ${beats}/${unit}，${bpm} BPM`, `Metronome set to ${beats}/${unit}, ${bpm} BPM`), new Color(220, 225, 235, 255));
        });
    }

    private openWavePanel() {
        if (!this.wavePanel) this.buildWavePanel();
        this.wavePanelOpen = true;
        this.wavePanel.active = true;
        this.wavePanel.setSiblingIndex(this.uiRoot.children.length - 1);
        this.relayoutWavePanel(this.currentTarget);
        this.setInfo('波表编辑器：绘制波形或拖动坐标轴实时塑形', new Color(220, 225, 235, 255));
    }

    private attachHoldTest(node: Node) {
        const id = -9000;
        node.on(Node.EventType.TOUCH_START, (e: EventTouch) => {
            e.propagationStopped = true;
            if (!NativeBridge.synthReady) { this.setInfo('合成器尚未就绪，请稍候再试', new Color(255, 200, 120, 255)); return; }
            if (NativeBridge.isAndroidNative) NativeBridge.noteOn(id, 120, 180, 210, 255, 523.25, .7);
            else { this.webSynth = this.webSynth ?? new WebSynth(); this.webSynth.noteOn(id, 120, 180, 210, 255, 523.25, .7); }
            this.setInfo('测试音 C5（松开停止）', new Color(220, 225, 235, 255));
        }, this);
        const stop = (e: EventTouch) => {
            e.propagationStopped = true;
            if (NativeBridge.isAndroidNative) NativeBridge.noteOff(id); else this.webSynth?.noteOff(id);
            this.hideMainMenu();
        };
        node.on(Node.EventType.TOUCH_END, stop, this);
        node.on(Node.EventType.TOUCH_CANCEL, stop, this);
    }

    /** 同步建立全黑启动遮罩；onLoad 尚未返回，因此它会从首个可渲染帧开始遮住游戏 UI。 */
    private prepareSplashCover() {
        if (!NativeBridge.isAndroidNative) return;
        const splash = new Node('Splash');
        splash.layer = Layers.Enum.UI_2D;
        splash.addComponent(UITransform).setContentSize(4000, 4000);
        const bg = new Node('Bg');
        bg.layer = Layers.Enum.UI_2D;
        bg.addComponent(UITransform).setContentSize(4000, 4000);
        const bgG = bg.addComponent(Graphics);
        bgG.rect(-2000, -2000, 4000, 4000);
        bgG.fillColor = new Color(0, 0, 0, 255);
        bgG.fill();
        splash.addChild(bg);
        splash.addComponent(UIOpacity).opacity = 255;
        this.canvas.addChild(splash);
        this.splashNode = splash;
    }

    /** 启动幕布：全屏放映 Neuro 标志，标志出现后保持原有 1.33 秒时长。 */
    private showSplash() {
        try {
            if (!NativeBridge.isAndroidNative) return; // 仅原生显示
            // 把 JPEG 存到缓存目录，再经 loadRemote 解码加载（直接塞压缩字节会被当作原始 RGBA 崩溃）
            const path = NativeBridge.saveSplashImage(SPLASH_B64);
            if (!path) {
                console.error('[CM] 启动幕布图片保存失败');
                this.dismissSplash();
                return;
            }
            assetManager.loadRemote('file://' + path, { ext: '.jpg' }, (err, asset) => {
                if (err) {
                    console.error('[CM] 启动幕布加载失败:', err);
                    this.dismissSplash();
                    return;
                }
                try {
                    const imgAsset = asset as ImageAsset;
                    const tex = new Texture2D();
                    tex.image = imgAsset;
                    const sf = new SpriteFrame();
                    sf.texture = tex;

                    const splash = this.splashNode;
                    if (!splash?.isValid) return;
                    splash.setSiblingIndex(this.canvas.children.length - 1);

                    // 标志等比 1/3 尺寸居中显示（原铺满 2000×2000 → 缩小三倍 ≈667×667，屏中）
                    const logo = new Node('Logo');
                    logo.layer = Layers.Enum.UI_2D;
                    logo.addComponent(UITransform).setContentSize(2000 / 3, 2000 / 3);
                    const sp = logo.addComponent(Sprite);
                    sp.sizeMode = Sprite.SizeMode.CUSTOM; // 必须先设为 CUSTOM，再赋 spriteFrame，否则节点会被重置为图片原始尺寸
                    sp.spriteFrame = sf;
                    splash.addChild(logo);

                    const op = splash.getComponent(UIOpacity)!;

                    // 1.33 秒：满屏 1.08s → 0.25s 淡出 → 销毁进入游戏界面
                    tween(op)
                        .delay(1.08)
                        .to(0.25, { opacity: 0 }, { easing: 'quadOut' })
                        .call(() => { try { splash.destroy(); this.splashNode = null; } catch (e) { /* 忽略 */ } })
                        .start();
                    console.warn('[CM] 启动幕布已放映（1.33s）');
                } catch (e) {
                    console.error('[CM] 启动幕布构建异常:', e);
                    this.dismissSplash();
                }
            });
        } catch (e) {
            console.error('[CM] 启动幕布异常:', e);
            this.dismissSplash();
        }
    }

    private dismissSplash() {
        const splash = this.splashNode;
        if (!splash?.isValid) return;
        const op = splash.getComponent(UIOpacity)!;
        tween(op).to(.25, { opacity: 0 }, { easing: 'quadOut' }).call(() => {
            if (splash.isValid) splash.destroy();
            if (this.splashNode === splash) this.splashNode = null;
        }).start();
    }

    /* ============================== 波表编辑器 ============================== */

    private onWavePressed() {
        if (!this.wavePanel) {
            this.buildWavePanel();
        }
        this.wavePanelOpen = !this.wavePanelOpen;
        console.warn('[CM] 波表面板 ' + (this.wavePanelOpen ? '打开' : '关闭'));
        if (this.wavePanelOpen) {
            // 激活面板并重排当前方向布局 + 重绘所有 Graphics（激活后渲染数据需重建）
            this.wavePanel.active = true;
            this.wavePanel.setPosition(0, 0);
            this.relayoutWavePanel(this.currentTarget);
            this.setInfo('波表编辑器：在色块上滑动绘制 R/G/B 基础波形（横线=静音，自绘振幅）', new Color(220, 225, 235, 255));
        } else {
            this.closeWavePanel();
        }
    }

    /** 关闭波表面板（统一状态与视觉）。 */
    private closeWavePanel() {
        this.wavePanelOpen = false;
        this.wavePanel.active = false;
        this.fxUI?.dismiss();
        this.setInfo('已关闭波表编辑器', new Color(220, 225, 235, 255));
    }

    /**
     * 按当前方向重排波表面板。
     * 面板随容器旋转、对用户始终直立，因此「面板局部 +Y = 用户/重力方向的上」。
     * 横屏：面板 2000×900，三区沿局部 X 左中右，按钮底部一行；
     * 竖屏：面板 900×2000，三区沿局部 Y 上中下（R 上 G 中 B 下，波形仍沿局部 X 横向），按钮底部一行收窄。
     * @param animate 为 true 时元素以补间过渡（不改变初末位置），用于横竖屏旋转动画。
     */
    private relayoutWavePanel(target: number, animate = false) {
        if (!this.wavePanel) return;
        const portrait = target === 90 || target === -90;
        const panelTransform = this.wavePanelTransform;
        // 位置补间（横竖屏旋转时对元素做平滑过渡；Dropdown 取其 chip 节点）
        const mv = (t: any, x: number, y: number) => {
            const node = (t instanceof Dropdown) ? t.chip : (t as Node);
            if (!node) return;
            if (animate) this.tweenTo(node, x, y);
            else node.setPosition(x, y);
        };
        const view = this.userViewport(portrait);
        panelTransform.setContentSize(view.w, view.h);
        if (portrait) {
            this.waveTitleLabel.string = t('波表编辑器');
            this.waveTitleLabel.fontSize = 30;
            mv(this.waveTitle, 0, view.h / 2 - 42);
            const frameW = Math.min(580, view.w - 300);
            const frameH = 220;
            const topCenter = view.h / 2 - 315;
            const portraitGap = 360;
            const wpos = [
                { ch: 0, x: 0, y: topCenter },
                { ch: 1, x: 0, y: topCenter - portraitGap },
                { ch: 2, x: 0, y: topCenter - portraitGap * 2 },
            ];
            for (const d of wpos) {
                const a = this.waveAreas[d.ch];
                a.transform.setContentSize(frameW, frameH);
                mv(a.node, d.x, d.y);
                a.node.angle = 0;
                mv(a.labelNode, 0, frameH / 2 - 18);
                this.layoutWaveAxes(a);
            }
            mv(this.instDds[0], 0, topCenter - frameH / 2 - 48);
            mv(this.instDds[1], 0, topCenter - portraitGap - frameH / 2 - 48);
            mv(this.instDds[2], 0, topCenter - portraitGap * 2 - frameH / 2 - 48);
            mv(this.drumDds[0], 0, topCenter - frameH / 2 - 94);
            mv(this.drumDds[1], 0, topCenter - portraitGap - frameH / 2 - 94);
            mv(this.drumDds[2], 0, topCenter - portraitGap * 2 - frameH / 2 - 94);
            const bw = 104;
            const bh = 50;
            const yBtn = -view.h / 2 + 112;
            const btnXs = [-348, -232, -116, 0, 116, 232, 348];
            for (let i = 0; i < this.panelBtnBgs.length; i++) {
                const info = this.panelBtnBgs[i];
                const b = info.btn;
                mv(b, btnXs[i], yBtn);
                b.angle = 0;
                this.setPanelButtonSize(b, info, bw, bh, 16);
            }
            // 黑鼓/白鼓：并排在所有按钮之下、靠近界面底部
            mv(this.blackDd, -120, -view.h / 2 + 48);
            mv(this.whiteDd, 120, -view.h / 2 + 48);
            mv(this.undoBtn, -360, -view.h / 2 + 48);
        } else {
            this.waveTitleLabel.string = t('波表编辑器 · RGB 三通道基础波形（256 点 · 自动保存）');
            this.waveTitleLabel.fontSize = 28;
            mv(this.waveTitle, 0, view.h / 2 - 42);
            const cx = Math.min(465, (view.w - 490) / 2);
            const frameW = Math.min(420, (view.w - 180) / 3);
            const frameH = 260;
            const wpos = [
                { ch: 0, x: -cx, y: 120 },
                { ch: 1, x: 0, y: 120 },
                { ch: 2, x: cx, y: 120 },
            ];
            for (const d of wpos) {
                const a = this.waveAreas[d.ch];
                a.transform.setContentSize(frameW, frameH);
                mv(a.node, d.x, d.y);
                a.node.angle = 0;
                mv(a.labelNode, 0, frameH / 2 - 18);
                this.layoutWaveAxes(a);
            }
            mv(this.instDds[0], -cx + 105, -145);
            mv(this.instDds[1], 105, -145);
            mv(this.instDds[2], cx + 105, -145);
            mv(this.drumDds[0], -cx + 105, -195);
            mv(this.drumDds[1], 105, -195);
            mv(this.drumDds[2], cx + 105, -195);
            const btnXs = [-480, -330, -160, -10, 140, 350, 640];
            for (let i = 0; i < this.panelBtnBgs.length; i++) {
                const info = this.panelBtnBgs[i];
                const b = info.btn;
                mv(b, btnXs[i], -view.h / 2 + 58);
                b.angle = 0;
                this.setPanelButtonSize(b, info, i === 5 ? 150 : 128, 50, 19);
            }
            mv(this.blackDd, 380, -view.h / 2 + 120);
            mv(this.whiteDd, 610, -view.h / 2 + 120);
            mv(this.undoBtn, -630, -view.h / 2 + 58);
        }
        this.redrawWavePanelBg();
        this.redrawPanelButtonBgs();
        for (const a of this.waveAreas) this.redrawWaveArea(a);
        // 效果器槽位 UI 按方向重排 + 重绘
        if (this.fxUI) {
            this.fxUI.relayout(portrait, animate);
            this.fxUI.redrawAll();
        }
        // 预设/鼓下拉重绘（截点位置）
        for (const dd of this.instDds) dd?.redraw();
        for (const dd of this.drumDds) dd?.redraw();
        this.blackDd?.redraw();
        this.whiteDd?.redraw();
    }

    /** 平滑补间节点到目标位置（仅过渡，不改变初末位置），用于横竖屏旋转动画。 */
    private tweenTo(node: Node, x: number, y: number, dur = ROT_TWEEN): void {
        tween(node).stop();
        tween(node).to(dur, { position: new Vec3(x, y, 0) }, { easing: 'quadInOut' }).start();
    }

    /** 统一缩放，绝不对按钮、文字或图片做横纵向非等比拉伸。 */
    private rootScaleFor(portrait: boolean): Vec3 {
        const cw = Math.max(1, this.canvasTransform.contentSize.width);
        const ch = Math.max(1, this.canvasTransform.contentSize.height);
        const scale = Math.min(cw, ch) / DESIGN_H;
        return new Vec3(scale, scale, 1);
    }

    /** 按实际输出分辨率放大主界面按钮，不影响设置/编辑器等面板。 */
    private mainUiControlScale(): number {
        const frame = screen.windowSize;
        const shortSide = Math.max(1, Math.min(frame.width, frame.height));
        return Math.max(1, Math.min(MAIN_UI_MAX_SCALE, MAIN_UI_SCALE_SHORT_SIDE / shortSide));
    }

    /** 当前设备比例在 UIRoot 局部坐标中的真实可见范围。 */
    private userViewport(portrait: boolean): { w: number; h: number } {
        const cw = Math.max(1, this.canvasTransform.contentSize.width);
        const ch = Math.max(1, this.canvasTransform.contentSize.height);
        const scale = Math.min(cw, ch) / DESIGN_H;
        const landscape = { w: Math.max(cw, ch) / scale, h: Math.min(cw, ch) / scale };
        return portrait ? { w: landscape.h, h: landscape.w } : landscape;
    }

    /** 调整面板按钮尺寸与字号（info 记录当前尺寸供重绘底色）。 */
    private setPanelButtonSize(btn: Node, info: { w: number; h: number }, w: number, h: number, fontSize: number) {
        btn.getComponent(UITransform)!.setContentSize(w, h);
        info.w = w;
        info.h = h;
        const text = btn.getChildByName('Text');
        const lbl = text?.getComponent(Label);
        if (lbl) lbl.fontSize = fontSize;
    }

    /** 重绘波表面板底色与边框（使用当前面板尺寸）。 */
    private redrawWavePanelBg() {
        const gfx = this.wavePanel.getComponent(Graphics);
        if (!gfx) return;
        const t = this.wavePanelTransform;
        const w = t.contentSize.width;
        const h = t.contentSize.height;
        gfx.clear();
        // 底色铺满整个可见区域（大于面板，保证任一方向都覆盖全屏、无内边距）
        gfx.roundRect(-4000, -4000, 8000, 8000, 0);
        gfx.fillColor = new Color(8, 12, 24, 255);
        gfx.fill();
        // 面板边框（沿面板尺寸）
        gfx.roundRect(-w / 2, -h / 2, w, h, 24);
        gfx.lineWidth = 2;
        gfx.strokeColor = new Color(120, 140, 180, 255);
        gfx.stroke();
    }

    /** 重绘面板底部按钮的底色（离屏时绘制的 Graphics 不生成渲染数据，需在屏内重画）。 */
    private redrawPanelButtonBgs() {
        for (const info of this.panelBtnBgs) {
            const bgNode = info.btn.getChildByName('Bg');
            const g = bgNode?.getComponent(Graphics);
            if (g) {
                g.clear();
                const r = Math.min(18, info.h / 4);
                g.roundRect(-info.w / 2, -info.h / 2, info.w, info.h, r);
                g.fillColor = info.color;
                g.fill();
            }
        }
        // 撤销按钮底色
        if (this.undoBgGfx) {
            this.undoBgGfx.clear();
            this.undoBgGfx.roundRect(-75, -28, 150, 56, 18);
            this.undoBgGfx.fillColor = new Color(46, 60, 60, 255);
            this.undoBgGfx.fill();
        }
    }

    /** 构建波表面板（初始横屏布局；打开时按当前方向重排）。 */
    private buildWavePanel() {
        const panel = new Node('WavePanel');
        panel.layer = Layers.Enum.UI_2D;
        this.wavePanelTransform = panel.addComponent(UITransform);
        this.wavePanelTransform.setContentSize(1900, 860);
        panel.addComponent(Graphics); // 面板底色/边框（redrawWavePanelBg 绘制）

        const title = this.makeLabel('WaveTitle', '波表编辑器 · RGB 三通道基础波形（256 点 · 自动保存）', 28, 38, new Color(225, 230, 242, 255), 1800, 40);
        title.setPosition(0, 385);
        panel.addChild(title);
        this.waveTitle = title;
        this.waveTitleLabel = title.getComponent(Label)!;

        // 三个绘制区（横屏左中右；竖屏由 relayoutWavePanel 重排为上中下）
        const defs = [
            { ch: 0, label: 'R', color: new Color(255, 92, 92, 255), x: -640 },
            { ch: 1, label: 'G', color: new Color(96, 255, 120, 255), x: 0 },
            { ch: 2, label: 'B', color: new Color(120, 165, 255, 255), x: 640 },
        ];
        for (const d of defs) {
            const areaNode = new Node('WaveArea' + d.ch);
            areaNode.layer = Layers.Enum.UI_2D;
            const ut = areaNode.addComponent(UITransform);
            ut.setContentSize(560, 340);
            areaNode.setPosition(d.x, 60);
            panel.addChild(areaNode);

            const areaGfx = areaNode.addComponent(Graphics);
            const storedWave = this.loadWave(d.ch);
            const baseWave = this.loadBaseWave(d.ch, storedWave);
            const amplitude = this.loadWaveScalar(d.ch, 'amp', 1);
            const cycles = this.loadWaveScalar(d.ch, 'cycles', 1);
            const savedDrumId = loadStr(`cm_drum_channel_${d.ch}`, DRUM_NONE_ID);
            const savedSourceId = loadStr(`cm_drum_channel_source_${d.ch}`, ['tr808_kick', 'tr808_snare', 'tr808_hat'][d.ch]);
            this.channelDrumIds[d.ch] = savedDrumId === DRUM_CUSTOM_ID || savedDrumId === DRUM_NONE_ID || !!this.drumPresetOf(savedDrumId)
                ? savedDrumId : DRUM_NONE_ID;
            this.channelDrumSourceIds[d.ch] = this.drumPresetOf(savedSourceId)?.id ?? ['tr808_kick', 'tr808_snare', 'tr808_hat'][d.ch];
            const drumSpeed = this.loadWaveScalar(d.ch, 'drum_speed', 1);
            const sampleWave = this.drumPresetOf(this.channelDrumSourceIds[d.ch])?.waveform;
            const wave = this.channelDrumIds[d.ch] !== DRUM_NONE_ID && sampleWave
                ? this.stretchDrumWave(sampleWave, amplitude, drumSpeed)
                : this.applyWaveAxes(baseWave, amplitude, cycles);
            const lbl = this.makeLabel('WaveAreaLabel' + d.ch, d.label, 26, 32, d.color, 560, 32);
            lbl.setPosition(0, 190);
            areaNode.addChild(lbl);
            const ampAxis = new Node('AmplitudeAxis' + d.ch);
            ampAxis.layer = Layers.Enum.UI_2D; ampAxis.addComponent(UITransform).setContentSize(24, 300); areaNode.addChild(ampAxis);
            const ampGfx = ampAxis.addComponent(Graphics);
            const waveAxis = new Node('WavelengthAxis' + d.ch);
            waveAxis.layer = Layers.Enum.UI_2D; waveAxis.addComponent(UITransform).setContentSize(500, 24); areaNode.addChild(waveAxis);
            const waveGfx = waveAxis.addComponent(Graphics);
            const area = { ch: d.ch, node: areaNode, gfx: areaGfx, transform: ut, labelNode: lbl, points: [], wave, baseWave, amplitude, cycles, drumSpeed, ampAxis, waveAxis, ampGfx, waveGfx };
            this.waveAreas.push(area);
            this.sendWaveToNative(d.ch, baseWave, amplitude, cycles);

            // 每区单指绘制；START/MOVE/END 三段式
            areaNode.on(Node.EventType.TOUCH_START, (e: EventTouch) => this.onWaveAreaTouch(0, d.ch, e), this);
            areaNode.on(Node.EventType.TOUCH_MOVE, (e: EventTouch) => this.onWaveAreaTouch(1, d.ch, e), this);
            areaNode.on(Node.EventType.TOUCH_END, (e: EventTouch) => this.onWaveAreaTouch(2, d.ch, e), this);
            areaNode.on(Node.EventType.TOUCH_CANCEL, (e: EventTouch) => this.onWaveAreaTouch(2, d.ch, e), this);
            const bindAxis = (axis: Node, kind: 'amp' | 'cycles') => {
                axis.on(Node.EventType.TOUCH_START, (e: EventTouch) => this.onWaveAxisTouch(0, d.ch, kind, e), this);
                axis.on(Node.EventType.TOUCH_MOVE, (e: EventTouch) => this.onWaveAxisTouch(1, d.ch, kind, e), this);
                axis.on(Node.EventType.TOUCH_END, (e: EventTouch) => this.onWaveAxisTouch(2, d.ch, kind, e), this);
                axis.on(Node.EventType.TOUCH_CANCEL, (e: EventTouch) => this.onWaveAxisTouch(2, d.ch, kind, e), this);
            };
            bindAxis(ampAxis, 'amp'); bindAxis(waveAxis, 'cycles');
            this.layoutWaveAxes(area);
        }

        // 底部操作行：预设 / 试听 / 关闭（横屏默认位置；竖屏由 relayoutWavePanel 重排）
        const mkPanelBtn = (name: string, text: string, x: number, w: number, cb: () => void, bg: Color) => {
            const b = this.makeButton(name, text, x, -360, w, 56, cb, { bgColor: bg, opacity: 255, fontSize: 22 });
            panel.addChild(b);
            this.panelBtnBgs.push({ btn: b, w, h: 56, color: bg });
            return b;
        };
        mkPanelBtn('PresetRand', '随机生成', -700, 150, () => this.applyPreset(1), new Color(36, 48, 88, 255));
        mkPanelBtn('PresetClassic', '经典', -520, 150, () => this.applyPreset(2), new Color(36, 48, 88, 255));
        const listenR = mkPanelBtn('ListenR', '试听 R', -250, 150, () => {}, new Color(26, 52, 26, 255));
        const listenG = mkPanelBtn('ListenG', '试听 G', -70, 150, () => {}, new Color(26, 52, 26, 255));
        const listenB = mkPanelBtn('ListenB', '试听 B', 110, 150, () => {}, new Color(26, 52, 26, 255));
        this.attachChannelPreview(listenR, 0); this.attachChannelPreview(listenG, 1); this.attachChannelPreview(listenB, 2);
        mkPanelBtn('WaveReset', '全部重置', 380, 190, () => this.resetAll(), new Color(70, 40, 40, 255));
        mkPanelBtn('WaveClose', '关闭', 880, 150, () => this.closeWavePanel(), new Color(70, 40, 40, 255));

        // 撤销按钮（左下角；初始横屏位置，竖屏由 relayoutWavePanel 重排）
        const undoBtn = new Node('UndoWave');
        undoBtn.layer = Layers.Enum.UI_2D;
        undoBtn.addComponent(UITransform).setContentSize(150, 56);
        undoBtn.setPosition(-905, -360);
        panel.addChild(undoBtn);
        const ubg = new Node('Bg');
        ubg.layer = Layers.Enum.UI_2D;
        ubg.addComponent(UITransform).setContentSize(150, 56);
        const ug = ubg.addComponent(Graphics);
        ug.roundRect(-75, -28, 150, 56, 18);
        ug.fillColor = new Color(46, 60, 60, 255);
        ug.fill();
        undoBtn.addChild(ubg);
        const utn = new Node('Text');
        utn.layer = Layers.Enum.UI_2D;
        utn.addComponent(UITransform).setContentSize(150, 56);
        const utl = utn.addComponent(Label);
        utl.string = t('撤回');
        utl.fontSize = 22;
        utl.isSystemFontUsed = true;
        utl.horizontalAlign = Label.HorizontalAlign.CENTER;
        utl.verticalAlign = Label.VerticalAlign.CENTER;
        utl.color = new Color(235, 240, 250, 255);
        undoBtn.addChild(utn);
        undoBtn.on(Node.EventType.TOUCH_END, (e: EventTouch) => { e.propagationStopped = true; this.undo(); }, this);
        this.undoBtn = undoBtn;
        this.undoBgGfx = ug;

        // 面板打开时吞掉触摸，避免穿透到图片触发演奏
        const swallow = (e: EventTouch) => { e.propagationStopped = true; };
        panel.on(Node.EventType.TOUCH_START, swallow, this);
        panel.on(Node.EventType.TOUCH_MOVE, swallow, this);
        panel.on(Node.EventType.TOUCH_END, swallow, this);
        panel.on(Node.EventType.TOUCH_CANCEL, swallow, this);

        this.wavePanel = panel;
        this.uiRoot.addChild(panel);
        // 效果器插件 UI（8 槽下拉 + 设置弹窗）
        this.fxUI = new FxUI((slots) => {
            this.fxSlots = slots;
            saveFxSlots(slots);
            this.pushFxToNative();
        });
        this.fxUI.setSlots(this.fxSlots);
        this.fxUI.build(panel);

        // 音色预设下拉（R/G/B 各一，含“自定义”）
        const instItems = [...PRESET_INST.map((d) => ({ id: d.id, label: d.label })), { id: CUSTOM_INST.id, label: CUSTOM_INST.label }];
        const instEnglish: Record<string, string> = {
            piano: 'Replaces this channel wavetable with a piano-like harmonic stack: fundamental plus smoothly decaying harmonics, then normalized.',
            bell: 'Uses strong upper harmonics (especially the 3rd-5th) for a bright metallic bell timbre.',
            violin: 'Uses a fundamental with gently decaying harmonics for a rounded violin-like tone.',
            cello: 'Emphasizes the fundamental and low harmonics while suppressing upper partials for a warm cello tone.',
            flute: 'Uses an almost pure fundamental with a very light second harmonic for an airy flute tone.',
            piccolo: 'Emphasizes the second harmonic and upper partials for a high, bright piccolo tone.',
            bass: 'Keeps the fundamental dominant with a few low harmonics for a deep bass tone.',
            guitar: 'Uses strong second and third harmonics with a decaying series for a bright plucked-guitar tone.',
            sax: 'Adds prominent odd harmonics for a smooth saxophone tone with a slight square-wave character.',
            trombone: 'Combines a strong fundamental with smooth harmonics for a full, rounded brass tone.',
            vox: 'Emphasizes the fundamental and first few harmonics to approximate vowel-like vocal resonance.',
        };
        const instDesc = (id: string) => {
            if (id === CUSTOM_INST.id) return t('自定义：无预设，保留你当前的自绘/重置波形。', 'Custom: keeps your current drawn or reset waveform without applying a preset.');
            return isEnglish() ? (instEnglish[id] ?? '') : (PRESET_INST.find((d) => d.id === id)?.desc ?? '');
        };
        this.instDds = [];
        for (let c = 0; c < 3; c++) {
            this.instIds[c] = loadStr('cm_inst_' + c, c === 0 ? 'piano' : c === 1 ? 'flute' : 'bell');
            const dd = new Dropdown(panel, instItems, this.instIds[c], instDesc,
                (id) => this.onInstPick(c, id));
            this.instDds.push(dd);
        }
        const channelDrumItems = [
            { id: DRUM_CUSTOM_ID, label: isEnglish() ? 'Drum · Custom' : '鼓预设 · 自定义', group: isEnglish() ? 'Mode' : '模式' },
            { id: DRUM_NONE_ID, label: isEnglish() ? 'Drum · None' : '鼓预设 · 无', group: isEnglish() ? 'Mode' : '模式' },
            ...this.drumMenuItems(),
        ];
        this.drumDds = [];
        for (let c = 0; c < 3; c++) {
            const dd = new Dropdown(panel, channelDrumItems, this.channelDrumIds[c],
                (id) => this.channelDrumDescription(id), (id) => this.onChannelDrumPick(c, id));
            this.drumDds.push(dd);
            this.refreshChannelDrumWave(c, false);
        }
        // 启动时为空的通道使用完整 4 槽乐器塑形链。
        for (let c = 0; c < 3; c++) {
            const first = globalFxIndex(c, 0);
            if (this.fxSlots[first]?.id === 'none') {
                const chain = recommendedGlobalFxChain(this.instIds[c]);
                for (let j = 0; j < FX_GLOBAL_SLOTS_PER_CHANNEL; j++) this.fxSlots[globalFxIndex(c, j)] = chain[j];
            }
        }
        saveFxSlots(this.fxSlots);
        this.fxUI.setSlots(this.fxSlots);
        this.pushFxToNative();
        // 黑鼓/白鼓下拉
        this.drumBlackId = this.validDrumId(loadStr('cm_drum_black', 'tr808_kick'), 'tr808_kick');
        this.drumWhiteId = this.validDrumId(loadStr('cm_drum_white', 'tr808_snare'), 'tr808_snare');
        const drumItems = this.drumMenuItems();
        this.blackDd = new Dropdown(panel, drumItems, this.drumBlackId,
            (id) => isEnglish()
                ? `Trigger: tap a near-black pixel where R, G and B are all below 55.\n\nSelected one-shot: ${this.drumPresetOf(id)?.englishLabel ?? ''}.`
                : `触发条件：点击图片中 R、G、B 均低于 55 的近黑像素。\n\n当前单击采样：${this.drumPresetOf(id)?.label ?? ''}。`,
            (id) => { this.drumBlackId = id; saveStr('cm_drum_black', id); this.pushDrumToNative(); });
        this.whiteDd = new Dropdown(panel, drumItems, this.drumWhiteId,
            (id) => isEnglish()
                ? `Trigger: tap a near-white pixel where R, G and B are all above 200.\n\nSelected one-shot: ${this.drumPresetOf(id)?.englishLabel ?? ''}.`
                : `触发条件：点击图片中 R、G、B 均高于 200 的近白像素。\n\n当前单击采样：${this.drumPresetOf(id)?.label ?? ''}。`,
            (id) => { this.drumWhiteId = id; saveStr('cm_drum_white', id); this.pushDrumToNative(); });

        // 初始隐藏（deactivate）；打开时激活并重绘所有 Graphics（见 onWavePressed）
        panel.active = false;
        this.redrawWavePanelBg();
        for (const a of this.waveAreas) this.redrawWaveArea(a);
    }

    private drumPresetOf(id: string): DrumPresetDef | undefined {
        return DRUM_PRESETS.find((preset) => preset.id === (LEGACY_DRUM_IDS[id] ?? id));
    }

    private validDrumId(id: string, fallback: string): string {
        return this.drumPresetOf(id)?.id ?? fallback;
    }

    private drumMenuItems() {
        return DRUM_PRESETS.map((preset) => ({
            id: preset.id,
            label: isEnglish() ? preset.englishLabel : preset.label,
            group: isEnglish() ? (preset.group === '原声鼓' ? 'Acoustic' : preset.group) : preset.group,
        }));
    }

    private channelDrumDescription(id: string): string {
        if (id === DRUM_NONE_ID) return t(
            '无：关闭该 RGB 通道的鼓采样，恢复可绘制的循环波表。',
            'None: disables the drum sample on this RGB channel and restores the drawable wavetable.',
        );
        if (id === DRUM_CUSTOM_ID) return t(
            '自定义：保留当前鼓采样，并使用你调节后的音量、播放速度和效果器。',
            'Custom: keeps the current sample with your adjusted level, playback speed and effects.',
        );
        const preset = this.drumPresetOf(id);
        return isEnglish() ? (preset?.englishDesc ?? '') : (preset?.desc ?? '');
    }

    private isChannelDrumActive(ch: number): boolean {
        return this.channelDrumIds[ch] !== DRUM_NONE_ID && !!this.drumPresetOf(this.channelDrumSourceIds[ch]);
    }

    private saveChannelDrumState(ch: number): void {
        const area = this.waveAreas[ch];
        if (!area) return;
        saveStr(`cm_drum_channel_${ch}`, this.channelDrumIds[ch]);
        saveStr(`cm_drum_channel_source_${ch}`, this.channelDrumSourceIds[ch]);
        saveStr(`cm_wt_drum_speed_${ch}`, String(area.drumSpeed));
    }

    private pushChannelDrumToNative(ch: number): void {
        const area = this.waveAreas[ch];
        if (!area || !NativeBridge.isAndroidNative || !NativeBridge.synthReady) return;
        NativeBridge.setChannelDrum(ch, this.isChannelDrumActive(ch) ? this.channelDrumSourceIds[ch] : DRUM_NONE_ID,
            area.amplitude, area.drumSpeed);
    }

    /** Keep the editor on a fixed time window: faster samples compress left, slower samples stretch past the frame. */
    private stretchDrumWave(source: number[], amplitude: number, speed: number): number[] {
        const out = new Array(256).fill(0);
        const safeSpeed = Math.max(.5, Math.min(2, speed));
        for (let i = 0; i < out.length; i++) {
            const position = i * safeSpeed;
            const i0 = Math.floor(position);
            if (i0 >= source.length) continue;
            const i1 = Math.min(source.length - 1, i0 + 1);
            const value = source[i0] + (source[i1] - source[i0]) * (position - i0);
            out[i] = Math.max(-1, Math.min(1, value * amplitude));
        }
        return out;
    }

    private refreshChannelDrumWave(ch: number, pushNative = true): void {
        const area = this.waveAreas[ch];
        if (!area) return;
        const sample = this.drumPresetOf(this.channelDrumSourceIds[ch]);
        area.wave = this.isChannelDrumActive(ch) && sample
            ? this.stretchDrumWave(sample.waveform, area.amplitude, area.drumSpeed)
            : this.applyWaveAxes(area.baseWave, area.amplitude, area.cycles);
        this.saveWaveState(area);
        this.redrawWaveArea(area);
        if (pushNative) this.pushChannelDrumToNative(ch);
    }

    private disableChannelDrum(ch: number, pushNative = true): void {
        this.channelDrumIds[ch] = DRUM_NONE_ID;
        this.drumDds[ch]?.setValue(DRUM_NONE_ID);
        this.saveChannelDrumState(ch);
        this.refreshChannelDrumWave(ch, pushNative);
    }

    private markChannelDrumCustom(ch: number): void {
        if (!this.isChannelDrumActive(ch)) return;
        this.channelDrumIds[ch] = DRUM_CUSTOM_ID;
        this.drumDds[ch]?.setValue(DRUM_CUSTOM_ID);
        this.saveChannelDrumState(ch);
    }

    private onChannelDrumPick(ch: number, id: string): void {
        this.pushUndo();
        const area = this.waveAreas[ch];
        if (!area) return;
        if (id === DRUM_NONE_ID) {
            this.disableChannelDrum(ch);
            this.setInfo(t('鼓采样已关闭，可继续绘制该通道波形', 'Drum sample disabled; this channel can be drawn again'), new Color(220, 225, 235, 255));
            return;
        }
        if (id !== DRUM_CUSTOM_ID) {
            const preset = this.drumPresetOf(id);
            if (!preset) return;
            this.channelDrumSourceIds[ch] = preset.id;
            area.amplitude = 1;
            area.drumSpeed = 1;
        }
        this.channelDrumIds[ch] = id;
        this.saveChannelDrumState(ch);
        this.refreshChannelDrumWave(ch);
        this.setInfo(t('已启用鼓采样：波形框改为采样预览，绘制暂时关闭', 'Drum sample enabled: the frame now previews the sample and drawing is disabled'), new Color(220, 225, 235, 255));
    }

    /** 音色预设选择 → 把通道波表替换为对应音色波形，并把该通道的全局效果器设为该乐器推荐配置。 */
    private onInstPick(ch: number, id: string) {
        this.pushUndo();
        this.disableChannelDrum(ch);
        // “自定义”：不改变波形，仅标记（保留当前自绘/重置波形）
        if (id === CUSTOM_INST.id) {
            this.instIds[ch] = id;
            saveStr('cm_inst_' + ch, id);
            return;
        }
        this.instIds[ch] = id;
        saveStr('cm_inst_' + ch, id);
        const wave = presetWaveFor(id);
        const a = this.waveAreas[ch];
        a.baseWave = wave.slice(); a.amplitude = 1; a.cycles = 1; a.wave = wave.slice();
        this.saveWaveState(a);
        this.sendWaveToNative(ch, a.baseWave, a.amplitude, a.cycles);
        this.redrawWaveArea(a);
        // 关联全局效果器到预设（按乐器音色设定该通道的全局效果器插件与参数）
        this.applyInstGlobalFx(ch, id);
    }

    /** 把通道 ch 标记为“自定义”（自绘/重置后的波形无预设名）。 */
    private markInstCustom(ch: number) {
        this.instIds[ch] = CUSTOM_INST.id;
        saveStr('cm_inst_' + ch, CUSTOM_INST.id);
        this.instDds[ch]?.setValue(CUSTOM_INST.id);
    }

    /** 把通道 ch 的全局效果器槽位设为 instId 对应的推荐配置（保存 + 推送原生）。 */
    private applyInstGlobalFx(ch: number, instId: string) {
        const chain = recommendedGlobalFxChain(instId);
        for (let j = 0; j < FX_GLOBAL_SLOTS_PER_CHANNEL; j++) this.fxSlots[globalFxIndex(ch, j)] = chain[j];
        saveFxSlots(this.fxSlots);
        this.fxUI?.setSlots(this.fxSlots);
        this.pushFxToNative();
    }

    private cloneSlots(slots: FxSlot[]): FxSlot[] {
        return slots.map((s) => ({ id: s.id, invert: s.invert, intensity: s.intensity, params: { ...s.params }, curve: s.curve.slice() }));
    }

    /** 压入撤销快照（三通道波形 + 预设）。 */
    private pushUndo() {
        try {
            const waves = this.waveAreas.map((a) => a.wave.slice());
            const baseWaves = this.waveAreas.map((a) => a.baseWave.slice());
            const amplitudes = this.waveAreas.map((a) => a.amplitude);
            const cycles = this.waveAreas.map((a) => a.cycles);
            const drumSpeeds = this.waveAreas.map((a) => a.drumSpeed);
            const instIds = this.instIds.slice();
            const drumIds = this.channelDrumIds.slice();
            const drumSourceIds = this.channelDrumSourceIds.slice();
            const fxSlots = this.cloneSlots(this.fxSlots);
            this.undoStack.push({ waves, baseWaves, amplitudes, cycles, drumSpeeds, instIds, drumIds, drumSourceIds, fxSlots });
            if (this.undoStack.length > 30) this.undoStack.shift();
        } catch (e) { /* 忽略 */ }
    }

    /** 撤回上一步的操作（恢复上一次的波形 + 预设）。 */
    private undo() {
        const snap = this.undoStack.pop();
        if (!snap) {
            this.setInfo('没有可撤回的操作', new Color(255, 200, 120, 255));
            return;
        }
        try {
            for (let ch = 0; ch < 3; ch++) {
                const a = this.waveAreas[ch];
                if (!a) continue;
                const w = snap.waves[ch] ? snap.waves[ch].slice() : a.wave;
                a.wave = w;
                a.baseWave = snap.baseWaves[ch]?.slice() ?? w.slice();
                a.amplitude = snap.amplitudes[ch] ?? 1;
                a.cycles = snap.cycles[ch] ?? 1;
                a.drumSpeed = snap.drumSpeeds[ch] ?? 1;
                this.channelDrumIds[ch] = snap.drumIds[ch] ?? DRUM_NONE_ID;
                this.channelDrumSourceIds[ch] = snap.drumSourceIds[ch] ?? ['tr808_kick', 'tr808_snare', 'tr808_hat'][ch];
                this.saveChannelDrumState(ch);
                this.refreshChannelDrumWave(ch, false);
                this.sendWaveToNative(ch, a.baseWave, a.amplitude, a.cycles);
                this.pushChannelDrumToNative(ch);
                this.instIds[ch] = snap.instIds[ch] ?? CUSTOM_INST.id;
                saveStr('cm_inst_' + ch, this.instIds[ch]);
                this.instDds[ch]?.setValue(this.instIds[ch]);
                this.drumDds[ch]?.setValue(this.channelDrumIds[ch]);
            }
            this.fxSlots = this.cloneSlots(snap.fxSlots);
            saveFxSlots(this.fxSlots); this.fxUI?.setSlots(this.fxSlots); this.pushFxToNative();
            this.setInfo('已撤回上一步操作', new Color(220, 225, 235, 255));
        } catch (e) {
            console.error('[CM] 撤销异常:', e);
        }
    }

    /** 全部重置：波形=正弦、预设=自定义、所有效果器槽=无、鼓=kick/snare。 */
    private resetAll() {
        this.pushUndo();
        for (let ch = 0; ch < 3; ch++) {
            const a = this.waveAreas[ch];
            if (!a) continue;
            const w = this.sineWave();
            a.baseWave = w.slice(); a.amplitude = 1; a.cycles = 1; a.drumSpeed = 1; a.wave = w;
            this.channelDrumIds[ch] = DRUM_NONE_ID;
            this.channelDrumSourceIds[ch] = ['tr808_kick', 'tr808_snare', 'tr808_hat'][ch];
            this.saveChannelDrumState(ch);
            this.drumDds[ch]?.setValue(DRUM_NONE_ID);
            this.saveWaveState(a);
            this.sendWaveToNative(ch, a.baseWave, a.amplitude, a.cycles);
            this.pushChannelDrumToNative(ch);
            this.redrawWaveArea(a);
            this.markInstCustom(ch);
        }
        // 所有效果器槽位 → 无
        this.fxSlots = [];
        for (let i = 0; i < FX_SLOT_COUNT; i++) this.fxSlots.push(newSlot('none'));
        saveFxSlots(this.fxSlots);
        this.fxUI?.setSlots(this.fxSlots);
        this.fxUI?.resetGlobalSlotCounts();
        this.pushFxToNative();
        // 鼓重置
        this.drumBlackId = 'tr808_kick';
        this.drumWhiteId = 'tr808_snare';
        saveStr('cm_drum_black', this.drumBlackId);
        saveStr('cm_drum_white', this.drumWhiteId);
        this.blackDd?.setValue(this.drumBlackId);
        this.whiteDd?.setValue(this.drumWhiteId);
        this.pushDrumToNative();
        this.setInfo('已全部重置（波形=正弦、RGB 鼓=无、效果器=无、黑白鼓=TR-808）', new Color(220, 225, 235, 255));
    }

    /** 黑/白鼓元素推给原生。 */
    private pushDrumToNative() {
        try {
            if (NativeBridge.isAndroidNative && NativeBridge.synthReady) {
                NativeBridge.setDrumIds(this.drumBlackId, this.drumWhiteId);
            }
        } catch (e) {
            console.error('[CM] setDrumIds 异常:', e);
        }
    }

    /** 效果器槽位配置推给原生合成器。 */
    private pushFxToNative() {
        try {
            if (NativeBridge.isAndroidNative && NativeBridge.synthReady) {
                NativeBridge.setEffectSlots(fxSlotsToJson(this.fxSlots));
            }
        } catch (e) {
            console.error('[CM] setEffectSlots 异常:', e);
        }
    }

    private openGridSettings() {
        const portrait = this.currentTarget === 90 || this.currentTarget === -90;
        const view = this.userViewport(portrait);
        if (!this.gridSettings) {
            this.gridSettings = new GridSettingsUI(this.uiRoot, this.gridState,
                (state) => {
                    this.gridState = state;
                    saveGridState(state);
                    this.redrawPlayGrid();
                    this.refreshInfoVisibility();
                },
                () => this.gridSettings?.close());
        }
        this.gridSettings.open(view.w, view.h, portrait);
    }

    private redrawPlayGrid() {
        if (!this.gridGfx || !this.gridTransform) return;
        const portrait = this.currentTarget === 90 || this.currentTarget === -90;
        const view = this.userViewport(portrait);
        this.gridTransform.setContentSize(view.w, view.h);
        const g = this.gridGfx; g.clear();
        const w = view.w, h = view.h;
        const verticalLines = this.repeatedGridLines(this.gridState.verticalLines, this.gridState.verticalPeriod);
        const horizontalLines = this.repeatedGridLines(this.gridState.horizontalLines, this.gridState.horizontalPeriod);
        if (this.gridState.visible) {
            const vc = GRID_COLORS[this.gridState.verticalColor] ?? GRID_COLORS.white;
            const hc = GRID_COLORS[this.gridState.horizontalColor] ?? GRID_COLORS.white;
            const rulerOuter = 1.6;
            const rulerInner = 5.3;
            g.strokeColor = new Color(vc.r, vc.g, vc.b, Math.round(this.gridState.verticalAlpha * 255));
            for (let i = 0; i < verticalLines.length; i++) {
                const p = verticalLines[i];
                const before = p - (i > 0 ? verticalLines[i - 1] : 0);
                const after = (i + 1 < verticalLines.length ? verticalLines[i + 1] : 1) - p;
                const thickness = Math.max(MIN_GRID_LINE_WIDTH, Math.min(5, Math.min(Math.min(before, after) * w, h / (horizontalLines.length + 1)) / 30));
                const x = -w / 2 + p * w;
                g.lineWidth = thickness;
                g.moveTo(x, -h / 2); g.lineTo(x, h / 2); g.stroke();
                g.lineWidth = Math.max(3, thickness * 2.2);
                g.moveTo(x, -h / 2 + rulerOuter); g.lineTo(x, -h / 2 + rulerInner);
                g.moveTo(x, h / 2 - rulerOuter); g.lineTo(x, h / 2 - rulerInner);
                g.stroke();
            }
            g.strokeColor = new Color(hc.r, hc.g, hc.b, Math.round(this.gridState.horizontalAlpha * 255));
            for (let i = 0; i < horizontalLines.length; i++) {
                const p = horizontalLines[i];
                const before = p - (i > 0 ? horizontalLines[i - 1] : 0);
                const after = (i + 1 < horizontalLines.length ? horizontalLines[i + 1] : 1) - p;
                const thickness = Math.max(MIN_GRID_LINE_WIDTH, Math.min(5, Math.min(Math.min(before, after) * h, w / (verticalLines.length + 1)) / 30));
                const y = -h / 2 + p * h;
                g.lineWidth = thickness;
                g.moveTo(-w / 2, y); g.lineTo(w / 2, y); g.stroke();
                g.lineWidth = Math.max(3, thickness * 2.2);
                g.moveTo(-w / 2 + rulerOuter, y); g.lineTo(-w / 2 + rulerInner, y);
                g.moveTo(w / 2 - rulerOuter, y); g.lineTo(w / 2 - rulerInner, y);
                g.stroke();
            }
        }
        this.updateGridEdgeLabels(verticalLines, horizontalLines, w, h);
        // 约 0.3mm 的屏幕边缘状态线：录音红、播放绿、同时进行橙色，其余白色。
        const edge = this.styleTransition ? new Color(70, 130, 255, 255)
            : this.edgeMode === 'both' ? new Color(255, 150, 45, 255)
            : this.edgeMode === 'record' ? new Color(245, 55, 65, 255)
                : this.edgeMode === 'play' ? new Color(60, 220, 110, 255)
                    : new Color(255, 255, 255, 255);
        g.lineWidth = 1.6; g.strokeColor = edge;
        g.roundRect(-w / 2 + .8, -h / 2 + .8, w - 1.6, h - 1.6, SCREEN_EDGE_RADIUS);
        g.stroke();
    }

    private edgeLabel(pool: Node[], index: number, name: string): Node {
        while (pool.length <= index) {
            const node = new Node(name);
            node.layer = Layers.Enum.UI_2D;
            node.addComponent(UITransform).setContentSize(38, 16);
            const label = node.addComponent(Label);
            label.fontSize = 8; label.lineHeight = 10; label.isSystemFontUsed = true;
            label.horizontalAlign = Label.HorizontalAlign.CENTER;
            label.verticalAlign = Label.VerticalAlign.CENTER;
            label.overflow = Label.Overflow.SHRINK;
            label.enableWrapText = false;
            this.gridNode.addChild(node);
            pool.push(node);
        }
        const node = pool[index]; node.active = true; return node;
    }

    private gridLabelFontSize(cellFraction: number, defaultDivisions: number): number {
        return Math.max(MIN_GRID_LABEL_FONT_SIZE, Math.min(MAX_GRID_LABEL_FONT_SIZE,
            DEFAULT_GRID_LABEL_FONT_SIZE * cellFraction * defaultDivisions));
    }

    /** 下边缘显示音阶、左边缘显示音量；文字坐标与颜色/透明度跟随对应网格线。 */
    private updateGridEdgeLabels(verticalLines: number[], horizontalLines: number[], w: number, h: number) {
        if (!this.gridState.visible) {
            for (const node of this.gridNoteLabels) node.active = false;
            for (const node of this.gridVolumeLabels) node.active = false;
            return;
        }
        const vc = GRID_COLORS[this.gridState.verticalColor] ?? GRID_COLORS.white;
        const hc = GRID_COLORS[this.gridState.horizontalColor] ?? GRID_COLORS.white;
        const noteColor = new Color(vc.r, vc.g, vc.b, Math.round(this.gridState.verticalAlpha * 255));
        const volumeColor = new Color(hc.r, hc.g, hc.b, Math.round(this.gridState.horizontalAlpha * 255));
        const xBoundaries = [0, ...verticalLines, 1];
        const yBoundaries = [0, ...horizontalLines, 1];
        const columnCount = xBoundaries.length - 1;
        const rowCount = yBoundaries.length - 1;
        for (let i = 0; i < columnCount; i++) {
            const p = xBoundaries[i], next = xBoundaries[i + 1];
            const node = this.edgeLabel(this.gridNoteLabels, i, 'GridNoteMark');
            node.angle = 0;
            const cellWidth = (next - p) * w;
            const fontSize = this.gridLabelFontSize(next - p, DEFAULT_GRID_COLUMNS);
            const labelHeight = Math.max(16, fontSize + 4);
            node.getComponent(UITransform)!.setContentSize(Math.max(8, cellWidth - 2), labelHeight);
            node.setPosition(-w / 2 + (p + next) * .5 * w, -h / 2 + labelHeight / 2 + 1);
            const label = node.getComponent(Label)!;
            const midi = Math.round(this.gridState.midiMin + ((i + .5) / columnCount) * (this.gridState.midiMax - this.gridState.midiMin));
            label.string = midiToName(midi);
            label.fontSize = fontSize;
            label.lineHeight = label.fontSize + 2;
            label.color = noteColor;
        }
        for (let i = columnCount; i < this.gridNoteLabels.length; i++) this.gridNoteLabels[i].active = false;

        for (let i = 0; i < rowCount; i++) {
            const p = yBoundaries[i], next = yBoundaries[i + 1];
            const node = this.edgeLabel(this.gridVolumeLabels, i, 'GridVolumeMark');
            node.angle = 0;
            const cellHeight = (next - p) * h;
            const fontSize = this.gridLabelFontSize(next - p, DEFAULT_GRID_ROWS);
            const labelWidth = Math.max(38, fontSize * 3.2);
            node.getComponent(UITransform)!.setContentSize(labelWidth, Math.max(8, cellHeight - 2));
            node.setPosition(-w / 2 + labelWidth / 2 + 1, -h / 2 + (p + next) * .5 * h);
            const label = node.getComponent(Label)!;
            const volume = this.gridState.volumeMin + ((i + .5) / rowCount) * (this.gridState.volumeMax - this.gridState.volumeMin);
            label.string = String(Math.round(volume * 100));
            label.fontSize = fontSize;
            label.lineHeight = label.fontSize + 2;
            label.color = volumeColor;
        }
        for (let i = rowCount; i < this.gridVolumeLabels.length; i++) this.gridVolumeLabels[i].active = false;
    }

    private openOutputPanel() {
        if (!this.outputPanel) this.buildOutputPanel();
        const panel = this.outputPanel!;
        panel.active = true; panel.setSiblingIndex(this.uiRoot.children.length - 1);
        this.relayoutOutputPanel();
        this.outputFxUI?.redrawAll();
    }

    private openGuidePanel() {
        if (!this.guidePanel) this.buildGuidePanel();
        this.guidePanel.active = true;
        this.guidePanel.setSiblingIndex(this.uiRoot.children.length - 1);
        this.relayoutGuidePanel();
        this.showGuideEntry(this.guideSelected);
    }

    private closeGuidePanel() {
        if (!this.guidePanel) return;
        this.guidePanel.active = false;
        this.setInfo('已关闭游玩说明', new Color(220, 225, 235, 255));
    }

    /** 构建说明内容；左侧只放分类，右侧保持完整、可扫描的层级文字。 */
    private buildGuidePanel() {
        const panel = new Node('GuidePanel');
        panel.layer = Layers.Enum.UI_2D;
        panel.addComponent(UITransform).setContentSize(DESIGN_W, DESIGN_H);
        const bg = panel.addComponent(Graphics);
        this.uiRoot.addChild(panel);
        panel.on(Node.EventType.TOUCH_START, (event: EventTouch) => { event.propagationStopped = true; }, this);

        this.guideEntries = [
            {
                title: '快速开始',
                content: '一.开始演奏\n1. 点击右上角“∏”菜单，选择“选择图片”。\n2. 选图后，图片会铺满播放区并自动保持原始比例。\n3. 在图片上按住即可持续发声，松开停止；拖动可连续滑音。\n4. 多指演奏时，每根手指都有独立触点提示并控制独立音符。\n\n二.坐标含义\n1. 水平方向对应音高：左侧较低，右侧较高。\n2. 竖直方向对应音量：下方较小，上方较大。\n3. 同一个网格格子内，音高与音量保持不变。\n\n三.设备姿态\n1. 横竖屏会随设备姿态自动切换。\n2. 图片按比例旋转，不会被横向或纵向拉伸。',
            },
            {
                title: '网格',
                content: '一.网格作用\n1. 将图片播放区划分为音高×音量的离散格子，便于稳定演奏和找音。\n2. 每格内部使用相同的音高与音量，不会因手指微小抖动产生音高漂移。\n3. 网格线可以隐藏，但量化规则仍然生效。\n\n二.网格自定义调节\n1. 在“设置→网格”中可开关网格线与音色提示。\n2. 可分别设置横线、竖线的颜色、透明度、起止音阶/音量。\n3. 横向疏密控制列数，纵向疏密控制行数；输入框和滑块均可调整。\n4. 网格越密，线条越细；网格越疏，线条越粗。\n5. “重置”会恢复全部网格设置与边缘标尺。\n\n三.游玩中调整\n1. 单指在屏幕边缘拖动，只改变触点以内的网格线，屏幕外重复网格保持不动。\n2. 同一边缘双指合拢或放大，才会按原点等比缩放整组网格及重复周期。\n3. 拖动左、右边缘调整横向网格密度；拖动上、下边缘调整纵向网格密度。\n4. 边缘白线和标尺用于定位，标尺文字会随网格颜色与透明度变化。',
            },
            {
                title: '触摸演奏',
                content: '一.基本触摸\n1. 按下图片开始发声，抬起手指停止，时长由实际按住时间决定。\n2. 支持多指同时演奏，不同手指可形成和弦或节奏层次。\n3. 从一个位置滑到另一个位置，会连续更新音高和音量，保持声音相位连续。\n\n二.边缘手势\n1. 靠近屏幕边缘的触摸会优先用于调整网格，不会触发音符。\n2. 单指调整局部线条；双指捏合调整全局重复周期。\n3. 完成拖动后，左上角临时显示当前行列数，松手后恢复音色提示。\n\n三.建议\n1. 使用网格量化旋律，用连续滑动完成滑音。\n2. 先用低音量试音，再逐步提高音量，避免突然过响。',
            },
            {
                title: '颜色与音色',
                content: '一.像素到声音\n1. 红色通道主要驱动弦乐类音色，绿色通道主要驱动管乐类音色，蓝色通道主要驱动钢琴/铃类音色。\n2. 图片像素的亮度、透明度会参与音色明暗、起音和空间感塑形。\n3. RGB 三个通道可以同时发声，也可以在波表中分别试听。\n\n二.音高与音量\n1. 音高由网格所在列决定，音量由所在行决定。\n2. 系统会对不同频率做响度补偿，减少低频听感偏小的问题。\n3. 最终声音还会经过 RGB 混音与输出效果器处理。\n\n三.提示\n1. 颜色提示可在网格设置中隐藏，不影响实际演奏。\n2. 图片透明区域也会参与颜色和音量计算，适合制作渐变和淡入效果。',
            },
            {
                title: '波表编辑器',
                    content: '一.打开与布局\n1. 通过“设置→波表”进入，横屏为横向三栏，竖屏为纵向三栏。\n2. 三个绘制框分别对应 R、G、B 声部；每个乐器预设槽下方都有独立的鼓预设槽。\n\n二.绘制与试听\n1. 鼓预设为“无”时，可在框内绘制循环波表；左轴调振幅，下轴调重复次数。\n2. 选择鼓采样后，框内改为显示真实采样波形并禁止绘制；左轴调采样音量，下轴调 0.5–2.0 倍播放速度。\n3. 调节鼓采样参数后槽位显示“自定义”，当前采样不会丢失；选择“无”可恢复绘制。\n4. 每个 RGB 声部可独立试听，“随机生成”会随机波形和效果器。\n\n三.鼓组与效果器\n1. 鼓列表按 TR-808、TR-909、TR-606 / RD-6、原声鼓、Boom-Bap、Trap、Lo-fi 分组。\n2. 鼓采样继续通过对应颜色的四槽串联效果器，可调滤波、延迟、混响等音色。\n3. “撤回”和样式管理都会保存波表、鼓采样、音量、速度及效果器状态。\n\n四.黑鼓与白鼓\n1. 像素的 R、G、B 全部低于 55 时进入黑鼓区域，纯黑触发最强。\n2. 像素的 R、G、B 全部高于 200 时进入白鼓区域，纯白触发最强。\n3. 右下角两个鼓槽使用相同的分组采样库，可分别选择不同鼓组和鼓件。',
            },
            {
                title: '效果器',
                content: '一.RGB 全局效果器\n1. 在波表编辑器中分别塑造红、绿、蓝声部。\n2. 每个声部最多四个串联槽位，效果器按从上到下的顺序处理。\n3. 点击槽内文本进入参数设置，点击加号添加下一个效果器。\n\n二.输出效果器\n1. 通过“设置→输出效果器”处理 RGB 混音后的最终声音。\n2. 输出端最多四个槽位，适合做总音量、空间感、动态和最终染色。\n3. 支持重置、随机和撤回，调整后立即作用于游玩声音。\n\n三.使用建议\n1. 先调整单个 RGB 声部，再用输出效果器做整体统一。\n2. 多个高增益效果器串联可能造成削波，应适当降低参数或输出音量。',
            },
            {
                title: '录音与音频编辑',
                content: '一.录音与节拍器\n1. 红点开始或结束录音；小喇叭打开音频编辑轨道；单三角播放一次；双三角循环播放。\n2. 倒置三叉戟按钮控制节拍器。可在“设置→节拍器”输入拍号与 BPM，节拍器声音不会录入成品。\n3. 录音时屏幕边框为红色，播放时为绿色，同时录音与播放时为橙色。\n\n二.左侧音频栏\n1. 点击音频栏可向下展开音量、起止裁剪、颜色、导出和删除设置；修改会实时同步到由该音频生成的所有轨道块。\n2. 小按钮依次用于重置、试听和克隆；拖动音频栏可在右侧新建轨道块，也可放入已有轨道。\n3. 底部可清空轨道、导出右侧编排为 WAV 或 MP3、查看目录及撤回操作。\n\n三.轨道编排\n1. 单击轨道头切换静音，沿轨道头上下滑动可连续设置；双击轨道头切换独奏。\n2. 单击音频块选中并显示克隆、左对齐、删除和颜色按钮；再次点击名称可编辑音量、音高、声相、速度及裁剪自动化。\n3. 长按一秒后拖动音频块，双击可单独试听；磁铁按钮控制节拍吸附。\n4. 单指拖动画布，双指横向缩放；点击或拖动时间轴可定位时间戳，播放与停止按钮分别从记录点播放和停在当前位置。\n5. 左下角箭头可收起或展开音频栏。导出只合成右侧当前可听的轨道内容。',
            },
            {
                title: '样式管理',
                content: '一.样式\n1. 点击控制台的横线图标进入样式管理；保存内容包括波表、网格、效果器和节拍器设置，不包含录音片段。\n2. 绿色边框表示样式，蓝色边框表示样式流；点击名称重命名，展开按钮显示预览。\n3. 样式预览按 R、G、B 左中右排列；每栏可导出、载入或删除。导出后可从中央提示直接查看目录。\n\n二.样式流\n1. 新样式流默认有 5 个节点，最多 13 个；每个节点选择一个已有样式并设置切换时间。\n2. 样式流随循环播放运行，切换时屏幕边框会在 1.3 秒内过渡为蓝色再恢复。\n\n三.文件管理\n1. 导入可从设备中选择样式数据包；导出的数据包保存在游戏文件根目录。\n2. “清空样式栏”和“清空数据包”都会连续询问两次，确认后操作不可撤回。',
            },
            {
                title: '菜单与校准',
                content: '一.右上角菜单\n1. 点击圆形“∏”按钮呼出“选择图片、测试音、校准、游玩说明、设置”。\n2. 再次点击菜单按钮，或点击菜单外的播放区域，可收起选项。\n3. 选择图片、波表、网格和输出效果器后会进入对应设置界面。\n\n二.测试音\n1. 按住“测试音”按钮试听基准音，松开立即停止，不使用固定时长。\n2. 测试音仅用于确认合成器输出，不会改变图片演奏参数。\n\n三.设备校准\n1. 当图片方向与设备姿态不一致时点击“校准”。\n2. 保持设备处于希望的横屏或竖屏方向，等待校准完成。\n3. 设备旋转后界面会平滑切换，控件大小保持不变。',
            },
        ];
        if (isEnglish()) {
            this.guideEntries = [
                {
                    title: 'Quick Start',
                    content: 'I. Start Playing\n1. Open the top-right menu and choose “Choose Image”.\n2. The image fills the play area while keeping its original aspect ratio.\n3. Hold the image to sustain a note, release to stop, or drag for a continuous glide.\n\nII. Screen Coordinates\n1. Horizontal position controls pitch: low on the left, high on the right.\n2. Vertical position controls volume: quiet at the bottom, loud at the top.\n3. Pitch and volume remain constant inside each grid cell.\n\nIII. Device Orientation\n1. The interface follows the device between landscape and portrait.\n2. Images rotate proportionally and are never stretched.',
                },
                {
                    title: 'Grid',
                    content: 'I. Purpose\n1. The play area is divided into discrete pitch × volume cells for stable performance.\n2. Every point in one cell uses the same pitch and volume, preventing finger jitter.\n3. Grid lines may be hidden while quantization remains active.\n\nII. Customization\n1. Open Settings → Grid to show or hide grid lines and tone information.\n2. Horizontal and vertical line color, opacity, pitch range and volume range are independent.\n3. Horizontal density controls columns; vertical density controls rows. Use either inputs or sliders.\n4. Dense grids use thinner lines; sparse grids use thicker lines. Reset restores all grid and ruler settings.\n\nIII. Edge Gestures\n1. A one-finger edge drag changes only lines inside the touch coordinate; repeated offscreen lines stay fixed.\n2. A two-finger pinch on the same edge scales the entire pattern and repeat period from the origin.\n3. Drag left/right edges for horizontal grid density; drag top/bottom edges for vertical density.\n4. Edge rulers follow the configured grid color and opacity.',
                },
                {
                    title: 'Touch Performance',
                    content: 'I. Basic Touch\n1. Press the image to start sound and release to stop; duration follows your actual hold.\n2. Multitouch supports chords and layered rhythms.\n3. Dragging continuously updates pitch and volume while preserving phase.\n\nII. Edge Gestures\n1. Touches near an edge adjust the grid instead of triggering notes.\n2. One finger edits local lines; two fingers adjust the global repeat period.\n3. Current rows and columns appear temporarily at the top left while dragging.\n\nIII. Tips\n1. Use quantized cells for melodies and continuous dragging for glides.\n2. Begin at low volume and raise it gradually to avoid sudden loud output.',
                },
                {
                    title: 'Color & Timbre',
                    content: 'I. Pixels to Sound\n1. Red mainly drives string timbres, green drives wind timbres, and blue drives piano / bell timbres.\n2. Pixel brightness and channel balance shape tone, attack and space.\n3. All RGB voices can sound together or be previewed independently in the wavetable editor.\n\nII. Pitch and Loudness\n1. The grid column selects pitch and the row selects volume.\n2. Frequency loudness compensation reduces the perceived loss of low notes.\n3. The final sound passes through RGB mixing and Output FX.\n\nIII. Display\n1. Tone information may be hidden in Grid Settings without affecting sound.\n2. Gradients and transparent image areas can create smooth timbre transitions.',
                },
                {
                    title: 'Wavetable Editor',
                    content: 'I. Layout\n1. Open Settings → Wavetable. RGB panels run left-to-right in landscape and top-to-bottom in portrait.\n2. Every instrument preset has a separate Drum Preset directly below it.\n\nII. Wavetables and Samples\n1. With Drum Preset set to None, draw a looping wavetable in the frame; the left axis controls amplitude and the bottom axis controls repetition.\n2. Choosing a drum replaces the display with its real sample waveform and disables drawing. The left axis controls sample level and the bottom axis controls 0.5–2.0x playback speed.\n3. Editing a drum marks it Custom without losing its source sample. Choose None to return to drawing.\n4. Each RGB channel can be previewed independently.\n\nIII. Drum Kits and Effects\n1. Samples are grouped as TR-808, TR-909, TR-606 / RD-6, Acoustic, Boom-Bap, Trap and Lo-fi.\n2. Samples pass through the selected RGB channel’s four serial effects.\n3. Undo and Styles preserve sample choice, level, speed, wavetable and effects.\n4. Near-black and near-white pixels use the two bottom-right drum slots, which share the same grouped sample library.',
                },
                {
                    title: 'Effects',
                    content: 'I. RGB Global Effects\n1. Shape the red, green and blue voices independently in the wavetable editor.\n2. Each voice supports four serial slots processed from top to bottom.\n3. Tap slot text to edit parameters; tap + to reveal the next slot.\n\nII. Output Effects\n1. Settings → Output FX processes the final sound after RGB mixing.\n2. Four serial slots can shape overall space, dynamics and color.\n3. Reset, Randomize and Undo apply immediately to performance audio.\n\nIII. Tips\n1. Shape individual voices first, then use Output FX to unify the mix.\n2. Several high-gain effects in series can clip; reduce effect intensity or output level when needed.',
                },
                {
                    title: 'Recording & Audio Editing',
                    content: 'I. Recording & Metronome\n1. The red dot starts or stops recording; the speaker opens Audio Edit Tracks; the single triangle plays once; the double triangle loops.\n2. The inverted trident toggles the metronome. Set its time signature and BPM in Settings → Metronome; its clicks are excluded from recordings.\n3. The border is red while recording, green while playing, and orange when both are active.\n\nII. Source Pane\n1. Tap a source row to expand volume, trim, color, export and delete controls. Changes update every track block made from that source.\n2. The small buttons reset, preview and clone. Drag a source into the track area to create a block or add it to an existing track.\n3. Footer controls clear tracks, export the arrangement as WAV or MP3, open the folder and undo.\n\nIII. Track Arrangement\n1. Tap a track head to mute it, slide vertically across heads for continuous selection, or double-tap for solo.\n2. Select a block for Clone, Align Left, Delete and Color. Tap its name again to edit volume, pitch, pan, speed and trim automation.\n3. Hold for one second to drag a block, double-tap to preview it, and use the magnet for beat snapping.\n4. Drag the canvas with one finger and zoom horizontally with two. Tap or drag the ruler to seek; Play returns to its recorded start point while Stop holds the current position.\n5. The lower-left arrow collapses or restores the source pane. Export renders only currently audible arranged tracks.',
                },
                {
                    title: 'Style Manager',
                    content: 'I. Styles\n1. Open Style Manager with the console lines icon. A style stores wavetable, grid, effect and metronome settings, but not recorded clips.\n2. Green borders identify styles and blue borders identify flows. Tap names to rename and expand rows for previews.\n3. RGB previews run left, center and right. Each row can export, load or delete; after export, View Folder opens the package directory.\n\nII. Style Flows\n1. A new flow starts with five nodes and supports up to 13. Each node selects an owned style and a switch delay.\n2. Flows run with loop playback. A style switch flashes the border blue and restores it within 1.3 seconds.\n\nIII. Files\n1. Import selects a style package from the device. Exported packages are stored in the game file root.\n2. Clear Style List and Clear Packages both require two confirmations and cannot be undone.',
                },
                {
                    title: 'Menu & Calibration',
                    content: 'I. Top-right Controls\n1. Tap the round menu button to reveal Choose Image, Test Tone, Calibrate, How to Play and Settings.\n2. Tap the flag beside it to switch between English and Chinese. The choice is saved.\n3. Tap the menu again or the play area to collapse its options.\n\nII. Test Tone\n1. Hold Test Tone for a reference note and release to stop immediately.\n2. It verifies synth output without changing image performance settings.\n\nIII. Calibration\n1. Tap Calibrate if the interface does not match device orientation.\n2. Hold the device in the desired landscape or portrait orientation while calibration completes.\n3. Controls keep their size and reposition smoothly during rotation.',
                },
            ];
        }

        const title = this.makeLabel('GuideTitle', '游玩说明', 30, 38, new Color(240, 244, 252, 255), 500, 52);
        panel.addChild(title);
        const close = this.makeButton('GuideClose', '关闭', 0, 0, 150, 52, () => this.closeGuidePanel(),
            { bgColor: new Color(44, 60, 96, 255), opacity: 255, fontSize: 21 });
        panel.addChild(close);

        const contentNode = this.makeLabel('GuideContent', '', 22, 32, new Color(225, 231, 242, 255), 1200, 700);
        const contentLabel = contentNode.getComponent(Label)!;
        contentLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
        contentLabel.verticalAlign = Label.VerticalAlign.TOP;
        contentLabel.enableWrapText = true;
        contentLabel.overflow = Label.Overflow.SHRINK;
        panel.addChild(contentNode);
        this.guideContentLabel = contentLabel;

        for (let i = 0; i < this.guideEntries.length; i++) {
            const choice = this.makeButton('GuideChoice' + i, this.guideEntries[i].title, 0, 0, 300, 54,
                () => this.showGuideEntry(i), { bgColor: new Color(34, 48, 78, 255), opacity: 255, fontSize: 20 });
            panel.addChild(choice);
            this.guideChoiceButtons.push(choice);
        }
        this.guidePanel = panel;
        this.guidePanel.active = false;
    }

    private showGuideEntry(index: number) {
        if (!this.guideEntries.length || !this.guideContentLabel) return;
        this.guideSelected = Math.max(0, Math.min(this.guideEntries.length - 1, index));
        this.guideContentLabel.string = this.guideEntries[this.guideSelected].content;
        for (let i = 0; i < this.guideChoiceButtons.length; i++) {
            const button = this.guideChoiceButtons[i];
            const size = button.getComponent(UITransform)!.contentSize;
            const bg = button.getChildByName('Bg')?.getComponent(Graphics);
            if (!bg) continue;
            bg.clear();
            bg.roundRect(-size.width / 2 + 2, -size.height / 2 + 2, size.width - 4, size.height - 4, 11);
            bg.fillColor = i === this.guideSelected ? new Color(62, 92, 145, 255) : new Color(34, 48, 78, 255);
            bg.fill();
        }
    }

    private relayoutGuidePanel() {
        if (!this.guidePanel) return;
        const portrait = this.currentTarget === 90 || this.currentTarget === -90;
        const view = this.userViewport(portrait);
        const panel = this.guidePanel;
        panel.getComponent(UITransform)!.setContentSize(view.w, view.h);
        const leftW = portrait ? Math.min(270, view.w * .31) : Math.min(420, view.w * .23);
        const dividerX = -view.w / 2 + leftW;
        const g = panel.getComponent(Graphics)!;
        g.clear();
        g.rect(-view.w / 2, -view.h / 2, view.w, view.h);
        g.fillColor = new Color(8, 12, 24, 252); g.fill();
        g.lineWidth = 2; g.strokeColor = new Color(255, 255, 255, 235);
        g.moveTo(dividerX, -view.h / 2); g.lineTo(dividerX, view.h / 2); g.stroke();

        const title = panel.getChildByName('GuideTitle');
        title?.setPosition(dividerX / 2, view.h / 2 - 48);
        const close = panel.getChildByName('GuideClose');
        close?.setPosition(view.w / 2 - 105, -view.h / 2 + 45);
        const content = panel.getChildByName('GuideContent');
        if (content) {
            const ct = content.getComponent(UITransform)!;
            const contentW = view.w - leftW - 80;
            const contentH = view.h - 150;
            ct.setContentSize(contentW, contentH);
            ct.setAnchorPoint(0, 1);
            content.setPosition(dividerX + 40, view.h / 2 - 92);
            const label = content.getComponent(Label)!;
            label.fontSize = portrait ? 19 : 22;
            label.lineHeight = portrait ? 28 : 32;
        }
        const buttonW = leftW - 38;
        const buttonH = portrait ? 54 : 52;
        const top = view.h / 2 - 105;
        const gap = portrait ? 10 : 8;
        for (let i = 0; i < this.guideChoiceButtons.length; i++) {
            const b = this.guideChoiceButtons[i];
            b.setPosition(-view.w / 2 + leftW / 2, top - i * (buttonH + gap));
            const bt = b.getComponent(UITransform)!; bt.setContentSize(buttonW, buttonH);
            const bg = b.getChildByName('Bg')?.getComponent(Graphics);
            if (bg) {
                bg.clear();
                bg.roundRect(-buttonW / 2 + 2, -buttonH / 2 + 2, buttonW - 4, buttonH - 4, 11);
                bg.fillColor = i === this.guideSelected ? new Color(62, 92, 145, 255) : new Color(34, 48, 78, 255); bg.fill();
            }
            const border = b.getChildByName('Border')?.getComponent(Graphics);
            if (border) { border.clear(); border.roundRect(-buttonW / 2, -buttonH / 2, buttonW, buttonH, 12); border.fillColor = new Color(255, 255, 255, 255); border.fill(); }
            const text = b.getChildByName('Text')?.getComponent(UITransform); text?.setContentSize(buttonW, buttonH);
        }
    }

    private buildOutputPanel() {
        const panel = new Node('OutputFxPanel'); panel.layer = Layers.Enum.UI_2D;
        panel.addComponent(UITransform).setContentSize(1440, 900); panel.addComponent(Graphics); this.uiRoot.addChild(panel);
        const title = this.makeLabel('OutputTitle', '输出效果器 · RGB 合成后的最终 4 槽串联处理', 32, 40, new Color(235,240,250,255), 850, 52);
        panel.addChild(title);
        this.outputFxUI = new FxUI((slots) => { this.outputFxSlots = slots; saveOutputFxSlots(slots); this.pushOutputFxToNative(); }, true);
        this.outputFxUI.setSlots(this.outputFxSlots); this.outputFxUI.build(panel);
        const defs: Array<[string, string, () => void]> = [
            ['OutputUndo','撤回',()=>this.undoOutputFx()], ['OutputRandom','随机',()=>this.randomizeOutputFx()],
            ['OutputReset','重置',()=>this.resetOutputFx()], ['OutputClose','关闭',()=>{ this.outputFxUI?.dismiss(); panel.active=false; }],
        ];
        for (const [name,text,cb] of defs) { const b=this.makeButton(name,text,0,0,170,58,cb,{bgColor:new Color(44,60,96,255),opacity:255,fontSize:23});panel.addChild(b); }
        panel.active = false; this.outputPanel = panel; this.pushOutputFxToNative();
    }

    private relayoutOutputPanel() {
        if (!this.outputPanel) return;
        const portrait = this.currentTarget === 90 || this.currentTarget === -90;
        const view = this.userViewport(portrait); const panel=this.outputPanel;
        panel.getComponent(UITransform)!.setContentSize(view.w,view.h);
        const g=panel.getComponent(Graphics)!;g.clear();g.rect(-view.w/2,-view.h/2,view.w,view.h);g.fillColor=new Color(8,12,24,252);g.fill();g.lineWidth=2;g.strokeColor=new Color(120,140,180,255);g.stroke();
        panel.getChildByName('OutputTitle')?.setPosition(0,view.h/2-58);
        this.outputFxUI?.relayout(portrait,false);
        const names=['OutputUndo','OutputRandom','OutputReset','OutputClose'];
        const xs=portrait?[-285,-95,95,285]:[-300,-100,100,300];
        for(let i=0;i<names.length;i++){const b=panel.getChildByName(names[i]);b?.setPosition(xs[i],-view.h/2+78);const bg=b?.getChildByName('Bg')?.getComponent(Graphics);if(bg){bg.clear();bg.roundRect(-85,-29,170,58,14);bg.fillColor=new Color(44,60,96,255);bg.fill();}}
    }

    private pushOutputFxToNative() {
        if (NativeBridge.isAndroidNative && NativeBridge.synthReady) NativeBridge.setOutputEffectSlots(fxSlotsToJson(this.outputFxSlots));
    }

    private randomizeOutputFx() {
        this.outputUndoStack.push(this.cloneSlots(this.outputFxSlots)); if(this.outputUndoStack.length>20)this.outputUndoStack.shift();
        this.outputFxSlots=new Array(4).fill(0).map(()=>this.randomFxSlot(false, true));saveOutputFxSlots(this.outputFxSlots);this.outputFxUI?.setSlots(this.outputFxSlots);this.pushOutputFxToNative();
    }
    private resetOutputFx() { this.outputUndoStack.push(this.cloneSlots(this.outputFxSlots));this.outputFxSlots=new Array(4).fill(0).map(()=>newSlot('none'));saveOutputFxSlots(this.outputFxSlots);this.outputFxUI?.setSlots(this.outputFxSlots);this.pushOutputFxToNative(); }
    private undoOutputFx() { const s=this.outputUndoStack.pop();if(!s){this.setInfo('输出效果器没有可撤回的操作',new Color(255,200,120,255));return;}this.outputFxSlots=this.cloneSlots(s);saveOutputFxSlots(s);this.outputFxUI?.setSlots(s);this.pushOutputFxToNative(); }

    private layoutWaveAxes(area: typeof this.waveAreas[number]) {
        const w = area.transform.contentSize.width;
        const h = area.transform.contentSize.height;
        area.ampAxis.getComponent(UITransform)!.setContentSize(24, h);
        area.waveAxis.getComponent(UITransform)!.setContentSize(w, 24);
        // 轴线紧贴绘制框外约 8px；24px 热区仍完全位于框外，兼顾间距与拖动命中率。
        area.ampAxis.setPosition(-w / 2 - 13, 0);
        area.waveAxis.setPosition(0, -h / 2 - 13);
        this.redrawWaveAxes(area);
    }

    private redrawWaveAxes(area: typeof this.waveAreas[number]) {
        const h = area.ampAxis.getComponent(UITransform)!.contentSize.height;
        const w = area.waveAxis.getComponent(UITransform)!.contentSize.width;
        const lineOffset = 5;
        const ag = area.ampGfx; ag.clear();
        ag.moveTo(lineOffset, -h / 2 + 4); ag.lineTo(lineOffset, h / 2 - 4);
        ag.moveTo(lineOffset, h / 2 - 4); ag.lineTo(lineOffset - 7, h / 2 - 14); ag.moveTo(lineOffset, h / 2 - 4); ag.lineTo(lineOffset + 7, h / 2 - 14);
        ag.lineWidth = 3; ag.strokeColor = new Color(235, 240, 250, 230); ag.stroke();
        const ay = -h / 2 + 4 + Math.max(0, Math.min(1, area.amplitude / 1.25)) * (h - 8);
        ag.circle(lineOffset, ay, 9); ag.fillColor = this.waveColor(area); ag.fill();

        const wg = area.waveGfx; wg.clear();
        wg.moveTo(-w / 2 + 4, lineOffset); wg.lineTo(w / 2 - 4, lineOffset);
        wg.moveTo(w / 2 - 4, lineOffset); wg.lineTo(w / 2 - 14, lineOffset + 7); wg.moveTo(w / 2 - 4, lineOffset); wg.lineTo(w / 2 - 14, lineOffset - 7);
        wg.lineWidth = 3; wg.strokeColor = new Color(235, 240, 250, 230); wg.stroke();
        const horizontalValue = this.isChannelDrumActive(area.ch)
            ? (area.drumSpeed - .5) / 1.5
            : (area.cycles - 1) / 7;
        const cx = -w / 2 + 4 + Math.max(0, Math.min(1, horizontalValue)) * (w - 8);
        wg.circle(cx, lineOffset, 9); wg.fillColor = this.waveColor(area); wg.fill();
    }

    private onWaveAxisTouch(phase: number, ch: number, kind: 'amp' | 'cycles', event: EventTouch) {
        event.propagationStopped = true;
        const area = this.waveAreas[ch];
        if (!area) return;
        const key = `${ch}:${kind}`;
        const id = event.getID();
        if (phase === 0) {
            this.waveAxisTouchIds.set(key, id);
            this.waveAxisLastNativeMs.set(key, 0);
            this.pushUndo();
        }
        if (this.waveAxisTouchIds.get(key) !== id) return;
        const p = area.transform.convertToNodeSpaceAR(new Vec3(event.getUILocation().x, event.getUILocation().y, 0));
        const w = area.transform.contentSize.width, h = area.transform.contentSize.height;
        const drumActive = this.isChannelDrumActive(ch);
        if (kind === 'amp') area.amplitude = Math.max(0, Math.min(1.25, ((p.y + h / 2) / h) * 1.25));
        else if (drumActive) area.drumSpeed = Math.max(.5, Math.min(2, .5 + ((p.x + w / 2) / w) * 1.5));
        else area.cycles = Math.max(1, Math.min(8, 1 + ((p.x + w / 2) / w) * 7));
        const sample = this.drumPresetOf(this.channelDrumSourceIds[ch]);
        area.wave = drumActive && sample
            ? this.stretchDrumWave(sample.waveform, area.amplitude, area.drumSpeed)
            : this.applyWaveAxes(area.baseWave, area.amplitude, area.cycles);
        this.redrawWaveArea(area);
        // 高频拖动期间不写 localStorage，并限制跨 JS/Java 的波表同步频率；视觉仍逐帧更新。
        const now = Date.now();
        const lastNative = this.waveAxisLastNativeMs.get(key) ?? 0;
        if (phase === 2 || now - lastNative >= 50) {
            if (drumActive) this.pushChannelDrumToNative(ch);
            else this.sendWaveToNative(ch, area.baseWave, area.amplitude, area.cycles);
            this.waveAxisLastNativeMs.set(key, now);
        }
        if (phase === 2) {
            this.saveWaveState(area);
            if (drumActive) this.markChannelDrumCustom(ch);
            this.waveAxisTouchIds.delete(key);
            this.waveAxisLastNativeMs.delete(key);
        }
    }

    private applyWaveAxes(base: number[], amplitude: number, cycles: number): number[] {
        const out = new Array(256).fill(0);
        for (let i = 0; i < 256; i++) {
            const p = ((i / 255) * cycles) % 1;
            const f = p * 256;
            const i0 = Math.floor(f) % 256, i1 = (i0 + 1) % 256;
            const v = base[i0] + (base[i1] - base[i0]) * (f - Math.floor(f));
            out[i] = Math.max(-1, Math.min(1, v * amplitude));
        }
        return out;
    }

    private attachChannelPreview(node: Node, ch: number) {
        node.on(Node.EventType.TOUCH_START, (e: EventTouch) => {
            e.propagationStopped = true;
            this.previewChannels.add(ch);
            this.updateChannelPreview();
        }, this);
        const stop = (e: EventTouch) => {
            e.propagationStopped = true;
            this.previewChannels.delete(ch);
            this.updateChannelPreview();
        };
        node.on(Node.EventType.TOUCH_END, stop, this); node.on(Node.EventType.TOUCH_CANCEL, stop, this);
    }

    private updateChannelPreview() {
        const touchId = -9100;
        const previewFreq = 329.63;
        if (this.previewChannels.size === 0) {
            if (NativeBridge.isAndroidNative) NativeBridge.noteOff(touchId); else this.webSynth?.noteOff(touchId);
            return;
        }
        const rgb = [0, 0, 0];
        for (const ch of this.previewChannels) rgb[ch] = 255;
        if (NativeBridge.isAndroidNative) NativeBridge.noteOn(touchId, rgb[0], rgb[1], rgb[2], 255, previewFreq, .7);
        else {
            this.webSynth = this.webSynth ?? new WebSynth();
            this.webSynth.noteOn(touchId, rgb[0], rgb[1], rgb[2], 255, previewFreq, .7);
        }
        const channels = Array.from(this.previewChannels).sort().map((ch) => 'RGB'[ch]).join('+');
        const previewCh = Array.from(this.previewChannels)[0];
        if (this.previewChannels.size === 1 && this.isChannelDrumActive(previewCh)) {
            const speed = this.waveAreas[previewCh]?.drumSpeed ?? 1;
            this.setInfo(isEnglish()
                ? `Preview ${channels}: drum sample at ${speed.toFixed(2)}x speed (release to stop)`
                : `试听 ${channels}：鼓采样 ${speed.toFixed(2)} 倍速（松开停止）`, new Color(220, 225, 235, 255));
            return;
        }
        const audibleFreq = this.previewChannels.size === 1
            ? previewFreq * (this.waveAreas[Array.from(this.previewChannels)[0]]?.cycles ?? 1)
            : previewFreq;
        this.setInfo(isEnglish()
            ? `Preview ${channels}: ${audibleFreq.toFixed(1)} Hz (release to stop)`
            : `试听 ${channels}：${audibleFreq.toFixed(1)}Hz（松开停止）`, new Color(220, 225, 235, 255));
    }

    /** 绘制区触摸：phase 0=START 1=MOVE 2=END/CANCEL。 */
    private onWaveAreaTouch(phase: number, ch: number, event: EventTouch) {
        const area = this.waveAreas[ch];
        if (!area) return;
        event.propagationStopped = true;
        if (this.isChannelDrumActive(ch)) {
            if (phase === 0) this.setInfo(t(
                '鼓采样模式下不能绘制波形；请在鼓预设中选择“无”后再绘制。',
                'Drawing is disabled in drum sample mode. Choose None in Drum Preset to draw again.',
            ), new Color(255, 200, 120, 255));
            return;
        }
        const id = event.getID();
        if (phase === 0) {
            // 一根手指同时只能画一个区域
            for (const tid of this.waveTouchIds.values()) if (tid === id) return;
            this.waveTouchIds.set(ch, id);
            area.points = [];
            this.addWavePoint(area, event);
            this.drawWaveStroke(area);
            return;
        }
        if (this.waveTouchIds.get(ch) !== id) return;
        if (phase === 1) {
            this.addWavePoint(area, event);
            this.drawWaveStroke(area);
            return;
        }
        // 抬起：重建 256 点波形 → 平滑归一 → 保存 → 发原生 → 重绘（并标记预设为“自定义”）
        this.waveTouchIds.delete(ch);
        this.pushUndo();
        this.rebuildWaveFromPoints(area);
        this.saveWaveState(area);
        this.sendWaveToNative(ch, area.baseWave, area.amplitude, area.cycles);
        this.redrawWaveArea(area);
        this.markInstCustom(ch);
    }

    private addWavePoint(area: { transform: UITransform; points: { x: number; y: number }[] }, event: EventTouch) {
        const uiPos = event.getUILocation();
        const local = area.transform.convertToNodeSpaceAR(new Vec3(uiPos.x, uiPos.y, 0));
        const t = area.transform;
        const hw = t.contentSize.width / 2;
        const hh = t.contentSize.height / 2;
        if (Math.abs(local.x) > hw || Math.abs(local.y) > hh) return;
        const pts = area.points;
        if (pts.length) {
            const last = pts[pts.length - 1];
            const dx = local.x - last.x;
            const dy = local.y - last.y;
            if (dx * dx + dy * dy < 25) return; // 5px 去抖
        }
        pts.push({ x: local.x, y: local.y });
    }

    /** 手绘轨迹折线（边画边看，未映射振幅）。 */
    private drawWaveStroke(area: { gfx: Graphics; transform: UITransform; points: { x: number; y: number }[] }) {
        const g = area.gfx;
        g.clear();
        const hh = area.transform.contentSize.height / 2;
        const drawHalf = hh - 20;
        g.lineWidth = 3;
        g.strokeColor = this.waveColor(area as any);
        const pts = area.points;
        for (let i = 0; i < pts.length; i++) {
            const x = pts[i].x;
            const y = Math.max(-drawHalf, Math.min(drawHalf, pts[i].y));
            if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
        this.redrawWaveAxes(area as typeof this.waveAreas[number]);
    }

    /**
     * 把手绘轨迹重建成 256 点波形：逐段插值 + 3 轮平滑 + 去直流。
     * 振幅按绘制高度直接映射（不归一化）：横线=静音（可自绘振幅，不再被放大成方波）。
     */
    private rebuildWaveFromPoints(area: typeof this.waveAreas[number]) {
        const w = new Array(256).fill(0);
        const pts = area.points;
        const t = area.transform;
        const aw = t.contentSize.width;
        const ah = t.contentSize.height;
        const hw = aw / 2;
        const hh = ah / 2;
        const drawHalf = hh - 20; // 与显示一致的振幅上限
        if (pts.length >= 2) {
            const toX = (i: number) => -hw + (i * aw) / 255;
            for (let k = 0; k < pts.length - 1; k++) {
                const p0 = pts[k];
                const p1 = pts[k + 1];
                const x0 = Math.max(-hw, Math.min(hw, p0.x));
                const x1 = Math.max(-hw, Math.min(hw, p1.x));
                if (Math.abs(x1 - x0) < 0.5) continue;
                const y0 = Math.max(-hh, Math.min(hh, p0.y));
                const y1 = Math.max(-hh, Math.min(hh, p1.y));
                const i0 = Math.round(((x0 + hw) / aw) * 255);
                const i1 = Math.round(((x1 + hw) / aw) * 255);
                const lo = Math.min(i0, i1);
                const hi = Math.max(i0, i1);
                for (let i = lo; i <= hi; i++) {
                    const tq = (toX(i) - x0) / (x1 - x0);
                    w[i] = y0 + (y1 - y0) * tq;
                }
            }
            // 3 轮 5 点滑动平均
            let s = w.slice();
            for (let pass = 0; pass < 3; pass++) {
                const next = s.slice();
                for (let i = 0; i < 256; i++) {
                    let sum = s[i];
                    let n = 1;
                    for (let j = 1; j <= 2; j++) {
                        if (i - j >= 0) { sum += s[i - j]; n++; }
                        if (i + j < 256) { sum += s[i + j]; n++; }
                    }
                    next[i] = sum / n;
                }
                s = next;
            }
            // 去直流（避免偏置爆音），再按绘制高度映射振幅
            let mean = 0;
            for (let i = 0; i < 256; i++) mean += s[i];
            mean /= 256;
            for (let i = 0; i < 256; i++) {
                const v = (s[i] - mean) / drawHalf;
                w[i] = Math.max(-1, Math.min(1, v));
            }
            area.baseWave = w.slice();
            area.amplitude = 1;
            area.cycles = 1;
            area.wave = w;
        }
    }

    /** 去直流 + 归一化到 [-1, 1]。 */
    private normalizeWave(w: number[]): number[] {
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

    private sineWave(): number[] {
        const w = new Array(256);
        for (let i = 0; i < 256; i++) w[i] = Math.sin((2 * Math.PI * i) / 256);
        return w;
    }

    /** 随机：16 个谐波随机振幅/相位（1/k 衰减，听感自然）。 */
    private randomWave(): number[] {
        const w = new Array(256).fill(0);
        for (let k = 1; k <= 16; k++) {
            const amp = (Math.random() * 2 - 1) / k;
            const phase = Math.random() * 2 * Math.PI;
            for (let i = 0; i < 256; i++) {
                w[i] += amp * Math.sin((2 * Math.PI * k * i) / 256 + phase);
            }
        }
        return this.normalizeWave(w);
    }

    /** 经典：锯齿+方波混合谐波堆叠（电子合成器经典音色）。 */
    private classicWave(): number[] {
        const w = new Array(256).fill(0);
        for (let k = 1; k <= 12; k++) {
            const amp = (1 / k) * (k % 2 === 1 ? 1 : 0.6);
            for (let i = 0; i < 256; i++) {
                w[i] += amp * Math.sin((2 * Math.PI * k * i) / 256);
            }
        }
        return this.normalizeWave(w);
    }

    private applyPreset(idx: number) {
        const names = isEnglish() ? ['Sine Wave', 'Random Wave', 'Classic Harmonics'] : ['正弦波', '随机波形', '经典谐波'];
        console.warn('[CM] 应用预设: ' + names[idx]);
        this.pushUndo();
        for (const a of this.waveAreas) {
            const w = idx === 0 ? this.sineWave() : idx === 1 ? this.randomWave() : this.classicWave();
            this.channelDrumIds[a.ch] = DRUM_NONE_ID;
            this.drumDds[a.ch]?.setValue(DRUM_NONE_ID);
            this.saveChannelDrumState(a.ch);
            a.baseWave = w.slice(); a.amplitude = 1; a.cycles = 1; a.wave = w;
            this.saveWaveState(a);
            this.sendWaveToNative(a.ch, a.baseWave, a.amplitude, a.cycles);
            this.pushChannelDrumToNative(a.ch);
            this.redrawWaveArea(a);
            this.markInstCustom(a.ch);
        }
        if (idx === 1) {
            for (let i = 0; i < 8; i++) this.fxSlots[i] = this.randomFxSlot(true);
            for (let ch = 0; ch < 3; ch++) {
                const count = 1 + Math.floor(Math.random() * FX_GLOBAL_SLOTS_PER_CHANNEL);
                for (let j = 0; j < FX_GLOBAL_SLOTS_PER_CHANNEL; j++) {
                    this.fxSlots[globalFxIndex(ch, j)] = j < count ? this.randomFxSlot(false) : newSlot('none');
                }
            }
            saveFxSlots(this.fxSlots); this.fxUI?.setSlots(this.fxSlots); this.pushFxToNative();
        }
        this.setInfo(isEnglish()
            ? `Preset applied: ${names[idx]} (RGB updated and autosaved)`
            : `已应用预设：${names[idx]}（R/G/B 同步更新，已自动保存）`, new Color(220, 225, 235, 255));
    }

    private randomFxSlot(allowNone: boolean, outputStage = false): FxSlot {
        if (allowNone && Math.random() < .38) return newSlot('none');
        const defs = FX_LIBRARY.filter((d) => d.id !== 'none' && (!outputStage || d.id !== 'env'));
        const def = defs[Math.floor(Math.random() * defs.length)];
        const slot = newSlot(def.id);
        slot.intensity = .18 + Math.random() * .82;
        slot.invert = !outputStage && allowNone && Math.random() < .25;
        for (const slider of def.sliders ?? []) slot.params[slider.key] = slider.min + Math.random() * (slider.max - slider.min);
        if (def.curveType) {
            const n = def.curveType === 'eq' ? 16 : 32;
            let v = def.curveType === 'eq' ? .5 : 0;
            slot.curve = new Array(n).fill(0).map((_, i) => {
                v += (Math.random() - .5) * .22;
                if (def.curveType === 'adsr') v = Math.max(v, i < n * .18 ? i / (n * .18) : Math.max(0, 1 - i / n));
                return Math.max(0, Math.min(1, v));
            });
        }
        return slot;
    }

    private waveColor(area: { ch: number }): Color {
        return area.ch === 0 ? new Color(255, 92, 92, 255)
            : area.ch === 1 ? new Color(96, 255, 120, 255)
                : new Color(120, 165, 255, 255);
    }

    /** 重绘某区域：细网格 + 灰色中线（固定基线）+ 白色边框 + 当前 256 点波形。 */
    private redrawWaveArea(area: { ch: number; gfx: Graphics; transform: UITransform; wave: number[] }) {
        const g = area.gfx;
        const t = area.transform;
        const w = t.contentSize.width;
        const h = t.contentSize.height;
        const hw = w / 2;
        const hh = h / 2;
        const drawHalf = hh - 20;
        g.clear();
        // 细网格（轻）
        g.lineWidth = 1;
        g.strokeColor = new Color(255, 255, 255, 22);
        for (let i = 0; i <= 8; i++) {
            const x = -hw + (i * w) / 8;
            g.moveTo(x, -hh);
            g.lineTo(x, hh);
        }
        for (const y of [-hh / 2, 0, hh / 2]) {
            g.moveTo(-hw, y);
            g.lineTo(hw, y);
        }
        g.stroke();
        // 灰色中线：固定波基线
        g.lineWidth = 1.5;
        g.strokeColor = new Color(150, 150, 150, 200);
        g.moveTo(-hw, 0);
        g.lineTo(hw, 0);
        g.stroke();
        // 白色边框
        g.lineWidth = 2;
        g.strokeColor = new Color(255, 255, 255, 230);
        g.rect(-hw, -hh, w, h);
        g.stroke();
        // 波形
        g.lineWidth = 3;
        g.strokeColor = this.waveColor(area);
        const wave = area.wave;
        for (let i = 0; i < 256; i++) {
            const x = -hw + (i * w) / 255;
            const y = wave[i] * drawHalf;
            if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
        this.redrawWaveAxes(area as typeof this.waveAreas[number]);
    }

    /** 从本地存储加载该通道波形（无则正弦）。 */
    private loadWave(ch: number): number[] {
        try {
            const raw = sys.localStorage.getItem(this.waveKey(ch));
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr) && arr.length === 256) {
                    const w = arr.map((v) => Number(v) || 0);
                    let ok = true;
                    for (const v of w) if (!(v >= -1 && v <= 1)) { ok = false; break; }
                    if (ok) return w;
                }
            }
        } catch (e) { /* 忽略 */ }
        return this.sineWave();
    }

    private waveKey(ch: number): string {
        return 'cm_wt_' + ch;
    }

    private loadBaseWave(ch: number, fallback: number[]): number[] {
        try {
            const raw = sys.localStorage.getItem(`cm_wt_base_${ch}`);
            const arr = raw ? JSON.parse(raw) : null;
            if (Array.isArray(arr) && arr.length === 256) return arr.map((v) => Math.max(-1, Math.min(1, Number(v) || 0)));
        } catch (e) { /* 忽略 */ }
        return fallback.slice();
    }

    private loadWaveScalar(ch: number, name: string, fallback: number): number {
        try { const v = Number(sys.localStorage.getItem(`cm_wt_${name}_${ch}`)); return Number.isFinite(v) && v > 0 ? v : fallback; }
        catch (e) { return fallback; }
    }

    private saveWave(ch: number, wave: number[]) {
        try { sys.localStorage.setItem(this.waveKey(ch), JSON.stringify(wave)); } catch (e) { /* 忽略 */ }
    }

    private saveWaveState(area: typeof this.waveAreas[number]) {
        this.saveWave(area.ch, area.wave);
        try {
            sys.localStorage.setItem(`cm_wt_base_${area.ch}`, JSON.stringify(area.baseWave));
            sys.localStorage.setItem(`cm_wt_amp_${area.ch}`, String(area.amplitude));
            sys.localStorage.setItem(`cm_wt_cycles_${area.ch}`, String(area.cycles));
            sys.localStorage.setItem(`cm_wt_drum_speed_${area.ch}`, String(area.drumSpeed));
        } catch (e) { /* 忽略 */ }
    }

    /** 把单周期波形与周期倍率分别发给原生合成器，避免非整数周期在表边界产生跳变失真。 */
    private sendWaveToNative(ch: number, baseWave: number[], amplitude = 1, cycles = 1) {
        try {
            if (NativeBridge.isAndroidNative && NativeBridge.synthReady) {
                const wave = baseWave.map((v) => Math.max(-1, Math.min(1, v * amplitude)));
                NativeBridge.setWavetable(ch, wave, cycles);
            }
        } catch (e) {
            console.error('[CM] setWavetable 异常:', e);
        }
    }

    /* ============================== 原生回调 ============================== */

    private registerNativeCallbacks() {
        NativeBridge.registerImageCallback((info) => this.onNativeImage(info));
        NativeBridge.registerUtilityCallbacks();

        const self = this;
        const checkTimer = setInterval(() => {
            if ((globalThis as any)[JS_SYNTH_READY_FLAG] === true) {
                clearInterval(checkTimer);
                self.refreshSynthStatus();
                self.pushWavesToNative();
            }
        }, 500);
        this.node.on(Node.EventType.NODE_DESTROYED, () => clearInterval(checkTimer), this);
    }

    private refreshSynthStatus() {
        if (!NativeBridge.isAndroidNative) return;
        const state = NativeBridge.synthReady
            ? t('音频合成器已就绪', 'Audio synthesizer ready')
            : t('音频合成器初始化中…', 'Initializing audio synthesizer…');
        this.setInfo(isEnglish() ? `[Native Synth] ${state}` : `[原生合成] ${state}`, new Color(200, 230, 200, 255));
    }

    /** 启动时把本地保存的三通道波表推给原生合成器（即使从未打开过编辑器也生效）。 */
    private pushWavesToNative() {
        for (let ch = 0; ch < 3; ch++) {
            const storedWave = this.loadWave(ch);
            const baseWave = this.loadBaseWave(ch, storedWave);
            const amplitude = this.loadWaveScalar(ch, 'amp', 1);
            const cycles = this.loadWaveScalar(ch, 'cycles', 1);
            this.sendWaveToNative(ch, baseWave, amplitude, cycles);
            const drumId = loadStr(`cm_drum_channel_${ch}`, DRUM_NONE_ID);
            const sourceId = this.validDrumId(loadStr(`cm_drum_channel_source_${ch}`, ['tr808_kick', 'tr808_snare', 'tr808_hat'][ch]), ['tr808_kick', 'tr808_snare', 'tr808_hat'][ch]);
            const speed = this.loadWaveScalar(ch, 'drum_speed', 1);
            NativeBridge.setChannelDrum(ch, drumId === DRUM_NONE_ID ? DRUM_NONE_ID : sourceId, amplitude, speed);
        }
        this.pushFxToNative();
        this.pushOutputFxToNative();
        this.pushDrumToNative();
        console.warn('[CM] 已推送保存的波表到原生合成器');
    }

    /* ============================== 交互 ============================== */

    private onPickPressed() {
        console.log('[CM] 点击「选择图片」');
        if (NativeBridge.isAndroidNative) {
            NativeBridge.pickImage();
            this.setInfo('已打开系统图片选择器…', new Color(220, 225, 235, 255));
        } else {
            this.pickWeb();
        }
    }

    private toggleRecording() {
        if (this.isRecording) {
            const path = NativeBridge.stopRecording();
            this.isRecording = false;
            this.recordingPath = path || this.recordingPath;
            if (this.recordingPath) {
                if (this.recordedClips.length >= 13) {
                    this.setInfo(isEnglish() ? 'Maximum 13 audio clips' : '最多支持 13 个音频片段', new Color(255, 190, 120, 255));
                    this.setEdgeMode(this.clipsPlaying ? 'play' : 'idle');
                    this.updateConsoleGlyphs();
                    return;
                }
                const clip: AudioClipMeta = {
                    id: `clip_${Date.now()}`, name: t('新音频', 'New Audio'), path: this.recordingPath,
                    duration: Math.max(.1, (Date.now() - this.recordingStartedAt) / 1000), enabled: true, volume: 1, trimStart: 0, trimEnd: 0,
                };
                this.recordedClips.unshift(clip);
                this.saveAudioClips();
            }
            this.setEdgeMode(this.activePlaybackLoop ? 'play' : 'idle');
            this.setInfo(isEnglish() ? 'Recording stopped' : '录音已结束', new Color(220, 225, 235, 255));
        } else {
            const fileName = `audio_${Date.now()}.wav`;
            this.recordingPath = NativeBridge.startRecording(fileName);
            if (!this.recordingPath) {
                this.setInfo(isEnglish() ? 'Unable to start recording' : '无法开始录音', new Color(255, 150, 150, 255));
                return;
            }
            this.recordingStartedAt = Date.now();
            this.isRecording = true;
            this.setEdgeMode(this.activePlaybackLoop ? 'both' : 'record');
            this.setInfo(isEnglish() ? 'Recording… tap the red button to stop' : '正在录音…再次点击红点结束', new Color(255, 140, 150, 255));
        }
        this.updateConsoleGlyphs();
    }

    private toggleClipPlayback(loop: boolean) {
        const clips = this.recordedClips.filter((c) => c.enabled && c.path);
        if (!clips.length) {
            this.setInfo(isEnglish() ? 'No enabled recordings' : '没有可播放的已勾选音频', new Color(255, 190, 120, 255));
            return;
        }
        if (this.clipsPlaying) {
            NativeBridge.stopAudioFiles();
            this.activePlaybackLoop = false;
            this.clipsPlaying = false;
            this.setEdgeMode(this.isRecording ? 'record' : 'idle');
            this.setInfo(isEnglish() ? 'Playback stopped' : '播放已停止', new Color(220, 225, 235, 255));
        } else {
            NativeBridge.playAudioFiles(clips, loop);
            this.activePlaybackLoop = loop;
            this.clipsPlaying = true;
            if (loop) this.startStyleFlow();
            this.setEdgeMode(this.isRecording ? 'both' : 'play');
            this.setInfo(loop
                ? (isEnglish() ? 'Loop playback started' : '循环播放已开始')
                : (isEnglish() ? 'Playback started' : '单次播放已开始'), new Color(220, 225, 235, 255));
            if (!loop) this.scheduleOnce(() => {
                if (!this.clipsPlaying || this.activePlaybackLoop) return;
                this.clipsPlaying = false;
                this.activePlaybackLoop = false;
                this.setEdgeMode(this.isRecording ? 'record' : 'idle');
                this.updateConsoleGlyphs();
            }, this.recordedClips.filter((c) => c.enabled)
                .reduce((m, c) => Math.max(m, Math.max(.1, (c.trimEnd || c.duration) - c.trimStart)), .1) + .08);
        }
        this.updateConsoleGlyphs();
    }

    private setEdgeMode(mode: 'idle' | 'record' | 'play' | 'both') {
        this.edgeMode = mode;
        if (this.gridGfx) this.redrawPlayGrid();
    }

    private updateConsoleGlyphs() {
        const recordGlyph = this.recordBtn?.getChildByName('RecordButtonGlyph')?.getComponent(Label);
        if (recordGlyph) recordGlyph.color = this.isRecording ? new Color(255, 90, 100, 255) : new Color(235, 55, 65, 255);
    }

    private loadAudioClips(): AudioClipMeta[] {
        try {
            const raw = sys.localStorage.getItem('cm_audio_clips'); const value = raw ? JSON.parse(raw) : [];
            return Array.isArray(value) ? value.map((clip) => ({ ...clip, name: localizeMutableDefaultName(String(clip.name ?? t('新音频', 'New Audio'))) })) : [];
        } catch (e) { return []; }
    }
    private saveAudioClips() { try { sys.localStorage.setItem('cm_audio_clips', JSON.stringify(this.recordedClips.slice(0, 13))); } catch (e) { /* ignore */ } }

    private loadMixerTracks(): MixerTrack[] {
        let tracks: MixerTrack[] = [];
        try {
            const raw = sys.localStorage.getItem('cm_mixer_tracks_v15');
            const value = raw ? JSON.parse(raw) : [];
            if (Array.isArray(value)) tracks = value.slice(0, 13).map((track, index) => ({ id: track.id || `track_${Date.now()}_${index}`, muted: !!track.muted, solo: !!track.solo, blocks: Array.isArray(track.blocks) ? track.blocks : [] }));
        } catch (e) { /* ignore */ }
        const stamp = Date.now();
        while (tracks.length < 13) tracks.push({ id: `track_${stamp}_${tracks.length}`, muted: false, solo: false, blocks: [] });
        return tracks;
    }

    private saveMixerTracks() {
        try { sys.localStorage.setItem('cm_mixer_tracks_v15', JSON.stringify(this.mixerTracks.slice(0, 13))); } catch (e) { /* ignore */ }
    }

    private pushMixerUndo() {
        this.mixerUndoStack.push(JSON.parse(JSON.stringify(this.mixerTracks)));
        if (this.mixerUndoStack.length > 30) this.mixerUndoStack.shift();
    }

    private undoMixer() {
        const state = this.mixerUndoStack.pop();
        if (!state) return;
        this.mixerTracks = state;
        this.ensureMixerTrack(12);
        this.saveMixerTracks();
        this.redrawMixerTimeline();
    }

    private timelineBlocks(includeSilentTracks = false) {
        const solo = this.mixerTracks.some(track => track.solo);
        const result: Array<AudioClipMeta & { startBeat: number; bpm: number; speed: number; trackId: string; trackAudible: boolean; volumeAutomation?: number[]; pitchAutomation?: number[]; panAutomation?: number[] }> = [];
        for (const track of this.mixerTracks) {
            const trackAudible = !track.muted && (!solo || track.solo);
            if (!trackAudible && !includeSilentTracks) continue;
            for (const block of track.blocks) {
                const clip = this.recordedClips.find(item => item.id === block.clipId);
                if (clip?.path && clip.enabled !== false) {
                    const volumeAutomation = block.volumeAutomation?.length ? block.volumeAutomation : [1];
                    const speed = Math.max(.25, Math.min(4, block.speed ?? 1));
                    let elapsedSeconds = 0;
                    for (const range of this.mixerBlockTrimRanges(clip, block)) {
                        result.push({ ...clip, trimStart: range.start, trimEnd: range.end, volume: clip.volume, enabled: true, startBeat: block.startBeat + elapsedSeconds * this.metronomeBpm / 60 / speed, bpm: this.metronomeBpm, speed, trackId: track.id, trackAudible, volumeAutomation, pitchAutomation: block.pitchAutomation, panAutomation: block.panAutomation });
                        elapsedSeconds += range.end - range.start;
                    }
                }
            }
        }
        return result;
    }

    private openAudioPanel() {
        if (this.stylePanelOpen) this.closeStylePanel();
        const created = !this.audioPanel;
        if (created) this.buildAudioPanel();
        this.audioPanel!.active = true;
        this.audioPanelOpen = true;
        this.audioPanel!.setSiblingIndex(this.uiRoot.children.length - 1);
        this.layoutAudioPanel(); this.rebuildAudioRows();
    }

    private buildAudioPanel() {
        const panel = new Node('AudioMixerPanel'); panel.layer = Layers.Enum.UI_2D;
        panel.addComponent(UITransform).setContentSize(1400, 860); const initialBg = panel.addComponent(Graphics);
        initialBg.rect(-700, -430, 1400, 860); initialBg.fillColor = new Color(8, 12, 24, 255); initialBg.fill();
        const sourcePane = new Node('AudioSourcePane'); sourcePane.layer = Layers.Enum.UI_2D; sourcePane.addComponent(UITransform).setContentSize(1400, 860); sourcePane.addComponent(UIOpacity).opacity = 255; panel.addChild(sourcePane); this.mixerSourcePane = sourcePane;
        const sourceBackground = new Node('AudioSourcePaneBackground'); sourceBackground.layer = Layers.Enum.UI_2D; sourceBackground.addComponent(UITransform).setContentSize(1400, 860); sourceBackground.addComponent(Graphics); sourcePane.addChild(sourceBackground); this.mixerSourcePaneBackground = sourceBackground;
        const title = this.makeLabel('AudioMixerTitle', isEnglish() ? 'Audio Edit Tracks' : '音频编辑轨道', 22, 38, new Color(240, 244, 252, 255), 180, 50); sourcePane.addChild(title);
        const close = this.makePanelButton(sourcePane, isEnglish() ? 'Close' : '关闭', 0, 0, 77, 30, () => this.closeAudioPanel(), new Color(45, 58, 88, 255)); close.name = 'AudioClose';
        const clear = this.makePanelButton(sourcePane, t('清空轨道', 'Clear Tracks'), 0, 0, 170, 42, () => this.clearAudioTracks(), new Color(105, 45, 55, 255)); clear.name = 'AudioClearTracks';
        const wav = this.makePanelButton(sourcePane, t('导出为 WAV 音频', 'Export WAV'), 0, 0, 220, 42, () => this.exportEnabledMix('wav'), new Color(36, 92, 78, 255)); wav.name = 'AudioExportWav';
        const mp3 = this.makePanelButton(sourcePane, t('导出为 MP3 音频', 'Export MP3'), 0, 0, 220, 42, () => this.exportEnabledMix('mp3'), new Color(42, 72, 115, 255)); mp3.name = 'AudioExportMp3';
        const folder = this.makePanelButton(sourcePane, t('查看目录', 'View Folder'), 0, 0, 150, 42, () => NativeBridge.openExportDirectory(), new Color(55, 62, 82, 255)); folder.name = 'AudioViewFolder';
        const undo = this.makePanelButton(sourcePane, t('撤回', 'Undo'), 0, 0, 100, 42, () => this.undoMixer(), new Color(45, 58, 88, 255)); undo.name = 'AudioUndo';
        for (const footerButton of [clear, wav, mp3, folder, undo]) this.setPanelButtonBlackFill(footerButton);
        const follow = this.makePanelButton(panel, '→', 0, 0, 44, 44, () => this.toggleMixerPlayheadFollow(), new Color(8, 10, 15, 255)); follow.name = 'AudioTimelineFollow';
        const play = this.makePanelButton(panel, '▶', 0, 0, 44, 44, () => this.toggleMixerTimelinePlayback(), new Color(8, 10, 15, 255)); play.name = 'AudioTimelinePlay';
        const stop = this.makePanelButton(panel, '■', 0, 0, 44, 44, () => this.stopMixerTimelinePlayback(), new Color(8, 10, 15, 255)); stop.name = 'AudioTimelineStop';
        const home = this.makePanelButton(panel, '◀', 0, 0, 42, 42, () => this.returnMixerTimelineToStart(), new Color(8, 10, 15, 255)); home.name = 'AudioTimelineHome';
        const magnet = this.makePanelButton(panel, '∪', 0, 0, 42, 42, () => { this.mixerMagnet = !this.mixerMagnet; this.queueMixerRedraw(); }, new Color(8, 10, 15, 255)); magnet.name = 'AudioMagnet';
        const collapse = new Node('AudioSourceCollapse'); collapse.layer = Layers.Enum.UI_2D; collapse.addComponent(UITransform).setContentSize(64, 64); const collapseDisc = this.makeLabel('AudioSourceCollapseDisc', '●', 64, 68, new Color(0, 0, 0, 255), 68, 68); collapse.addChild(collapseDisc); const collapseLabel = this.makeLabel('Arrow', '←', 25, 36, new Color(255, 255, 255, 255), 34, 34); collapse.addChild(collapseLabel); collapse.addComponent(Button).transition = Button.Transition.SCALE; collapse.on(Button.EventType.CLICK, () => this.toggleMixerSourcePane(), this);
        const collapsedUndo = new Node('AudioCollapsedUndo'); collapsedUndo.layer = Layers.Enum.UI_2D; collapsedUndo.addComponent(UITransform).setContentSize(64, 64); const undoDisc = this.makeLabel('AudioCollapsedUndoDisc', '●', 64, 68, new Color(0, 0, 0, 255), 68, 68); collapsedUndo.addChild(undoDisc); const undoIcon = this.makeLabel('UndoIcon', '↶', 27, 38, new Color(255, 255, 255, 255), 38, 38); collapsedUndo.addChild(undoIcon); collapsedUndo.addComponent(Button).transition = Button.Transition.SCALE; collapsedUndo.on(Button.EventType.CLICK, () => this.undoMixer(), this); collapsedUndo.active = false;
        const multiSelect = new Node('AudioMultiSelect'); multiSelect.layer = Layers.Enum.UI_2D; multiSelect.addComponent(UITransform).setContentSize(44, 44); multiSelect.addComponent(Graphics); multiSelect.addComponent(Button).transition = Button.Transition.NONE; multiSelect.on(Button.EventType.CLICK, () => this.toggleMixerMultiSelectMode(), this); multiSelect.active = false;
        const viewport = new Node('AudioTimelineViewport'); viewport.layer = Layers.Enum.UI_2D; viewport.addComponent(UITransform).setContentSize(1000, 700); (viewport.addComponent(Mask) as any).type = 0; panel.addChild(viewport); this.mixerViewport = viewport;
        const timeline = new Node('AudioTimeline'); timeline.layer = Layers.Enum.UI_2D; timeline.addComponent(UITransform).setContentSize(6000, 1200); viewport.addChild(timeline); this.mixerTimeline = timeline;
        this.attachMixerViewportGestures(viewport);
        viewport.setSiblingIndex(0);
        const connections = new Node('MixerConnections'); connections.layer = Layers.Enum.UI_2D; connections.addComponent(UITransform).setContentSize(1400, 860); connections.addComponent(Graphics); panel.addChild(connections); connections.setSiblingIndex(sourcePane.getSiblingIndex() + 1); this.mixerConnectionLayer = connections;
        const frame = new Node('AudioPanelTopBorder'); frame.layer = Layers.Enum.UI_2D; frame.addComponent(UITransform).setContentSize(1400, 860); frame.addComponent(Graphics); frame.addChild(collapse); frame.addChild(collapsedUndo); frame.addChild(multiSelect); panel.addChild(frame);
        const swallow = (e: EventTouch) => { if (e.target === panel) e.propagationStopped = true; };
        panel.on(Node.EventType.TOUCH_START, swallow, this); panel.on(Node.EventType.TOUCH_MOVE, swallow, this); panel.on(Node.EventType.TOUCH_END, swallow, this);
        this.uiRoot.addChild(panel); panel.active = false;
        initialBg.clear(); initialBg.rect(-700, -430, 1400, 860); initialBg.fillColor = new Color(8, 12, 24, 255); initialBg.fill();
        this.audioPanel = panel;
    }

    private layoutAudioPanel() {
        if (!this.audioPanel) return;
        const view = this.userViewport(false); const panel = this.audioPanel;
        panel.getComponent(UITransform)!.setContentSize(view.w, view.h);
        const g = panel.getComponent(Graphics)!; g.clear(); g.rect(-view.w / 2, -view.h / 2, view.w, view.h); g.fillColor = new Color(8, 12, 24, 255); g.fill();
        const frame = panel.getChildByName('AudioPanelTopBorder'), frameG = frame?.getComponent(Graphics); frame?.getComponent(UITransform)?.setContentSize(view.w, view.h);
        if (frameG) { frameG.clear(); frameG.lineWidth = 1.6; frameG.strokeColor = new Color(255, 255, 255, 255); frameG.roundRect(-view.w / 2 + .8, -view.h / 2 + .8, view.w - 1.6, view.h - 1.6, SCREEN_EDGE_RADIUS); frameG.stroke(); }
        const leftWidth = view.w / 5;
        const sourcePane = this.mixerSourcePane;
        sourcePane?.getComponent(UITransform)?.setContentSize(view.w, view.h);
        const sourceBackground = this.mixerSourcePaneBackground;
        sourceBackground?.getComponent(UITransform)?.setContentSize(view.w, view.h);
        this.paintMixerSourceBackground(this.mixerSourcePanelCollapsed ? this.mixerCollapsedSourceWidth() : leftWidth);
        if (!this.mixerSourcePaneAnimating) { sourcePane?.setPosition(0, 0); sourceBackground?.setPosition(0, 0); }
        if (!this.mixerSourcePaneAnimating) { const sourceOpacity = sourcePane?.getComponent(UIOpacity); if (sourceOpacity) sourceOpacity.opacity = 255; }
        sourcePane?.getChildByName('AudioMixerTitle')?.setPosition(-view.w / 2 + leftWidth / 2 - 44, view.h / 2 - 34);
        sourcePane?.getChildByName('AudioClose')?.setPosition(-view.w / 2 + leftWidth - 48, view.h / 2 - 34);
        panel.getChildByName('AudioTimelineFollow')?.setPosition(view.w / 2 - 166, view.h / 2 - 35);
        panel.getChildByName('AudioTimelinePlay')?.setPosition(view.w / 2 - 112, view.h / 2 - 35);
        panel.getChildByName('AudioTimelineStop')?.setPosition(view.w / 2 - 58, view.h / 2 - 35);
        panel.getChildByName('AudioTimelineHome')?.setPosition(view.w / 2 - 78, -view.h / 2 + 30);
        panel.getChildByName('AudioMagnet')?.setPosition(view.w / 2 - 28, -view.h / 2 + 30);
        const collapsedWidth = this.mixerCollapsedSourceWidth();
        const viewportWidth = this.mixerSourcePanelCollapsed ? view.w - collapsedWidth : view.w - leftWidth - 8;
        this.mixerViewport?.getComponent(UITransform)?.setContentSize(viewportWidth, view.h);
        this.mixerViewport?.setPosition(this.mixerSourcePanelCollapsed ? collapsedWidth / 2 : -view.w / 2 + leftWidth + (view.w - leftWidth) / 2, 0);
        this.mixerConnectionLayer?.getComponent(UITransform)?.setContentSize(view.w, view.h);
        const footerY = -view.h / 2 + 145;
        const leftX = -view.w / 2 + leftWidth / 2;
        sourcePane?.getChildByName('AudioClearTracks')?.setPosition(leftX, footerY + 72);
        sourcePane?.getChildByName('AudioExportWav')?.setPosition(leftX, footerY + 24);
        sourcePane?.getChildByName('AudioExportMp3')?.setPosition(leftX, footerY - 24);
        sourcePane?.getChildByName('AudioViewFolder')?.setPosition(leftX, footerY - 72);
        sourcePane?.getChildByName('AudioUndo')?.setPosition(leftX, footerY - 120);
        const collapseInset = MIXER_CONTENT_INSET + 12;
        const collapsePosition = this.mixerSourcePanelCollapsed
            ? new Vec3(-view.w / 2 + collapsedWidth / 2, -view.h / 2 + collapsedWidth / 2 + 2, 0)
            : new Vec3(-view.w / 2 + leftWidth + collapseInset, -view.h / 2 + 42, 0);
        const collapse = frame?.getChildByName('AudioSourceCollapse');
        if (!this.mixerSourcePaneAnimating && collapse) {
            collapse.setPosition(collapsePosition);
            const visualScale = this.mixerSourcePanelCollapsed ? MIXER_COLLAPSED_RESTORE_VISUAL_SCALE : 1;
            for (const child of collapse.children) child.setScale(visualScale, visualScale, 1);
        }
        const collapsedUndo = frame?.getChildByName('AudioCollapsedUndo');
        if (collapsedUndo) {
            collapsedUndo.setPosition(-view.w / 2 + collapsedWidth / 2, -view.h / 2 + collapsedWidth / 2 + 66, 0);
            for (const child of collapsedUndo.children) child.setScale(MIXER_COLLAPSED_RESTORE_VISUAL_SCALE, MIXER_COLLAPSED_RESTORE_VISUAL_SCALE, 1);
            collapsedUndo.active = this.mixerSourcePanelCollapsed && !this.mixerSourcePaneAnimating && !this.mixerMultiSelectMode;
        }
        if (frame) frame.setSiblingIndex(panel.children.length - 1);
        const arrow = collapse?.getChildByName('Arrow')?.getComponent(Label); if (arrow) arrow.string = this.mixerSourcePanelCollapsed ? '→' : '←';
        const multiSelect = frame?.getChildByName('AudioMultiSelect');
        multiSelect?.setPosition(-view.w / 2 + collapsedWidth / 2, view.h / 2 - collapsedWidth / 2 - 2, 0);
        if (multiSelect) multiSelect.active = this.mixerSourcePanelCollapsed && !this.mixerSourcePaneAnimating;
        this.paintMixerMultiSelectButton(); this.setMixerMultiSelectChrome(this.mixerMultiSelectMode);
        this.redrawPanelButtons(panel);
        this.queueMixerRedraw();
        this.updateMixerConnections();
    }

    private mixerCollapsedSourceWidth() { return MIXER_TRACK_HEAD_WIDTH + 8; }

    private paintMixerSourceBackground(width: number) {
        const background = this.mixerSourcePaneBackground, graphics = background?.getComponent(Graphics);
        if (!background || !graphics) return;
        const view = this.userViewport(false);
        graphics.clear(); graphics.rect(-view.w / 2, -view.h / 2, Math.max(0, width), view.h);
        graphics.fillColor = new Color(8, 12, 24, 255); graphics.fill();
    }

    private paintMixerMultiSelectButton() {
        const button = this.audioPanel?.getChildByName('AudioPanelTopBorder')?.getChildByName('AudioMultiSelect');
        const graphics = button?.getComponent(Graphics); if (!graphics) return;
        graphics.clear(); graphics.circle(0, 0, 10);
        if (this.mixerMultiSelectMode) { graphics.fillColor = new Color(255, 255, 255, 255); graphics.fill(); }
        else { graphics.lineWidth = 2; graphics.strokeColor = new Color(255, 255, 255, 255); graphics.stroke(); }
    }

    private setMixerMultiSelectChrome(enabled: boolean) {
        const panel = this.audioPanel, frame = panel?.getChildByName('AudioPanelTopBorder');
        if (!panel || !frame) return;
        for (const name of ['AudioTimelineFollow', 'AudioTimelinePlay', 'AudioTimelineStop', 'AudioTimelineHome', 'AudioMagnet']) {
            const control = panel.getChildByName(name); if (control) { control.active = !enabled; if (!enabled) this.redrawPanelButton(control); }
        }
        const collapse = frame.getChildByName('AudioSourceCollapse');
        if (collapse) collapse.active = !enabled;
        const collapsedUndo = frame.getChildByName('AudioCollapsedUndo');
        if (collapsedUndo) collapsedUndo.active = !enabled && this.mixerSourcePanelCollapsed && !this.mixerSourcePaneAnimating;
        const multiSelect = frame.getChildByName('AudioMultiSelect');
        if (multiSelect) {
            multiSelect.active = this.mixerSourcePanelCollapsed && !this.mixerSourcePaneAnimating;
            if (multiSelect.active) multiSelect.setSiblingIndex(frame.children.length - 1);
        }
        const playhead = this.mixerTimeline?.getChildByName('MixerPlayhead');
        if (playhead) {
            playhead.active = !enabled;
            if (!enabled) { this.paintMixerPlayheadLine(playhead, this.mixerViewport?.getComponent(UITransform)?.contentSize.height ?? 1); this.updateMixerPlayheadVisual(); }
        }
        if (this.mixerConnectionLayer) this.mixerConnectionLayer.active = !enabled;
        for (const dot of this.mixerCollapsedSourceDots) {
            const button = dot.getComponent(Button); if (button) button.interactable = !enabled;
        }
        let veil = this.mixerMultiLeftVeil;
        if (!veil?.isValid || veil.parent !== frame) {
            veil?.destroy(); veil = new Node('MixerMultiLeftVeil'); veil.layer = Layers.Enum.UI_2D;
            veil.addComponent(UITransform); veil.addComponent(Graphics);
            const swallow = (event: EventTouch) => { event.propagationStopped = true; };
            veil.on(Node.EventType.TOUCH_START, swallow, this); veil.on(Node.EventType.TOUCH_MOVE, swallow, this); veil.on(Node.EventType.TOUCH_END, swallow, this); veil.on(Node.EventType.TOUCH_CANCEL, swallow, this);
            frame.addChild(veil); this.mixerMultiLeftVeil = veil;
        }
        const view = this.userViewport(false), width = this.mixerCollapsedSourceWidth();
        veil.getComponent(UITransform)!.setContentSize(width, view.h);
        veil.setPosition(-view.w / 2 + width / 2, 0, 0); veil.active = enabled;
        const graphics = veil.getComponent(Graphics)!; graphics.clear(); graphics.rect(-width / 2, -view.h / 2, width, view.h); graphics.fillColor = new Color(0, 0, 0, 84); graphics.fill();
        if (enabled) {
            veil.setSiblingIndex(frame.children.length - 1);
            const button = frame.getChildByName('AudioMultiSelect'); if (button) button.setSiblingIndex(frame.children.length - 1);
        }
        this.paintMixerMultiSelectButton(); this.redrawMixerTransportButtons();
    }

    private toggleMixerMultiSelectMode() {
        if (!this.mixerSourcePanelCollapsed || this.mixerSourcePaneAnimating) return;
        this.setMixerMultiSelectMode(!this.mixerMultiSelectMode);
    }

    private setMixerMultiSelectMode(enabled: boolean, redraw = true) {
        if (enabled && !this.mixerSourcePanelCollapsed) return;
        if (enabled === this.mixerMultiSelectMode) return;
        this.stopMixerInertia(false);
        this.mixerMultiSelectMode = enabled;
        this.mixerMultiSelectedBlockIds.clear();
        this.mixerMultiBoxTouchId = -1; this.mixerMultiBoxStart = null; this.mixerMultiBoxCurrent = null;
        this.mixerSelectedBlockId = ''; this.mixerConnectionBlockId = ''; this.mixerConnectionSourceId = '';
        if (this.mixerSelectionBorderTransition) { Tween.stopAllByTarget(this.mixerSelectionBorderTransition); this.mixerSelectionBorderTransition.destroy(); this.mixerSelectionBorderTransition = null; }
        if (!enabled) { this.mixerMultiSelectOverlay?.destroy(); this.mixerMultiSelectOverlay = null; }
        this.mixerColorPalette?.destroy(); this.mixerColorPalette = null;
        this.paintMixerMultiSelectButton(); this.setMixerMultiSelectChrome(enabled);
        for (const child of this.mixerTimeline?.children ?? []) {
            if (!child.name.startsWith('MixerBlock')) continue;
            const found = this.findMixerBlock(child.name.slice('MixerBlock'.length)); if (found) this.setMixerMultiBlockSelectionVisual(child, found.block, false);
        }
        if (enabled) this.paintMixerMultiSelectOverlay();
        this.updateMixerConnections();
        const generation = ++this.mixerMultiModeGeneration;
        if (redraw) this.scheduleOnce(() => {
            if (generation !== this.mixerMultiModeGeneration) return;
            this.mixerTimelineVisualDirty = true; this.redrawMixerTimeline(); this.setMixerMultiSelectChrome(this.mixerMultiSelectMode);
        }, .035);
    }

    private mixerMultiViewportPoint(event: EventTouch) {
        const transform = this.mixerViewport?.getComponent(UITransform); if (!transform) return null;
        const p = event.getUILocation(); return transform.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0));
    }

    private paintMixerMultiSelectOverlay() {
        const timeline = this.mixerTimeline, viewport = this.mixerViewport;
        if (!this.mixerMultiSelectMode || !timeline || !viewport) return;
        let overlay = this.mixerMultiSelectOverlay;
        if (!overlay?.isValid || overlay.parent !== timeline) {
            if (overlay?.isValid) overlay.destroy();
            overlay = new Node('MixerMultiSelectOverlay'); overlay.layer = Layers.Enum.UI_2D;
            overlay.addComponent(UITransform); overlay.addComponent(Graphics); timeline.addChild(overlay); this.mixerMultiSelectOverlay = overlay;
        }
        const size = viewport.getComponent(UITransform)!.contentSize;
        overlay.getComponent(UITransform)!.setContentSize(size.width, size.height); overlay.setPosition(Vec3.ZERO); overlay.setScale(Vec3.ONE);
        const graphics = overlay.getComponent(Graphics)!; graphics.clear(); graphics.fillColor = new Color(0, 0, 0, 84);
        const start = this.mixerMultiBoxStart, current = this.mixerMultiBoxCurrent;
        if (!start || !current) { graphics.rect(-size.width / 2, -size.height / 2, size.width, size.height); graphics.fill(); }
        else {
            const left = Math.max(-size.width / 2, Math.min(start.x, current.x));
            const right = Math.min(size.width / 2, Math.max(start.x, current.x));
            const bottom = Math.max(-size.height / 2, Math.min(start.y, current.y));
            const top = Math.min(size.height / 2, Math.max(start.y, current.y));
            graphics.rect(-size.width / 2, top, size.width, size.height / 2 - top);
            graphics.rect(-size.width / 2, -size.height / 2, size.width, bottom + size.height / 2);
            graphics.rect(-size.width / 2, bottom, left + size.width / 2, Math.max(0, top - bottom));
            graphics.rect(right, bottom, size.width / 2 - right, Math.max(0, top - bottom)); graphics.fill();
            graphics.lineWidth = 4; graphics.strokeColor = new Color(255, 255, 255, 255);
            // About 5 mm on the target tablet after the design-to-device scale.
            graphics.roundRect(left, bottom, Math.max(1, right - left), Math.max(1, top - bottom), Math.min(46, Math.abs(right - left) / 2, Math.abs(top - bottom) / 2)); graphics.stroke();
        }
        overlay.setSiblingIndex(timeline.children.length - 1);
        for (const id of this.mixerMultiSelectedBlockIds) {
            const node = timeline.getChildByName(`MixerBlock${id}`); if (node) node.setSiblingIndex(timeline.children.length - 1);
        }
    }

    private showMixerMultiTapFeedback(event: EventTouch) {
        const frame = this.audioPanel?.getChildByName('AudioPanelTopBorder'), transform = frame?.getComponent(UITransform);
        if (!frame || !transform) return;
        const p = event.getUILocation(), local = transform.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0));
        const dot = new Node('MixerMultiTapFeedback'); dot.layer = Layers.Enum.UI_2D; dot.addComponent(UITransform).setContentSize(40, 40); dot.setPosition(local); dot.setScale(.72, .72, 1);
        const graphics = dot.addComponent(Graphics); graphics.circle(0, 0, 11); graphics.fillColor = new Color(255, 255, 255, 255); graphics.fill();
        const opacity = dot.addComponent(UIOpacity); frame.addChild(dot); dot.setSiblingIndex(frame.children.length - 1);
        tween(dot).to(.26, { scale: new Vec3(1.75, 1.75, 1) }, { easing: 'quadOut' }).start();
        tween(opacity).to(.26, { opacity: 0 }, { easing: 'quadOut' }).call(() => dot.destroy()).start();
    }

    private setMixerMultiBlockSelectionVisual(node: Node, block: MixerBlock, selected: boolean) {
        Tween.stopAllByTarget(node); node.setScale(Vec3.ONE);
        node.getChildByName('BlockSelectionBorder')?.destroy(); node.getChildByName('BlockToolbar')?.destroy(); node.getChildByName('BlockName')?.destroy();
        const transform = node.getComponent(UITransform), clip = this.recordedClips.find(item => item.id === block.clipId); if (!transform || !clip) return;
        const width = transform.contentSize.width, hh = transform.contentSize.height / 2, color = this.mixerColor(block.color);
        if (selected) { this.drawMixerBlockSelectionBorder(node, width, hh, color); this.drawMixerBlockToolbar(node, block, clip, width, hh, color); }
        else { const label = this.makeLabel('BlockName', clip.name, 12, 18, new Color(255, 255, 255, 230), Math.max(20, width - 8), 18); label.setPosition(0, hh - 11); node.addChild(label); }
    }

    private toggleMixerMultiBlockSelection(node: Node, block: MixerBlock) {
        const selected = !this.mixerMultiSelectedBlockIds.has(block.id);
        if (selected) this.mixerMultiSelectedBlockIds.add(block.id); else this.mixerMultiSelectedBlockIds.delete(block.id);
        this.setMixerMultiBlockSelectionVisual(node, block, selected); this.paintMixerMultiSelectOverlay();
    }

    private finishMixerMultiBoxSelection() {
        const start = this.mixerMultiBoxStart, current = this.mixerMultiBoxCurrent, timeline = this.mixerTimeline, viewport = this.mixerViewport;
        this.mixerMultiBoxTouchId = -1; this.mixerMultiBoxStart = null; this.mixerMultiBoxCurrent = null;
        if (!start || !current || !timeline || !viewport) { this.paintMixerMultiSelectOverlay(); return; }
        const left = Math.min(start.x, current.x), right = Math.max(start.x, current.x), bottom = Math.min(start.y, current.y), top = Math.max(start.y, current.y);
        if (right - left < 18 && top - bottom < 18) { this.paintMixerMultiSelectOverlay(); return; }
        const viewportTransform = viewport.getComponent(UITransform)!;
        const toggled: Array<{ node: Node; block: MixerBlock }> = [];
        for (const child of timeline.children.slice()) {
            if (!child.name.startsWith('MixerBlock')) continue;
            const transform = child.getComponent(UITransform); if (!transform) continue;
            const halfW = transform.contentSize.width / 2, halfH = transform.contentSize.height / 2;
            const corners = [new Vec3(-halfW, -halfH), new Vec3(halfW, -halfH), new Vec3(-halfW, halfH), new Vec3(halfW, halfH)]
                .map(point => viewportTransform.convertToNodeSpaceAR(transform.convertToWorldSpaceAR(point)));
            const blockLeft = Math.min(...corners.map(point => point.x)), blockRight = Math.max(...corners.map(point => point.x));
            const blockBottom = Math.min(...corners.map(point => point.y)), blockTop = Math.max(...corners.map(point => point.y));
            if (left <= blockRight && right >= blockLeft && bottom <= blockTop && top >= blockBottom) {
                const id = child.name.slice('MixerBlock'.length);
                const found = this.findMixerBlock(id); if (found) toggled.push({ node: child, block: found.block });
            }
        }
        for (const item of toggled) this.toggleMixerMultiBlockSelection(item.node, item.block);
        this.paintMixerMultiSelectOverlay();
    }

    private paintMixerSourceRow(node: Node, opacity = 1) {
        const style = (node as any).__mixerSourceRowStyle as { width: number; height: number; color: Color } | undefined;
        const graphics = node.getComponent(Graphics); if (!style || !graphics) return;
        const alpha = Math.max(0, Math.min(1, opacity));
        graphics.clear(); graphics.roundRect(-style.width / 2, -style.height / 2, style.width, style.height, 4);
        graphics.fillColor = new Color(18, 23, 34, Math.round(255 * alpha)); graphics.fill();
        graphics.lineWidth = 1.5;
        graphics.strokeColor = new Color(style.color.r, style.color.g, style.color.b, Math.round(style.color.a * alpha)); graphics.stroke();
    }

    private closeAudioPanel() { if (this.audioPanel) { this.stopMixerInertia(); this.stopMixerTimelineReturnAnimation(); this.stopMixerTimelinePlayback(); this.mixerColorPalette?.destroy(); this.mixerColorPalette = null; this.audioPanel.active = false; this.audioPanelOpen = false; } }

    private updateMixerConnections() {
        const layer = this.mixerConnectionLayer, panel = this.audioPanel, viewport = this.mixerViewport, timeline = this.mixerTimeline;
        const graphics = layer?.getComponent(Graphics); if (!layer || !graphics) return;
        graphics.clear();
        if (!panel || !viewport || !timeline || !this.audioPanelOpen) return;
        let clipId = this.mixerConnectionSourceId;
        let blocks: MixerBlock[] = [];
        if (this.mixerConnectionBlockId) {
            const found = this.findMixerBlock(this.mixerConnectionBlockId); if (!found) return;
            clipId = found.block.clipId; blocks = [found.block];
        } else if (clipId) {
            for (const track of this.mixerTracks) for (const block of track.blocks) if (block.clipId === clipId) blocks.push(block);
        }
        if (!clipId || !blocks.length) return;
        const clip = this.recordedClips.find(item => item.id === clipId); if (!clip) return;
        const rowSource = this.clipRows.find(row => row.name === `AudioSource${clipId}`);
        const dotSource = this.mixerCollapsedSourceDots.find(dot => dot.name === `AudioSourceDot${clipId}`);
        const source = this.mixerSourcePanelCollapsed && !this.mixerSourcePaneAnimating ? dotSource : rowSource;
        const sourceTransform = source?.getComponent(UITransform);
        const layerTransform = layer.getComponent(UITransform), viewportTransform = viewport.getComponent(UITransform);
        if (!source || !sourceTransform || !layerTransform || !viewportTransform) return;
        const sourceWorld = sourceTransform.convertToWorldSpaceAR(new Vec3(sourceTransform.contentSize.width / 2, 0, 0));
        const sourcePoint = layerTransform.convertToNodeSpaceAR(sourceWorld);
        const viewportSize = viewportTransform.contentSize;
        const color = this.mixerColor(clip.color ?? 'white'); graphics.lineWidth = 2; graphics.strokeColor = new Color(color.r, color.g, color.b, 230);
        const visibleEnds: Vec3[] = [];
        for (const block of blocks) {
            const blockNode = timeline.getChildByName(`MixerBlock${block.id}`), blockTransform = blockNode?.getComponent(UITransform); if (!blockNode || !blockTransform) continue;
            const endWorld = blockTransform.convertToWorldSpaceAR(new Vec3(-blockTransform.contentSize.width / 2, 0, 0));
            const viewportPoint = viewportTransform.convertToNodeSpaceAR(endWorld);
            if (viewportPoint.x < -viewportSize.width / 2 || viewportPoint.x > viewportSize.width / 2
                || viewportPoint.y < -viewportSize.height / 2 || viewportPoint.y > viewportSize.height / 2) continue;
            const endPoint = layerTransform.convertToNodeSpaceAR(endWorld); visibleEnds.push(endPoint);
            const bend = Math.max(28, Math.abs(endPoint.x - sourcePoint.x) * .38);
            graphics.moveTo(sourcePoint.x, sourcePoint.y);
            graphics.bezierCurveTo(sourcePoint.x + bend, sourcePoint.y, endPoint.x - bend, endPoint.y, endPoint.x, endPoint.y);
        }
        graphics.stroke();
        if (!visibleEnds.length) return;
        graphics.fillColor = new Color(color.r, color.g, color.b, 255); graphics.circle(sourcePoint.x, sourcePoint.y, 3.5); graphics.fill();
        for (const endPoint of visibleEnds) { graphics.circle(endPoint.x, endPoint.y, 3.5); graphics.fill(); }
    }

    private mixerTimelineContentInset() { return MIXER_CONTENT_INSET + (this.mixerSourcePanelCollapsed ? this.mixerCollapsedContentInsetExtra : 0); }

    private selectCollapsedMixerSource(clip: AudioClipMeta) {
        const previousBlockId = this.mixerSelectedBlockId;
        this.mixerConnectionSourceId = clip.id; this.mixerConnectionBlockId = ''; this.mixerSelectedBlockId = '';
        if (previousBlockId) {
            const previousBlock = this.mixerTimeline?.getChildByName(`MixerBlock${previousBlockId}`);
            previousBlock?.getChildByName('BlockSelectionBorder')?.destroy(); previousBlock?.getChildByName('BlockToolbar')?.destroy();
        }
        if (this.mixerSelectionBorderTransition) {
            Tween.stopAllByTarget(this.mixerSelectionBorderTransition); this.mixerSelectionBorderTransition.destroy(); this.mixerSelectionBorderTransition = null;
        }
        this.refreshCollapsedSourceDotSelection(true); this.updateMixerConnections();
    }

    private refreshCollapsedSourceDotSelection(animate = false) {
        for (const dot of this.mixerCollapsedSourceDots) {
            const clipId = dot.name.slice('AudioSourceDot'.length);
            const selected = this.mixerConnectionSourceId === clipId && !this.mixerConnectionBlockId;
            const targetScale = selected ? 1.18 : 1;
            if (this.mixerSourcePanelCollapsed && !this.mixerSourcePaneAnimating) {
                dot.active = true;
            }
            Tween.stopAllByTarget(dot);
            if (animate) tween(dot).to(.2, { scale: new Vec3(targetScale, targetScale, 1) }, { easing: 'sineInOut' }).start();
            else dot.setScale(targetScale, targetScale, 1);
        }
    }

    private animateMixerSourceRows(collapsing: boolean, duration: number) {
        const view = this.userViewport(false), leftWidth = view.w / 5;
        const rowWidth = Math.max(1, leftWidth - 18), dotWidth = 18;
        const leftEdge = -view.w / 2 + 9, dotX = leftEdge + dotWidth / 2;
        const staticNames = ['AudioMixerTitle', 'AudioClose', 'AudioClearTracks', 'AudioExportWav', 'AudioExportMp3', 'AudioViewFolder', 'AudioUndo'];
        for (const name of staticNames) {
            const node = this.mixerSourcePane?.getChildByName(name); if (!node) continue;
            node.active = true;
            const opacity = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity); Tween.stopAllByTarget(opacity);
            tween(opacity).to(duration * .55, { opacity: collapsing ? 0 : 255 }, { easing: 'sineInOut' }).start();
            const style = (node as any).__panelButtonStyle as { graphicsOpacity?: number } | undefined;
            if (style) {
                const graphicsOpacity = { value: collapsing ? 1 : 0 };
                style.graphicsOpacity = graphicsOpacity.value; this.redrawPanelButton(node);
                tween(graphicsOpacity).to(duration * .55, { value: collapsing ? 0 : 1 }, {
                    easing: 'sineInOut',
                    onUpdate: () => { style.graphicsOpacity = graphicsOpacity.value; this.redrawPanelButton(node); },
                }).start();
            }
        }
        const backgroundProgress = { value: collapsing ? leftWidth : this.mixerCollapsedSourceWidth() };
        tween(backgroundProgress).to(duration, { value: collapsing ? this.mixerCollapsedSourceWidth() : leftWidth }, {
            easing: 'sineInOut', onUpdate: () => this.paintMixerSourceBackground(backgroundProgress.value),
        }).start();
        for (const row of this.clipRows) {
            const expandedPosition = ((row as any).__expandedPosition as Vec3 | undefined) ?? row.position.clone();
            const opacity = row.getComponent(UIOpacity) ?? row.addComponent(UIOpacity); row.active = true;
            Tween.stopAllByTarget(row); Tween.stopAllByTarget(opacity);
            if (!collapsing) { row.setPosition(dotX, expandedPosition.y, 0); row.setScale(dotWidth / rowWidth, 1, 1); opacity.opacity = 0; }
            const graphicsOpacity = { value: collapsing ? 1 : 0 };
            this.paintMixerSourceRow(row, graphicsOpacity.value);
            tween(graphicsOpacity).to(duration * .72, { value: collapsing ? 0 : 1 }, {
                easing: 'sineInOut', onUpdate: () => this.paintMixerSourceRow(row, graphicsOpacity.value),
            }).start();
            tween(row).to(duration, {
                position: collapsing ? new Vec3(dotX, expandedPosition.y, 0) : expandedPosition,
                scale: collapsing ? new Vec3(dotWidth / rowWidth, 1, 1) : Vec3.ONE,
            }, { easing: 'sineInOut' }).start();
            tween(opacity).to(duration * .6, { opacity: collapsing ? 0 : 255 }, { easing: 'sineInOut' }).start();
        }
        for (const dot of this.mixerCollapsedSourceDots) {
            dot.active = true;
            const clipId = dot.name.slice('AudioSourceDot'.length);
            const selectedScale = this.mixerConnectionSourceId === clipId && !this.mixerConnectionBlockId ? 1.18 : 1;
            Tween.stopAllByTarget(dot);
            if (collapsing) dot.setScale(.35, .35, 1);
            tween(dot).to(duration, { scale: new Vec3(collapsing ? selectedScale : .35, collapsing ? selectedScale : .35, 1) }, { easing: 'sineInOut' }).start();
        }
        this.scheduleOnce(() => {
            for (const name of staticNames) {
                const node = this.mixerSourcePane?.getChildByName(name); if (node) node.active = !collapsing;
            }
            for (const row of this.clipRows) row.active = !collapsing;
            for (const dot of this.mixerCollapsedSourceDots) dot.active = collapsing;
            this.refreshCollapsedSourceDotSelection(false); this.updateMixerConnections();
        }, duration);
    }

    private toggleMixerSourcePane() {
        if (!this.audioPanel || !this.mixerViewport || !this.mixerSourcePane || this.mixerSourcePaneAnimating) return;
        this.stopMixerTimelineReturnAnimation();
        // Stop input inertia without its eager redraw; that redraw briefly resets the
        // timeline transform and causes a visible jerk before the pane transition.
        this.stopMixerInertia(false);
        const view = this.userViewport(false), leftWidth = view.w / 5, collapsedWidth = this.mixerCollapsedSourceWidth(), viewport = this.mixerViewport, pane = this.mixerSourcePane;
        const button = this.audioPanel.getChildByName('AudioPanelTopBorder')?.getChildByName('AudioSourceCollapse');
        // Resizing the centered viewport shifts its children by half the width
        // delta. Compensate only that amount so the first transition frame keeps
        // the grid and track heads at their pre-click screen coordinates.
        const timeline = this.mixerTimeline, duration = .82, timelineTravel = (leftWidth - collapsedWidth) / 2 + 4;
        const collapseInset = MIXER_CONTENT_INSET + 12;
        const sourceOpacity = pane.getComponent(UIOpacity);
        if (sourceOpacity) sourceOpacity.opacity = 255;
        this.mixerSourcePaneAnimating = true;
        if (!this.mixerSourcePanelCollapsed) {
            // The expanded viewport owns the newly exposed left side. Keeping the old
            // pane travel as an inset leaves that area without grid lines after collapse.
            this.mixerCollapsedContentInsetExtra = 0;
            this.mixerSourcePanelCollapsed = true;
            const viewportTransform = viewport.getComponent(UITransform)!;
            const startViewportWidth = viewportTransform.contentSize.width, startViewportX = viewport.position.x;
            const targetViewportWidth = view.w - collapsedWidth, targetViewportX = collapsedWidth / 2;
            viewportTransform.setContentSize(targetViewportWidth, view.h); viewport.setPosition(targetViewportX, 0);
            this.mixerTimelinePendingTransitionPosition = new Vec3(timelineTravel, 0, 0); this.redrawMixerTimeline(); this.mixerTimelinePendingTransitionPosition = null;
            viewportTransform.setContentSize(startViewportWidth, view.h); viewport.setPosition(startViewportX, 0, 0);
            this.animateMixerSourceRows(true, duration);
            const viewportProgress = { value: 0 };
            tween(viewportProgress).to(duration, { value: 1 }, {
                easing: 'sineInOut',
                onUpdate: () => {
                    const t = viewportProgress.value;
                    viewportTransform.setContentSize(startViewportWidth + (targetViewportWidth - startViewportWidth) * t, view.h);
                    viewport.setPosition(startViewportX + (targetViewportX - startViewportX) * t, 0, 0);
                    this.updateMixerPlayheadVisual();
                    this.updateMixerConnections();
                },
            }).start();
            // Rebuild at the final width first, then move the complete timeline from its
            // old screen position. This keeps the grid and track heads moving together.
            if (timeline) {
                Tween.stopAllByTarget(timeline); timeline.setPosition(timelineTravel, 0, 0); timeline.setScale(Vec3.ONE);
                tween(timeline).to(duration, { position: Vec3.ZERO }, { easing: 'sineInOut', onUpdate: () => this.updateMixerPlayheadVisual() }).start();
            }
            if (button) tween(button).to(duration, {
                position: new Vec3(-view.w / 2 + collapsedWidth / 2, -view.h / 2 + collapsedWidth / 2 + 2, 0),
            }, { easing: 'sineInOut' }).start();
            for (const child of button?.children ?? []) tween(child).to(duration, {
                scale: new Vec3(MIXER_COLLAPSED_RESTORE_VISUAL_SCALE, MIXER_COLLAPSED_RESTORE_VISUAL_SCALE, 1),
            }, { easing: 'sineInOut' }).start();
            const arrow = button?.getChildByName('Arrow')?.getComponent(Label); if (arrow) arrow.string = '→';
            this.scheduleOnce(() => {
                viewportTransform.setContentSize(targetViewportWidth, view.h); viewport.setPosition(targetViewportX, 0, 0); this.mixerSourcePaneAnimating = false;
                this.rebuildAudioRows(); this.redrawMixerTimeline(); this.setMixerMultiSelectChrome(this.mixerMultiSelectMode); this.updateMixerConnections();
            }, duration);
        } else {
            // Apply the expanded viewport geometry before the pane starts moving so the
            // timeline is redrawn into the correct area for the entire transition.
            this.setMixerMultiSelectMode(false, false);
            const multiSelect = this.audioPanel.getChildByName('AudioPanelTopBorder')?.getChildByName('AudioMultiSelect'); if (multiSelect) multiSelect.active = false;
            const collapsedUndo = this.audioPanel.getChildByName('AudioPanelTopBorder')?.getChildByName('AudioCollapsedUndo'); if (collapsedUndo) collapsedUndo.active = false;
            this.mixerSourcePanelCollapsed = false; this.mixerCollapsedContentInsetExtra = 0;
            const viewportTransform = viewport.getComponent(UITransform)!;
            const startViewportWidth = viewportTransform.contentSize.width, startViewportX = viewport.position.x;
            const targetViewportWidth = view.w - leftWidth - 8, targetViewportX = -view.w / 2 + leftWidth + (view.w - leftWidth) / 2;
            viewportTransform.setContentSize(targetViewportWidth, view.h); viewport.setPosition(targetViewportX, 0);
            if (timeline) Tween.stopAllByTarget(timeline);
            this.mixerTimelinePendingTransitionPosition = new Vec3(-timelineTravel, 0, 0); this.redrawMixerTimeline(); this.mixerTimelinePendingTransitionPosition = null;
            viewportTransform.setContentSize(startViewportWidth, view.h); viewport.setPosition(startViewportX, 0, 0);
            this.animateMixerSourceRows(false, duration);
            const viewportProgress = { value: 0 };
            tween(viewportProgress).to(duration, { value: 1 }, {
                easing: 'sineInOut',
                onUpdate: () => {
                    const t = viewportProgress.value;
                    viewportTransform.setContentSize(startViewportWidth + (targetViewportWidth - startViewportWidth) * t, view.h);
                    viewport.setPosition(startViewportX + (targetViewportX - startViewportX) * t, 0, 0);
                    this.updateMixerPlayheadVisual();
                    this.updateMixerConnections();
                },
            }).start();
            if (timeline) {
                timeline.setPosition(-timelineTravel, 0, 0); timeline.setScale(Vec3.ONE);
                tween(timeline).to(duration, { position: Vec3.ZERO }, { easing: 'sineInOut', onUpdate: () => this.updateMixerPlayheadVisual() }).start();
            }
            pane.setPosition(Vec3.ZERO); if (sourceOpacity) sourceOpacity.opacity = 255;
            if (button) tween(button).to(duration, {
                position: new Vec3(-view.w / 2 + leftWidth + collapseInset, -view.h / 2 + 42, 0),
            }, { easing: 'sineInOut' }).start();
            for (const child of button?.children ?? []) tween(child).to(duration, { scale: Vec3.ONE }, { easing: 'sineInOut' }).start();
            const arrow = button?.getChildByName('Arrow')?.getComponent(Label); if (arrow) arrow.string = '←';
            this.scheduleOnce(() => {
                viewportTransform.setContentSize(targetViewportWidth, view.h); viewport.setPosition(targetViewportX, 0, 0); this.mixerSourcePaneAnimating = false;
                this.rebuildAudioRows(); this.redrawMixerTimeline(); this.setMixerMultiSelectChrome(this.mixerMultiSelectMode); this.updateMixerConnections();
            }, duration);
        }
    }

    private resetAudioSource(clip: AudioClipMeta) {
        clip.volume = 1; clip.trimStart = 0; clip.trimEnd = Math.max(.1, clip.duration);
        this.saveAudioClips(); this.rebuildAudioRows(); this.queueMixerRedraw();
    }

    private queueMixerLiveRedraw() {
        if (this.mixerLiveRedrawTimer) return;
        this.mixerLiveRedrawTimer = setTimeout(() => { this.mixerLiveRedrawTimer = null; this.redrawMixerTimeline(); }, 33);
    }

    private flushMixerLiveRedraw() {
        if (this.mixerLiveRedrawTimer) clearTimeout(this.mixerLiveRedrawTimer);
        this.mixerLiveRedrawTimer = null; this.redrawMixerTimeline();
    }

    private clearAudioTracks() {
        if (!this.recordedClips.length && !this.mixerTracks.some(track => track.blocks.length)) {
            this.setInfo(t('混音台中没有轨道', 'The mixer has no tracks.'), new Color(255, 190, 120, 255));
            return;
        }
        NativeBridge.confirm(t('清空轨道', 'Clear Tracks'), t('确定清空混音台中的全部轨道吗？', 'Clear every track from the mixer?'), confirmed => {
            if (!confirmed) return;
            NativeBridge.stopAudioFiles();
            this.pushMixerUndo();
            this.recordedClips = [];
            // Clear block contents while keeping the track rows and mute/solo controls.
            this.mixerTracks = this.mixerTracks.length
                ? this.mixerTracks.map(track => ({ ...track, blocks: [] }))
                : Array.from({ length: 13 }, (_, index) => ({ id: `track_${Date.now()}_${index}`, muted: false, solo: false, blocks: [] }));
            this.mixerSelectedBlockId = '';
            this.mixerConnectionSourceId = ''; this.mixerConnectionBlockId = '';
            this.clipsPlaying = false; this.activePlaybackLoop = false;
            this.saveAudioClips(); this.saveMixerTracks(); this.rebuildAudioRows(); this.updateConsoleGlyphs(); this.redrawMixerTimeline();
            this.setEdgeMode(this.isRecording ? 'record' : 'idle');
            this.setInfo(t('已清空全部轨道', 'All mixer tracks cleared.'), new Color(220, 225, 235, 255));
        });
    }

    private exportEnabledMix(format: 'wav' | 'mp3') {
        const enabled = this.audioPanel
            ? this.timelineBlocks()
            : this.recordedClips.filter(clip => clip.enabled && !!clip.path).map(clip => ({ ...clip, startBeat: 0, bpm: this.metronomeBpm }));
        if (!enabled.length) {
            this.setInfo(t('没有点亮绿点的轨道', 'No green-dot tracks are enabled.'), new Color(255, 190, 120, 255));
            return;
        }
        if (!NativeBridge.isAndroidNative) {
            this.setInfo(t('浏览器预览不支持导出混音', 'Mix export is unavailable in browser preview.'), new Color(255, 190, 120, 255));
            return;
        }
        this.setInfo(t('正在合成并导出音频…', 'Rendering and exporting audio…'), new Color(220, 225, 235, 255));
        const name = `ColorMusic_Mix_${Date.now()}`;
        NativeBridge.mixAndExportAudioAsync(enabled, name, format, path => {
            const failed = !path || path.startsWith('ERROR:');
            if (failed) this.setInfo(path.replace(/^ERROR:/, '') || t('混音导出失败', 'Mix export failed.'), new Color(255, 150, 150, 255));
            else { this.setInfo(t('混音导出成功', 'Mix exported successfully.'), new Color(200, 235, 205, 255)); NativeBridge.showAudioExportResult(path); }
        });
    }

    private rebuildAudioRows() {
        if (!this.audioPanel) return;
        const sourceTransitionDuration = .24;
        const previousPositions = new Map<string, Vec3>();
        const previousHeights = new Map<string, number>();
        for (const row of this.clipRows) { previousPositions.set(row.name, row.position.clone()); previousHeights.set(row.name, row.getComponent(UITransform)?.contentSize.height ?? 48); }
        for (const row of this.clipRows) row.destroy();
        this.clipRows = [];
        for (const dot of this.mixerCollapsedSourceDots) dot.destroy();
        this.mixerCollapsedSourceDots = [];
        const panel = this.mixerSourcePane ?? this.audioPanel;
        const view = this.userViewport(false); const rowW = view.w - 40;
        const leftWidth = view.w / 5;
        let sourceY = view.h / 2 - 92;
        this.recordedClips.slice(0, 13).forEach((clip, i) => {
            const expanded = this.mixerExpandedSourceId === clip.id;
            const rowHeight = expanded ? 178 : 48;
            const row = new Node(`AudioSource${clip.id}`); row.layer = Layers.Enum.UI_2D;
            row.addComponent(UITransform).setContentSize(leftWidth - 18, rowHeight);
            const rowOpacity = row.addComponent(UIOpacity);
            const targetPosition = new Vec3(-view.w / 2 + leftWidth / 2, sourceY - rowHeight / 2 + 24, 0);
            (row as any).__expandedPosition = targetPosition.clone();
            const wasExpanded = (previousHeights.get(row.name) ?? 48) > 100;
            row.setPosition(wasExpanded === expanded ? (previousPositions.get(row.name) ?? targetPosition) : targetPosition);
            row.addComponent(Graphics);
            (row as any).__mixerSourceRowStyle = { width: leftWidth - 18, height: rowHeight, color: this.mixerColor(clip.color ?? 'white') };
            this.paintMixerSourceRow(row);
            const enabled = this.makePanelButton(row, clip.enabled !== false ? '●' : '○', -(leftWidth - 18) / 2 + 22, rowHeight / 2 - 24, 34, 34, () => { clip.enabled = clip.enabled === false; this.saveAudioClips(); this.queueMixerRedraw(); this.rebuildAudioRows(); }, clip.enabled !== false ? new Color(40, 150, 80, 255) : new Color(55, 65, 80, 255));
            const enabledLabel = enabled.getChildByName('Text')?.getComponent(Label); if (enabledLabel) enabledLabel.fontSize = 20;
            const label = this.makeLabel('SourceName', clip.name, 15, 22, new Color(240, 244, 250, 255), leftWidth - 155, 24); label.setPosition(-48, rowHeight / 2 - 16); row.addChild(label);
            const detail = this.makeLabel('SourceDetail', `${Math.max(.1, clip.duration).toFixed(1)}s  ${Math.round(clip.volume * 100)}%`, 11, 16, new Color(160, 170, 190, 255), leftWidth - 155, 18); detail.setPosition(-48, rowHeight / 2 - 36); row.addChild(detail);
            const reset = this.makePanelButton(row, '↻', (leftWidth - 18) / 2 - 113, rowHeight / 2 - 24, 34, 34, () => this.resetAudioSource(clip), new Color(48, 58, 78, 255)); (reset as any).__mixerSourceControl = true;
            const resetLabel = reset.getChildByName('Text')?.getComponent(Label); if (resetLabel) resetLabel.fontSize = 19;
            const preview = this.makePanelButton(row, '▶', (leftWidth - 18) / 2 - 69, rowHeight / 2 - 24, 34, 34, () => NativeBridge.playAudioFiles([clip], false), new Color(42, 72, 115, 255));
            const previewLabel = preview.getChildByName('Text')?.getComponent(Label); if (previewLabel) previewLabel.fontSize = 16;
            this.makeCloneButton(row, (leftWidth - 18) / 2 - 25, rowHeight / 2 - 24, () => this.cloneAudioClip(clip));
            if (expanded) {
                const content = new Node('SourceExpandedContent'); content.layer = Layers.Enum.UI_2D; content.addComponent(UITransform).setContentSize(leftWidth - 18, 124); const contentOpacity = content.addComponent(UIOpacity); row.addChild(content);
                this.makeSourceVolumeSlider(content, clip, 0, -rowHeight / 2 + 116, leftWidth - 70);
                this.makeTrimRangeSlider(content, clip, 0, -rowHeight / 2 + 78, leftWidth - 70, () => this.queueMixerLiveRedraw());
                this.makeSourceColorButton(content, clip, -115, -rowHeight / 2 + 28);
                this.makePanelButton(content, t('导出', 'Export'), -35, -rowHeight / 2 + 28, 82, 30, () => this.exportAudioClip(clip), new Color(42, 72, 115, 255));
                this.makePanelButton(content, t('删除', 'Delete'), 65, -rowHeight / 2 + 28, 82, 30, () => this.deleteAudioSource(clip), new Color(110, 45, 55, 255));
                if (!wasExpanded) { content.setPosition(0, 14); contentOpacity.opacity = 0; tween(content).to(sourceTransitionDuration, { position: Vec3.ZERO }, { easing: 'quadOut' }).start(); tween(contentOpacity).to(sourceTransitionDuration, { opacity: 255 }, { easing: 'quadOut' }).start(); }
            }
            this.attachMixerSourceDrag(row, clip);
            panel.addChild(row); this.clipRows.push(row);
            const dot = new Node(`AudioSourceDot${clip.id}`); dot.layer = Layers.Enum.UI_2D;
            dot.addComponent(UITransform).setContentSize(36, 36);
            const dotColor = this.mixerColor(clip.color ?? 'white');
            dot.addChild(this.makeLabel('DotFill', '●', 25, 32, dotColor, 36, 36));
            dot.setPosition(-view.w / 2 + 18, targetPosition.y, 0);
            dot.addComponent(Button).transition = Button.Transition.NONE;
            dot.on(Button.EventType.CLICK, () => this.selectCollapsedMixerSource(clip), this);
            // The top-border container is never clipped by the source background
            // or timeline viewport. Connections remain beneath these endpoint dots.
            (this.audioPanel?.getChildByName('AudioPanelTopBorder') ?? this.mixerConnectionLayer ?? panel).addChild(dot); this.mixerCollapsedSourceDots.push(dot);
            if (this.mixerSourcePanelCollapsed && !this.mixerSourcePaneAnimating) {
                rowOpacity.opacity = 0; row.active = false; dot.active = true;
            } else {
                rowOpacity.opacity = 255; dot.active = false;
            }
            const previous = previousPositions.get(row.name);
            if (previous && wasExpanded === expanded && !previous.equals(targetPosition)) tween(row).to(sourceTransitionDuration, { position: targetPosition }, { easing: 'quadInOut' }).start();
            else row.setPosition(targetPosition);
            sourceY -= rowHeight + 6;
        });
        this.refreshCollapsedSourceDotSelection(false); this.setMixerMultiSelectChrome(this.mixerMultiSelectMode);
        this.updateMixerConnections();
        this.scheduleOnce(() => this.updateMixerConnections(), sourceTransitionDuration + .02);
        return;
        this.recordedClips.slice(0, 13).forEach((clip, i) => {
            const row = new Node(`ClipRow${clip.id}`); row.layer = Layers.Enum.UI_2D; row.addComponent(UITransform).setContentSize(rowW, 48); row.setPosition(0, view.h / 2 - 92 - i * 58);
            const rg = row.addComponent(Graphics); rg.roundRect(-rowW / 2, -23, rowW, 46, 6); rg.fillColor = new Color(22, 30, 48, 255); rg.fill(); rg.lineWidth = 1; rg.strokeColor = new Color(60, 80, 110, 255); rg.stroke();
            const left = -rowW / 2;
            const dot = this.makePanelButton(row, clip.enabled ? '●' : '○', left + 25, 0, 38, 34, () => { clip.enabled = !clip.enabled; this.saveAudioClips(); this.rebuildAudioRows(); }, clip.enabled ? new Color(40, 150, 80, 255) : new Color(55, 65, 80, 255));
            const dotLabel = dot.getChildByName('Text')?.getComponent(Label);
            if (dotLabel) dotLabel.fontSize = 22;
            this.makePanelButton(row, clip.name, left + 185, 0, 260, 34, () => this.renameAudioClip(clip), new Color(30, 40, 62, 255));
            const sliderNode = new Node('Volume'); sliderNode.layer = Layers.Enum.UI_2D;
            const volumeWidth = 180; const sliderTransform = sliderNode.addComponent(UITransform); sliderTransform.setContentSize(volumeWidth, 36); sliderNode.setPosition(left + 425, 0);
            const sliderGfx = sliderNode.addComponent(Graphics);
            const drawVolume = () => {
                sliderGfx.clear(); sliderGfx.roundRect(-volumeWidth / 2, -4, volumeWidth, 8, 4); sliderGfx.fillColor = new Color(55, 65, 82, 255); sliderGfx.fill();
                sliderGfx.roundRect(-volumeWidth / 2, -4, volumeWidth * clip.volume, 8, 4); sliderGfx.fillColor = new Color(70, 190, 120, 255); sliderGfx.fill();
                sliderGfx.circle(-volumeWidth / 2 + volumeWidth * clip.volume, 0, 8); sliderGfx.fillColor = new Color(240, 245, 252, 255); sliderGfx.fill();
            };
            const updateVolume = (e: EventTouch) => { const p = e.getUILocation(); const local = sliderTransform.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0)); clip.volume = Math.max(0, Math.min(1, (local.x + volumeWidth / 2) / volumeWidth)); drawVolume(); this.saveAudioClips(); e.propagationStopped = true; };
            sliderNode.on(Node.EventType.TOUCH_START, updateVolume, this); sliderNode.on(Node.EventType.TOUCH_MOVE, updateVolume, this); drawVolume(); row.addChild(sliderNode);
            const duration = Math.max(.1, clip.duration || 0); const end = clip.trimEnd > clip.trimStart ? clip.trimEnd : duration;
            const startButton = this.makePanelButton(row, `始 ${clip.trimStart.toFixed(1)}s`, left + 580, 0, 100, 34, () => this.editClipTrim(clip, true), new Color(42, 62, 88, 255));
            const endButton = this.makePanelButton(row, `末 ${end.toFixed(1)}s`, left + 945, 0, 100, 34, () => this.editClipTrim(clip, false), new Color(42, 62, 88, 255));
            const refreshTrimLabels = () => {
                const currentEnd = clip.trimEnd > clip.trimStart ? clip.trimEnd : duration;
                const startLabel = startButton.getChildByName('Text')?.getComponent(Label); if (startLabel) startLabel.string = `始 ${clip.trimStart.toFixed(1)}s`;
                const endLabel = endButton.getChildByName('Text')?.getComponent(Label); if (endLabel) endLabel.string = `末 ${currentEnd.toFixed(1)}s`;
            };
            this.makeTrimRangeSlider(row, clip, left + 760, 0, 210, refreshTrimLabels);
            const right = rowW / 2;
            this.makePanelButton(row, '▶', right - 260, 0, 42, 34, () => NativeBridge.playAudioFiles([clip], false), new Color(42, 72, 115, 255));
            this.makeCloneButton(row, right - 208, 0, () => this.cloneAudioClip(clip));
            this.makePanelButton(row, '×', right - 156, 0, 42, 34, () => { this.recordedClips = this.recordedClips.filter((c) => c.id !== clip.id); this.saveAudioClips(); this.rebuildAudioRows(); }, new Color(110, 45, 55, 255));
            this.makePanelButton(row, '→', right - 104, 0, 42, 34, () => this.exportAudioClip(clip), new Color(42, 72, 115, 255));
            panel.addChild(row); this.clipRows.push(row);
        });
    }

    private makeSourceVolumeSlider(parent: Node, clip: AudioClipMeta, x: number, y: number, width: number) {
        const node = new Node('SourceVolumeSlider'); node.layer = Layers.Enum.UI_2D;
        (node as any).__mixerSourceControl = true;
        const transform = node.addComponent(UITransform); transform.setContentSize(width, 30); node.setPosition(x, y);
        const g = node.addComponent(Graphics);
        const draw = () => { g.clear(); g.roundRect(-width / 2, -4, width, 8, 4); g.fillColor = new Color(55, 65, 82, 255); g.fill(); g.roundRect(-width / 2, -4, width * clip.volume, 8, 4); g.fillColor = new Color(70, 190, 120, 255); g.fill(); g.circle(-width / 2 + width * clip.volume, 0, 7); g.fillColor = new Color(240, 245, 252, 255); g.fill(); };
        const update = (event: EventTouch) => { const p = event.getUILocation(); const local = transform.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0)); clip.volume = Math.max(0, Math.min(1, (local.x + width / 2) / width)); draw(); this.queueMixerLiveRedraw(); event.propagationStopped = true; };
        const finish = (event: EventTouch) => { this.saveAudioClips(); this.flushMixerLiveRedraw(); event.propagationStopped = true; };
        node.on(Node.EventType.TOUCH_START, update, this); node.on(Node.EventType.TOUCH_MOVE, update, this); node.on(Node.EventType.TOUCH_END, finish, this); node.on(Node.EventType.TOUCH_CANCEL, finish, this); draw(); parent.addChild(node);
    }

    private makeSourceColorButton(parent: Node, clip: AudioClipMeta, x: number, y: number) {
        const node = new Node('SourceColor'); node.layer = Layers.Enum.UI_2D; (node as any).__mixerSourceControl = true;
        node.addComponent(UITransform).setContentSize(30, 30); node.setPosition(x, y);
        const g = node.addComponent(Graphics); g.circle(0, 0, 12); g.fillColor = this.mixerColor(clip.color ?? 'white'); g.fill(); g.lineWidth = 2; g.strokeColor = new Color(215, 222, 235, 235); g.stroke();
        node.addComponent(Button).transition = Button.Transition.SCALE; node.on(Button.EventType.CLICK, () => this.openMixerSourceColorPalette(clip), this); parent.addChild(node);
    }

    private deleteAudioSource(clip: AudioClipMeta) {
        this.pushMixerUndo();
        const connectedBlock = this.mixerConnectionBlockId ? this.findMixerBlock(this.mixerConnectionBlockId)?.block : null;
        if (this.mixerConnectionSourceId === clip.id || connectedBlock?.clipId === clip.id) { this.mixerConnectionSourceId = ''; this.mixerConnectionBlockId = ''; }
        this.recordedClips = this.recordedClips.filter(item => item.id !== clip.id);
        this.mixerTracks = this.mixerTracks.map(track => ({ ...track, blocks: track.blocks.filter(block => block.clipId !== clip.id) }));
        this.mixerExpandedSourceId = '';
        this.saveAudioClips(); this.saveMixerTracks(); this.rebuildAudioRows(); this.queueMixerRedraw();
    }

    private attachMixerSourceDrag(row: Node, clip: AudioClipMeta) {
        let dragging = false; let moved = false; let start = new Vec3();
        let renameHoldTimer: ReturnType<typeof setTimeout> | null = null;
        let renameTriggered = false;
        const isControl = (event: EventTouch) => { let target = event.target as Node | null; while (target && target !== row) { if ((target as any).__mixerSourceControl || target.getComponent(Button)) return true; target = target.parent; } return false; };
        const isSourceName = (event: EventTouch) => {
            const nameNode = row.getChildByName('SourceName');
            const transform = nameNode?.getComponent(UITransform);
            if (!nameNode || !transform) return false;
            const p = event.getUILocation();
            const local = transform.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0));
            return Math.abs(local.x) <= transform.contentSize.width / 2 && Math.abs(local.y) <= transform.contentSize.height / 2;
        };
        const cancelRenameHold = () => { if (renameHoldTimer !== null) clearTimeout(renameHoldTimer); renameHoldTimer = null; };
        row.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
            if (isControl(event)) return;
            const p = event.getUILocation(); start.set(p.x, p.y, 0); dragging = false; moved = false; renameTriggered = false;
            cancelRenameHold();
            if (isSourceName(event)) renameHoldTimer = setTimeout(() => {
                renameHoldTimer = null;
                if (moved || dragging || !row.isValid) return;
                renameTriggered = true;
                this.renameAudioClip(clip);
            }, 700);
            event.propagationStopped = true;
        }, this);
        row.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => {
            if (isControl(event)) return;
            const p = event.getUILocation(); const point = new Vec3(p.x, p.y, 0); if (!moved && Math.abs(p.x - start.x) + Math.abs(p.y - start.y) > 12) { moved = true; dragging = true; cancelRenameHold(); this.beginMixerDragGhost(clip, point); }
            if (dragging) this.updateMixerDragGhost(point);
            event.propagationStopped = true;
        }, this);
        const finish = (event: EventTouch) => {
            if (isControl(event)) return;
            cancelRenameHold();
            if (dragging) { const target = this.mixerLocation(event); if (target) this.addMixerBlock(clip, target.track, target.beat); this.mixerDragGhost?.destroy(); this.mixerDragGhost = null; }
            else if (!moved && !renameTriggered) {
                const previousBlockId = this.mixerSelectedBlockId;
                this.mixerConnectionSourceId = clip.id; this.mixerConnectionBlockId = ''; this.mixerSelectedBlockId = '';
                if (previousBlockId) { const previousBlock = this.mixerTimeline?.getChildByName(`MixerBlock${previousBlockId}`); previousBlock?.getChildByName('BlockSelectionBorder')?.destroy(); previousBlock?.getChildByName('BlockToolbar')?.destroy(); }
                if (this.mixerSelectionBorderTransition) { Tween.stopAllByTarget(this.mixerSelectionBorderTransition); this.mixerSelectionBorderTransition.destroy(); this.mixerSelectionBorderTransition = null; }
                if (this.mixerExpandedSourceId === clip.id) { const content = row.getChildByName('SourceExpandedContent'); if (content) { const opacity = content.getComponent(UIOpacity); Tween.stopAllByTarget(content); if (opacity) { Tween.stopAllByTarget(opacity); tween(opacity).to(.24, { opacity: 0 }, { easing: 'quadInOut' }).start(); } tween(content).to(.24, { position: new Vec3(0, 14, 0) }, { easing: 'quadInOut' }).call(() => { this.mixerExpandedSourceId = ''; this.rebuildAudioRows(); }).start(); } else { this.mixerExpandedSourceId = ''; this.rebuildAudioRows(); } }
                else { this.mixerExpandedSourceId = clip.id; this.rebuildAudioRows(); }
                this.updateMixerConnections();
            }
            dragging = false; moved = false; renameTriggered = false;
            event.propagationStopped = true;
        };
        row.on(Node.EventType.TOUCH_END, finish, this); row.on(Node.EventType.TOUCH_CANCEL, finish, this);
    }

    private beginMixerDragGhost(clip: AudioClipMeta, point: Vec3) {
        this.mixerDragGhost?.destroy();
        if (!this.audioPanel) return;
        const ghost = new Node('MixerDragGhost'); ghost.layer = Layers.Enum.UI_2D; ghost.addComponent(UITransform).setContentSize(190, 52);
        const g = ghost.addComponent(Graphics); g.roundRect(-95, -26, 190, 52, MIXER_BLOCK_CORNER_RADIUS); g.fillColor = new Color(2, 3, 5, 235); g.fill(); g.lineWidth = 2; g.strokeColor = new Color(245, 245, 245, 230); g.stroke();
        ghost.addChild(this.makeLabel('GhostName', clip.name, 14, 22, new Color(255, 255, 255, 255), 176, 22));
        this.audioPanel.addChild(ghost); this.mixerDragGhost = ghost; this.updateMixerDragGhost(point);
    }

    private updateMixerDragGhost(point: Vec3) {
        if (!this.mixerDragGhost || !this.audioPanel) return;
        const local = this.audioPanel.getComponent(UITransform)!.convertToNodeSpaceAR(point);
        this.mixerDragGhost.setPosition(local.x, local.y, 0);
    }

    private mixerLocation(event: EventTouch): { track: number; beat: number } | null {
        if (!this.mixerViewport) return null;
        const point = event.getUILocation();
        const local = this.mixerViewport.getComponent(UITransform)!.convertToNodeSpaceAR(new Vec3(point.x, point.y, 0));
        const size = this.mixerViewport.getComponent(UITransform)!.contentSize;
        if (Math.abs(local.x) > size.width / 2 || Math.abs(local.y) > size.height / 2) return null;
        const beat = Math.max(0, (local.x + size.width / 2 - this.mixerTimelineContentInset() + this.mixerScrollX) / this.mixerBeatWidth);
        const track = Math.max(0, Math.min(12, Math.floor((size.height / 2 - local.y - 38 + this.mixerScrollY) / this.mixerRowHeight)));
        return { track, beat: this.mixerMagnet ? Math.round(beat) : beat };
    }

    private clipBeats(clip: AudioClipMeta, block?: MixerBlock): number {
        const seconds = block?.trimRanges?.length
            ? block.trimRanges.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0)
            : (() => {
                const start = block?.trimStart ?? clip.trimStart;
                const blockEnd = block?.trimEnd ?? clip.trimEnd;
                return Math.max(.05, (blockEnd > start ? blockEnd : clip.duration) - start);
            })();
        return Math.max(.1, seconds * this.metronomeBpm / 60 / Math.max(.25, Math.min(4, block?.speed ?? 1)));
    }

    private mixerBlockTrimRanges(clip: AudioClipMeta, block: MixerBlock): Array<{ start: number; end: number }> {
        if (block.trimRanges?.length) return block.trimRanges.filter(range => range.end > range.start + .001).map(range => ({ start: range.start, end: range.end }));
        const start = block.trimStart ?? clip.trimStart;
        const blockEnd = block.trimEnd ?? clip.trimEnd;
        const end = blockEnd > start ? blockEnd : clip.duration;
        return [{ start, end }];
    }

    private setMixerBlockTrimRanges(block: MixerBlock, ranges: Array<{ start: number; end: number }>) {
        const normalized = ranges.filter(range => range.end > range.start + .001).map(range => ({ start: range.start, end: range.end }));
        block.trimRanges = normalized;
        if (normalized.length) { block.trimStart = normalized[0].start; block.trimEnd = normalized[normalized.length - 1].end; }
    }

    private ensureMixerTrack(index: number): MixerTrack | null {
        while (this.mixerTracks.length <= index && this.mixerTracks.length < 13) this.mixerTracks.push({ id: `track_${Date.now()}_${this.mixerTracks.length}`, muted: false, solo: false, blocks: [] });
        return this.mixerTracks[index] ?? null;
    }

    private findFreeMixerTrack(start: number, beat: number, length: number, ignoreId = ''): number {
        for (let index = Math.max(0, start); index < 13; index++) {
            const track = this.ensureMixerTrack(index); if (!track) break;
            const overlaps = track.blocks.some(block => {
                if (block.id === ignoreId) return false;
                const clip = this.recordedClips.find(item => item.id === block.clipId); if (!clip) return false;
                const end = block.startBeat + this.clipBeats(clip, block);
                return beat < end - .001 && beat + length > block.startBeat + .001;
            });
            if (!overlaps) return index;
        }
        return Math.min(12, Math.max(0, start));
    }

    private addMixerBlock(clip: AudioClipMeta, requestedTrack: number, beat: number) {
        this.pushMixerUndo();
        const block: MixerBlock = { id: `block_${Date.now()}_${Math.floor(Math.random() * 1000)}`, clipId: clip.id, startBeat: Math.max(0, beat), color: clip.color ?? 'white', speed: 1, volumeAutomation: [1, 1] };
        const trackIndex = this.findFreeMixerTrack(requestedTrack, block.startBeat, this.clipBeats(clip, block));
        this.ensureMixerTrack(trackIndex)?.blocks.push(block);
        this.mixerSelectedBlockId = block.id;
        this.saveMixerTracks(); this.redrawMixerTimeline();
    }

    private findMixerBlock(blockId: string): { block: MixerBlock; track: MixerTrack; trackIndex: number } | null {
        for (let i = 0; i < this.mixerTracks.length; i++) {
            const block = this.mixerTracks[i].blocks.find(item => item.id === blockId);
            if (block) return { block, track: this.mixerTracks[i], trackIndex: i };
        }
        return null;
    }

    private mixerColor(name: string): Color {
        const colors: Record<string, Color> = { black: new Color(35, 35, 38, 255), white: new Color(245, 245, 245, 255), red: new Color(240, 70, 75, 255), orange: new Color(245, 145, 50, 255), pink: new Color(245, 105, 165, 255), yellow: new Color(240, 215, 55, 255), blue: new Color(75, 135, 245, 255), green: new Color(70, 195, 110, 255), cyan: new Color(55, 205, 205, 255), brown: new Color(145, 95, 60, 255) };
        return colors[name] ?? colors.white;
    }

    private queueMixerRedraw() {
        if (this.mixerRedrawQueued) return;
        this.mixerTimelineVisualDirty = true;
        this.mixerRedrawQueued = true;
        this.scheduleOnce(() => { this.mixerRedrawQueued = false; this.redrawMixerTimeline(); }, 0);
    }

    private deferMixerGestureRedraw(inertiaGeneration = this.mixerInertiaGeneration) {
        const request = ++this.mixerDeferredRedrawGeneration;
        this.scheduleOnce(() => {
            if (request !== this.mixerDeferredRedrawGeneration || inertiaGeneration !== this.mixerInertiaGeneration
                || this.mixerGestureTouches.size > 0 || this.mixerInertiaFrame !== null) return;
            this.redrawMixerTimeline();
        }, 0);
    }

    private mixerBeatAccent(beat: number) {
        const beatsPerBar = Math.max(1, this.metronomeBeatsPerBar), position = ((Math.round(beat) % beatsPerBar) + beatsPerBar) % beatsPerBar;
        const compoundSecondary = this.metronomeBeatUnit === 8 && beatsPerBar >= 6 && beatsPerBar % 3 === 0 && position > 0 && position % 3 === 0;
        const simpleSecondary = !compoundSecondary && beatsPerBar >= 4 && position === Math.ceil(beatsPerBar / 2);
        return position === 0 ? 2 : (compoundSecondary || simpleSecondary ? 1 : 0);
    }

    private mixerTimelineSignature() {
        return `${JSON.stringify(this.mixerTracks)}|${JSON.stringify(this.recordedClips.map(clip => ({ id: clip.id, name: clip.name, duration: clip.duration, trimStart: clip.trimStart, trimEnd: clip.trimEnd, volume: clip.volume, enabled: clip.enabled, color: clip.color })))}`;
    }

    private redrawMixerTimeline() {
        const timeline = this.mixerTimeline, viewport = this.mixerViewport;
        if (!timeline || !viewport || !this.audioPanelOpen || this.mixerDraggingBlockId) return;
        this.ensureMixerTrack(12);
        this.mixerDeferredRedrawGeneration++;
        if (this.mixerSelectionBorderTransition) {
            Tween.stopAllByTarget(this.mixerSelectionBorderTransition);
            this.mixerSelectionBorderTransition.destroy();
        }
        this.mixerSelectionBorderTransition = null;
        const size = viewport.getComponent(UITransform)!.contentSize; const w = size.width, h = size.height, contentInset = this.mixerTimelineContentInset();
        this.mixerTimelineViewportHeight = h;
        const signature = this.mixerTimelineSignature();
        const viewportWidthChanged = Math.abs(this.mixerTimelineCacheViewportWidth - w) > .001;
        const rebuild = this.mixerTimelineVisualDirty || !this.mixerTimelineCacheReady || signature !== this.mixerTimelineCacheSignature
            || Math.abs(this.mixerTimelineCacheBeatWidth - this.mixerBeatWidth) > .001
            || Math.abs(this.mixerTimelineCacheInset - contentInset) > .001;
        const preservedTimelinePosition = this.mixerTimelinePendingTransitionPosition
            ?? (this.mixerSourcePaneAnimating ? timeline.position.clone() : Vec3.ZERO);
        timeline.setPosition(preservedTimelinePosition); timeline.setScale(Vec3.ONE);
        if (rebuild) {
            // Detached nodes stay retained so scrolling never destroys already loaded content.
            const staleChildren = timeline.children.slice();
            for (const child of staleChildren) {
                // Keep the playhead in the timeline so its layer and transform stay
                // identical to the grid during scroll and pane transitions.
                if (child.name === 'MixerPlayhead') { child.active = true; continue; }
                if (child.name === 'MixerMultiSelectOverlay') { child.destroy(); this.mixerMultiSelectOverlay = null; continue; }
                child.active = false; child.removeFromParent(); this.mixerRetainedTimelineNodes.push(child);
            }
            this.mixerTimelineLoadedThroughBeat = 0;
            this.mixerTimelineCacheReady = true;
            this.mixerTimelineCacheSignature = signature;
            this.mixerTimelineCacheBeatWidth = this.mixerBeatWidth;
            this.mixerTimelineCacheInset = contentInset;
            this.mixerTimelineCacheViewportWidth = w;
            this.mixerTimelineVisualDirty = false;
            this.mixerRenderedScrollX = this.mixerScrollX;
            this.mixerRenderedScrollY = this.mixerScrollY;
            this.mixerRenderedBeatWidth = this.mixerBeatWidth;
            this.mixerGestureVisualBasePosition.set(0, 0, 0); this.mixerGestureVisualBaseScaleX = 1;
            const gridHeight = Math.max(h, 34 + Math.max(1, this.mixerTracks.length) * this.mixerRowHeight);
            const grid = new Node('TimelineGrid'); grid.layer = Layers.Enum.UI_2D; grid.addComponent(UITransform).setContentSize(w, gridHeight); const gg = grid.addComponent(Graphics);
            grid.on(Node.EventType.TOUCH_END, (event: EventTouch) => {
                if (this.mixerMultiSelectMode) return;
                if (!this.mixerGestureMoved) {
                    const p = event.getUILocation();
                    const viewportTransform = this.mixerViewport?.getComponent(UITransform);
                    const local = viewportTransform?.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0));
                    if (local) {
                        const currentWidth = viewportTransform?.contentSize.width ?? w, currentHeight = viewportTransform?.contentSize.height ?? h;
                        if (local.y >= currentHeight / 2 - 42) { if (this.mixerPlaying) this.stopMixerTimelinePlayback(true); this.setMixerPlayheadFromLocalX(local.x, currentWidth, true); }
                        else this.deselectMixerBlockImmediately();
                    }
                }
            }, this);
            const verticalGroups = [1, 1.5, 3].map((lineWidth, index) => { const layer = new Node(`BeatLines${index}`); layer.layer = Layers.Enum.UI_2D; layer.addComponent(UITransform).setContentSize(w * 2, gridHeight); const graphics = layer.addComponent(Graphics); graphics.lineWidth = lineWidth; graphics.strokeColor = new Color(255, 255, 255, 84); grid.addChild(layer); return graphics; });
            grid.setPosition(-this.mixerScrollX, this.mixerScrollY, 0);
            const ruler = new Node('TimelineRuler'); ruler.layer = Layers.Enum.UI_2D; ruler.addComponent(UITransform).setContentSize(w * 2, 34); ruler.setPosition(-this.mixerScrollX, h / 2 - 17);
            const rulerG = ruler.addComponent(Graphics); rulerG.rect(-w, -17, w * 2, 34); rulerG.fillColor = new Color(0, 0, 0, 255); rulerG.fill(); rulerG.lineWidth = 1; rulerG.strokeColor = new Color(105, 115, 135, 220); rulerG.moveTo(-w, -17); rulerG.lineTo(w, -17); rulerG.stroke();
            const rulerLabels = new Node('TimelineRulerLabels'); rulerLabels.layer = Layers.Enum.UI_2D; rulerLabels.addComponent(UITransform).setContentSize(w * 2, 34); rulerLabels.setPosition(-this.mixerScrollX, h / 2 - 17);
            timeline.addChild(grid);
            this.mixerTracks.forEach((track, trackIndex) => {
                const y = h / 2 - 34 - trackIndex * this.mixerRowHeight - this.mixerRowHeight / 2 + this.mixerScrollY;
                const head = new Node(`TrackHead${trackIndex}`); head.layer = Layers.Enum.UI_2D; head.addComponent(UITransform).setContentSize(MIXER_TRACK_HEAD_WIDTH, this.mixerRowHeight - 4); head.setPosition(-w / 2 + MIXER_TRACK_HEAD_WIDTH / 2 + 2, y); head.addComponent(Graphics); this.paintMixerTrackHead(head, track);
                const number = this.makeLabel('TrackNumber', `${trackIndex + 1}${track.solo ? ' S' : ''}`, 11, 16, new Color(255, 255, 255, 255), 32, 20); head.addChild(number); this.attachTrackMuteGesture(head, track, trackIndex); timeline.addChild(head);
            });
            timeline.addChild(ruler);
            timeline.addChild(rulerLabels);
            this.createMixerPlayhead(timeline, w, h, ruler);
            ruler.on(Node.EventType.TOUCH_END, (event: EventTouch) => { if (this.mixerMultiSelectMode) return; if (!this.mixerGestureMoved) { const p = event.getUILocation(); const viewportTransform = this.mixerViewport?.getComponent(UITransform); const local = viewportTransform?.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0)); if (local) { if (this.mixerPlaying) this.stopMixerTimelinePlayback(true); this.setMixerPlayheadFromLocalX(local.x, viewportTransform?.contentSize.width ?? w, true); } } event.propagationStopped = true; }, this);
        } else {
            if (viewportWidthChanged) {
                // Reuse the existing draw nodes during pane animation. Every timeline
                // element is anchored from the viewport center, so a width change only
                // requires this single shared horizontal offset.
                const widthOffset = (this.mixerTimelineCacheViewportWidth - w) / 2;
                if (Math.abs(widthOffset) > .001) {
                    for (const child of timeline.children) child.setPosition(child.position.x + widthOffset, child.position.y, 0);
                }
                this.mixerTimelineCacheViewportWidth = w;
            }
            const dx = this.mixerRenderedScrollX - this.mixerScrollX, dy = this.mixerScrollY - this.mixerRenderedScrollY;
            if (Math.abs(dx) > .001 || Math.abs(dy) > .001) {
                for (const child of timeline.children) {
                    if (child.name.startsWith('TrackHead')) continue;
                    if (child.name === 'TimelineGrid') child.setPosition(child.position.x + dx, child.position.y + dy, 0);
                    else if (child.name === 'TimelineRuler' || child.name === 'TimelineRulerLabels') child.setPosition(child.position.x + dx, child.position.y, 0);
                    else if (child.name.startsWith('MixerBlock')) child.setPosition(child.position.x + dx, child.position.y + dy, 0);
                }
            }
            this.mixerRenderedScrollX = this.mixerScrollX;
            this.mixerRenderedScrollY = this.mixerScrollY;
            if (!this.mixerSelectedBlockId) {
                for (const child of timeline.children) {
                    child.getChildByName('BlockSelectionBorder')?.destroy();
                    child.getChildByName('BlockToolbar')?.destroy();
                }
            }
        }
        const desiredEndBeat = Math.max(200, (this.mixerScrollX - contentInset + w * 1.5) / this.mixerBeatWidth);
        if (desiredEndBeat > this.mixerTimelineLoadedThroughBeat) {
            const appendTo = this.mixerTimelineLoadedThroughBeat <= 0 ? 200 : Math.ceil(desiredEndBeat / 100) * 100;
            this.appendMixerTimelineRange(this.mixerTimelineLoadedThroughBeat, appendTo, w, h, contentInset);
            this.mixerTimelineLoadedThroughBeat = appendTo;
        }
        for (let trackIndex = 0; trackIndex < this.mixerTracks.length; trackIndex++) {
            const head = timeline.getChildByName(`TrackHead${trackIndex}`); if (!head) continue;
            const y = h / 2 - 34 - trackIndex * this.mixerRowHeight - this.mixerRowHeight / 2 + this.mixerScrollY;
            head.setPosition(-w / 2 + MIXER_TRACK_HEAD_WIDTH / 2 + 2, y, 0);
        }
        const fixedRulerY = h / 2 - 17;
        const ruler = timeline.getChildByName('TimelineRuler');
        const rulerLabels = timeline.getChildByName('TimelineRulerLabels');
        // Ruler labels and the black ruler strip must share the grid's x origin.
        // Gesture preview temporarily changes these nodes independently; leaving
        // that preview coordinate in place makes labels disappear or jump during
        // the pane transition.
        const rulerX = timeline.getChildByName('TimelineGrid')?.position.x ?? -this.mixerScrollX;
        if (ruler) ruler.setPosition(rulerX, fixedRulerY, 0);
        if (rulerLabels) rulerLabels.setPosition(rulerX, fixedRulerY, 0);
        this.mixerGestureVisualBasePosition.set(0, 0, 0); this.mixerGestureVisualBaseScaleX = 1;
        this.ensureMixerBlockSelectionVisual();
        this.updateMixerPlayheadVisual();
        if (this.mixerMultiSelectMode) this.paintMixerMultiSelectOverlay();
        const audioPanelTopBorder = this.audioPanel?.getChildByName('AudioPanelTopBorder');
        if (audioPanelTopBorder && this.audioPanel) {
            audioPanelTopBorder.setSiblingIndex(this.audioPanel.children.length - 1);
        }
        const magnet = this.audioPanel?.getChildByName('AudioMagnet'); if (magnet) { (magnet as any).__panelButtonStyle.color = this.mixerMagnet ? new Color(245, 245, 245, 255) : new Color(8, 10, 15, 255); const label = magnet.getChildByName('Text')?.getComponent(Label); if (label) label.color = this.mixerMagnet ? new Color(0, 0, 0, 255) : new Color(255, 255, 255, 255); this.redrawPanelButton(magnet); }
        this.updateMixerConnections();
        this.redrawMixerTransportButtons();
    }

    private appendMixerTimelineRange(startBeat: number, endBeat: number, w: number, h: number, contentInset: number) {
        const timeline = this.mixerTimeline; if (!timeline) return;
        const grid = timeline.getChildByName('TimelineGrid'); const ruler = timeline.getChildByName('TimelineRuler'); const rulerLabels = timeline.getChildByName('TimelineRulerLabels');
        if (!grid || !ruler || !rulerLabels) return;
        const groups = [0, 1, 2].map(index => grid.getChildByName(`BeatLines${index}`)?.getComponent(Graphics)).filter(Boolean) as Graphics[];
        const firstBeat = Math.max(0, Math.floor(startBeat)); const lastBeat = Math.max(firstBeat, Math.ceil(endBeat));
        for (let beat = firstBeat; beat <= lastBeat; beat++) {
            if (grid.getChildByName(`Beat${beat}`)) continue;
            const x = -w / 2 + contentInset + beat * this.mixerBeatWidth, accent = this.mixerBeatAccent(beat);
            const group = groups[accent]; if (group) { group.moveTo(x, h / 2 - 34); group.lineTo(x, h / 2 - 34 - this.mixerTracks.length * this.mixerRowHeight); }
            const fontSize = accent === 2 ? 17 : (accent === 1 ? 11 : 6), lineHeight = accent === 2 ? 22 : (accent === 1 ? 16 : 10);
            const label = this.makeLabel(`Beat${beat}`, String(beat + 1), fontSize, lineHeight, new Color(210, 215, 225, 220), 40, 24);
            const labelComponent = label.getComponent(Label); if (labelComponent) labelComponent.isBold = accent === 2;
            label.setPosition(x - 1, 0, 0); rulerLabels.addChild(label);
        }
        for (const group of groups) group.stroke();
        const horizontalName = `TimelineHorizontalLines${firstBeat}`;
        if (!grid.getChildByName(horizontalName)) {
            const segmentWidth = Math.max(this.mixerBeatWidth, (lastBeat - firstBeat) * this.mixerBeatWidth);
            const horizontal = new Node(horizontalName); horizontal.layer = Layers.Enum.UI_2D;
            const gridHeight = Math.max(h, 34 + Math.max(1, this.mixerTracks.length) * this.mixerRowHeight);
            horizontal.addComponent(UITransform).setContentSize(segmentWidth, gridHeight);
            horizontal.setPosition(-w / 2 + contentInset + (firstBeat + lastBeat) * this.mixerBeatWidth / 2, 0, 0);
            const hg = horizontal.addComponent(Graphics); hg.lineWidth = 1; hg.strokeColor = new Color(255, 255, 255, 84);
            for (let row = 0; row <= this.mixerTracks.length; row++) { const y = h / 2 - 34 - row * this.mixerRowHeight; hg.moveTo(-segmentWidth / 2, y); hg.lineTo(segmentWidth / 2, y); }
            hg.stroke(); grid.addChild(horizontal);
        }
        for (const [trackIndex, track] of this.mixerTracks.entries()) {
            const y = h / 2 - 34 - trackIndex * this.mixerRowHeight - this.mixerRowHeight / 2 + this.mixerScrollY;
            for (const block of track.blocks) {
                const clip = this.recordedClips.find(item => item.id === block.clipId); if (!clip) continue;
                const blockEnd = block.startBeat + this.clipBeats(clip, block);
                if (blockEnd < startBeat || block.startBeat > endBeat || timeline.getChildByName(`MixerBlock${block.id}`)) continue;
                this.drawMixerBlock(timeline, block, trackIndex, w, h, y);
            }
        }
    }

    private drawMixerBlock(parent: Node, block: MixerBlock, trackIndex: number, viewW: number, viewH: number, y: number) {
        const clip = this.recordedClips.find(item => item.id === block.clipId); if (!clip) return;
        const length = this.clipBeats(clip, block); const width = Math.max(18, length * this.mixerBeatWidth); const color = this.mixerColor(block.color); const selected = this.mixerMultiSelectMode ? this.mixerMultiSelectedBlockIds.has(block.id) : block.id === this.mixerSelectedBlockId;
        const blockHeight = this.mixerRowHeight - 2; const node = new Node(`MixerBlock${block.id}`); node.layer = Layers.Enum.UI_2D; node.addComponent(UITransform).setContentSize(width, blockHeight); const target = new Vec3(-viewW / 2 + this.mixerTimelineContentInset() + block.startBeat * this.mixerBeatWidth - this.mixerScrollX + width / 2, y, 0); node.setPosition(target);
        const bg = node.addComponent(Graphics); const hh = blockHeight / 2, radius = Math.min(MIXER_BLOCK_CORNER_RADIUS, width / 2, hh); bg.roundRect(-width / 2, -hh, width, hh * 2, radius); bg.fillColor = new Color(2, 3, 5, 255); bg.fill(); bg.lineWidth = 2; bg.strokeColor = color; bg.stroke();
        const automation = block.volumeAutomation?.length ? block.volumeAutomation : [1, 1]; const kappa = .5522848;
        bg.fillColor = new Color(color.r, color.g, color.b, 84); bg.moveTo(-width / 2 + radius, -hh); bg.bezierCurveTo(-width / 2 + radius * (1 - kappa), -hh, -width / 2, -hh + radius * (1 - kappa), -width / 2, -hh + radius);
        automation.forEach((value, i) => { const y = -hh + Math.max(0, Math.min(1, value * clip.volume)) * hh * 2; const edgeY = i === 0 || i === automation.length - 1 ? Math.max(-hh + radius, y) : y; bg.lineTo(-width / 2 + width * i / Math.max(1, automation.length - 1), edgeY); });
        bg.lineTo(width / 2, -hh + radius); bg.bezierCurveTo(width / 2, -hh + radius * (1 - kappa), width / 2 - radius * (1 - kappa), -hh, width / 2 - radius, -hh); bg.close(); bg.fill();
        bg.strokeColor = new Color(255, 255, 255, 235); bg.lineWidth = 1.2; const waveTop = selected ? hh - 24 : hh; for (let x = 0; x < width; x += 3) { const phase = x / Math.max(1, width) * Math.PI * 18; const amp = (Math.sin(phase) * .55 + Math.sin(phase * .37) * .25) * (waveTop - 8); const px = -width / 2 + x; if (x === 0) bg.moveTo(px, 0); else bg.lineTo(px, amp); } bg.stroke();
        if (selected) { this.drawMixerBlockSelectionBorder(node, width, hh, color); this.drawMixerBlockToolbar(node, block, clip, width, hh, color); }
        else { const label = this.makeLabel('BlockName', clip.name, 12, 18, new Color(255, 255, 255, 230), Math.max(20, width - 8), 18); label.setPosition(0, hh - 11); node.addChild(label); }
        this.attachMixerBlockGesture(node, block, trackIndex);
        parent.addChild(node);
        // Keep audio blocks below the track heads/mute buttons and the ruler background.
        const firstTrackHead = parent.children.findIndex(child => child.name.startsWith('TrackHead'));
        const rulerIndex = parent.children.findIndex(child => child.name === 'TimelineRuler');
        const blockIndex = firstTrackHead >= 0 ? firstTrackHead : (rulerIndex >= 0 ? rulerIndex : parent.children.length - 1);
        node.setSiblingIndex(Math.max(1, blockIndex));
        if (selected && !this.mixerMultiSelectMode) this.promoteMixerSelectedBlock(node);
        const from = this.mixerAnimateFrom.get(block.id); if (from) { node.setPosition(from); tween(node).to(1, { position: target }, { easing: 'quadInOut' }).start(); this.mixerAnimateFrom.delete(block.id); }
    }

    /** Keep the selected block above every other block, while track heads and the ruler remain above it. */
    private promoteMixerSelectedBlock(node: Node) {
        const timeline = this.mixerTimeline;
        if (!timeline || node.parent !== timeline) return;
        const lastBlockIndex = timeline.children.reduce((last, child, index) => child.name.startsWith('MixerBlock') ? index : last, -1);
        if (lastBlockIndex >= 0 && node.getSiblingIndex() !== lastBlockIndex) node.setSiblingIndex(lastBlockIndex);
    }

    private ensureMixerBlockSelectionVisual() {
        if (this.mixerMultiSelectMode || !this.mixerSelectedBlockId || this.mixerSelectionBorderTransition) return;
        const found = this.findMixerBlock(this.mixerSelectedBlockId);
        const node = this.mixerTimeline?.getChildByName(`MixerBlock${this.mixerSelectedBlockId}`);
        const transform = node?.getComponent(UITransform);
        if (!found || !node || !transform) return;
        const clip = this.recordedClips.find(item => item.id === found.block.clipId);
        if (!clip) return;
        node.getChildByName('BlockName')?.destroy();
        const color = this.mixerColor(found.block.color);
        if (!node.getChildByName('BlockSelectionBorder')) this.drawMixerBlockSelectionBorder(node, transform.contentSize.width, transform.contentSize.height / 2, color);
        if (!node.getChildByName('BlockToolbar')) this.drawMixerBlockToolbar(node, found.block, clip, transform.contentSize.width, transform.contentSize.height / 2, color);
        this.promoteMixerSelectedBlock(node);
    }

    private drawMixerBlockSelectionBorder(node: Node, width: number, hh: number, color: Color) {
        node.getChildByName('BlockSelectionBorder')?.destroy();
        const inset = 5;
        const border = new Node('BlockSelectionBorder'); border.layer = Layers.Enum.UI_2D; border.addComponent(UITransform).setContentSize(width + inset * 2 + 2, hh * 2 + inset * 2 + 2);
        const g = border.addComponent(Graphics); g.lineWidth = 1.5; g.strokeColor = color; g.roundRect(-width / 2 - inset, -hh - inset, width + inset * 2, hh * 2 + inset * 2, MIXER_BLOCK_CORNER_RADIUS + inset); g.stroke(); node.addChild(border);
    }

    private animateMixerBlockSelectionBorder(fromNode: Node | null, toNode: Node, blockId: string, color: Color) {
        const timeline = this.mixerTimeline, targetTransform = toNode.getComponent(UITransform);
        if (!timeline || !targetTransform) return;
        const targetWidth = targetTransform.contentSize.width + 10, targetHeight = targetTransform.contentSize.height + 10;
        let sourcePosition = toNode.position.clone(), sourceWidth = targetWidth, sourceHeight = targetHeight;
        const active = this.mixerSelectionBorderTransition;
        if (active) {
            const activeTransform = active.getComponent(UITransform);
            sourcePosition = active.position.clone();
            if (activeTransform) {
                sourceWidth = activeTransform.contentSize.width * Math.abs(active.scale.x);
                sourceHeight = activeTransform.contentSize.height * Math.abs(active.scale.y);
            }
            Tween.stopAllByTarget(active); active.destroy();
        } else if (fromNode) {
            const sourceTransform = fromNode.getComponent(UITransform);
            sourcePosition = fromNode.position.clone();
            if (sourceTransform) {
                sourceWidth = sourceTransform.contentSize.width + 10;
                sourceHeight = sourceTransform.contentSize.height + 10;
            }
        }
        const transition = new Node('BlockSelectionBorderTransition'); transition.layer = Layers.Enum.UI_2D;
        transition.addComponent(UITransform).setContentSize(sourceWidth, sourceHeight); transition.setPosition(sourcePosition);
        const g = transition.addComponent(Graphics); g.lineWidth = 1.5; g.strokeColor = color;
        g.roundRect(-sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight, Math.min(MIXER_BLOCK_CORNER_RADIUS + 5, sourceWidth / 2, sourceHeight / 2)); g.stroke();
        timeline.addChild(transition);
        this.promoteMixerSelectedBlock(toNode);
        const lastBlockIndex = timeline.children.reduce((last, child, index) => child.name.startsWith('MixerBlock') ? index : last, -1);
        if (lastBlockIndex >= 0) transition.setSiblingIndex(lastBlockIndex + 1);
        this.mixerSelectionBorderTransition = transition;
        tween(transition).to(.3, {
            position: toNode.position.clone(),
            scale: new Vec3(targetWidth / Math.max(1, sourceWidth), targetHeight / Math.max(1, sourceHeight), 1),
        }, { easing: 'quadInOut' }).call(() => {
            if (this.mixerSelectionBorderTransition !== transition) return;
            this.mixerSelectionBorderTransition = null; transition.destroy();
            if (this.mixerSelectedBlockId !== blockId) return;
            this.drawMixerBlockSelectionBorder(toNode, targetTransform.contentSize.width, targetTransform.contentSize.height / 2, color);
            this.promoteMixerSelectedBlock(toNode);
        }).start();
    }

    private drawMixerBlockToolbar(node: Node, block: MixerBlock, clip: AudioClipMeta, width: number, hh: number, color: Color) {
        const bar = new Node('BlockToolbar'); bar.layer = Layers.Enum.UI_2D; bar.addComponent(UITransform).setContentSize(width - 4, 24); const barG = bar.addComponent(Graphics); barG.roundRect(-(width - 4) / 2, -12, width - 4, 24, Math.min(MIXER_BLOCK_CORNER_RADIUS, 12)); barG.fillColor = new Color(2, 3, 5, 255); barG.fill(); barG.lineWidth = 1; barG.strokeColor = color; barG.moveTo(-(width - 4) / 2, -12); barG.lineTo((width - 4) / 2, -12); barG.stroke(); bar.setPosition(0, this.mixerMultiSelectMode ? hh - 12 : hh + 4); node.addChild(bar); if (!this.mixerMultiSelectMode) tween(bar).to(.06, { position: new Vec3(0, hh - 12, 0) }, { easing: 'quadOut' }).start();
        const label = this.makeLabel('BlockName', clip.name, 12, 18, new Color(255, 255, 255, 255), Math.max(30, width - 132), 18); label.setPosition(-Math.max(0, width / 2 - 65), 0); bar.addChild(label);
        if (width < 150) return;
        const actions: Array<[string, () => void, Color]> = [
            ['⧉', () => this.cloneMixerBlock(block.id), new Color(10, 10, 12, 255)],
            ['←', () => this.alignMixerBlockLeft(block.id), new Color(10, 10, 12, 255)],
            ['X', () => this.deleteMixerBlock(block.id), new Color(10, 10, 12, 255)],
            ['●', () => this.openMixerColorPalette(block.id), color],
        ];
        actions.forEach((action, index) => { const x = width / 2 - 16 - (3 - index) * 31; const button = this.makePanelButton(bar, action[0], x, 0, 26, 22, action[1], action[2]); const text = button.getChildByName('Text')?.getComponent(Label); if (text) { text.fontSize = 12; if (action[0] === 'X') text.color = new Color(255, 65, 70, 255); } });
    }

    private paintMixerTrackHead(node: Node, track: MixerTrack) {
        const g = node.getComponent(Graphics); if (!g) return;
        const width = MIXER_TRACK_HEAD_WIDTH, height = this.mixerRowHeight - 4, radius = Math.min(MIXER_BLOCK_CORNER_RADIUS, width / 2, height / 2); g.clear();
        g.roundRect(-width / 2, -height / 2, width, height, radius); g.fillColor = new Color(0, 0, 0, 255); g.fill();
        if (track.muted) { /* opaque base is the muted state */ }
        else {
            const rings = 7, step = Math.min(width, height) * .45 / rings;
            for (let ring = 0; ring < rings; ring++) {
                const inset = ring * step, innerW = width - inset * 2, innerH = height - inset * 2, shade = Math.round(105 * (1 - ring / rings));
                g.fillColor = new Color(shade, shade, shade, 153);
                g.roundRect(-width / 2 + inset, -height / 2 + inset, innerW, innerH, Math.max(0, radius - inset)); g.fill();
            }
            const centerInset = rings * step; g.fillColor = new Color(0, 0, 0, 153); g.roundRect(-width / 2 + centerInset, -height / 2 + centerInset, Math.max(0, width - centerInset * 2), Math.max(0, height - centerInset * 2), Math.max(0, radius - centerInset)); g.fill();
        }
        g.lineWidth = track.solo ? 3 : 1; g.strokeColor = track.solo ? new Color(255, 220, 70, 255) : new Color(210, 215, 225, 180); g.roundRect(-width / 2, -height / 2, width, height, radius); g.stroke();
    }

    private attachTrackMuteGesture(node: Node, track: MixerTrack, trackIndex: number) {
        let startY = 0, lastIndex = trackIndex, sliding = false, targetMuted = false;
        const applyIndex = (index: number) => { const item = this.mixerTracks[index]; if (!item || item.muted === targetMuted) return; item.muted = targetMuted; const head = this.mixerTimeline?.getChildByName(`TrackHead${index}`); if (head) this.paintMixerTrackHead(head, item); };
        const indexAt = (e: EventTouch) => { if (!this.mixerViewport) return trackIndex; const p = e.getUILocation(); const local = this.mixerViewport.getComponent(UITransform)!.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0)); const height = this.mixerViewport.getComponent(UITransform)!.contentSize.height; return Math.max(0, Math.min(this.mixerTracks.length - 1, Math.floor((height / 2 - 34 + this.mixerScrollY - local.y) / this.mixerRowHeight))); };
        node.on(Node.EventType.TOUCH_START, e => { if (this.mixerMultiSelectMode) return; this.stopMixerInertia(false); startY = e.getUILocation().y; lastIndex = trackIndex; sliding = false; targetMuted = !track.muted; e.propagationStopped = true; }, this);
        node.on(Node.EventType.TOUCH_MOVE, e => { if (this.mixerMultiSelectMode) return; const current = indexAt(e); if (!sliding && Math.abs(e.getUILocation().y - startY) > 7) { sliding = true; applyIndex(trackIndex); } if (sliding) { const from = Math.min(lastIndex, current), to = Math.max(lastIndex, current); for (let index = from; index <= to; index++) applyIndex(index); lastIndex = current; } e.propagationStopped = true; }, this);
        const finish = (e: EventTouch) => {
            if (this.mixerMultiSelectMode) return;
            if (sliding) { this.saveMixerTracks(); this.refreshMixerTimelineAudio(); this.queueMixerRedraw(); }
            else {
                const pending = this.mixerTrackTapTimers.get(track.id);
                if (pending) { clearTimeout(pending); this.mixerTrackTapTimers.delete(track.id); track.muted = !track.muted; track.solo = !track.solo; }
                else { track.muted = !track.muted; const timer = setTimeout(() => { this.mixerTrackTapTimers.delete(track.id); }, 320); this.mixerTrackTapTimers.set(track.id, timer); }
                this.saveMixerTracks(); this.refreshMixerTimelineAudio(); this.paintMixerTrackHead(node, track); this.queueMixerRedraw();
            }
            e.propagationStopped = true;
        };
        node.on(Node.EventType.TOUCH_END, finish, this); node.on(Node.EventType.TOUCH_CANCEL, finish, this);
    }

    private attachMixerBlockGesture(node: Node, block: MixerBlock, trackIndex: number) {
        let start = new Vec3(); let dragOrigin = new Vec3(); let moved = false; let holding = false; let selectedAtStart = false; let holdTimer: ReturnType<typeof setTimeout> | null = null;
        let multiBoxing = false, multiMoved = false; const multiOrigins = new Map<string, Vec3>();
        const isToolbarControl = (target: Node | null) => { let current = target; while (current && current !== node) { if (current.getComponent(Button) || current.getComponent(Label)?.node?.name === 'Text') return true; current = current.parent; } return false; };
        node.on(Node.EventType.TOUCH_START, e => {
            if (isToolbarControl(e.target as Node)) return;
            this.stopMixerInertia(false); const p = e.getUILocation(); start.set(p.x, p.y, 0); dragOrigin.set(node.position); moved = false; holding = false; multiBoxing = false; multiMoved = false; multiOrigins.clear();
            if (this.mixerMultiSelectMode) {
                selectedAtStart = this.mixerMultiSelectedBlockIds.has(block.id);
                if (selectedAtStart) holdTimer = setTimeout(() => {
                    if (!this.mixerMultiSelectMode || moved) return;
                    holding = true;
                    for (const id of this.mixerMultiSelectedBlockIds) {
                        const selectedNode = this.mixerTimeline?.getChildByName(`MixerBlock${id}`); if (!selectedNode) continue;
                        multiOrigins.set(id, selectedNode.position.clone()); Tween.stopAllByTarget(selectedNode);
                        tween(selectedNode).to(.1, { scale: new Vec3(1.045, 1.045, 1) }, { easing: 'quadOut' }).start();
                    }
                }, 340);
                e.propagationStopped = true; return;
            }
            selectedAtStart = this.mixerSelectedBlockId === block.id;
            if (!selectedAtStart) {
                const previousNode = this.mixerSelectedBlockId ? this.mixerTimeline?.getChildByName(`MixerBlock${this.mixerSelectedBlockId}`) ?? null : null;
                previousNode?.getChildByName('BlockSelectionBorder')?.destroy(); previousNode?.getChildByName('BlockToolbar')?.destroy(); this.mixerSelectedBlockId = block.id; this.promoteMixerSelectedBlock(node); node.getChildByName('BlockName')?.destroy();
                const clip = this.recordedClips.find(item => item.id === block.clipId); const transform = node.getComponent(UITransform);
                if (clip && transform) { const color = this.mixerColor(block.color); if (previousNode || this.mixerSelectionBorderTransition) this.animateMixerBlockSelectionBorder(previousNode, node, block.id, color); else this.drawMixerBlockSelectionBorder(node, transform.contentSize.width, transform.contentSize.height / 2, color); if (!node.getChildByName('BlockToolbar')) this.drawMixerBlockToolbar(node, block, clip, transform.contentSize.width, transform.contentSize.height / 2, color); }
            }
            this.mixerDraggingBlockId = block.id;
            holdTimer = setTimeout(() => { holding = true; node.active = true; this.promoteMixerSelectedBlock(node); tween(node).to(.18, { scale: new Vec3(1.05, 1.05, 1) }, { easing: 'quadOut' }).start(); }, 1000);
            e.propagationStopped = true;
        }, this);
        node.on(Node.EventType.TOUCH_MOVE, e => {
            if (isToolbarControl(e.target as Node)) return;
            const p = e.getUILocation(), dx = p.x - start.x, dy = p.y - start.y;
            if (this.mixerMultiSelectMode) {
                if (holding) {
                    multiMoved = multiMoved || Math.hypot(dx, dy) > 2;
                    for (const [id, origin] of multiOrigins) this.mixerTimeline?.getChildByName(`MixerBlock${id}`)?.setPosition(origin.x + dx, origin.y + dy, 0);
                }
                else if (Math.hypot(dx, dy) >= 18) {
                    moved = true; if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
                    if (!multiBoxing) { const startLocal = this.mixerViewport?.getComponent(UITransform)?.convertToNodeSpaceAR(start); if (startLocal) { this.mixerMultiBoxStart = startLocal; this.mixerMultiBoxCurrent = null; this.mixerMultiBoxTouchId = e.getID(); multiBoxing = true; } }
                    const local = this.mixerMultiViewportPoint(e); if (local) { this.mixerMultiBoxCurrent = local; this.paintMixerMultiSelectOverlay(); }
                }
                e.propagationStopped = true; return;
            }
            if (Math.abs(dx) + Math.abs(dy) > 10) moved = true;
            if (holding) { node.setPosition(dragOrigin.x + dx, dragOrigin.y + dy, 0); this.updateMixerConnections(); }
            e.propagationStopped = true;
        }, this);
        const finish = (e: EventTouch) => {
            if (isToolbarControl(e.target as Node)) return;
            if (holdTimer) clearTimeout(holdTimer); holdTimer = null;
            if (this.mixerMultiSelectMode) {
                const p = e.getUILocation(), dx = p.x - start.x, dy = p.y - start.y;
                if (holding) {
                    for (const id of this.mixerMultiSelectedBlockIds) { const selectedNode = this.mixerTimeline?.getChildByName(`MixerBlock${id}`); if (selectedNode) { Tween.stopAllByTarget(selectedNode); tween(selectedNode).to(.08, { scale: Vec3.ONE }, { easing: 'quadOut' }).start(); } }
                    if (multiMoved) this.moveMixerMultiSelectedBlocks(dx, dy); else this.paintMixerMultiSelectOverlay();
                }
                else if (multiBoxing) { const local = this.mixerMultiViewportPoint(e); if (local) this.mixerMultiBoxCurrent = local; this.finishMixerMultiBoxSelection(); }
                else if (!moved) { this.showMixerMultiTapFeedback(e); this.toggleMixerMultiBlockSelection(node, block); }
                holding = false; multiBoxing = false; multiMoved = false; e.propagationStopped = true; return;
            }
            this.mixerDraggingBlockId = '';
            if (holding && moved) { const target = this.mixerBlockLocation(node, block); if (target) this.moveMixerBlock(block.id, target.track, target.beat, undefined, true); else { Tween.stopAllByTarget(node); node.setScale(Vec3.ONE); } }
            else if (holding) { Tween.stopAllByTarget(node); node.setScale(Vec3.ONE); this.promoteMixerSelectedBlock(node); this.updateMixerConnections(); }
            else if (!moved) this.handleMixerBlockTap(block, selectedAtStart); else this.queueMixerRedraw();
            e.propagationStopped = true;
        };
        node.on(Node.EventType.TOUCH_END, finish, this); node.on(Node.EventType.TOUCH_CANCEL, finish, this);
    }

    private mixerBlockLocation(node: Node, block: MixerBlock): { track: number; beat: number } | null {
        if (!this.mixerViewport) return null;
        const clip = this.recordedClips.find(item => item.id === block.clipId); if (!clip) return null;
        const size = this.mixerViewport.getComponent(UITransform)!.contentSize;
        const width = Math.max(18, this.clipBeats(clip, block) * this.mixerBeatWidth);
        const leftX = node.position.x - width / 2;
        const rawBeat = Math.max(0, (leftX + size.width / 2 - this.mixerTimelineContentInset() + this.mixerScrollX) / this.mixerBeatWidth);
        const firstCenterY = size.height / 2 - 34 - this.mixerRowHeight / 2 + this.mixerScrollY;
        const track = Math.max(0, Math.min(12, Math.round((firstCenterY - node.position.y) / this.mixerRowHeight)));
        return { track, beat: this.mixerMagnet ? Math.round(rawBeat) : rawBeat };
    }

    private mixerBlockPosition(block: MixerBlock, trackIndex: number): Vec3 | null {
        const transform = this.mixerViewport?.getComponent(UITransform); if (!transform) return null;
        const clip = this.recordedClips.find(item => item.id === block.clipId); if (!clip) return null;
        const size = transform.contentSize, width = Math.max(18, this.clipBeats(clip, block) * this.mixerBeatWidth);
        return new Vec3(
            -size.width / 2 + this.mixerTimelineContentInset() + block.startBeat * this.mixerBeatWidth - this.mixerScrollX + width / 2,
            size.height / 2 - 34 - trackIndex * this.mixerRowHeight - this.mixerRowHeight / 2 + this.mixerScrollY,
            0,
        );
    }

    private settleMixerBlockNode(block: MixerBlock, trackIndex: number) {
        const node = this.mixerTimeline?.getChildByName(`MixerBlock${block.id}`), position = this.mixerBlockPosition(block, trackIndex);
        if (!node || !position) return;
        Tween.stopAllByTarget(node); node.setPosition(position); node.setScale(Vec3.ONE);
        if (!this.mixerMultiSelectMode && this.mixerSelectedBlockId === block.id) this.promoteMixerSelectedBlock(node);
    }

    private handleMixerBlockTap(block: MixerBlock, wasSelected = this.mixerSelectedBlockId === block.id) {
        this.mixerConnectionBlockId = block.id; this.mixerConnectionSourceId = ''; this.refreshCollapsedSourceDotSelection(true); this.updateMixerConnections();
        const now = Date.now();
        if (this.mixerLastBlockTap.id === block.id && now - this.mixerLastBlockTap.at < 330) { this.mixerSelectedBlockId = block.id; this.previewMixerBlock(block); this.queueMixerRedraw(); this.mixerLastBlockTap = { id: '', at: 0 }; return; }
        this.mixerLastBlockTap = { id: block.id, at: now };
        if (!wasSelected) { this.mixerSelectedBlockId = block.id; if (!this.mixerSelectionBorderTransition) this.queueMixerRedraw(); this.scheduleOnce(() => { if (this.mixerLastBlockTap.id === block.id) this.mixerLastBlockTap = { id: '', at: 0 }; }, .3); }
        else this.scheduleOnce(() => { if (this.mixerLastBlockTap.id === block.id) { this.mixerLastBlockTap = { id: '', at: 0 }; this.openMixerBlockEditor(block.id); } }, .3);
    }

    private deselectMixerBlockImmediately() {
        this.mixerLastBlockTap = { id: '', at: 0 };
        this.mixerConnectionBlockId = ''; this.mixerConnectionSourceId = ''; this.refreshCollapsedSourceDotSelection(true); this.updateMixerConnections();
        if (this.mixerSelectionBorderTransition) { Tween.stopAllByTarget(this.mixerSelectionBorderTransition); this.mixerSelectionBorderTransition.destroy(); this.mixerSelectionBorderTransition = null; }
        if (!this.mixerSelectedBlockId) return;
        this.mixerSelectedBlockId = ''; this.mixerColorPalette?.destroy(); this.mixerColorPalette = null;
        this.redrawMixerTimeline();
    }

    private previewMixerBlock(block: MixerBlock) {
        const clip = this.recordedClips.find(item => item.id === block.clipId);
        if (!clip) return;
        const speed = Math.max(.25, Math.min(4, block.speed ?? 1)); let elapsedSeconds = 0;
        const entries = this.mixerBlockTrimRanges(clip, block).map(range => {
            const entry = { ...clip, trimStart: range.start, trimEnd: range.end, volume: clip.volume, startBeat: elapsedSeconds * this.metronomeBpm / 60 / speed, speed, volumeAutomation: block.volumeAutomation, pitchAutomation: block.pitchAutomation, panAutomation: block.panAutomation };
            elapsedSeconds += range.end - range.start; return entry;
        });
        NativeBridge.playTimeline(entries, this.metronomeBpm);
    }

    private moveMixerBlock(blockId: string, requestedTrack: number, beat: number, from?: Vec3, settleImmediately = false) {
        const found = this.findMixerBlock(blockId); if (!found) return; const clip = this.recordedClips.find(item => item.id === found.block.clipId); if (!clip) return;
        this.pushMixerUndo(); found.track.blocks = found.track.blocks.filter(item => item.id !== blockId);
        found.block.startBeat = Math.max(0, this.mixerMagnet ? Math.round(beat) : beat);
        const trackIndex = this.findFreeMixerTrack(requestedTrack, found.block.startBeat, this.clipBeats(clip, found.block), blockId);
        this.ensureMixerTrack(trackIndex)?.blocks.push(found.block); this.saveMixerTracks();
        if (settleImmediately) {
            this.mixerAnimateFrom.delete(blockId); this.settleMixerBlockNode(found.block, trackIndex);
            this.mixerTimelineCacheSignature = this.mixerTimelineSignature(); this.updateMixerConnections();
        } else {
            if (from) this.mixerAnimateFrom.set(blockId, from);
            this.queueMixerRedraw();
        }
    }

    private mixerMultiOperationIds(blockId: string) {
        if (this.mixerMultiSelectMode && this.mixerMultiSelectedBlockIds.has(blockId)) return Array.from(this.mixerMultiSelectedBlockIds).filter(id => !!this.findMixerBlock(id));
        return [blockId];
    }

    private moveMixerMultiSelectedBlocks(deltaX: number, deltaY: number) {
        const ids = Array.from(this.mixerMultiSelectedBlockIds), idSet = new Set(ids);
        const entries = ids.map(id => this.findMixerBlock(id)).filter(Boolean) as Array<{ block: MixerBlock; track: MixerTrack; trackIndex: number }>;
        if (!entries.length) return;
        this.pushMixerUndo();
        const leftmost = Math.min(...entries.map(entry => entry.block.startBeat));
        let targetLeft = Math.max(0, leftmost + deltaX / this.mixerBeatWidth); if (this.mixerMagnet) targetLeft = Math.round(targetLeft);
        const beatDelta = targetLeft - leftmost, trackDelta = Math.round(-deltaY / this.mixerRowHeight);
        for (const track of this.mixerTracks) track.blocks = track.blocks.filter(item => !idSet.has(item.id));
        entries.sort((a, b) => a.trackIndex - b.trackIndex || a.block.startBeat - b.block.startBeat);
        const finalTracks = new Map<string, number>();
        for (const entry of entries) {
            entry.block.startBeat = Math.max(0, entry.block.startBeat + beatDelta);
            const clip = this.recordedClips.find(item => item.id === entry.block.clipId); if (!clip) continue;
            const desiredTrack = Math.max(0, Math.min(12, entry.trackIndex + trackDelta));
            const targetTrack = this.findFreeMixerTrack(desiredTrack, entry.block.startBeat, this.clipBeats(clip, entry.block), entry.block.id);
            this.ensureMixerTrack(targetTrack)?.blocks.push(entry.block);
            finalTracks.set(entry.block.id, targetTrack);
        }
        this.saveMixerTracks();
        for (const entry of entries) {
            const finalTrack = finalTracks.get(entry.block.id); if (finalTrack === undefined) continue;
            this.mixerAnimateFrom.delete(entry.block.id); this.settleMixerBlockNode(entry.block, finalTrack);
        }
        this.mixerTimelineCacheSignature = this.mixerTimelineSignature(); this.paintMixerMultiSelectOverlay(); this.updateMixerConnections();
    }

    private cloneMixerMultiSelectedBlocks() {
        const ids = Array.from(this.mixerMultiSelectedBlockIds);
        const entries = ids.map(id => this.findMixerBlock(id)).filter(Boolean) as Array<{ block: MixerBlock; track: MixerTrack; trackIndex: number }>;
        if (!entries.length) return;
        const minStart = Math.min(...entries.map(entry => entry.block.startBeat));
        const maxEnd = Math.max(...entries.map(entry => { const clip = this.recordedClips.find(item => item.id === entry.block.clipId); return entry.block.startBeat + (clip ? this.clipBeats(clip, entry.block) : 0); }));
        const offset = Math.max(.001, maxEnd - minStart), stamp = Date.now(), cloneIds = new Set<string>();
        this.pushMixerUndo();
        entries.sort((a, b) => a.trackIndex - b.trackIndex || a.block.startBeat - b.block.startBeat).forEach((entry, index) => {
            const clip = this.recordedClips.find(item => item.id === entry.block.clipId); if (!clip) return;
            const clone: MixerBlock = JSON.parse(JSON.stringify(entry.block)); clone.id = `block_${stamp}_${index}`; clone.startBeat += offset;
            const targetTrack = this.findFreeMixerTrack(entry.trackIndex, clone.startBeat, this.clipBeats(clip, clone)); this.ensureMixerTrack(targetTrack)?.blocks.push(clone); cloneIds.add(clone.id);
            const sourceNode = this.mixerTimeline?.getChildByName(`MixerBlock${entry.block.id}`); if (sourceNode) this.mixerAnimateFrom.set(clone.id, sourceNode.position.clone());
        });
        this.mixerMultiSelectedBlockIds = cloneIds; this.saveMixerTracks(); this.queueMixerRedraw();
    }

    private alignMixerMultiSelectedBlocks() {
        const ids = Array.from(this.mixerMultiSelectedBlockIds), idSet = new Set(ids);
        const entries = ids.map(id => this.findMixerBlock(id)).filter(Boolean) as Array<{ block: MixerBlock; track: MixerTrack; trackIndex: number }>;
        if (!entries.length) return;
        const leftmost = Math.min(...entries.map(entry => entry.block.startBeat)); let best = 0;
        for (const track of this.mixerTracks) for (const other of track.blocks) {
            if (idSet.has(other.id)) continue;
            const clip = this.recordedClips.find(item => item.id === other.clipId); if (!clip) continue;
            const end = other.startBeat + this.clipBeats(clip, other); if (end <= leftmost + .001 && end > best) best = end;
        }
        const delta = best - leftmost; this.pushMixerUndo();
        for (const track of this.mixerTracks) track.blocks = track.blocks.filter(item => !idSet.has(item.id));
        entries.sort((a, b) => a.trackIndex - b.trackIndex || a.block.startBeat - b.block.startBeat).forEach(entry => {
            const clip = this.recordedClips.find(item => item.id === entry.block.clipId); if (!clip) return;
            entry.block.startBeat = Math.max(0, entry.block.startBeat + delta);
            const targetTrack = this.findFreeMixerTrack(entry.trackIndex, entry.block.startBeat, this.clipBeats(clip, entry.block), entry.block.id); this.ensureMixerTrack(targetTrack)?.blocks.push(entry.block);
        });
        this.saveMixerTracks(); this.queueMixerRedraw();
    }

    private deleteMixerMultiSelectedBlocks() {
        const ids = new Set(this.mixerMultiSelectedBlockIds); if (!ids.size) return;
        this.pushMixerUndo(); for (const track of this.mixerTracks) track.blocks = track.blocks.filter(item => !ids.has(item.id));
        this.mixerMultiSelectedBlockIds.clear(); this.saveMixerTracks(); this.mixerTimelineVisualDirty = true; this.redrawMixerTimeline();
    }

    private cloneMixerBlock(blockId: string) {
        if (this.mixerMultiSelectMode && this.mixerMultiSelectedBlockIds.has(blockId)) { this.cloneMixerMultiSelectedBlocks(); return; }
        const found = this.findMixerBlock(blockId); if (!found) return; const clip = this.recordedClips.find(item => item.id === found.block.clipId); if (!clip || !this.mixerViewport) return; this.pushMixerUndo(); const clone: MixerBlock = JSON.parse(JSON.stringify(found.block)); clone.id = `block_${Date.now()}`; clone.startBeat = found.block.startBeat + this.clipBeats(clip, found.block); const targetTrack = this.findFreeMixerTrack(found.trackIndex, clone.startBeat, this.clipBeats(clip, clone)); this.ensureMixerTrack(targetTrack)?.blocks.push(clone); const size = this.mixerViewport.getComponent(UITransform)!.contentSize; const originalWidth = this.clipBeats(clip, found.block) * this.mixerBeatWidth; this.mixerAnimateFrom.set(clone.id, new Vec3(-size.width / 2 + this.mixerTimelineContentInset() + found.block.startBeat * this.mixerBeatWidth - this.mixerScrollX + originalWidth / 2, size.height / 2 - 34 - found.trackIndex * this.mixerRowHeight - this.mixerRowHeight / 2 + this.mixerScrollY, 0)); this.mixerSelectedBlockId = clone.id; this.saveMixerTracks(); this.queueMixerRedraw();
    }
    private alignMixerBlockLeft(blockId: string) { if (this.mixerMultiSelectMode && this.mixerMultiSelectedBlockIds.has(blockId)) { this.alignMixerMultiSelectedBlocks(); return; } const found = this.findMixerBlock(blockId); if (!found) return; const from = this.mixerTimeline?.getChildByName(`MixerBlock${blockId}`)?.position.clone(); let best = 0; for (const track of this.mixerTracks) for (const other of track.blocks) { if (other.id === blockId) continue; const clip = this.recordedClips.find(item => item.id === other.clipId); if (!clip) continue; const end = other.startBeat + this.clipBeats(clip, other); if (end < found.block.startBeat && end > best) best = end; } this.moveMixerBlock(blockId, found.trackIndex, best, from); }
    private deleteMixerBlock(blockId: string) { if (this.mixerMultiSelectMode && this.mixerMultiSelectedBlockIds.has(blockId)) { this.deleteMixerMultiSelectedBlocks(); return; } const found = this.findMixerBlock(blockId); if (!found) return; this.pushMixerUndo(); found.track.blocks = found.track.blocks.filter(item => item.id !== blockId); this.mixerSelectedBlockId = ''; if (this.mixerConnectionBlockId === blockId) this.mixerConnectionBlockId = ''; this.saveMixerTracks(); this.redrawMixerTimeline(); }
    private openMixerSourceColorPalette(clip: AudioClipMeta) {
        if (!this.audioPanel) return;
        this.mixerColorPalette?.destroy();
        const names = ['黑', '白', '红', '橙', '粉', '黄', '蓝', '绿', '青', '棕'];
        const colors = ['black', 'white', 'red', 'orange', 'pink', 'yellow', 'blue', 'green', 'cyan', 'brown'];
        const palette = new Node('MixerSourceColorPalette'); palette.layer = Layers.Enum.UI_2D; const width = 500, height = 92;
        palette.addComponent(UITransform).setContentSize(width, height); const bg = palette.addComponent(Graphics); bg.roundRect(-width / 2, -height / 2, width, height, 8); bg.fillColor = new Color(7, 10, 17, 248); bg.fill(); bg.lineWidth = 1.5; bg.strokeColor = new Color(150, 165, 190, 240); bg.stroke();
        colors.forEach((name, index) => {
            const button = new Node(`SourceColor-${name}`); button.layer = Layers.Enum.UI_2D; button.addComponent(UITransform).setContentSize(34, 34); button.setPosition(-width / 2 + 34 + index * 40, 6);
            const buttonG = button.addComponent(Graphics); buttonG.circle(0, 0, 15); buttonG.fillColor = this.mixerColor(name); buttonG.fill(); buttonG.lineWidth = 2; buttonG.strokeColor = name === (clip.color ?? 'white') ? new Color(255, 255, 255, 255) : new Color(110, 125, 150, 255); buttonG.stroke();
            const buttonLabel = this.makeLabel('ColorName', names[index], 13, 18, name === 'black' ? new Color(235, 240, 248, 255) : new Color(18, 22, 30, 255), 34, 18); buttonLabel.setPosition(0, -28); button.addChild(buttonLabel);
            button.addComponent(Button).transition = Button.Transition.SCALE; button.on(Button.EventType.CLICK, () => { clip.color = name; for (const track of this.mixerTracks) for (const block of track.blocks) if (block.clipId === clip.id) block.color = name; this.saveAudioClips(); this.saveMixerTracks(); palette.destroy(); this.mixerColorPalette = null; this.rebuildAudioRows(); this.redrawMixerTimeline(); }, this); palette.addChild(button);
        });
        const close = this.makePanelButton(palette, '×', width / 2 - 24, height / 2 - 22, 34, 30, () => { palette.destroy(); this.mixerColorPalette = null; }, new Color(80, 38, 48, 255)); close.name = 'PaletteClose';
        this.audioPanel.addChild(palette); this.mixerColorPalette = palette;
    }

    private openMixerColorPalette(blockId: string) {
        const found = this.findMixerBlock(blockId);
        if (!found || !this.audioPanel) return;
        this.mixerColorPalette?.destroy();
        const names = ['黑', '白', '红', '橙', '粉', '黄', '蓝', '绿', '青', '棕'];
        const colors = ['black', 'white', 'red', 'orange', 'pink', 'yellow', 'blue', 'green', 'cyan', 'brown'];
        const palette = new Node('MixerColorPalette'); palette.layer = Layers.Enum.UI_2D;
        const width = 500, height = 92;
        palette.addComponent(UITransform).setContentSize(width, height);
        const bg = palette.addComponent(Graphics); bg.roundRect(-width / 2, -height / 2, width, height, 8); bg.fillColor = new Color(7, 10, 17, 248); bg.fill(); bg.lineWidth = 1.5; bg.strokeColor = new Color(150, 165, 190, 240); bg.stroke();
        palette.setPosition(0, 0);
        colors.forEach((name, index) => {
            const button = new Node(`Color-${name}`); button.layer = Layers.Enum.UI_2D; button.addComponent(UITransform).setContentSize(34, 34); button.setPosition(-width / 2 + 34 + index * 40, 6);
            const buttonG = button.addComponent(Graphics); buttonG.circle(0, 0, 15); buttonG.fillColor = this.mixerColor(name); buttonG.fill(); buttonG.lineWidth = 2; buttonG.strokeColor = name === found.block.color ? new Color(255, 255, 255, 255) : new Color(110, 125, 150, 255); buttonG.stroke();
            const buttonLabel = this.makeLabel('ColorName', names[index], 13, 18, name === 'black' ? new Color(235, 240, 248, 255) : new Color(18, 22, 30, 255), 34, 18); buttonLabel.setPosition(0, -28); button.addChild(buttonLabel);
            const click = button.addComponent(Button); click.transition = Button.Transition.SCALE; button.on(Button.EventType.CLICK, () => {
                const ids = this.mixerMultiOperationIds(blockId); for (const id of ids) { const target = this.findMixerBlock(id); if (target) target.block.color = name; }
                this.saveMixerTracks(); this.mixerColorPalette?.destroy(); this.mixerColorPalette = null; this.mixerTimelineVisualDirty = true; this.redrawMixerTimeline();
            }, this); palette.addChild(button);
        });
        const close = this.makePanelButton(palette, '×', width / 2 - 24, height / 2 - 22, 34, 30, () => { palette.destroy(); this.mixerColorPalette = null; }, new Color(80, 38, 48, 255)); close.name = 'PaletteClose';
        this.audioPanel.addChild(palette); this.mixerColorPalette = palette;
    }

    private createMixerPlayhead(parent: Node, width: number, height: number, ruler: Node) {
        const existing = parent.getChildByName('MixerPlayhead');
        if (existing) {
            existing.active = !this.mixerMultiSelectMode;
            existing.getComponent(UITransform)?.setContentSize(30, height);
            this.paintMixerPlayheadLine(existing, height);
            let stamp = existing.getChildByName('MixerPlayheadStamp') ?? ruler.getChildByName('MixerPlayheadStamp');
            if (!stamp) {
                const retainedRuler = this.mixerRetainedTimelineNodes.find(node => node.name === 'TimelineRuler');
                stamp = retainedRuler?.getChildByName('MixerPlayheadStamp');
            }
            if (!stamp) { stamp = new Node('MixerPlayheadStamp'); stamp.layer = Layers.Enum.UI_2D; stamp.addComponent(UITransform).setContentSize(30, 34); stamp.addComponent(Graphics); }
            stamp.removeFromParent(); existing.addChild(stamp); stamp.setPosition(0, 0, 0); stamp.active = true;
            const stampG = stamp.getComponent(Graphics)!; stampG.clear(); stampG.fillColor = new Color(255, 255, 255, 255); stampG.moveTo(-7, 16); stampG.lineTo(7, 16); stampG.lineTo(0, 5); stampG.close(); stampG.fill();
            stamp.setSiblingIndex(existing.children.length - 1);
            // The playhead and marker must render after the black ruler strip.
            existing.setSiblingIndex(parent.children.length - 1);
            return;
        }
        const node = new Node('MixerPlayhead'); node.layer = Layers.Enum.UI_2D;
        node.active = !this.mixerMultiSelectMode;
        node.addComponent(UITransform).setContentSize(30, height); node.addComponent(Graphics); this.paintMixerPlayheadLine(node, height);
        const setFromTouch = (event: EventTouch) => {
            const p = event.getUILocation();
            const viewportTransform = this.mixerViewport?.getComponent(UITransform);
            const local = viewportTransform?.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0));
            if (local) this.setMixerPlayheadFromLocalX(local.x - this.mixerPlayheadTouchOffsetX, viewportTransform?.contentSize.width ?? width);
            event.propagationStopped = true;
        };
        node.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
            if (this.mixerPlaying) this.stopMixerTimelinePlayback(true);
            const p = event.getUILocation();
            const viewportTransform = this.mixerViewport?.getComponent(UITransform);
            const touchLocal = viewportTransform?.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0));
            const playheadTransform = node.getComponent(UITransform);
            const playheadWorld = playheadTransform?.convertToWorldSpaceAR(Vec3.ZERO);
            const playheadLocal = playheadWorld && viewportTransform?.convertToNodeSpaceAR(playheadWorld);
            this.mixerPlayheadTouchOffsetX = touchLocal && playheadLocal ? touchLocal.x - playheadLocal.x : 0;
            this.mixerDraggingPlayhead = true;
            setFromTouch(event);
        }, this);
        node.on(Node.EventType.TOUCH_MOVE, setFromTouch, this);
        const finish = (event: EventTouch) => { setFromTouch(event); this.mixerDraggingPlayhead = false; this.mixerPlayheadTouchOffsetX = 0; };
        node.on(Node.EventType.TOUCH_END, finish, this); node.on(Node.EventType.TOUCH_CANCEL, finish, this);
        const stamp = new Node('MixerPlayheadStamp'); stamp.layer = Layers.Enum.UI_2D; stamp.addComponent(UITransform).setContentSize(30, 34); const stampG = stamp.addComponent(Graphics);
        stampG.fillColor = new Color(255, 255, 255, 255); stampG.moveTo(-7, 16); stampG.lineTo(7, 16); stampG.lineTo(0, 5); stampG.close(); stampG.fill(); node.addChild(stamp);
        stamp.setPosition(0, 0, 0);
        parent.addChild(node);
        // Keep the line and marker above the ruler black strip. Track heads and
        // audio blocks are inserted before the ruler, so they remain underneath it.
        node.setSiblingIndex(parent.children.length - 1);
    }

    private paintMixerPlayheadLine(playhead: Node, height: number) {
        const graphics = playhead.getComponent(Graphics) ?? playhead.addComponent(Graphics);
        graphics.clear(); graphics.lineWidth = 2; graphics.strokeColor = new Color(255, 255, 255, 255);
        graphics.moveTo(0, -height / 2); graphics.lineTo(0, height / 2); graphics.stroke();
    }

    private setMixerPlayheadFromLocalX(localX: number, width: number, animate = false) {
        // A pane transition owns the playhead transform. Ignore any touch-end that
        // arrives from the collapse button or the old viewport during that frame.
        if (this.mixerSourcePaneAnimating) return;
        const playhead = this.mixerTimeline?.getChildByName('MixerPlayhead'), stamp = playhead?.getChildByName('MixerPlayheadStamp'); const from = playhead?.position.clone();
        const contentInset = this.mixerTimelineContentInset();
        this.mixerPlayheadBeat = Math.max(0, (localX + width / 2 - contentInset + this.mixerScrollX) / this.mixerBeatWidth);
        if (this.mixerFollowPlayhead) this.mixerFollowPlayheadX = localX;
        const targetX = this.mixerPlayheadTimelineX(width);
        if (playhead && animate && from) {
            Tween.stopAllByTarget(playhead); playhead.setPosition(from); tween(playhead).to(.3, { position: new Vec3(targetX, 0, 0) }, { easing: 'quadOut' }).start();
            if (stamp) {
                // The marker is a child of the playhead, so only its vertical
                // anchor needs to be refreshed; tweening it to Vec3.ZERO makes
                // the inverted triangle visibly fall during the horizontal move.
                const stampY = (this.mixerViewport?.getComponent(UITransform)?.contentSize.height ?? width) / 2 - 17 - (this.mixerTimeline?.position.y ?? 0);
                Tween.stopAllByTarget(stamp); stamp.setPosition(0, stampY, 0);
            }
        }
        else this.updateMixerPlayheadVisual();
    }

    private mixerPlayheadViewportX(width: number) {
        // During a pane transition the viewport width is tweened, but the grid
        // geometry remains based on the transition's rendered width. Use that
        // same width for the playhead so it cannot drift or leave the mask while
        // the parent timeline is moving.
        const renderedWidth = this.mixerSourcePaneAnimating && this.mixerTimelineCacheReady
            ? this.mixerTimelineCacheViewportWidth : width;
        // During gesture/inertia preview the timeline parent carries the delta
        // from renderedScrollX to mixerScrollX. Keep the playhead in the same
        // rendered coordinate as the grid so that delta is applied exactly once.
        const previewing = Math.abs(this.mixerScrollX - this.mixerRenderedScrollX) > .001
            || Math.abs(this.mixerScrollY - this.mixerRenderedScrollY) > .001;
        const visualScrollX = previewing ? this.mixerRenderedScrollX : this.mixerScrollX;
        return -renderedWidth / 2 + this.mixerTimelineContentInset() + this.mixerPlayheadBeat * this.mixerBeatWidth - visualScrollX;
    }

    private mixerPlayheadTimelineX(width: number) {
        // Playhead and grid are both children of the animated timeline. Keep the
        // playhead in the same canonical local coordinate as the grid instead of
        // subtracting the timeline's temporary transition/inertia transform. The
        // parent movement must carry both visuals together.
        return this.mixerPlayheadViewportX(width);
    }

    private mixerPlayheadPanelX(width: number) {
        return this.mixerPlayheadTimelineX(width);
    }

    private updateMixerPlayheadVisual() {
        const viewport = this.mixerViewport, timeline = this.mixerTimeline, playhead = timeline?.getChildByName('MixerPlayhead'), stamp = playhead?.getChildByName('MixerPlayheadStamp');
        if (!viewport || !playhead) return;
        playhead.active = !this.mixerMultiSelectMode; if (this.mixerMultiSelectMode) return;
        Tween.stopAllByTarget(playhead); if (stamp) Tween.stopAllByTarget(stamp);
        const viewportSize = viewport.getComponent(UITransform)!.contentSize;
        const width = viewportSize.width;
        const x = this.mixerPlayheadTimelineX(width), inverseScale = 1 / Math.max(.001, timeline?.scale.x ?? 1);
        playhead.setPosition(x, 0, 0); playhead.setScale(inverseScale, 1, 1);
        if (stamp) {
            stamp.setPosition(0, viewportSize.height / 2 - 18 - (timeline?.position.y ?? 0), 0);
            stamp.setScale(inverseScale, 1, 1);
        }
    }

    private previewMixerGestureTransform(viewportWidth: number) {
        if (!this.mixerTimeline) return;
        const scaleX = this.mixerBeatWidth / Math.max(1, this.mixerRenderedBeatWidth);
        const contentInset = this.mixerTimelineContentInset();
        const oldOrigin = -viewportWidth / 2 + contentInset - this.mixerRenderedScrollX;
        const newOrigin = -viewportWidth / 2 + contentInset - this.mixerScrollX;
        const offsetX = newOrigin - oldOrigin * scaleX;
        const offsetY = this.mixerScrollY - this.mixerRenderedScrollY;
        this.mixerTimeline.setScale(scaleX, 1, 1);
        this.mixerTimeline.setPosition(offsetX, offsetY, 0);
        for (const child of this.mixerTimeline.children) {
            if (child.name.startsWith('TrackHead')) { child.setScale(1 / scaleX, 1, 1); child.setPosition((-viewportWidth / 2 + MIXER_TRACK_HEAD_WIDTH / 2 + 2 - offsetX) / scaleX, child.position.y, 0); }
        }
        const ruler = this.mixerTimeline.getChildByName('TimelineRuler');
        const grid = this.mixerTimeline.getChildByName('TimelineGrid');
        const rulerLabels = this.mixerTimeline.getChildByName('TimelineRulerLabels');
        const viewportHeight = this.mixerTimelineViewportHeight || this.mixerViewport?.getComponent(UITransform)?.contentSize.height || 0;
        if (ruler) ruler.setPosition(0, viewportHeight / 2 - 17 - offsetY, 0);
        if (rulerLabels) rulerLabels.setPosition(grid?.position.x ?? 0, viewportHeight / 2 - 17 - offsetY, 0);
        if (this.mixerPlaying && this.mixerFollowPlayhead && this.mixerViewportInteractionActive()) this.captureMixerFollowPlayheadPosition();
        this.updateMixerPlayheadVisual();
        this.updateMixerConnections();
    }

    private mixerViewportInteractionActive() {
        return this.mixerGestureTouches.size > 0 || this.mixerInertiaFrame !== null;
    }

    private stopMixerInertia(redraw = false, deferRedraw = false) {
        const needsRedraw = this.mixerInertiaFrame !== null || !!this.mixerTimeline && (Math.abs(this.mixerTimeline.position.x) > .01 || Math.abs(this.mixerTimeline.position.y) > .01 || Math.abs(this.mixerTimeline.scale.x - 1) > .001);
        const generation = ++this.mixerInertiaGeneration;
        if (this.mixerInertiaFrame !== null) cancelAnimationFrame(this.mixerInertiaFrame);
        this.mixerInertiaFrame = null; this.mixerPanVelocity.set(0, 0, 0);
        if (redraw && needsRedraw && this.mixerTimeline) {
            if (deferRedraw) this.deferMixerGestureRedraw(generation);
            else this.redrawMixerTimeline();
        }
    }

    private stopMixerTimelineReturnAnimation() {
        this.mixerReturnGeneration++;
        if (this.mixerReturnFrame !== null) cancelAnimationFrame(this.mixerReturnFrame);
        this.mixerReturnFrame = null;
    }

    private returnMixerTimelineToStart() {
        const viewport = this.mixerViewport;
        if (!viewport || !this.mixerTimeline || !this.audioPanelOpen) return;
        this.stopMixerInertia(false);
        this.stopMixerTimelineReturnAnimation();
        const from = this.mixerScrollX;
        const width = viewport.getComponent(UITransform)!.contentSize.width;
        if (from <= .01) { this.mixerScrollX = 0; this.previewMixerGestureTransform(width); return; }
        if (this.mixerFollowPlayhead) { this.mixerFollowPlayhead = false; this.redrawMixerTransportButtons(); }
        const generation = ++this.mixerReturnGeneration;
        const started = performance.now();
        const durationMs = Math.min(900, 380 + from / Math.max(1, width) * 90);
        const advance = (now: number) => {
            if (generation !== this.mixerReturnGeneration || !this.audioPanelOpen) return;
            const progress = Math.max(0, Math.min(1, (now - started) / durationMs));
            const eased = 1 - Math.pow(1 - progress, 3);
            this.mixerScrollX = progress >= 1 ? 0 : from * (1 - eased);
            this.previewMixerGestureTransform(width);
            if (Math.abs(this.mixerScrollX - this.mixerRenderedScrollX) > width * .4) this.redrawMixerTimeline();
            if (progress < 1) this.mixerReturnFrame = requestAnimationFrame(advance);
            else this.mixerReturnFrame = null;
        };
        this.mixerReturnFrame = requestAnimationFrame(advance);
    }

    private startMixerInertia(viewport: Node) {
        const releaseDelay = Math.max(0, Date.now() - this.mixerGestureLastAt);
        const releaseDecay = Math.pow(.8, releaseDelay / 16);
        this.mixerPanVelocity.x = Math.max(-1.3, Math.min(1.3, this.mixerPanVelocity.x * releaseDecay));
        this.mixerPanVelocity.y = Math.max(-1.1, Math.min(1.1, this.mixerPanVelocity.y * releaseDecay));
        const size = viewport.getComponent(UITransform)!.contentSize;
        const outsidePreloadWindow = () => Math.abs(this.mixerScrollX - this.mixerRenderedScrollX) > size.width * .4
            || Math.abs(this.mixerScrollY - this.mixerRenderedScrollY) > this.mixerRowHeight * 1.5;
        const speed = Math.abs(this.mixerPanVelocity.x) + Math.abs(this.mixerPanVelocity.y);
        if (speed < .08) { this.stopMixerInertia(outsidePreloadWindow(), true); return; }
        const generation = ++this.mixerInertiaGeneration;
        let lastAt = 0;
        const tick = (now: number) => {
            if (this.mixerInertiaFrame === null || generation !== this.mixerInertiaGeneration) return;
            this.mixerInertiaFrame = null;
            const dt = lastAt > 0 ? Math.max(1, Math.min(34, now - lastAt)) : 16; lastAt = now;
            const maxY = Math.max(0, this.mixerTracks.length * this.mixerRowHeight - size.height + 38);
            const nextX = Math.max(0, this.mixerScrollX + this.mixerPanVelocity.x * dt), nextY = Math.max(0, Math.min(maxY, this.mixerScrollY + this.mixerPanVelocity.y * dt));
            if (nextX === 0 && this.mixerPanVelocity.x < 0) this.mixerPanVelocity.x = 0;
            if ((nextY === 0 && this.mixerPanVelocity.y < 0) || (nextY === maxY && this.mixerPanVelocity.y > 0)) this.mixerPanVelocity.y = 0;
            this.mixerScrollX = nextX; this.mixerScrollY = nextY; this.previewMixerGestureTransform(size.width);
            if (outsidePreloadWindow()) {
                this.mixerTimeline?.setPosition(0, 0, 0); this.mixerTimeline?.setScale(Vec3.ONE); this.redrawMixerTimeline(); this.mixerGestureStartScrollX = this.mixerScrollX; this.mixerGestureStartScrollY = this.mixerScrollY; this.mixerGestureVisualBasePosition.set(0, 0, 0); this.mixerGestureVisualBaseScaleX = 1;
            }
            const friction = Math.pow(.8, dt / 16); this.mixerPanVelocity.x *= friction; this.mixerPanVelocity.y *= friction;
            if (Math.abs(this.mixerPanVelocity.x) + Math.abs(this.mixerPanVelocity.y) < .025) { this.stopMixerInertia(false); return; }
            this.mixerInertiaFrame = requestAnimationFrame(tick);
        };
        this.mixerInertiaFrame = requestAnimationFrame(tick);
    }

    private attachMixerViewportGestures(viewport: Node) {
        viewport.on(Node.EventType.TOUCH_START, e => {
            this.stopMixerTimelineReturnAnimation();
            this.stopMixerInertia(false);
            let target = e.target as Node | null;
            while (target && target !== viewport) {
                if (target.name.startsWith('MixerBlock') || (!this.mixerMultiSelectMode && target.name.startsWith('TrackHead'))) return;
                target = target.parent;
            }
            if (this.mixerMultiSelectMode) {
                const local = this.mixerMultiViewportPoint(e); if (!local) return;
                this.mixerMultiBoxTouchId = e.getID(); this.mixerMultiBoxStart = local.clone(); this.mixerMultiBoxCurrent = null;
                e.propagationStopped = true; return;
            }
            const activeTouches = (e as any).getAllTouches?.() as any[] | undefined; if (!activeTouches || activeTouches.length <= 1) this.mixerGestureTouches.clear();
            const p = e.getUILocation(); this.mixerGestureTouches.set(e.getID(), new Vec3(p.x, p.y, 0));
            if (this.mixerGestureTouches.size === 1) {
                this.mixerGestureVisualBasePosition.set(this.mixerTimeline?.position ?? Vec3.ZERO); this.mixerGestureVisualBaseScaleX = this.mixerTimeline?.scale.x ?? 1;
                this.mixerGestureStartPoint.set(p.x, p.y, 0); this.mixerGestureLastPoint.set(p.x, p.y, 0); this.mixerGestureLastAt = Date.now(); this.mixerPanVelocity.set(0, 0, 0); this.mixerGestureStartScrollX = this.mixerScrollX; this.mixerGestureStartScrollY = this.mixerScrollY; this.mixerGestureStartBeatWidth = this.mixerBeatWidth; this.mixerGestureMoved = false;
            } else if (this.mixerGestureTouches.size === 2) {
                const points = Array.from(this.mixerGestureTouches.values()); const midpoint = new Vec3((points[0].x + points[1].x) / 2, (points[0].y + points[1].y) / 2, 0); const local = viewport.getComponent(UITransform)!.convertToNodeSpaceAR(midpoint); const width = viewport.getComponent(UITransform)!.contentSize.width;
                this.mixerGestureVisualBasePosition.set(this.mixerTimeline?.position ?? Vec3.ZERO); this.mixerGestureVisualBaseScaleX = this.mixerTimeline?.scale.x ?? 1; this.mixerPanVelocity.set(0, 0, 0); this.mixerGestureStartScrollX = this.mixerScrollX; this.mixerGestureStartScrollY = this.mixerScrollY; this.mixerGestureStartBeatWidth = this.mixerBeatWidth; this.mixerLastPinchDistance = Math.max(8, Math.abs(points[1].x - points[0].x)); this.mixerPinchAnchorBeat = Math.max(0, (local.x + width / 2 - this.mixerTimelineContentInset() + this.mixerScrollX) / this.mixerBeatWidth); this.mixerGestureMoved = true;
            }
            e.propagationStopped = true;
        }, this);
        viewport.on(Node.EventType.TOUCH_MOVE, e => {
            if (this.mixerMultiSelectMode) {
                if (e.getID() !== this.mixerMultiBoxTouchId) return;
                const local = this.mixerMultiViewportPoint(e), start = this.mixerMultiBoxStart;
                if (local && start && (this.mixerMultiBoxCurrent || Math.hypot(local.x - start.x, local.y - start.y) >= 18)) { this.mixerMultiBoxCurrent = local; this.paintMixerMultiSelectOverlay(); }
                e.propagationStopped = true; return;
            }
            if (!this.mixerGestureTouches.has(e.getID())) return;
            const p = e.getUILocation(); this.mixerGestureTouches.set(e.getID(), new Vec3(p.x, p.y, 0)); const points = Array.from(this.mixerGestureTouches.values());
            if (points.length >= 2) {
                const distance = Math.max(8, Math.abs(points[1].x - points[0].x)); const midpoint = new Vec3((points[0].x + points[1].x) / 2, (points[0].y + points[1].y) / 2, 0); const local = viewport.getComponent(UITransform)!.convertToNodeSpaceAR(midpoint); const width = viewport.getComponent(UITransform)!.contentSize.width;
                this.mixerBeatWidth = Math.max(20, Math.min(260, this.mixerGestureStartBeatWidth * distance / Math.max(8, this.mixerLastPinchDistance)));
                this.mixerScrollX = Math.max(0, this.mixerPinchAnchorBeat * this.mixerBeatWidth - (local.x + width / 2 - this.mixerTimelineContentInset())); this.mixerPanVelocity.set(0, 0, 0);
            } else {
                const dx = p.x - this.mixerGestureStartPoint.x, dy = p.y - this.mixerGestureStartPoint.y;
                if (this.mixerPlaying && this.mixerFollowPlayhead && Math.abs(dx) > 3) {
                    this.mixerFollowPlayhead = false;
                    this.redrawMixerTransportButtons();
                }
                if (!this.mixerPlaying || !this.mixerFollowPlayhead) this.mixerScrollX = Math.max(0, this.mixerGestureStartScrollX - dx);
                const maxY = Math.max(0, this.mixerTracks.length * this.mixerRowHeight - viewport.getComponent(UITransform)!.contentSize.height + 38); this.mixerScrollY = Math.max(0, Math.min(maxY, this.mixerGestureStartScrollY + dy));
                if (Math.abs(dx) + Math.abs(dy) > 3) this.mixerGestureMoved = true;
                const now = Date.now(), dt = Math.max(1, now - this.mixerGestureLastAt), vx = this.mixerPlaying && this.mixerFollowPlayhead ? 0 : -(p.x - this.mixerGestureLastPoint.x) / dt, vy = (p.y - this.mixerGestureLastPoint.y) / dt; this.mixerPanVelocity.x = this.mixerPanVelocity.x * .55 + vx * .45; this.mixerPanVelocity.y = this.mixerPanVelocity.y * .55 + vy * .45; this.mixerGestureLastPoint.set(p.x, p.y, 0); this.mixerGestureLastAt = now;
            }
            this.previewMixerGestureTransform(viewport.getComponent(UITransform)!.contentSize.width); e.propagationStopped = true;
        }, this);
        const end = (e: EventTouch) => {
            if (this.mixerMultiSelectMode) {
                if (e.getID() !== this.mixerMultiBoxTouchId) return;
                const local = this.mixerMultiViewportPoint(e); if (local && this.mixerMultiBoxCurrent) this.mixerMultiBoxCurrent = local;
                this.finishMixerMultiBoxSelection(); e.propagationStopped = true; return;
            }
            if (!this.mixerGestureTouches.has(e.getID())) return;
            const gestureChanged = this.mixerGestureMoved, wasPinch = this.mixerGestureTouches.size > 1 || this.mixerLastPinchDistance > 0;
            const wasTap = !gestureChanged && this.mixerGestureTouches.size === 1; this.mixerGestureTouches.delete(e.getID());
            if (this.mixerGestureTouches.size === 0) { if (gestureChanged && !wasPinch) this.startMixerInertia(viewport); else if (gestureChanged) this.stopMixerInertia(true, true); }
            else if (this.mixerGestureTouches.size === 1) { this.mixerGestureVisualBasePosition.set(this.mixerTimeline?.position ?? Vec3.ZERO); this.mixerGestureVisualBaseScaleX = this.mixerTimeline?.scale.x ?? 1; const remaining = Array.from(this.mixerGestureTouches.values())[0]; this.mixerGestureStartPoint.set(remaining); this.mixerGestureLastPoint.set(remaining); this.mixerGestureLastAt = Date.now(); this.mixerPanVelocity.set(0, 0, 0); this.mixerGestureStartScrollX = this.mixerScrollX; this.mixerGestureStartScrollY = this.mixerScrollY; this.mixerGestureStartBeatWidth = this.mixerBeatWidth; }
            this.mixerLastPinchDistance = 0; if (wasTap && e.target === viewport) this.deselectMixerBlockImmediately(); e.propagationStopped = true;
        };
        viewport.on(Node.EventType.TOUCH_END, end, this); viewport.on(Node.EventType.TOUCH_CANCEL, end, this);
    }

    private redrawMixerTransportButton(name: string, active: boolean) {
        const button = this.audioPanel?.getChildByName(name); if (!button) return;
        const style = (button as any).__panelButtonStyle as { fillColor?: Color } | undefined;
        if (style) style.fillColor = active ? new Color(245, 248, 255, 255) : new Color(8, 10, 15, 255);
        const label = button.getChildByName('Text')?.getComponent(Label); if (label) label.color = active ? new Color(0, 0, 0, 255) : new Color(245, 248, 255, 255);
        this.redrawPanelButton(button);
    }

    private redrawMixerTransportButtons() {
        this.redrawMixerTransportButton('AudioTimelineFollow', this.mixerFollowPlayhead);
        this.redrawMixerTransportButton('AudioTimelinePlay', this.mixerPlaying);
        this.redrawMixerTransportButton('AudioTimelineStop', false);
    }

    private captureMixerFollowPlayheadPosition() {
        const viewport = this.mixerViewport; if (!viewport) return;
        const width = viewport.getComponent(UITransform)!.contentSize.width, current = this.mixerPlayheadViewportX(width);
        const minX = -width / 2 + this.mixerTimelineContentInset(), maxX = width / 2 - 24;
        this.mixerFollowPlayheadX = current < -width / 2 || current > width / 2 ? 0 : Math.max(minX, Math.min(maxX, current));
    }

    private updateMixerFollowPosition() {
        if (!this.mixerFollowPlayhead || !this.mixerViewport) { this.updateMixerPlayheadVisual(); return; }
        const width = this.mixerViewport.getComponent(UITransform)!.contentSize.width;
        if (this.mixerViewportInteractionActive()) {
            this.captureMixerFollowPlayheadPosition();
            this.updateMixerPlayheadVisual();
            return;
        }
        this.mixerScrollX = Math.max(0, -width / 2 + this.mixerTimelineContentInset() + this.mixerPlayheadBeat * this.mixerBeatWidth - this.mixerFollowPlayheadX);
        this.previewMixerGestureTransform(width);
        if (Math.abs(this.mixerScrollX - this.mixerRenderedScrollX) > width * .42) this.redrawMixerTimeline();
    }

    private toggleMixerPlayheadFollow() {
        this.mixerFollowPlayhead = !this.mixerFollowPlayhead;
        if (this.mixerFollowPlayhead) { this.captureMixerFollowPlayheadPosition(); this.updateMixerFollowPosition(); }
        this.redrawMixerTransportButtons();
    }

    private toggleMixerTimelinePlayback() {
        if (this.mixerPlaying) { NativeBridge.stopAudioFiles(); this.mixerPlaying = false; if (this.mixerPlayTimer !== null) cancelAnimationFrame(this.mixerPlayTimer); this.mixerPlayTimer = null; this.mixerPlayheadBeat = this.mixerPlaybackAnchorBeat; this.updateMixerFollowPosition(); this.redrawMixerTransportButtons(); return; }
        const allBlocks = this.timelineBlocks(true);
        this.mixerPlaybackAnchorBeat = this.mixerPlayheadBeat;
        if (this.mixerFollowPlayhead) this.captureMixerFollowPlayheadPosition();
        const blocks = this.mixerTimelineBlocksFrom(this.mixerPlaybackAnchorBeat, allBlocks);
        this.mixerPlaybackEndBeat = this.mixerTimelineEndBeat(allBlocks);
        if (blocks.length) NativeBridge.playTimeline(blocks, this.metronomeBpm);
        else NativeBridge.stopAudioFiles();
        this.mixerPlaying = true; this.redrawMixerTransportButtons(); const started = performance.now();
        const advance = (now: number) => {
            if (!this.mixerPlaying) return;
            this.mixerPlayheadBeat = this.mixerPlaybackAnchorBeat + (now - started) / 60000 * this.metronomeBpm;
            this.updateMixerFollowPosition();
            this.mixerPlayTimer = requestAnimationFrame(advance);
        };
        this.mixerPlayTimer = requestAnimationFrame(advance);
    }

    private mixerTimelineBlocksFrom(anchorBeat: number, allBlocks = this.timelineBlocks(true)) {
        const blocks: typeof allBlocks = [];
        for (const block of allBlocks) {
            const seconds = Math.max(.05, (block.trimEnd > block.trimStart ? block.trimEnd : block.duration) - block.trimStart);
            const endBeat = block.startBeat + seconds * this.metronomeBpm / 60 / block.speed;
            if (endBeat <= anchorBeat) continue;
            if (block.startBeat >= anchorBeat) { blocks.push({ ...block, startBeat: block.startBeat - anchorBeat }); continue; }
            const elapsedSourceSeconds = (anchorBeat - block.startBeat) * 60 / this.metronomeBpm * block.speed;
            blocks.push({ ...block, startBeat: 0, trimStart: Math.min(block.trimEnd || block.duration, block.trimStart + elapsedSourceSeconds) });
        }
        return blocks;
    }

    private mixerTimelineEndBeat(blocks = this.timelineBlocks(true)) {
        return blocks.reduce((end, block) => {
            const seconds = Math.max(.05, (block.trimEnd > block.trimStart ? block.trimEnd : block.duration) - block.trimStart);
            return Math.max(end, block.startBeat + seconds * this.metronomeBpm / 60 / block.speed);
        }, 0);
    }

    private refreshMixerTimelineAudio() {
        if (!this.mixerPlaying) return;
        const solo = this.mixerTracks.some(track => track.solo);
        const audibility: Record<string, boolean> = {};
        for (const track of this.mixerTracks) audibility[track.id] = !track.muted && (!solo || track.solo);
        NativeBridge.setTimelineTrackAudibility(audibility);
    }

    private stopMixerTimelinePlayback(keepPosition = true) { NativeBridge.stopAudioFiles(); this.mixerPlaying = false; if (this.mixerPlayTimer !== null) cancelAnimationFrame(this.mixerPlayTimer); this.mixerPlayTimer = null; if (!keepPosition) this.mixerPlayheadBeat = 0; this.updateMixerFollowPosition(); this.redrawMixerTransportButtons(); }

    private openMixerBlockEditor(blockId: string) {
        const initialFound = this.findMixerBlock(blockId); if (!initialFound || !this.audioPanel) return; const initialClip = this.recordedClips.find(item => item.id === initialFound.block.clipId); if (!initialClip) return;
        this.mixerEditor?.destroy(); this.mixerEditorUndo = []; this.mixerEditorCropping = false; this.mixerEditorCropStart = -1; this.mixerEditorCropEnd = -1; this.mixerEditorInitial = this.captureMixerEditorSnapshot();
        const currentBlock = () => this.findMixerBlock(blockId)?.block ?? null;
        const currentClip = () => { const block = currentBlock(); return block ? this.recordedClips.find(item => item.id === block.clipId) ?? null : null; };
        const panel = new Node('MixerBlockEditor'); panel.layer = Layers.Enum.UI_2D; const view = this.userViewport(false); panel.addComponent(UITransform).setContentSize(view.w * .78, view.h * .82); panel.setPosition(view.w * .03, 0); const pg = panel.addComponent(Graphics); const pw = view.w * .78, ph = view.h * .82; pg.rect(-pw / 2, -ph / 2, pw, ph); pg.fillColor = new Color(5, 7, 12, 252); pg.fill(); pg.lineWidth = 2; pg.strokeColor = this.mixerColor(initialFound.block.color); pg.stroke(); this.audioPanel.addChild(panel); this.mixerEditor = panel;
        const title = this.makeLabel('EditorTitle', initialClip.name, 20, 30, new Color(245, 245, 248, 255), pw * .5, 34); title.setPosition(0, ph / 2 - 28); panel.addChild(title);
        let redraw = () => { /* assigned after graph creation */ };
        let updateSpeedLabel = () => { /* assigned after button creation */ };
        const speed = this.makePanelButton(panel, `${(initialFound.block.speed ?? 1).toFixed(2)}×`, -pw / 2 + 70, ph / 2 - 28, 90, 34, () => { const block = currentBlock(); if (!block) return; NativeBridge.promptText(t('音频块速度', 'Block speed'), String(block.speed ?? 1), value => { const n = Number(value); const live = currentBlock(); if (!live || !Number.isFinite(n)) return; this.pushMixerEditorUndo(); live.speed = Math.max(.25, Math.min(4, n)); this.resolveMixerBlockOverlap(blockId); this.saveMixerTracks(); updateSpeedLabel(); redraw(); }); }, new Color(28, 34, 48, 255));
        updateSpeedLabel = () => { const label = speed.getChildByName('Text')?.getComponent(Label); const block = currentBlock(); if (label && block) label.string = `${(block.speed ?? 1).toFixed(2)}×`; };
        this.makePanelButton(panel, '×', pw / 2 - 28, ph / 2 - 28, 38, 34, () => { if (this.mixerEditorInitial) this.restoreMixerEditorSnapshot(this.mixerEditorInitial); this.mixerEditor?.destroy(); this.mixerEditor = null; this.queueMixerRedraw(); }, new Color(90, 38, 45, 255));
        const graph = new Node('AutomationGraph'); graph.layer = Layers.Enum.UI_2D; const graphW = pw - 60, graphH = ph - 150; const transform = graph.addComponent(UITransform); transform.setContentSize(graphW, graphH); graph.setPosition(0, 8); const gfx = graph.addComponent(Graphics); panel.addChild(graph);
        redraw = () => { const block = currentBlock(), clip = currentClip(); if (block && clip) this.drawAutomationGraph(gfx, graphW, graphH, block, clip, this.mixerEditorCropStart, this.mixerEditorCropEnd); };
        const touches = new Map<number, Vec3>(); let drawing = false; let pinchDistance = 0; let pinchSpeed = 1;
        const graphPoint = (event: EventTouch) => { const p = event.getUILocation(); const local = transform.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0)); return { x: Math.max(0, Math.min(1, (local.x + graphW / 2) / graphW)), y: Math.max(0, Math.min(1, (local.y + graphH / 2) / graphH)) }; };
        const cropGraphPoint = (event: EventTouch, block: MixerBlock) => { const point = graphPoint(event); const clip = currentClip(); if (this.mixerMagnet && clip) point.x = this.snapMixerCropRatio(block, clip, point.x); return point; };
        graph.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
            const p = event.getUILocation(); touches.set(event.getID(), new Vec3(p.x, p.y, 0)); const block = currentBlock(); if (!block) return;
            if (touches.size === 1) { this.pushMixerEditorUndo(); drawing = true; const point = this.mixerEditorCropping ? cropGraphPoint(event, block) : graphPoint(event); if (this.mixerEditorCropping) this.mixerEditorCropStart = this.mixerEditorCropEnd = point.x; else { this.upsertAutomationPoint(block, point.x, this.mixerEditorMode === 'pan' ? point.y * 2 - 1 : point.y); this.syncAutomationSamples(block); } }
            else if (touches.size === 2 && !this.mixerEditorCropping) { const beforeDraw = this.mixerEditorUndo.pop(); if (beforeDraw) this.restoreMixerEditorSnapshot(beforeDraw); this.pushMixerEditorUndo(); const points = Array.from(touches.values()); pinchDistance = Math.max(8, Math.abs(points[1].x - points[0].x)); pinchSpeed = currentBlock()?.speed ?? 1; drawing = false; }
            redraw(); event.propagationStopped = true;
        }, this);
        graph.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => {
            const p = event.getUILocation(); touches.set(event.getID(), new Vec3(p.x, p.y, 0)); const block = currentBlock(); if (!block) return;
            if (touches.size >= 2 && !this.mixerEditorCropping) { const points = Array.from(touches.values()); const distance = Math.max(8, Math.abs(points[1].x - points[0].x)); block.speed = Math.max(.25, Math.min(4, pinchSpeed * pinchDistance / distance)); updateSpeedLabel(); }
            else if (drawing) { const point = this.mixerEditorCropping ? cropGraphPoint(event, block) : graphPoint(event); if (this.mixerEditorCropping) this.mixerEditorCropEnd = point.x; else { this.upsertAutomationPoint(block, point.x, this.mixerEditorMode === 'pan' ? point.y * 2 - 1 : point.y); this.syncAutomationSamples(block); } }
            redraw(); event.propagationStopped = true;
        }, this);
        const finishGraphTouch = (event: EventTouch) => {
            const block = currentBlock();
            const hadMultiple = touches.size >= 2; touches.delete(event.getID());
            let timelineChanged = false;
            if (hadMultiple) { this.resolveMixerBlockOverlap(blockId); updateSpeedLabel(); }
            else if (drawing && this.mixerEditorCropping && block) {
                const point = cropGraphPoint(event, block); this.mixerEditorCropEnd = point.x;
                const a = Math.min(this.mixerEditorCropStart, this.mixerEditorCropEnd), b = Math.max(this.mixerEditorCropStart, this.mixerEditorCropEnd);
                if (b - a > .004) { this.applyMixerCrop(blockId, a, b); timelineChanged = true; }
                else {
                    const clip = currentClip();
                    if (clip && this.isMixerCropGridRatio(block, clip, this.mixerEditorCropStart)) { this.splitMixerBlockAtRatio(blockId, this.mixerEditorCropStart); timelineChanged = true; }
                }
            }
            if (this.mixerEditorCropping) { this.mixerEditorCropping = false; this.mixerEditorCropStart = -1; this.mixerEditorCropEnd = -1; }
            drawing = false; this.saveAudioClips(); this.saveMixerTracks(); if (timelineChanged) this.queueMixerRedraw(); redraw(); event.propagationStopped = true;
        };
        graph.on(Node.EventType.TOUCH_END, finishGraphTouch, this); graph.on(Node.EventType.TOUCH_CANCEL, finishGraphTouch, this);
        const modeY = -ph / 2 + 32; [['音量', 'volume'], ['音高', 'pitch'], ['声相', 'pan']].forEach((item, i) => this.makePanelButton(panel, t(item[0], item[1]), -250 + i * 85, modeY, 75, 34, () => { this.mixerEditorMode = item[1] as any; const block = currentBlock(); if (block) this.automationPoints(block); redraw(); }, new Color(32, 42, 62, 255)));
        this.makePanelButton(panel, t('撤回', 'Undo'), 30, modeY, 70, 34, () => { const state = this.mixerEditorUndo.pop(); if (state) this.restoreMixerEditorSnapshot(state); this.mixerEditorCropping = false; this.mixerEditorCropStart = -1; this.mixerEditorCropEnd = -1; updateSpeedLabel(); redraw(); }, new Color(45, 58, 78, 255));
        this.makePanelButton(panel, t('重置', 'Reset'), 110, modeY, 70, 34, () => { if (!this.mixerEditorInitial) return; this.pushMixerEditorUndo(); this.restoreMixerEditorSnapshot(this.mixerEditorInitial); this.mixerEditorCropping = false; this.mixerEditorCropStart = -1; this.mixerEditorCropEnd = -1; updateSpeedLabel(); redraw(); }, new Color(45, 58, 78, 255));
        this.makePanelButton(panel, t('裁剪', 'Crop'), 190, modeY, 70, 34, () => { this.mixerEditorCropping = true; this.mixerEditorCropStart = -1; this.mixerEditorCropEnd = -1; redraw(); }, new Color(85, 48, 50, 255));
        this.makePanelButton(panel, t('试听', 'Preview'), 270, modeY, 70, 34, () => { const block = currentBlock(); if (block) this.previewMixerBlock(block); }, new Color(38, 72, 110, 255));
        this.makePanelButton(panel, t('保存并关闭', 'Save & Close'), pw / 2 - 100, modeY, 140, 34, () => { this.saveAudioClips(); this.saveMixerTracks(); this.mixerEditor?.destroy(); this.mixerEditor = null; this.queueMixerRedraw(); }, new Color(38, 100, 70, 255)); redraw();
    }

    private captureMixerEditorSnapshot(): MixerEditorSnapshot { return { tracks: JSON.parse(JSON.stringify(this.mixerTracks)), clips: JSON.parse(JSON.stringify(this.recordedClips)) }; }
    private pushMixerEditorUndo() { this.mixerEditorUndo.push(this.captureMixerEditorSnapshot()); if (this.mixerEditorUndo.length > 30) this.mixerEditorUndo.shift(); }
    private restoreMixerEditorSnapshot(snapshot: MixerEditorSnapshot) { this.mixerTracks = JSON.parse(JSON.stringify(snapshot.tracks)); this.ensureMixerTrack(12); this.recordedClips = JSON.parse(JSON.stringify(snapshot.clips)); this.saveAudioClips(); this.saveMixerTracks(); }

    private automationPoints(block: MixerBlock): AutomationPoint[] {
        const fallback = this.mixerEditorMode === 'pan' ? 0 : 1;
        if (this.mixerEditorMode === 'pitch') return block.pitchAutomationPoints ?? (block.pitchAutomationPoints = [{ x: 0, y: block.pitchAutomation?.[0] ?? fallback }, { x: 1, y: block.pitchAutomation?.[block.pitchAutomation.length - 1] ?? fallback }]);
        if (this.mixerEditorMode === 'pan') return block.panAutomationPoints ?? (block.panAutomationPoints = [{ x: 0, y: block.panAutomation?.[0] ?? fallback }, { x: 1, y: block.panAutomation?.[block.panAutomation.length - 1] ?? fallback }]);
        return block.volumeAutomationPoints ?? (block.volumeAutomationPoints = [{ x: 0, y: block.volumeAutomation?.[0] ?? fallback }, { x: 1, y: block.volumeAutomation?.[block.volumeAutomation.length - 1] ?? fallback }]);
    }

    private upsertAutomationPoint(block: MixerBlock, x: number, y: number) { const points = this.automationPoints(block); const near = points.find(point => Math.abs(point.x - x) < .018); if (near) { near.x = x; near.y = y; } else points.push({ x, y }); points.sort((a, b) => a.x - b.x); if (points.length > 36) points.splice(1, points.length - 36); }
    private syncAutomationSamples(block: MixerBlock) { const data = this.fitAutomationPoints(this.automationPoints(block), 64, this.mixerEditorMode === 'pan' ? -1 : 0, 1); if (this.mixerEditorMode === 'pitch') block.pitchAutomation = data; else if (this.mixerEditorMode === 'pan') block.panAutomation = data; else block.volumeAutomation = data; }

    private fitAutomationPoints(points: AutomationPoint[], samples: number, min: number, max: number): number[] {
        const degree = Math.min(3, Math.max(0, points.length - 1)), size = degree + 1; const matrix = Array.from({ length: size }, () => Array(size + 1).fill(0));
        for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) matrix[row][col] = points.reduce((sum, point) => sum + Math.pow(point.x, row + col), 0) + (row === col ? 1e-7 : 0);
        for (let row = 0; row < size; row++) matrix[row][size] = points.reduce((sum, point) => sum + point.y * Math.pow(point.x, row), 0);
        for (let pivot = 0; pivot < size; pivot++) { let best = pivot; for (let row = pivot + 1; row < size; row++) if (Math.abs(matrix[row][pivot]) > Math.abs(matrix[best][pivot])) best = row; [matrix[pivot], matrix[best]] = [matrix[best], matrix[pivot]]; const divisor = Math.abs(matrix[pivot][pivot]) < 1e-9 ? 1 : matrix[pivot][pivot]; for (let col = pivot; col <= size; col++) matrix[pivot][col] /= divisor; for (let row = 0; row < size; row++) if (row !== pivot) { const factor = matrix[row][pivot]; for (let col = pivot; col <= size; col++) matrix[row][col] -= factor * matrix[pivot][col]; } }
        const coefficients = matrix.map(row => row[size]); return Array.from({ length: samples }, (_, index) => { const x = index / Math.max(1, samples - 1); const y = coefficients.reduce((sum, value, power) => sum + value * Math.pow(x, power), 0); return Math.max(min, Math.min(max, y)); });
    }

    private drawAutomationGraph(g: Graphics, w: number, h: number, block: MixerBlock, clip: AudioClipMeta, cropStart = -1, cropEnd = -1) {
        g.clear();
        g.fillColor = new Color(14, 18, 26, 255);
        g.rect(-w / 2, -h / 2, w, h);
        g.fill();

        const durationBeats = Math.max(.001, this.clipBeats(clip, block));
        g.strokeColor = new Color(255, 255, 255, 84);
        const blockStartBeat = Math.max(0, block.startBeat), blockEndBeat = blockStartBeat + durationBeats;
        const firstGridBeat = Math.ceil(blockStartBeat - 1e-6), lastGridBeat = Math.floor(blockEndBeat + 1e-6);
        for (let beat = firstGridBeat; beat <= lastGridBeat; beat++) {
            const x = -w / 2 + (beat - blockStartBeat) / durationBeats * w;
            g.lineWidth = this.mixerBeatAccent(beat) === 2 ? 2 : (this.mixerBeatAccent(beat) === 1 ? 1.5 : 1);
            g.moveTo(x, -h / 2);
            g.lineTo(x, h / 2);
            g.stroke();
        }
        g.lineWidth = 1;
        const horizontalDivisions = this.mixerEditorMode === 'pan' ? 10 : 5;
        for (let i = 0; i <= horizontalDivisions; i++) {
            const y = -h / 2 + i / horizontalDivisions * h;
            g.moveTo(-w / 2, y);
            g.lineTo(w / 2, y);
        }
        g.stroke();

        // Volume/pitch originate at bottom-left; pan uses the left midpoint.
        g.lineWidth = 1.5;
        g.strokeColor = new Color(255, 255, 255, 190);
        g.moveTo(-w / 2, -h / 2);
        g.lineTo(-w / 2, h / 2);
        const originY = this.mixerEditorMode === 'pan' ? 0 : -h / 2;
        g.moveTo(-w / 2, originY);
        g.lineTo(w / 2, originY);
        g.rect(-w / 2, -h / 2, w, h);
        g.stroke();

        this.syncAutomationSamples(block);
        const data = this.mixerEditorMode === 'pitch' ? block.pitchAutomation! : this.mixerEditorMode === 'pan' ? block.panAutomation! : block.volumeAutomation!;
        g.lineWidth = 3;
        g.strokeColor = this.mixerColor(block.color);
        data.forEach((value, i) => {
            const x = -w / 2 + i / Math.max(1, data.length - 1) * w;
            const normalized = this.mixerEditorMode === 'pan' ? (value + 1) / 2 : value;
            const y = -h / 2 + Math.max(0, Math.min(1, normalized)) * h;
            if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        });
        g.stroke();
        g.fillColor = new Color(245, 245, 248, 255);
        for (const point of this.automationPoints(block)) {
            const normalized = this.mixerEditorMode === 'pan' ? (point.y + 1) / 2 : point.y;
            g.circle(-w / 2 + point.x * w, -h / 2 + Math.max(0, Math.min(1, normalized)) * h, 4);
            g.fill();
        }
        if (cropStart >= 0 && cropEnd >= 0) {
            const a = Math.min(cropStart, cropEnd), b = Math.max(cropStart, cropEnd);
            g.fillColor = new Color(255, 45, 55, 84);
            g.rect(-w / 2 + a * w, -h / 2, Math.max(2, (b - a) * w), h);
            g.fill();
        }
    }

    private snapMixerCropRatio(block: MixerBlock, clip: AudioClipMeta, ratio: number) {
        const clamped = Math.max(0, Math.min(1, ratio));
        if (!this.mixerMagnet) return clamped;
        const durationBeats = Math.max(.001, this.clipBeats(clip, block));
        const startBeat = Math.max(0, block.startBeat);
        const endBeat = startBeat + durationBeats;
        let nearest = clamped, nearestDistance = Infinity;
        const consider = (candidate: number) => {
            const distance = Math.abs(candidate - clamped);
            if (distance < nearestDistance) { nearest = candidate; nearestDistance = distance; }
        };
        for (let beat = Math.ceil(startBeat - 1e-6); beat < endBeat - 1e-6; beat++) {
            consider((beat - startBeat) / durationBeats);
        }
        // Prefer an interior grid line when it is exactly at the touch point;
        // this keeps a short leading/trailing partial-beat cell selectable.
        consider(0); consider(1);
        return Math.max(0, Math.min(1, nearest));
    }

    private isMixerCropGridRatio(block: MixerBlock, clip: AudioClipMeta, ratio: number) {
        const clamped = Math.max(0, Math.min(1, ratio));
        if (clamped <= .004 || clamped >= .996) return false;
        const durationBeats = Math.max(.001, this.clipBeats(clip, block));
        const startBeat = Math.max(0, block.startBeat);
        const endBeat = startBeat + durationBeats;
        for (let beat = Math.ceil(startBeat - 1e-6); beat < endBeat - 1e-6; beat++) {
            if (Math.abs((beat - startBeat) / durationBeats - clamped) <= .004) return true;
        }
        return false;
    }

    private splitMixerBlockAtRatio(blockId: string, ratio: number) {
        const found = this.findMixerBlock(blockId); if (!found) return;
        const clip = this.recordedClips.find(item => item.id === found.block.clipId); if (!clip) return;
        const ranges = this.mixerBlockTrimRanges(clip, found.block);
        const totalSeconds = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
        const cutOffset = totalSeconds * Math.max(0, Math.min(1, ratio));
        if (cutOffset < .02 || totalSeconds - cutOffset < .02) return;
        const left: Array<{ start: number; end: number }> = [], rightRanges: Array<{ start: number; end: number }> = [];
        let elapsed = 0;
        for (const range of ranges) {
            const length = range.end - range.start;
            if (cutOffset <= elapsed) rightRanges.push(range);
            else if (cutOffset >= elapsed + length) left.push(range);
            else { left.push({ start: range.start, end: range.start + cutOffset - elapsed }); rightRanges.push({ start: range.start + cutOffset - elapsed, end: range.end }); }
            elapsed += length;
        }
        if (!left.length || !rightRanges.length) return;
        const right: MixerBlock = JSON.parse(JSON.stringify(found.block));
        right.id = `block_${Date.now()}_split`;
        this.setMixerBlockTrimRanges(found.block, left);
        this.setMixerBlockTrimRanges(right, rightRanges);
        right.startBeat = found.block.startBeat + cutOffset * this.metronomeBpm / 60 / Math.max(.25, found.block.speed ?? 1);
        const targetTrack = this.findFreeMixerTrack(found.trackIndex, right.startBeat, this.clipBeats(clip, right), blockId);
        this.ensureMixerTrack(targetTrack)?.blocks.push(right);
        this.saveMixerTracks();
    }

    private applyMixerCrop(blockId: string, startRatio: number, endRatio: number) {
        const found = this.findMixerBlock(blockId); if (!found) return; const clip = this.recordedClips.find(item => item.id === found.block.clipId); if (!clip) return;
        if (this.mixerMagnet) {
            startRatio = this.snapMixerCropRatio(found.block, clip, startRatio);
            endRatio = this.snapMixerCropRatio(found.block, clip, endRatio);
        }
        const ranges = this.mixerBlockTrimRanges(clip, found.block);
        const totalSeconds = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
        const cutStart = totalSeconds * Math.max(0, Math.min(1, startRatio));
        const cutEnd = totalSeconds * Math.max(0, Math.min(1, endRatio));
        if (cutEnd - cutStart < .004 || cutEnd - cutStart >= totalSeconds - .02) return;
        const kept: Array<{ start: number; end: number }> = [];
        let elapsed = 0;
        for (const range of ranges) {
            const length = range.end - range.start;
            const keepBefore = Math.max(0, Math.min(length, cutStart - elapsed));
            const keepAfter = Math.max(0, Math.min(length, elapsed + length - cutEnd));
            if (keepBefore > .001) kept.push({ start: range.start, end: range.start + keepBefore });
            if (keepAfter > .001) kept.push({ start: range.end - keepAfter, end: range.end });
            elapsed += length;
        }
        if (!kept.length) return;
        this.setMixerBlockTrimRanges(found.block, kept);
        this.resolveMixerBlockOverlap(blockId);
    }
    private resolveMixerBlockOverlap(blockId: string) { const found = this.findMixerBlock(blockId); if (!found) return; const clip = this.recordedClips.find(item => item.id === found.block.clipId); if (!clip) return; const target = this.findFreeMixerTrack(found.trackIndex, found.block.startBeat, this.clipBeats(clip, found.block), blockId); if (target !== found.trackIndex) { found.track.blocks = found.track.blocks.filter(item => item.id !== blockId); this.ensureMixerTrack(target)?.blocks.push(found.block); } }

    private renameAudioClip(clip: AudioClipMeta) { NativeBridge.promptText(t('重命名音频', 'Rename Audio'), clip.name, (value) => { if (value.trim()) clip.name = value.trim(); this.saveAudioClips(); this.rebuildAudioRows(); this.queueMixerRedraw(); }); }
    private editClipTrim(clip: AudioClipMeta, start: boolean) { const duration = Math.max(.1, clip.duration); const initial = start ? clip.trimStart : (clip.trimEnd || duration); NativeBridge.promptText(start ? '首端裁剪（秒）' : '末端裁剪（秒）', initial.toFixed(2), (value) => { const n = Number(value); if (!Number.isFinite(n)) return; if (start) clip.trimStart = Math.max(0, Math.min(n, (clip.trimEnd || duration) - .05)); else clip.trimEnd = Math.max(clip.trimStart + .05, Math.min(n, duration)); this.saveAudioClips(); this.rebuildAudioRows(); this.queueMixerRedraw(); }); }

    private makeTrimRangeSlider(parent: Node, clip: AudioClipMeta, x: number, y: number, width: number, refreshLabels: () => void) {
        const node = new Node('TrimRange'); node.layer = Layers.Enum.UI_2D; (node as any).__mixerSourceControl = true; const transform = node.addComponent(UITransform); transform.setContentSize(width, 36); node.setPosition(x, y); const g = node.addComponent(Graphics); let activeHandle: 'start' | 'end' = 'start';
        const duration = Math.max(.1, clip.duration || 0);
        const normalized = () => ({ start: Math.max(0, Math.min(1, clip.trimStart / duration)), end: Math.max(0, Math.min(1, (clip.trimEnd > clip.trimStart ? clip.trimEnd : duration) / duration)) });
        const draw = () => {
            const value = normalized(); const startX = -width / 2 + value.start * width; const endX = -width / 2 + value.end * width;
            g.clear(); g.roundRect(-width / 2, -8, width, 16, 4); g.fillColor = new Color(35, 45, 62, 255); g.fill(); g.lineWidth = 1; g.strokeColor = new Color(105, 125, 155, 255); g.stroke();
            g.roundRect(startX, -7, Math.max(2, endX - startX), 14, 3); g.fillColor = new Color(70, 175, 120, 255); g.fill();
            g.rect(startX - 5, -13, 10, 26); g.fillColor = new Color(238, 244, 252, 255); g.fill(); g.rect(endX - 5, -13, 10, 26); g.fill();
        };
        const moveHandle = (e: EventTouch) => {
            const p = e.getUILocation(); const local = transform.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0)); const value = Math.max(0, Math.min(1, (local.x + width / 2) / width)); const current = normalized(); const minGap = Math.min(.5, .05 / duration);
            if (activeHandle === 'start') clip.trimStart = Math.min(value, current.end - minGap) * duration;
            else clip.trimEnd = Math.max(value, current.start + minGap) * duration;
            refreshLabels(); draw(); e.propagationStopped = true;
        };
        node.on(Node.EventType.TOUCH_START, (e: EventTouch) => { const p = e.getUILocation(); const local = transform.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0)); const value = (local.x + width / 2) / width; const current = normalized(); activeHandle = Math.abs(value - current.start) <= Math.abs(value - current.end) ? 'start' : 'end'; moveHandle(e); }, this);
        node.on(Node.EventType.TOUCH_MOVE, moveHandle, this);
        const finish = (e: EventTouch) => { this.saveAudioClips(); this.flushMixerLiveRedraw(); e.propagationStopped = true; };
        node.on(Node.EventType.TOUCH_END, finish, this); node.on(Node.EventType.TOUCH_CANCEL, finish, this); parent.addChild(node); draw();
    }
    private cloneAudioClip(clip: AudioClipMeta) { if (this.recordedClips.length >= 13) { this.setInfo('最多支持 13 个音频片段', new Color(255, 190, 120, 255)); return; } this.recordedClips.unshift({ ...clip, id: `clip_${Date.now()}`, name: `${clip.name}${isEnglish() ? ' Copy' : ' 副本'}` }); this.saveAudioClips(); this.rebuildAudioRows(); }
    private makeCloneButton(parent: Node, x: number, y: number, cb: () => void) { const b = this.makePanelButton(parent, '', x, y, 42, 34, cb, new Color(42, 72, 115, 255)); const icon = new Node('CloneIcon'); icon.layer = Layers.Enum.UI_2D; icon.addComponent(UITransform).setContentSize(24, 24); b.addChild(icon); const g = icon.addComponent(Graphics); g.lineWidth = 1.5; g.strokeColor = new Color(255, 255, 255, 255); g.rect(-8, -8, 12, 12); g.stroke(); g.rect(-3, -3, 12, 12); g.stroke(); return b; }

    private exportAudioClip(clip: AudioClipMeta) {
        if (NativeBridge.isAndroidNative) {
            NativeBridge.chooseAudioExportFormat(format => {
                if (!format) return;
                const path = NativeBridge.exportAudio(clip.path, clip.name, format);
                const failed = !path || path.startsWith('ERROR:');
                if (failed) this.setInfo(path.replace(/^ERROR:/, '') || '音频导出失败', new Color(255, 150, 150, 255));
                else NativeBridge.showAudioExportResult(path);
            });
            return;
        }
        this.setInfo('浏览器预览不支持导出原生录音', new Color(255, 190, 120, 255));
    }

    private makePanelButton(parent: Node, text: string, x: number, y: number, w: number, h: number, cb: () => void, color: Color): Node {
        const node = new Node(`PanelButton-${text}-${Math.random()}`); node.layer = Layers.Enum.UI_2D; node.addComponent(UITransform).setContentSize(w, h); const button = node.addComponent(Button); button.transition = Button.Transition.SCALE; node.addComponent(Graphics); (node as any).__panelButtonStyle = { w, h, color: new Color(color.r, color.g, color.b, color.a) }; this.redrawPanelButton(node); const label = this.makeLabel('Text', text, Math.max(14, Math.min(22, h * .48)), h, new Color(245, 248, 255, 255), w, h); node.addChild(label); node.setPosition(x, y); node.on(Button.EventType.CLICK, cb, this); parent.addChild(node); return node;
    }

    private redrawPanelButton(node: Node) {
        const style = (node as any).__panelButtonStyle as { w: number; h: number; color: Color; fillColor?: Color; strokeColor?: Color; graphicsOpacity?: number } | undefined;
        const g = node.getComponent(Graphics); if (!style || !g) return;
        const opacity = Math.max(0, Math.min(1, style.graphicsOpacity ?? 1));
        const fill = style.fillColor ?? style.color, stroke = style.strokeColor ?? new Color(125, 150, 188, 230);
        g.clear(); g.roundRect(-style.w / 2, -style.h / 2, style.w, style.h, Math.min(8, style.h / 3));
        g.fillColor = new Color(fill.r, fill.g, fill.b, Math.round(fill.a * opacity)); g.fill();
        g.lineWidth = style.strokeColor ? 2 : 1.2; g.strokeColor = new Color(stroke.r, stroke.g, stroke.b, Math.round(stroke.a * opacity)); g.stroke();
    }

    private setPanelButtonBlackFill(node: Node) {
        const style = (node as any).__panelButtonStyle as { color: Color; fillColor?: Color; strokeColor?: Color } | undefined; if (!style) return;
        style.fillColor = new Color(0, 0, 0, 255); style.strokeColor = new Color(style.color.r, style.color.g, style.color.b, 255); this.redrawPanelButton(node);
    }

    private redrawPanelButtons(root: Node) {
        this.redrawPanelButton(root);
        for (const child of root.children) this.redrawPanelButtons(child);
    }

    private openStylePanel() {
        if (this.audioPanelOpen) this.closeAudioPanel();
        const created = !this.stylePanel;
        if (created) this.buildStylePanel();
        this.stylePanel!.active = true;
        this.stylePanelOpen = true;
        this.stylePanel!.setSiblingIndex(this.uiRoot.children.length - 1);
        this.layoutStylePanel(); this.rebuildStyleRows();
    }

    private closeStylePanel() { if (this.stylePanel) { this.stylePanel.active = false; this.stylePanelOpen = false; } }

    private buildStylePanel() {
        const panel = new Node('StyleManagerPanel'); panel.layer = Layers.Enum.UI_2D;
        panel.addComponent(UITransform).setContentSize(1400, 860);
        const initialBg = panel.addComponent(Graphics); initialBg.rect(-700, -430, 1400, 860); initialBg.fillColor = new Color(8, 12, 24, 255); initialBg.fill();
        const title = this.makeLabel('StyleTitle', isEnglish() ? 'Style Manager' : '样式管理', 30, 38, new Color(240, 244, 252, 255), 700, 50); panel.addChild(title);
        const save = this.makePanelButton(panel, isEnglish() ? 'Save current as new style' : '保存当前所有为新样式', 0, 0, 300, 52, () => { this.saveCurrentStyle(); this.rebuildStyleRows(); }, new Color(38, 72, 106, 255)); save.name = 'StyleSave';
        const flow = this.makePanelButton(panel, isEnglish() ? 'New style flow' : '新建样式流', 0, 0, 300, 52, () => this.openStyleFlowEditor(), new Color(38, 72, 106, 255)); flow.name = 'StyleFlow';
        const imp = this.makePanelButton(panel, isEnglish() ? 'Import' : '导入', 0, 0, 300, 52, () => this.importStyleJson(), new Color(38, 72, 106, 255)); imp.name = 'StyleImport';
        const clearList = this.makePanelButton(panel, isEnglish() ? 'Clear style list' : '清空样式栏', 0, 0, 300, 52, () => this.confirmClearStyles(), new Color(92, 54, 64, 255)); clearList.name = 'StyleClearList';
        const clearPackages = this.makePanelButton(panel, isEnglish() ? 'Clear packages' : '清空数据包', 0, 0, 300, 52, () => this.confirmClearPackages(), new Color(92, 54, 64, 255)); clearPackages.name = 'StyleClearPackages';
        for (const leftButton of [save, flow, imp, clearList, clearPackages]) this.setPanelButtonBlackFill(leftButton);
        const close = this.makePanelButton(panel, isEnglish() ? 'Close' : '关闭', 0, 0, 110, 42, () => this.closeStylePanel(), new Color(45, 58, 88, 255)); close.name = 'StyleClose';
        const swallow = (e: EventTouch) => { e.propagationStopped = true; };
        panel.on(Node.EventType.TOUCH_START, swallow, this); panel.on(Node.EventType.TOUCH_MOVE, swallow, this); panel.on(Node.EventType.TOUCH_END, swallow, this);
        this.uiRoot.addChild(panel); panel.active = false;
        initialBg.clear(); initialBg.rect(-700, -430, 1400, 860); initialBg.fillColor = new Color(8, 12, 24, 255); initialBg.fill();
        this.stylePanel = panel;
    }

    private layoutStylePanel() {
        if (!this.stylePanel) return;
        const panel = this.stylePanel; const view = this.userViewport(false);
        const leftW = Math.max(300, Math.min(350, view.w * .25)); const dividerX = -view.w / 2 + leftW;
        panel.getComponent(UITransform)!.setContentSize(view.w, view.h);
        const g = panel.getComponent(Graphics)!; g.clear();
        g.rect(-view.w / 2, -view.h / 2, view.w, view.h); g.fillColor = new Color(8, 12, 24, 255); g.fill();
        g.lineWidth = 1.5; g.strokeColor = new Color(95, 125, 165, 255); g.rect(-view.w / 2 + 1, -view.h / 2 + 1, view.w - 2, view.h - 2); g.stroke();
        g.strokeColor = new Color(225, 232, 244, 210); g.moveTo(dividerX, -view.h / 2 + 18); g.lineTo(dividerX, view.h / 2 - 70); g.stroke();
        panel.getChildByName('StyleTitle')?.setPosition(0, view.h / 2 - 34);
        panel.getChildByName('StyleClose')?.setPosition(view.w / 2 - 68, view.h / 2 - 34);
        const leftCenter = -view.w / 2 + leftW / 2;
        panel.getChildByName('StyleSave')?.setPosition(leftCenter, view.h / 2 - 125);
        panel.getChildByName('StyleFlow')?.setPosition(leftCenter, view.h / 2 - 194);
        panel.getChildByName('StyleImport')?.setPosition(leftCenter, view.h / 2 - 263);
        panel.getChildByName('StyleClearList')?.setPosition(leftCenter, view.h / 2 - 332);
        panel.getChildByName('StyleClearPackages')?.setPosition(leftCenter, view.h / 2 - 401);
        this.redrawPanelButtons(panel);
    }

    private rebuildStyleRows() {
        if (!this.stylePanel) return;
        for (const row of this.styleRows) row.destroy(); this.styleRows = [];
        const view = this.userViewport(false); const leftW = Math.max(300, Math.min(350, view.w * .25));
        const rightLeft = -view.w / 2 + leftW + 16; const rowW = view.w - leftW - 32; let cursor = view.h / 2 - 80;
        this.styles.forEach((style, i) => {
            const expanded = this.expandedStyleId === style.id; const totalH = expanded ? 150 : 62; const barY = totalH / 2 - 31;
            const row = new Node(`StyleRow${style.id}`); row.layer = Layers.Enum.UI_2D; row.addComponent(UITransform).setContentSize(rowW, totalH); row.setPosition(rightLeft + rowW / 2, cursor - totalH / 2);
            const g = row.addComponent(Graphics); g.roundRect(-rowW / 2, barY - 28, rowW, 56, 6); g.fillColor = new Color(22, 30, 48, 255); g.fill(); g.lineWidth = 2; g.strokeColor = style.kind === 'flow' ? new Color(75, 125, 240, 255) : new Color(60, 190, 110, 255); g.stroke();
            const right = rowW / 2;
            this.makePanelButton(row, style.name, -rowW / 2 + Math.min(185, rowW * .22), barY, Math.min(330, rowW * .43), 38, () => this.renameStyle(style), new Color(30, 40, 62, 255));
            this.makePanelButton(row, expanded ? '▲' : '▼', right - 190, barY, 42, 38, () => { this.expandedStyleId = expanded ? '' : style.id; this.rebuildStyleRows(); }, style.kind === 'flow' ? new Color(42, 72, 130, 255) : new Color(42, 105, 72, 255));
            this.makePanelButton(row, '→', right - 136, barY, 42, 38, () => this.exportStyleJson(style), new Color(42, 72, 115, 255));
            this.makePanelButton(row, '↓', right - 82, barY, 42, 38, () => this.applyStyle(style), new Color(42, 72, 115, 255));
            this.makePanelButton(row, '×', right - 28, barY, 42, 38, () => this.deleteStyle(style), new Color(115, 45, 58, 255));
            if (expanded) this.drawStylePreview(row, style, rowW, barY - 68);
            this.stylePanel!.addChild(row); this.styleRows.push(row); cursor -= totalH + 10;
            row.setScale(.98, .98, 1); tween(row).to(.18, { scale: new Vec3(1, 1, 1) }, { easing: 'quadOut' }).start();
        });
    }

    private renameStyle(style: StyleSnapshot) { NativeBridge.promptText(t('重命名样式', 'Rename Style'), style.name, (value) => { if (value.trim()) style.name = value.trim(); this.saveStyles(); this.rebuildStyleRows(); }); }

    private deleteStyle(style: StyleSnapshot) {
        NativeBridge.confirm('删除样式', `确定删除“${style.name}”吗？`, (confirmed) => {
            if (!confirmed) return;
            this.styles = this.styles.filter((item) => item.id !== style.id);
            if (this.activeStyleFlow?.id === style.id) this.activeStyleFlow = null;
            if (this.expandedStyleId === style.id) this.expandedStyleId = '';
            this.saveStyles(); this.rebuildStyleRows();
        });
    }

    private confirmTwice(action: string, apply: () => void) {
        NativeBridge.confirm('确认清空', `是否${action}？`, (first) => {
            if (!first) return;
            NativeBridge.confirm('再次确认', `${action}后无法恢复，确定继续吗？`, (second) => { if (second) apply(); });
        });
    }

    private confirmClearStyles() {
        this.confirmTwice('清空样式栏中的所有样式和样式流', () => {
            this.styles = []; this.activeStyleFlow = null; this.expandedStyleId = ''; this.saveStyles(); this.rebuildStyleRows();
            this.setInfo('样式栏已清空', new Color(220, 225, 235, 255));
        });
    }

    private confirmClearPackages() {
        this.confirmTwice('清除游戏文件根目录中的所有样式数据包', () => {
            const removed = NativeBridge.clearStylePackages();
            this.setInfo(removed >= 0 ? `已清空数据包（${removed} 个）` : '清空数据包失败', removed >= 0 ? new Color(220, 225, 235, 255) : new Color(255, 150, 150, 255));
        });
    }

    private drawStylePreview(row: Node, style: StyleSnapshot, width: number, centerY: number) {
        const preview = new Node('Preview'); preview.layer = Layers.Enum.UI_2D; preview.addComponent(UITransform).setContentSize(width - 20, 78); preview.setPosition(0, centerY); row.addChild(preview);
        const g = preview.addComponent(Graphics); const pw = width - 48; g.roundRect(-pw / 2, -37, pw, 74, 5); g.fillColor = new Color(13, 19, 33, 255); g.fill();
        if (style.kind === 'flow') {
            const nodes = style.flowNodes || []; const count = Math.max(1, nodes.length); const gap = Math.min(100, (pw - 70) / count); const start = -(count - 1) * gap / 2;
            nodes.forEach((n, i) => { g.circle(start + i * gap, 7, 7); g.fillColor = new Color(80, 135, 245, 255); g.fill(); if (i < nodes.length - 1) { g.strokeColor = new Color(150, 180, 235, 255); g.lineWidth = 1.5; g.moveTo(start + i * gap + 10, 7); g.lineTo(start + (i + 1) * gap - 10, 7); g.stroke(); } });
            const label = this.makeLabel('FlowPreviewText', `${nodes.length} 个节点`, 16, 20, new Color(185, 205, 240, 255), pw, 22); label.setPosition(0, -20); preview.addChild(label); return;
        }
        const colors = [new Color(255, 80, 90, 255), new Color(65, 225, 130, 255), new Color(80, 145, 255, 255)];
        const laneW = pw / 3;
        style.waves.slice(0, 3).forEach((wave, ch) => {
            const rawDrumData = wave.drumId && wave.drumId !== DRUM_NONE_ID
                ? this.drumPresetOf(wave.drumSourceId ?? wave.drumId)?.waveform : undefined;
            const drumData = rawDrumData ? this.stretchDrumWave(rawDrumData, 1, wave.drumSpeed ?? 1) : undefined;
            const data = drumData?.length ? drumData : (wave.baseWave?.length ? wave.baseWave : [0, 0]); const laneLeft = -pw / 2 + ch * laneW; const usable = Math.max(20, laneW - 30); g.strokeColor = colors[ch]; g.lineWidth = 1.5;
            if (ch > 0) { g.strokeColor = new Color(70, 82, 105, 180); g.lineWidth = 1; g.moveTo(laneLeft, -28); g.lineTo(laneLeft, 28); g.stroke(); g.strokeColor = colors[ch]; g.lineWidth = 1.5; }
            for (let x = 0; x < usable; x++) { const phase = drumData ? x / Math.max(1, usable - 1) : (x / Math.max(1, usable - 1)) * Math.max(.1, wave.cycles); const idx = Math.floor((drumData ? phase : phase % 1) * (data.length - 1)); const px = laneLeft + 15 + x; const py = -6 + Math.max(-20, Math.min(20, data[idx] * wave.amplitude * 20)); if (x === 0) g.moveTo(px, py); else g.lineTo(px, py); } g.stroke();
            const label = this.makeLabel(`Preview${ch}`, ['R', 'G', 'B'][ch], 14, 18, colors[ch], laneW, 18); label.setPosition(laneLeft + laneW / 2, 26); preview.addChild(label);
        });
    }

    private captureStyle(kind: 'style' | 'flow', name: string): StyleSnapshot {
        return {
            id: `style_${Date.now()}`, name, kind, createdAt: Date.now(),
            waves: [0, 1, 2].map((ch) => {
                const area = this.waveAreas[ch];
                const stored = this.loadWave(ch);
                return area
                    ? { baseWave: area.baseWave.slice(), amplitude: area.amplitude, cycles: area.cycles, instId: this.instIds[ch], drumId: this.channelDrumIds[ch], drumSourceId: this.channelDrumSourceIds[ch], drumSpeed: area.drumSpeed }
                    : { baseWave: this.loadBaseWave(ch, stored), amplitude: this.loadWaveScalar(ch, 'amp', 1), cycles: this.loadWaveScalar(ch, 'cycles', 1), instId: loadStr('cm_inst_' + ch, ch === 0 ? 'piano' : ch === 1 ? 'flute' : 'bell'), drumId: loadStr(`cm_drum_channel_${ch}`, DRUM_NONE_ID), drumSourceId: loadStr(`cm_drum_channel_source_${ch}`, ['tr808_kick', 'tr808_snare', 'tr808_hat'][ch]), drumSpeed: this.loadWaveScalar(ch, 'drum_speed', 1) };
            }),
            grid: JSON.parse(JSON.stringify(this.gridState)), fxSlots: JSON.parse(JSON.stringify(this.fxSlots)), outputFxSlots: JSON.parse(JSON.stringify(this.outputFxSlots)),
            drumBlackId: this.drumBlackId, drumWhiteId: this.drumWhiteId,
            metronome: { enabled: this.metronomeEnabled, beatsPerBar: this.metronomeBeatsPerBar, beatUnit: this.metronomeBeatUnit, bpm: this.metronomeBpm },
        };
    }

    private saveCurrentStyle() { this.styles.push(this.captureStyle('style', t('新样式', 'New Style'))); this.saveStyles(); this.setInfo(t('已保存新样式', 'New style saved'), new Color(220, 225, 235, 255)); }

    private openStyleFlowEditor() {
        const styleChoices = this.styles.filter((s) => s.kind === 'style');
        if (!styleChoices.length) { this.setInfo('请先保存至少一个样式', new Color(255, 190, 120, 255)); return; }
        const created = !this.flowEditorPanel;
        if (created) this.buildStyleFlowEditor();
        this.flowEditorPanel!.active = true;
        this.flowEditorNodes = Array.from({ length: 5 }, (_, i) => ({ styleId: styleChoices[Math.min(i, styleChoices.length - 1)].id, delaySec: 5 }));
        this.stylePanel!.active = false; this.flowEditorPanel!.setSiblingIndex(this.uiRoot.children.length - 1);
        this.layoutStyleFlowEditor(); this.rebuildStyleFlowEditor();
    }

    private buildStyleFlowEditor() {
        const panel = new Node('StyleFlowEditor'); panel.layer = Layers.Enum.UI_2D; panel.addComponent(UITransform).setContentSize(1400, 860); const initialBg = panel.addComponent(Graphics); initialBg.rect(-700, -430, 1400, 860); initialBg.fillColor = new Color(8, 12, 24, 255); initialBg.fill();
        const title = this.makeLabel('FlowTitle', '新建样式流', 30, 38, new Color(240, 244, 252, 255), 600, 50); panel.addChild(title);
        const reset = this.makePanelButton(panel, '重置', -130, 0, 110, 44, () => { const choices = this.styles.filter((s) => s.kind === 'style'); this.flowEditorNodes = Array.from({ length: 5 }, (_, i) => ({ styleId: choices[Math.min(i, choices.length - 1)]?.id || '', delaySec: 5 })); this.rebuildStyleFlowEditor(); }, new Color(45, 58, 88, 255)); reset.name = 'FlowReset';
        const close = this.makePanelButton(panel, '关闭', 0, 0, 110, 44, () => this.closeStyleFlowEditor(), new Color(45, 58, 88, 255)); close.name = 'FlowClose';
        const save = this.makePanelButton(panel, '保存', 130, 0, 110, 44, () => this.saveStyleFlow(), new Color(42, 105, 72, 255)); save.name = 'FlowSave';
        const swallow = (e: EventTouch) => { e.propagationStopped = true; }; panel.on(Node.EventType.TOUCH_START, swallow, this); panel.on(Node.EventType.TOUCH_MOVE, swallow, this); panel.on(Node.EventType.TOUCH_END, swallow, this);
        this.uiRoot.addChild(panel); panel.active = false;
        initialBg.clear(); initialBg.rect(-700, -430, 1400, 860); initialBg.fillColor = new Color(8, 12, 24, 255); initialBg.fill();
        this.flowEditorPanel = panel;
    }

    private layoutStyleFlowEditor() {
        if (!this.flowEditorPanel) return; const panel = this.flowEditorPanel; const view = this.userViewport(false); panel.getComponent(UITransform)!.setContentSize(view.w, view.h);
        const g = panel.getComponent(Graphics)!; g.clear(); g.rect(-view.w / 2, -view.h / 2, view.w, view.h); g.fillColor = new Color(8, 12, 24, 255); g.fill(); g.lineWidth = 1.5; g.strokeColor = new Color(75, 125, 240, 255); g.rect(-view.w / 2 + 1, -view.h / 2 + 1, view.w - 2, view.h - 2); g.stroke();
        panel.getChildByName('FlowTitle')?.setPosition(0, view.h / 2 - 35); panel.getChildByName('FlowReset')?.setPosition(-130, -view.h / 2 + 42); panel.getChildByName('FlowClose')?.setPosition(0, -view.h / 2 + 42); panel.getChildByName('FlowSave')?.setPosition(130, -view.h / 2 + 42);
        this.redrawPanelButtons(panel);
    }

    private rebuildStyleFlowEditor() {
        if (!this.flowEditorPanel) return; for (const n of this.flowEditorDynamic) n.destroy(); this.flowEditorDynamic = [];
        const panel = this.flowEditorPanel; const view = this.userViewport(false); const choices = this.styles.filter((s) => s.kind === 'style'); const perRow = 5; const cellW = Math.min(250, (view.w - 50) / perRow);
        this.flowEditorNodes.forEach((flowNode, i) => {
            const row = Math.floor(i / perRow); const col = i % perRow; const countInRow = Math.min(perRow, this.flowEditorNodes.length - row * perRow); const x = (col - (countInRow - 1) / 2) * cellW; const y = view.h / 2 - 140 - row * 190;
            const nodeMark = new Node(`FlowNode${i}`); nodeMark.layer = Layers.Enum.UI_2D; nodeMark.addComponent(UITransform).setContentSize(26, 26); nodeMark.setPosition(x, y + 58); const mg = nodeMark.addComponent(Graphics); mg.circle(0, 0, 10); mg.fillColor = new Color(80, 135, 245, 255); mg.fill(); const num = this.makeLabel('Number', String(i + 1), 12, 14, new Color(255, 255, 255, 255), 22, 22); nodeMark.addChild(num); panel.addChild(nodeMark); this.flowEditorDynamic.push(nodeMark);
            const before = new Set(panel.children); const dd = new Dropdown(panel, choices.map((s) => ({ id: s.id, label: s.name })), flowNode.styleId, () => '', (id) => { flowNode.styleId = id; }); dd.setPosition(x, y + 15); dd.redraw(); for (const child of panel.children) if (!before.has(child)) this.flowEditorDynamic.push(child);
            const time = this.makePanelButton(panel, `${flowNode.delaySec.toFixed(1)} 秒`, x, y - 42, 105, 36, () => NativeBridge.promptText(i === this.flowEditorNodes.length - 1 ? '循环回到首节点时间（秒）' : '切换到下一样式时间（秒）', String(flowNode.delaySec), (value) => { const n = Number(value); if (Number.isFinite(n)) flowNode.delaySec = Math.max(.1, Math.min(3599, n)); this.rebuildStyleFlowEditor(); }), new Color(38, 58, 88, 255)); this.flowEditorDynamic.push(time);
        });
        const rows = Math.ceil(this.flowEditorNodes.length / perRow); const controlsY = view.h / 2 - 140 - (rows - 1) * 190 - 100;
        const plus = this.makePanelButton(panel, '+', 25, controlsY, 38, 38, () => { if (this.flowEditorNodes.length >= 13) { this.setInfo('最多支持 13 个节点', new Color(255, 190, 120, 255)); return; } this.flowEditorNodes.push({ styleId: choices[0]?.id || '', delaySec: 5 }); this.rebuildStyleFlowEditor(); }, new Color(42, 105, 72, 255));
        const minus = this.makePanelButton(panel, '−', -25, controlsY, 38, 38, () => { if (this.flowEditorNodes.length > 1) this.flowEditorNodes.pop(); this.rebuildStyleFlowEditor(); }, new Color(110, 55, 65, 255)); this.flowEditorDynamic.push(plus, minus);
    }

    private closeStyleFlowEditor() { if (this.flowEditorPanel) this.flowEditorPanel.active = false; if (this.stylePanel) { this.stylePanel.active = true; this.layoutStylePanel(); this.rebuildStyleRows(); } }

    private saveStyleFlow() {
        const flow = this.captureStyle('flow', t('新样式流', 'New Style Flow')); flow.flowNodes = this.flowEditorNodes.map((n) => ({ ...n })); this.styles.push(flow); this.saveStyles(); this.closeStyleFlowEditor(); this.setInfo(t('已保存新样式流', 'New style flow saved'), new Color(220, 225, 235, 255));
    }
    private loadStyles(): StyleSnapshot[] { try { const raw = sys.localStorage.getItem('cm_styles'); const value = raw ? JSON.parse(raw) : []; return Array.isArray(value) ? value.map((style) => ({ ...style, name: localizeMutableDefaultName(String(style.name ?? (style.kind === 'flow' ? t('新样式流', 'New Style Flow') : t('新样式', 'New Style')))) })) : []; } catch (e) { return []; } }
    private saveStyles() { try { sys.localStorage.setItem('cm_styles', JSON.stringify(this.styles)); } catch (e) { /* ignore */ } }

    private applyStyle(style: StyleSnapshot) {
        if (style.kind === 'flow') {
            this.activeStyleFlow = style;
            const first = this.styles.find((s) => s.kind === 'style' && s.id === style.flowNodes?.[0]?.styleId);
            if (first) this.applyStyleSnapshot(first, true);
            this.setInfo('样式流已载入，将在循环播放时运行', new Color(180, 205, 255, 255));
            return;
        }
        this.applyStyleSnapshot(style, false);
    }

    private applyStyleSnapshot(style: StyleSnapshot, preserveFlow: boolean) {
        if (!preserveFlow) this.activeStyleFlow = null;
        const previousEdgeMode = this.edgeMode;
        this.styleTransition = true;
        this.redrawPlayGrid();
        style.waves.forEach((w, ch) => {
            const drumId = w.drumId ?? DRUM_NONE_ID;
            const drumSourceId = this.validDrumId(w.drumSourceId ?? drumId, ['tr808_kick', 'tr808_snare', 'tr808_hat'][ch]);
            const sampleWave = drumId !== DRUM_NONE_ID ? this.drumPresetOf(drumSourceId)?.waveform : undefined;
            const wave = sampleWave ? this.stretchDrumWave(sampleWave, w.amplitude, w.drumSpeed ?? 1) : this.applyWaveAxes(w.baseWave, w.amplitude, w.cycles);
            const a = this.waveAreas[ch];
            this.channelDrumIds[ch] = drumId;
            this.channelDrumSourceIds[ch] = drumSourceId;
            if (a) { a.baseWave = w.baseWave.slice(); a.amplitude = w.amplitude; a.cycles = w.cycles; a.drumSpeed = w.drumSpeed ?? 1; a.wave = wave; this.saveWaveState(a); this.saveChannelDrumState(ch); this.redrawWaveArea(a); this.drumDds[ch]?.setValue(drumId); }
            else {
                try { sys.localStorage.setItem(this.waveKey(ch), JSON.stringify(wave)); sys.localStorage.setItem(`cm_wt_base_${ch}`, JSON.stringify(w.baseWave)); sys.localStorage.setItem(`cm_wt_amp_${ch}`, String(w.amplitude)); sys.localStorage.setItem(`cm_wt_cycles_${ch}`, String(w.cycles)); } catch (e) { /* ignore */ }
            }
            this.instIds[ch] = w.instId; saveStr('cm_inst_' + ch, w.instId); this.sendWaveToNative(ch, w.baseWave, w.amplitude, w.cycles); this.pushChannelDrumToNative(ch);
        });
        this.gridState = JSON.parse(JSON.stringify(style.grid)); saveGridState(this.gridState); this.fxSlots = JSON.parse(JSON.stringify(style.fxSlots)); saveFxSlots(this.fxSlots); this.outputFxSlots = JSON.parse(JSON.stringify(style.outputFxSlots)); saveOutputFxSlots(this.outputFxSlots); this.drumBlackId = style.drumBlackId; this.drumWhiteId = style.drumWhiteId; this.pushFxToNative(); this.pushOutputFxToNative(); this.pushDrumToNative(); this.redrawPlayGrid(); this.scheduleOnce(() => { this.styleTransition = false; this.edgeMode = previousEdgeMode; this.redrawPlayGrid(); }, 1.3); this.setInfo('样式已载入', new Color(220, 225, 235, 255));
        if (style.metronome) {
            this.metronomeEnabled = !!style.metronome.enabled;
            this.metronomeBeatsPerBar = Math.max(1, Math.min(32, Math.round(style.metronome.beatsPerBar || 4)));
            this.metronomeBeatUnit = [1, 2, 4, 8, 16, 32].indexOf(style.metronome.beatUnit) >= 0 ? style.metronome.beatUnit : 4;
            this.metronomeBpm = Math.max(20, Math.min(320, Math.round(style.metronome.bpm || 120)));
            saveStr('cm_metronome_beats', String(this.metronomeBeatsPerBar)); saveStr('cm_metronome_unit', String(this.metronomeBeatUnit)); saveStr('cm_metronome_bpm', String(this.metronomeBpm));
            NativeBridge.setMetronome(this.metronomeEnabled, this.metronomeBeatsPerBar, this.metronomeBeatUnit, this.metronomeBpm);
            this.redrawMetronomeButton();
        }
    }

    private startStyleFlow() {
        const flow = this.activeStyleFlow; const nodes = flow?.flowNodes || []; const token = ++this.styleFlowToken; if (!flow || !nodes.length) return;
        const advance = (index: number) => {
            if (token !== this.styleFlowToken || !this.clipsPlaying || !this.activePlaybackLoop) return;
            const node = nodes[index]; const style = this.styles.find((s) => s.kind === 'style' && s.id === node.styleId); if (style) this.applyStyleSnapshot(style, true);
            this.scheduleOnce(() => advance((index + 1) % nodes.length), Math.max(.1, node.delaySec));
        };
        advance(0);
    }

    private exportStyleJson(style: StyleSnapshot) { const text = JSON.stringify(style); const base = `Neuro_Deta_${style.kind === 'flow' ? 'Style_Flow' : 'Style'}`; if (NativeBridge.isAndroidNative) { const path = NativeBridge.exportStylePackage(base, text); if (path) this.showCenterMessage('导出成功，数据包已保存至游戏文件根目录'); else this.setInfo('数据包导出失败', new Color(255, 150, 150, 255)); } else if (typeof document !== 'undefined') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = `${base}_${Date.now()}.json`; a.click(); this.showCenterMessage('导出成功，数据包已保存至游戏文件根目录'); } }
    private acceptImportedStyle(text: string) { try { const style = JSON.parse(text) as StyleSnapshot; if (!style?.waves || !style?.grid || (style.kind !== 'style' && style.kind !== 'flow')) throw new Error('invalid'); style.id = `style_${Date.now()}`; this.styles.push(style); this.saveStyles(); this.rebuildStyleRows(); this.setInfo('样式数据包已导入', new Color(220, 225, 235, 255)); } catch (e) { this.setInfo('样式文件解析失败', new Color(255, 150, 150, 255)); } }
    private importStyleJson() { if (NativeBridge.isAndroidNative) { NativeBridge.importStylePackage((json) => this.acceptImportedStyle(json)); return; } if (typeof document === 'undefined') return; const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,.style'; input.onchange = () => { const f = input.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => this.acceptImportedStyle(String(r.result)); r.readAsText(f); }; input.click(); }

    private pickWeb() {
        if (typeof document === 'undefined') return;
        let inputEl = document.getElementById('cm-file-input') as HTMLInputElement | null;
        if (!inputEl) {
            inputEl = document.createElement('input');
            inputEl.id = 'cm-file-input';
            inputEl.type = 'file';
            inputEl.accept = 'image/*';
            inputEl.style.display = 'none';
            document.body.appendChild(inputEl);
        }
        inputEl.onchange = () => {
            const file = inputEl?.files && inputEl.files[0];
            if (!file) return;
            const url = URL.createObjectURL(file);
            cachedPickedImage = { url };
            this.loadRemoteAndShow(url);
        };
        inputEl.click();
    }

    /* ============================== 图片加载 ============================== */

    private onNativeImage(info: PickedImageInfo) {
        console.log('[CM] 收到图片回调, w=', info.width, 'h=', info.height, '有字节=', !!info.imageBase64, '网格=', !!info.gridBase64);
        this.store.initFromNative(info);
        // 原生路径：用 loadRemote 解码 JPEG（ImageAsset 直接填压缩字节会被当作原始 RGBA，导致崩溃）
        let path = info.path;
        if (!path.startsWith('file://') && (path.startsWith('/') || /^[A-Za-z]:/.test(path))) {
            path = 'file://' + path;
        }
        // 显示图已保存到应用缓存路径；无需再保留体积较大的 imageBase64。
        cachedPickedImage = { url: path, nativeInfo: { ...info, imageBase64: undefined } };
        this.loadRemoteAndShow(path);
    }

    private restoreCachedImage() {
        if (!cachedPickedImage) return;
        if (cachedPickedImage.nativeInfo) this.store.initFromNative(cachedPickedImage.nativeInfo);
        this.loadRemoteAndShow(cachedPickedImage.url);
    }

    private loadRemoteAndShow(url: string) {
        this.setInfo('正在加载图片…', new Color(220, 225, 235, 255));
        assetManager.loadRemote(url, { ext: '.jpg' }, (err, asset) => {
            if (err) {
                console.error('[ColorMusic] 图片加载失败:', err);
                this.setInfo((isEnglish() ? 'Image failed to load: ' : '图片加载失败：') + (err as any).message, new Color(255, 150, 150, 255));
                return;
            }
            const imgAsset = asset as ImageAsset;
            this.showImage(imgAsset, imgAsset.width, imgAsset.height);
            this.setInfo(isEnglish()
                ? `Image loaded  ${imgAsset.width}×${imgAsset.height}  Hold / drag / tap to play`
                : `图片已加载  ${imgAsset.width}×${imgAsset.height}  按住/滑动/点按发声`, new Color(220, 225, 235, 255));
        });
    }

    /** 显示图片并按当前显示模式（横/竖）适配尺寸。 */
    private showImage(imgAsset: ImageAsset, width: number, height: number) {
        // 释放旧纹理/精灵帧（防止第二次选择时资源冲突）
        const oldSf = this.imageSprite.spriteFrame as any;
        if (oldSf && oldSf.texture) {
            try { (oldSf.texture as any).destroy(); } catch (e) { /* 忽略 */ }
        }
        const tex = new Texture2D();
        tex.image = imgAsset;
        console.log('[CM] Texture2D 创建并赋值');
        const sf = new SpriteFrame();
        sf.texture = tex;
        this.imageSprite.spriteFrame = sf;
        console.log('[CM] SpriteFrame 已赋给 Sprite');
        this.imgNaturalW = width;
        this.imgNaturalH = height;
        this.placeholder.active = false;
        this.fitImageToCurrentMode();

        // 渲染一帧后读取全量像素（回退数据源 / 网格校验）
        this.scheduleOnce(() => {
            try {
                if (!this.store.readFullFromTexture(tex)) {
                    console.warn('[ColorMusic] readPixels 失败，仅使用颜色网格');
                }
            } catch (e) {
                console.warn('[ColorMusic] readPixels 异常:', e);
            }
        }, 0.1);
    }

    /** 按当前显示模式（横/竖）重新铺满图片。 */
    private fitImageToCurrentMode() {
        const portrait = this.currentTarget === -90 || this.currentTarget === 90;
        const view = this.userViewport(portrait);
        this.fitImageToBounds(view.w, view.h);
        if (this.gridTransform) { this.gridTransform.setContentSize(view.w, view.h); this.redrawPlayGrid(); }
    }

    private fitImageToBounds(maxW: number, maxH: number) {
        this.imageTransform.setContentSize(maxW, maxH);
        if (this.imgNaturalW > 0 && this.imgNaturalH > 0) {
            // 等比完整放入屏幕，图片既不拉伸，也不裁切或超出显示范围。
            const ratio = Math.min(maxW / this.imgNaturalW, maxH / this.imgNaturalH);
            this.imageVisualTransform.setContentSize(
                Math.max(1, Math.round(this.imgNaturalW * ratio)),
                Math.max(1, Math.round(this.imgNaturalH * ratio)),
            );
        } else {
            this.imageVisualTransform.setContentSize(maxW, maxH);
        }
        this.placeholderTransform.setContentSize(maxW, maxH);
        if (this.placeholderLabelNode) {
            const portrait = maxH > maxW;
            this.placeholderLabelNode.getComponent(UITransform)!.setContentSize(portrait ? 820 : 1100, portrait ? 620 : 500);
            this.placeholderLabel.fontSize = portrait ? 15 : 17;
            this.placeholderLabel.lineHeight = portrait ? 22 : 24;
        }
        this.drawPlaceholderBorder();
    }

    /* ============================== 触摸 → 声音 ============================== */

    private attachTouch() {
        this.imageDisplay.on(Node.EventType.TOUCH_START, this.onImageTouchStart, this);
        this.imageDisplay.on(Node.EventType.TOUCH_MOVE, this.onImageTouchMove, this);
        this.imageDisplay.on(Node.EventType.TOUCH_END, this.onImageTouchEnd, this);
        this.imageDisplay.on(Node.EventType.TOUCH_CANCEL, this.onImageTouchEnd, this);
        input.on(Input.EventType.TOUCH_END, this.onGlobalTouchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.onGlobalTouchEnd, this);
    }

    /** Input-level fallback for touch sequences whose target node was hidden/rotated before TOUCH_END arrived. */
    private onGlobalTouchEnd(event: EventTouch) {
        const id = event.getID();
        if (!this.activeTouches.has(id)) return;
        this.activeTouches.delete(id);
        this.touchAudioUpdateMs.delete(id);
        this.touchVisualUpdateMs.delete(id);
        this.hideTouchRipple(id);
        if (NativeBridge.isAndroidNative) NativeBridge.noteOff(id); else this.webSynth?.noteOff(id);
    }

    private releaseAllActiveNotes() {
        if (NativeBridge.isAndroidNative) NativeBridge.releaseAllNotes();
        else for (const id of this.activeTouches.keys()) this.webSynth?.noteOff(id);
        this.activeTouches.clear();
        this.touchAudioUpdateMs.clear();
        this.touchVisualUpdateMs.clear();
        this.clearTouchRipples();
    }

    private gridEdgeAt(uv: { u: number; v: number }): 'left' | 'right' | 'top' | 'bottom' | null {
        const candidates: Array<{ edge: 'left' | 'right' | 'top' | 'bottom'; distance: number }> = [
            { edge: 'left', distance: uv.u }, { edge: 'right', distance: 1 - uv.u },
            { edge: 'bottom', distance: uv.v }, { edge: 'top', distance: 1 - uv.v },
        ];
        candidates.sort((a, b) => a.distance - b.distance);
        return candidates[0].distance <= .035 ? candidates[0].edge : null;
    }

    private isSideEdge(edge: 'left' | 'right' | 'top' | 'bottom'): boolean {
        return edge === 'left' || edge === 'right';
    }

    private gridGestureCoord(edge: 'left' | 'right' | 'top' | 'bottom', uv: { u: number; v: number }): number {
        // 左/右边缘沿纵轴操作横线；上/下边缘沿横轴操作竖线。
        return this.isSideEdge(edge) ? uv.v : uv.u;
    }

    private gridLinesForEdge(edge: 'left' | 'right' | 'top' | 'bottom'): number[] {
        return this.isSideEdge(edge) ? this.gridState.horizontalLines : this.gridState.verticalLines;
    }

    private gridPeriodForEdge(edge: 'left' | 'right' | 'top' | 'bottom'): number {
        return this.isSideEdge(edge) ? this.gridState.horizontalPeriod : this.gridState.verticalPeriod;
    }

    private setGridLinesForEdge(edge: 'left' | 'right' | 'top' | 'bottom', lines: number[]) {
        if (this.isSideEdge(edge)) this.gridState.horizontalLines = lines;
        else this.gridState.verticalLines = lines;
    }

    private setGridPeriodForEdge(edge: 'left' | 'right' | 'top' | 'bottom', period: number) {
        if (this.isSideEdge(edge)) this.gridState.horizontalPeriod = period;
        else this.gridState.verticalPeriod = period;
    }

    /** 将一组原点网格图案按周期平铺到整个屏幕，周期边界本身也是网格线。 */
    private repeatedGridLines(lines: number[], period: number): number[] {
        const safePeriod = Math.max(.008, Math.min(8, period));
        const cached = this.repeatedGridCache.get(lines);
        if (cached?.period === safePeriod) return cached.result;
        const pattern = lines.filter((p) => p > 0 && p < safePeriod);
        const result: number[] = [];
        for (let cycle = 0; cycle * safePeriod < 1 && result.length < 512; cycle++) {
            const offset = cycle * safePeriod;
            if (cycle > 0 && offset < 1) result.push(offset);
            for (const p of pattern) {
                const value = offset + p;
                if (value >= 1 || result.length >= 512) break;
                result.push(value);
            }
        }
        this.repeatedGridCache.set(lines, { period: safePeriod, result });
        return result;
    }

    /** 以左下原点等比变换指定分界线以下的线，并限制最小格宽以防线条穿越。 */
    private scaleGridLines(base: number[], requestedFactor: number, threshold: number, allowOffscreen = false): number[] {
        const affected = base.reduce<number[]>((out, p, i) => { if (p < threshold) out.push(i); return out; }, []);
        if (affected.length === 0) return base.slice();
        const lastIndex = affected[affected.length - 1];
        const firstFixed = lastIndex + 1 < base.length ? base[lastIndex + 1] : (allowOffscreen ? 8 : 1);
        const minGap = .0025;
        let minOriginalGap = base[0];
        for (let i = 1; i <= lastIndex; i++) minOriginalGap = Math.min(minOriginalGap, base[i] - base[i - 1]);
        const minFactor = Math.max(.04, minGap / Math.max(minGap, minOriginalGap));
        const maxFactor = Math.max(minFactor, (firstFixed - minGap) / base[lastIndex]);
        const factor = Math.max(minFactor, Math.min(maxFactor, requestedFactor));
        return base.map((p, i) => i <= lastIndex ? p * factor : p);
    }

    private gridCellIndex(value: number, lines: number[]): number {
        for (let i = 0; i < lines.length; i++) if (value < lines[i]) return i;
        return lines.length;
    }

    /** 按下：开始持续音（noteOn），支持多指合奏。 */
    private onImageTouchStart(event: EventTouch) {
        if (this.mainMenuOpen) {
            this.hideMainMenu();
            return;
        }
        if (this.settingsMenu.active) {
            this.settingsMenu.active = false;
            return;
        }
        if (this.guidePanel?.active) {
            return;
        }
        console.log('[CM] 触摸开始 id=', event.getID());
        const uv = this.screenUv(event);
        const edge = this.gridEdgeAt(uv);
        if (edge) {
            const id = event.getID();
            const coord = this.gridGestureCoord(edge, uv);
            this.gridResizeTouches.set(id, {
                edge, startCoord: coord, currentCoord: coord,
                baseLines: this.gridLinesForEdge(edge).slice(), basePeriod: this.gridPeriodForEdge(edge),
            });
            const partner = Array.from(this.gridResizeTouches.entries()).find(([otherId, t]) => otherId !== id && t.edge === edge);
            if (partner && !this.gridPinch) {
                const baseLines = this.gridLinesForEdge(edge).slice();
                const basePeriod = this.gridPeriodForEdge(edge);
                const other = partner[1];
                other.startCoord = other.currentCoord; other.baseLines = baseLines.slice(); other.basePeriod = basePeriod;
                const current = this.gridResizeTouches.get(id)!;
                current.startCoord = current.currentCoord; current.baseLines = baseLines.slice(); current.basePeriod = basePeriod;
                this.gridPinch = {
                    edge, ids: [partner[0], id],
                    startDistance: Math.max(.002, Math.abs(other.currentCoord - current.currentCoord)),
                    baseLines, basePeriod,
                };
            }
            return;
        }
        if (!this.store.ready) {
            this.setInfo('请先选择一张图片！', new Color(255, 180, 120, 255));
            return;
        }
        const id = event.getID();
        this.activeTouches.set(id, null as any);
        this.touchAudioUpdateMs.set(id, Date.now());
        this.playSustain(event);
    }

    /** 滑动：原位更新该手指的持续音（连续滑音，相位连续）。 */
    private onImageTouchMove(event: EventTouch) {
        const id = event.getID();
        const resize = this.gridResizeTouches.get(id);
        if (resize) {
            const uvNow = this.screenUv(event);
            resize.currentCoord = this.gridGestureCoord(resize.edge, uvNow);
            const pinch = this.gridPinch;
            if (pinch && (pinch.ids[0] === id || pinch.ids[1] === id)) {
                const a = this.gridResizeTouches.get(pinch.ids[0]);
                const b = this.gridResizeTouches.get(pinch.ids[1]);
                if (a && b) {
                    const distance = Math.abs(a.currentCoord - b.currentCoord);
                    const requested = Math.min(8 / pinch.basePeriod, distance / pinch.startDistance);
                    const transformed = this.scaleGridLines(pinch.baseLines, requested, Number.POSITIVE_INFINITY, true);
                    const actual = transformed.length ? transformed[0] / pinch.baseLines[0] : requested;
                    this.setGridLinesForEdge(resize.edge, transformed);
                    this.setGridPeriodForEdge(resize.edge, pinch.basePeriod * actual);
                }
            } else if (!pinch || pinch.edge !== resize.edge) {
                const denominator = Math.max(.015, resize.startCoord);
                const requestedFactor = resize.currentCoord / denominator;
                const transformed = this.scaleGridLines(resize.baseLines, requestedFactor, resize.startCoord);
                this.setGridLinesForEdge(resize.edge, transformed);
                // 单指只编辑触点以内的原始线；重复周期及屏幕外线只由双指捏合修改。
            }
            this.redrawPlayGrid();
            const visibleColumns = this.repeatedGridLines(this.gridState.verticalLines, this.gridState.verticalPeriod).length + 1;
            const visibleRows = this.repeatedGridLines(this.gridState.horizontalLines, this.gridState.horizontalPeriod).length + 1;
            this.showGridResizeInfo(isEnglish()
                ? `Grid: ${visibleColumns} columns × ${visibleRows} rows`
                : `网格：${visibleColumns} 列 × ${visibleRows} 行`);
            return;
        }
        if (!this.activeTouches.has(id)) return;
        if (!this.store.ready) return;
        const now = Date.now();
        if (now - (this.touchAudioUpdateMs.get(id) ?? 0) < TOUCH_AUDIO_INTERVAL_MS) return;
        // 距离节流：相对该手指上一次发声点移动 ≥ SLIDE_MIN_DIST 才更新
        const local = this.localFromEvent(event);
        if (!local) return;
        const prev = this.activeTouches.get(id);
        if (prev) {
            const dx = local.x - prev.x;
            const dy = local.y - prev.y;
            if (dx * dx + dy * dy < SLIDE_MIN_DIST * SLIDE_MIN_DIST) return;
        }
        this.touchAudioUpdateMs.set(id, now);
        this.activeTouches.set(id, new Vec3(local.x, local.y, 0));
        this.playSustain(event);
    }

    /** 抬起：释放该手指的持续音。 */
    private onImageTouchEnd(event: EventTouch) {
        const id = event.getID();
        if (this.gridResizeTouches.has(id)) {
            const pinch = this.gridPinch;
            this.gridResizeTouches.delete(id);
            if (pinch && (pinch.ids[0] === id || pinch.ids[1] === id)) {
                this.gridPinch = null;
                const remainingId = pinch.ids[0] === id ? pinch.ids[1] : pinch.ids[0];
                const remaining = this.gridResizeTouches.get(remainingId);
                if (remaining) {
                    remaining.startCoord = remaining.currentCoord;
                    remaining.baseLines = this.gridLinesForEdge(remaining.edge).slice();
                    remaining.basePeriod = this.gridPeriodForEdge(remaining.edge);
                }
            }
            saveGridState(this.gridState);
            if (this.gridResizeTouches.size === 0) {
                this.gridResizeInfoActive = false;
                this.restoreInfoAfterGridResize();
            }
            return;
        }
        if (!this.activeTouches.has(id)) return;
        this.activeTouches.delete(id);
        this.touchAudioUpdateMs.delete(id);
        this.touchVisualUpdateMs.delete(id);
        this.hideTouchRipple(id);
        if (NativeBridge.isAndroidNative) {
            NativeBridge.noteOff(id);
        } else {
            this.webSynth?.noteOff(id);
        }
    }

    /** 触摸事件 → 图片节点局部坐标（含旋转）；在图片外返回 null。 */
    private localFromEvent(event: EventTouch): Vec3 | null {
        const uiPos = event.getUILocation();
        const local = this.imageVisualTransform.convertToNodeSpaceAR(new Vec3(uiPos.x, uiPos.y, 0));
        const size = this.imageVisualTransform.contentSize;
        const halfW = size.width / 2;
        const halfH = size.height / 2;
        if (local.x < -halfW || local.x > halfW || local.y < -halfH || local.y > halfH) return null;
        return local;
    }

    private screenUv(event: EventTouch): { u: number; v: number } {
        const uiPos = event.getUILocation();
        const local = this.gridTransform.convertToNodeSpaceAR(new Vec3(uiPos.x, uiPos.y, 0));
        const cs = this.gridTransform.contentSize;
        return {
            u: Math.max(0, Math.min(1, (local.x + cs.width / 2) / cs.width)),
            v: Math.max(0, Math.min(1, (local.y + cs.height / 2) / cs.height)),
        };
    }

    /**
     * 在触摸点持续发声（noteOn）。
     * 颜色采样用图片局部坐标（跟随图片旋转，保证采到的是屏幕上看到的像素）；
     * 音高/音量用屏幕坐标（X→音高、Y→音量，符合横屏玩法规则）。
     */
    private playSustain(event: EventTouch) {
        const local = this.localFromEvent(event);
        if (!local) return;
        const size = this.imageVisualTransform.contentSize;
        const uImg = (local.x + size.width / 2) / size.width;      // 图片内 0~1
        const vImg = (local.y + size.height / 2) / size.height;    // 图片内 0~1

        // 屏幕坐标（画布未旋转，代表屏幕左→右 / 下→上）
        const screen = this.screenUv(event);
        const uScreen = screen.u, vTopScreen = screen.v;

        const color = this.store.sample(uImg, vImg);
        const params = buildNoteParams(color.r, color.g, color.b, color.a, uScreen, vTopScreen);
        const verticalLines = this.repeatedGridLines(this.gridState.verticalLines, this.gridState.verticalPeriod);
        const horizontalLines = this.repeatedGridLines(this.gridState.horizontalLines, this.gridState.horizontalPeriod);
        const col = this.gridCellIndex(uScreen, verticalLines);
        const row = this.gridCellIndex(vTopScreen, horizontalLines);
        const midi = Math.round(this.gridState.midiMin + ((col + .5) / (verticalLines.length + 1)) * (this.gridState.midiMax - this.gridState.midiMin));
        params.freq = midiToFreq(midi);
        params.volume = this.gridState.volumeMin + ((row + .5) / (horizontalLines.length + 1)) * (this.gridState.volumeMax - this.gridState.volumeMin);

        const touchId = event.getID();
        if (NativeBridge.isAndroidNative) {
            NativeBridge.noteOn(touchId, params.r, params.g, params.b, params.a, params.freq, params.volume);
        } else {
            this.webSynth = this.webSynth ?? new WebSynth();
            this.webSynth.noteOn(touchId, params.r, params.g, params.b, params.a, params.freq, params.volume);
        }

        const now = Date.now();
        const lastVisual = this.touchVisualUpdateMs.get(touchId);
        const firstVisual = lastVisual === undefined;
        if (firstVisual || now - lastVisual >= TOUCH_VISUAL_INTERVAL_MS) {
            this.showTouchRipple(touchId, local.x, local.y, color);
            this.touchVisualUpdateMs.set(touchId, now);
        }
        if (firstVisual || now - this.lastTouchInfoMs >= TOUCH_INFO_INTERVAL_MS) {
            const note = midiToName(midi);
            const summary = colorToneSummary(color.r, color.g, color.b, color.a);
            this.setInfo(
                isEnglish()
                    ? `${summary}  ${note} ${params.freq.toFixed(1)}Hz  Volume ${params.volume.toFixed(2)}`
                    : `${summary}  ${note} ${params.freq.toFixed(1)}Hz  音量 ${params.volume.toFixed(2)}`,
                new Color(220, 225, 235, 255),
            );
            this.lastTouchInfoMs = now;
        }
    }

    private showTouchRipple(touchId: number, localX: number, localY: number,
        color: { r: number; g: number; b: number }) {
        let ripple = this.touchRipples.get(touchId);
        const isNew = !ripple;
        if (!ripple) {
            const node = new Node(`TouchRipple-${touchId}`);
            node.layer = Layers.Enum.UI_2D;
            node.addComponent(UITransform).setContentSize(160, 160);
            const gfx = node.addComponent(Graphics);
            const opacity = node.addComponent(UIOpacity);
            this.imageDisplay.addChild(node);
            ripple = { node, gfx, opacity };
            this.touchRipples.set(touchId, ripple);
        }

        Tween.stopAllByTarget(ripple.node);
        Tween.stopAllByTarget(ripple.opacity);
        ripple.node.setPosition(localX, localY);
        ripple.node.setScale(isNew ? 0.6 : 1, isNew ? 0.6 : 1, 1);
        ripple.gfx.clear();
        ripple.gfx.circle(0, 0, 42);
        ripple.gfx.fillColor = new Color(color.r, color.g, color.b, 210);
        ripple.gfx.fill();
        ripple.opacity.opacity = 255;
        if (isNew) {
            tween(ripple.node).to(0.12, { scale: new Vec3(1, 1, 1) }, { easing: 'quadOut' }).start();
        }
    }

    private hideTouchRipple(touchId: number) {
        const ripple = this.touchRipples.get(touchId);
        if (!ripple) return;
        // 先移出映射；若系统快速复用 touchId，新光点不会被旧淡出回调误删。
        this.touchRipples.delete(touchId);
        Tween.stopAllByTarget(ripple.node);
        Tween.stopAllByTarget(ripple.opacity);
        tween(ripple.node).to(0.16, { scale: new Vec3(1.3, 1.3, 1) }, { easing: 'quadOut' }).start();
        tween(ripple.opacity)
            .to(0.16, { opacity: 0 }, { easing: 'quadOut' })
            .call(() => ripple!.node.destroy())
            .start();
    }

    private clearTouchRipples() {
        for (const ripple of this.touchRipples.values()) {
            Tween.stopAllByTarget(ripple.node);
            Tween.stopAllByTarget(ripple.opacity);
            ripple.node.destroy();
        }
        this.touchRipples.clear();
    }

    /* ============================== 陀螺仪旋转 ============================== */

    private onCalibratePressed() {
        console.log('[CM] 手动校准(绝对)');
        // 消除当前方向的细微偏移，使当前朝向干净吸附到 0/90/180/270
        this.calibOffset = this.deviceAngleSmoothed - Math.round(this.deviceAngleSmoothed / 90) * 90;
        this.calibrated = true;
        this.currentSnapped = this.absSnapped();
        this.applyRotation(this.targetForSnapped(this.currentSnapped), false);
    }

    /**
     * 读取物理方向角（度）：用重力在屏幕面内的分量计算绝对朝向。
     * 设备坐标系横/竖持机为干净的 0/±90°；近水平（重力主要在 z）时方向不可靠，保持当前朝向。
     */
    private readDeviceAngle(event: EventAcceleration): number {
        const g = globalThis as any;
        try {
            if (g.jsb?.device?.getDeviceMotionValue) {
                const v = g.jsb.device.getDeviceMotionValue();
                if (v && v.length >= 6) {
                    const gx = v[3] * 0.1;
                    const gy = v[4] * 0.1;
                    const gz = v[5] * 0.1;
                    return this.angleFromGravity(gx, gy, gz);
                }
            }
        } catch (e) { /* 忽略 */ }
        const a = event.acc;
        if (!a) return this.deviceAngleSmoothed;
        return this.angleFromGravity(a.x, a.y, 0);
    }

    /** 由重力三分量算方向角；近水平（方向不可靠）时返回当前朝向（保持不动）。 */
    private angleFromGravity(gx: number, gy: number, gz: number): number {
        const inPlane = Math.sqrt(gx * gx + gy * gy);
        const mag = Math.sqrt(gx * gx + gy * gy + gz * gz);
        // 重力几乎不在屏面内 → 手机近乎平放，方向角不可靠，保持现状
        if (mag > 0.5 && inPlane / mag < 0.35) return this.deviceAngleSmoothed;
        return Math.atan2(gx, gy) * 180 / Math.PI;
    }

    /**
     * 传感器"自然横向"基线：手机处于软件自然横持（重力沿设备 X 轴）时 atan2(gx,gy)=90°。
     * 绝对角减去该基线后，90° 的倍数正好对应 targetForSnapped 期望的"相对横持"朝向（0=横持、90=竖持），
     * 避免把"横持"误判成"竖持"造成的 90° 顺时针偏移。
     */
    private static readonly LANDSCAPE_ABS = 90;

    /** 校正后的绝对方向角（减去自然横持基线）。 */
    private correctedAngle(): number {
        return this.deviceAngleSmoothed - this.calibOffset - GameManager.LANDSCAPE_ABS;
    }

    /** 当前绝对朝向吸附为 0/90/180/270（相对自然横持）。 */
    private absSnapped(): number {
        const a = this.correctedAngle();
        return ((Math.round(a / 90) * 90) % 360 + 360) % 360;
    }

    private onDeviceMotion(event: EventAcceleration) {
        const angle = this.readDeviceAngle(event);
        // 低通平滑（强平滑，抗抖动）
        this.deviceAngleSmoothed = this.deviceAngleSmoothed * 0.9 + angle * 0.1;
        // 首次启动以当前握持姿态作为横屏基准，避免系统横屏窗口内的 UI 又被传感器旋成竖向。
        if (!this.calibrated) {
            this.calibrationCount++;
            if (this.calibrationCount >= 12) {
                this.calibrated = true;
                if (this.startupLandscapePending) {
                    this.calibOffset = this.deviceAngleSmoothed - GameManager.LANDSCAPE_ABS;
                    this.currentSnapped = 0;
                    this.startupLandscapePending = false;
                } else {
                    this.calibOffset = 0;
                    this.currentSnapped = this.absSnapped();
                }
                const tgt = this.targetForSnapped(this.currentSnapped);
                this.applyRotation(tgt, false);
                console.warn('[CM] 校零完成 snapped=', this.currentSnapped, 'target=', tgt);
            }
            return;
        }
        // 前 60 秒每 2 秒打点角度，便于诊断方向约定
        this.diagCounter++;
        if (this.diagCounter % 20 === 0 && this.diagCounter <= 300) {
            console.log('[CM] absAngle=', this.deviceAngleSmoothed.toFixed(0));
        }
    }

    /** 绝对朝向(0/90/180/270) → 图片目标角度（保持图片相对重力正立）。 */
    private targetForSnapped(s: number): number {
        switch (s) {
            case 90: return -90;   // 竖持 A
            case 270: return 90;   // 竖持 B
            case 180: return 180;  // 倒置
            default: return 0;     // 横持
        }
    }

    /** 应用旋转：根容器随设备旋转；子节点按用户视角的横/竖屏安全区重排。 */
    private applyRotation(target: number, animate: boolean) {
        const from = this.currentTarget;
        this.currentTarget = target;
        console.warn('[CM] applyRotation target=', target, 'from=', from, 'animate=', animate);

        /**
         * uiRoot 的局部坐标就是旋转补偿后的“用户视角坐标”：横屏可见区为
         * 2000×900，竖屏为 900×2000。直接在此坐标系布局，可让 ±90° 和
         * 180° 都得到一致结果，也避免旋转后的控件宽度越过屏幕边缘。
        */
        const portrait = target === 90 || target === -90;
        if (portrait) {
            if (this.audioPanelOpen) this.closeAudioPanel();
            if (this.stylePanelOpen) this.closeStylePanel();
        }
        const targetScale = this.rootScaleFor(portrait);
        const view = this.userViewport(portrait);
        const mainScale = this.mainUiControlScale();
        const cornerInset = MAIN_MENU_BUTTON_SIZE / 2 * mainScale + 6;
        const menuPos: [number, number] = [view.w / 2 - cornerInset, view.h / 2 - cornerInset];
        const bx = view.w / 2 - Math.max(70, 57.5 * mainScale + 12);
        const top = menuPos[1] - 46 * mainScale;
        const menuStep = 39 * mainScale;
        const btnPos: Array<[number, number]> = [
            [bx, top], [bx, top - menuStep], [bx, top - menuStep * 2],
            [bx, top - menuStep * 3], [bx, top - menuStep * 4],
        ];
        const infoPos: [number, number] = [-view.w / 2 + 12, view.h / 2 - 34];
        this.mainMenuCollapsedPosition = menuPos;
        this.mainMenuButtonPositions = btnPos;
        const controls = [this.pickBtn, this.testBtn, this.calibBtn, this.guideBtn, this.waveBtn];

        const placeControls = (withTween: boolean) => {
            for (let i = 0; i < controls.length; i++) {
                const node = controls[i];
                node.angle = 0;
                tween(node).stop();
                const destination = this.mainMenuOpen ? btnPos[i] : menuPos;
                if (withTween && node.active) this.tweenTo(node, destination[0], destination[1]);
                else {
                    node.setPosition(destination[0], destination[1]);
                    node.setScale(this.mainMenuOpen ? mainScale : .001, this.mainMenuOpen ? mainScale : .001, 1);
                }
            }
            this.mainMenuBtn.angle = 0;
            this.mainMenuBtn.setPosition(menuPos[0], menuPos[1]);
            this.mainMenuBtn.setScale(mainScale, mainScale, 1);
            this.languageBtn.angle = 0;
            const languageOffset = (MAIN_MENU_BUTTON_SIZE + LANGUAGE_BUTTON_SIZE) / 2 + MENU_LANGUAGE_GAP;
            this.languageBtn.setPosition(menuPos[0] - languageOffset * mainScale, menuPos[1]);
            this.languageBtn.setScale(mainScale, mainScale, 1);
            let rightmostConsoleX = menuPos[0];
            for (let i = 0; i < this.consoleButtons.length; i++) {
                const node = this.consoleButtons[i];
                node.angle = 0;
                const x = menuPos[0] - 76 * mainScale - view.w / 6 - i * 38 * mainScale;
                if (i === 0) rightmostConsoleX = x;
                if (withTween) this.tweenTo(node, x, menuPos[1], ROT_TWEEN);
                else node.setPosition(x, menuPos[1]);
                node.setScale(mainScale, mainScale, 1);
            }
            this.lockBtn.angle = 0;
            const lockX = (rightmostConsoleX + menuPos[0]) / 2;
            if (withTween) this.tweenTo(this.lockBtn, lockX, menuPos[1], ROT_TWEEN);
            else this.lockBtn.setPosition(lockX, menuPos[1]);
            this.lockBtn.setScale(mainScale, mainScale, 1);
            this.infoNode.angle = 0;
            tween(this.infoNode).stop();
            if (withTween) this.tweenTo(this.infoNode, infoPos[0], infoPos[1]);
            else this.infoNode.setPosition(infoPos[0], infoPos[1]);
            this.settingsMenu.setPosition(view.w / 2 - 125, btnPos[4][1] - 148.5);
        };

        try {
            if (animate && from !== target) {
                // 根容器旋转与横/竖布局切换同步进行。
                this.uiRoot.angle = from;
                placeControls(true);
                tween(this.uiRoot).stop();
                tween(this.uiRoot)
                    .to(ROT_TWEEN, { angle: target, scale: targetScale }, { easing: 'quadInOut' })
                    .start();
                // 并发：波表面板元素按目标方向做位置补间（不改变初末位置）
                if (this.wavePanel && this.wavePanelOpen) {
                    try { this.relayoutWavePanel(target, true); } catch (e) { console.error('[CM] 波表重排异常:', e); }
                }
                if (this.outputPanel?.active) this.relayoutOutputPanel();
                if (this.gridSettings?.panel.active) this.gridSettings.relayout(view.w, view.h, portrait);
                if (this.guidePanel?.active) this.relayoutGuidePanel();
            } else {
                this.uiRoot.angle = target;
                this.uiRoot.setScale(targetScale);
                placeControls(false);
                if (this.wavePanel && this.wavePanelOpen) {
                    try { this.relayoutWavePanel(target, false); } catch (e) { console.error('[CM] 波表重排异常:', e); }
                }
                if (this.outputPanel?.active) this.relayoutOutputPanel();
                if (this.gridSettings?.panel.active) this.gridSettings.relayout(view.w, view.h, portrait);
                if (this.guidePanel?.active) this.relayoutGuidePanel();
            }
        } catch (e) {
            console.error('[CM] applyRotation 异常:', e);
        }
        this.fitImageToCurrentMode();
    }

    /** 每 0.1s：按绝对重力方向吸附到最近 90°（实时校准，与启动朝向无关），带 55° 滞回防抖。 */
    private updateOrientation() {
        if (!this.calibrated) return;
        const angle = this.correctedAngle();
        // 距当前吸附朝向的偏差；<55° 视为仍在当前朝向（滞回防抖，避免近 45° 摆动反复横跳）
        const diff = ((angle - this.currentSnapped + 540) % 360) - 180;
        if (Math.abs(diff) < 55) return;
        const snapped = this.absSnapped();
        if (snapped === this.currentSnapped) return;
        this.currentSnapped = snapped;
        const target = this.targetForSnapped(snapped);
        if (target === this.currentTarget) return;
        this.applyRotation(target, true);
    }

    private showCenterMessage(text: string) {
        this.uiRoot.getChildByName('CenterMessage')?.destroy();
        const view = this.userViewport(false); const width = Math.min(920, view.w - 80); const height = 108;
        const message = new Node('CenterMessage'); message.layer = Layers.Enum.UI_2D; message.addComponent(UITransform).setContentSize(width, height);
        const g = message.addComponent(Graphics); g.roundRect(-width / 2, -height / 2, width, height, 6); g.fillColor = new Color(12, 19, 31, 245); g.fill(); g.lineWidth = 2; g.strokeColor = new Color(70, 190, 115, 255); g.stroke();
        const label = this.makeLabel('Text', text, 22, 30, new Color(240, 248, 244, 255), width - 36, 52); label.setPosition(0, 14); message.addChild(label);
        this.makePanelButton(message, '查看目录', width / 2 - 82, -31, 132, 34, () => NativeBridge.openExportDirectory(), new Color(42, 105, 72, 255));
        const opacity = message.addComponent(UIOpacity); opacity.opacity = 0; this.uiRoot.addChild(message); message.setPosition(0, 0); message.setSiblingIndex(this.uiRoot.children.length - 1);
        tween(opacity).to(.16, { opacity: 255 }).delay(5).to(.24, { opacity: 0 }).call(() => message.destroy()).start();
    }

    private setInfo(text: string, color: Color) {
        if (!this.infoLabel) return;
        const localized = t(text);
        this.infoText = localized;
        this.infoColor = new Color(color.r, color.g, color.b, color.a);
        if (this.gridResizeInfoActive) return;
        this.infoLabel.string = localized;
        this.infoLabel.color = color;
        this.infoNode.active = this.gridState.showToneInfo && !this.uiLocked;
    }

    /** 边缘拖动期间强制显示网格尺寸，不受“显示音色提示”开关影响。 */
    private showGridResizeInfo(text: string) {
        this.gridResizeInfoActive = true;
        this.infoLabel.string = text;
        this.infoLabel.color = new Color(220, 225, 235, 255);
        this.infoNode.active = !this.uiLocked;
    }

    private restoreInfoAfterGridResize() {
        this.infoLabel.string = this.infoText;
        this.infoLabel.color = this.infoColor;
        this.infoNode.active = this.gridState.showToneInfo && !this.uiLocked;
    }

    private refreshInfoVisibility() {
        if (!this.infoNode || this.gridResizeInfoActive) return;
        this.infoNode.active = this.gridState.showToneInfo && !this.uiLocked;
    }

    /** 供调试/插件使用的图片数据访问。 */
    get imageStore(): ImageStore {
        return this.store;
    }
}
