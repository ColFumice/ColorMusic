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

// 设计分辨率 2000×900（20:9，EXACT_FIT 下在 20:9 屏上正好铺满、不变形、无黑边）
const DESIGN_W = 2000;
const DESIGN_H = 900;
const IMG_MAX_W = 2000;          // 横屏播放/显示区：设为整个画布宽度，铺满（去掉内边距）
const IMG_MAX_H = 900;           // 高度铺满
// 竖屏显示区：注意节点旋转 90° 后 局部宽→屏幕高、局部高→屏幕宽，故竖屏模式局部尺寸要"换位"
const IMG_MAX_W_PORTRAIT = 900;  // 竖屏旋转后宽度铺满
const IMG_MAX_H_PORTRAIT = 2000; // 竖屏旋转后高度铺满
const SLIDE_MIN_DIST = 12;       // 滑音最小移动距离（设计单位）

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
const LEGACY_DRUM_IDS: Record<string, string> = {
    kick: 'tr808_kick', snare: 'tr808_snare', clap: 'boombap_clap',
    hihat: 'tr808_hat', tom: 'tr606_kick', maracas: 'lofi_hat',
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
        }, this);
        console.warn('[CM] onLoad 完成');
    }

    /** 应用进入后台：标记，用于区分"启动时的 SHOW"与"从后台恢复的 SHOW"。 */
    private onAppHide() {
        this.appWasHidden = true;
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

    /** 右上角五个常驻圆形控制台按钮：录音、混音、单次、循环、样式。 */
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
        this.consoleButtons = [this.recordBtn, this.mixerBtn, this.playOnceBtn, this.playLoopBtn, this.styleBtn];
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
            for (const id of this.activeTouches.keys()) {
                if (NativeBridge.isAndroidNative) NativeBridge.noteOff(id); else this.webSynth?.noteOff(id);
            }
            for (const id of [-9000, -9100, -9101, -9102]) {
                if (NativeBridge.isAndroidNative) NativeBridge.noteOff(id); else this.webSynth?.noteOff(id);
            }
            this.activeTouches.clear();
            this.clearTouchRipples();
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
        menu.addComponent(UITransform).setContentSize(230, 188);
        const g = menu.addComponent(Graphics);
        g.roundRect(-115, -94, 230, 188, 8);
        g.fillColor = new Color(10, 16, 30, 245); g.fill();
        g.lineWidth = 1.5; g.strokeColor = new Color(120, 140, 180, 255); g.stroke();
        this.uiRoot.addChild(menu);
        const entries: Array<[string, number, () => void]> = [
            ['波表', 61, () => { menu.active = false; this.openWavePanel(); }],
            ['网格', 0, () => { menu.active = false; this.openGridSettings(); }],
            ['输出效果器', -61, () => { menu.active = false; this.openOutputPanel(); }],
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
        const g=this.settingsMenu.getComponent(Graphics)!;g.clear();g.roundRect(-115,-94,230,188,8);g.fillColor=new Color(10,16,30,245);g.fill();g.lineWidth=1.5;g.strokeColor=new Color(120,140,180,255);g.stroke();
        for(const b of this.settingsMenu.children){const bg=b.getChildByName('Bg')?.getComponent(Graphics);if(!bg)continue;bg.clear();bg.roundRect(-105,-26,210,52,10);bg.fillColor=new Color(34,48,78,255);bg.fill();}
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
                title: '录音与混音',
                content: '一.主界面控制台\n1. 红点开始或结束录音；小喇叭打开混音台；单三角播放一次；双三角循环播放。\n2. 录音时屏幕边框为红色，播放时为绿色，同时录音与播放时为橙色。\n3. 单次播放会在所有已启用片段结束后停止；循环播放以最长片段为一轮。\n\n二.混音台\n1. 最多保存 13 个音频片段，点击名称可重命名，左侧圆点控制启用或静音。\n2. 音量滑块调整片段增益；“始”和“末”可精确输入裁剪时间，中间双向滑块可快速裁剪头尾。\n3. 每栏右侧依次提供试听、克隆、删除和导出。克隆会复制当前片段设置。\n4. 导出时可选择无损 WAV 或便于分享的 MP3，MP3 使用 LAME 转换。',
            },
            {
                title: '样式管理',
                content: '一.样式\n1. 点击控制台的横线图标进入样式管理；保存内容包括波表、网格和效果器设置，不包含录音片段。\n2. 绿色边框表示样式，蓝色边框表示样式流；点击名称重命名，展开按钮显示预览。\n3. 样式预览按 R、G、B 左中右排列；每栏可导出、载入或删除。导出后可从中央提示直接查看目录。\n\n二.样式流\n1. 新样式流默认有 5 个节点，最多 13 个；每个节点选择一个已有样式并设置切换时间。\n2. 样式流随循环播放运行，切换时屏幕边框会在 1.3 秒内过渡为蓝色再恢复。\n\n三.文件管理\n1. 导入可从设备中选择样式数据包；导出的数据包保存在游戏文件根目录。\n2. “清空样式栏”和“清空数据包”都会连续询问两次，确认后操作不可撤回。',
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
                    title: 'Recording & Mixer',
                    content: 'I. Console Controls\n1. The red dot starts or stops recording; the speaker opens the mixer; the single triangle plays once; the double triangle loops.\n2. The screen border is red while recording, green while playing, and orange when both are active.\n3. Play Once stops after all enabled clips finish. Loop Playback uses the longest enabled clip as one cycle.\n\nII. Mixer\n1. Store up to 13 clips. Tap a name to rename it; use the left dot to enable or mute it.\n2. The volume slider changes clip gain. Start and End accept exact trim times, while the dual-handle range provides quick trimming.\n3. Row actions provide preview, clone, delete and export. Choose lossless WAV or shareable MP3 when exporting; MP3 uses LAME conversion.',
                },
                {
                    title: 'Style Manager',
                    content: 'I. Styles\n1. Open Style Manager with the console lines icon. A style stores wavetable, grid and effect settings, but not recorded clips.\n2. Green borders identify styles and blue borders identify flows. Tap names to rename and expand rows for previews.\n3. RGB previews run left, center and right. Each row can export, load or delete; after export, View Folder opens the package directory.\n\nII. Style Flows\n1. A new flow starts with five nodes and supports up to 13. Each node selects an owned style and a switch delay.\n2. Flows run with loop playback. A style switch flashes the border blue and restores it within 1.3 seconds.\n\nIII. Files\n1. Import selects a style package from the device. Exported packages are stored in the game file root.\n2. Clear Style List and Clear Packages both require two confirmations and cannot be undone.',
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
                    id: `clip_${Date.now()}`, name: '新音频', path: this.recordingPath,
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
        try { const raw = sys.localStorage.getItem('cm_audio_clips'); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : []; } catch (e) { return []; }
    }
    private saveAudioClips() { try { sys.localStorage.setItem('cm_audio_clips', JSON.stringify(this.recordedClips.slice(0, 13))); } catch (e) { /* ignore */ } }

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
        const title = this.makeLabel('AudioMixerTitle', isEnglish() ? 'Audio Mixer' : '混音台', 30, 38, new Color(240, 244, 252, 255), 700, 50); panel.addChild(title);
        const close = this.makePanelButton(panel, isEnglish() ? 'Close' : '关闭', 0, 0, 110, 42, () => this.closeAudioPanel(), new Color(45, 58, 88, 255)); close.name = 'AudioClose';
        const swallow = (e: EventTouch) => { e.propagationStopped = true; };
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
        g.lineWidth = 1.5; g.strokeColor = new Color(95, 125, 165, 255); g.rect(-view.w / 2 + 1, -view.h / 2 + 1, view.w - 2, view.h - 2); g.stroke();
        panel.getChildByName('AudioMixerTitle')?.setPosition(0, view.h / 2 - 34);
        panel.getChildByName('AudioClose')?.setPosition(view.w / 2 - 68, view.h / 2 - 34);
        this.redrawPanelButtons(panel);
    }

    private closeAudioPanel() { if (this.audioPanel) { this.audioPanel.active = false; this.audioPanelOpen = false; } }

    private rebuildAudioRows() {
        if (!this.audioPanel) return;
        for (const row of this.clipRows) row.destroy();
        this.clipRows = [];
        const panel = this.audioPanel;
        const view = this.userViewport(false); const rowW = view.w - 40;
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

    private renameAudioClip(clip: AudioClipMeta) { NativeBridge.promptText('重命名音频', clip.name, (value) => { if (value.trim()) clip.name = value.trim(); this.saveAudioClips(); this.rebuildAudioRows(); }); }
    private editClipTrim(clip: AudioClipMeta, start: boolean) { const duration = Math.max(.1, clip.duration); const initial = start ? clip.trimStart : (clip.trimEnd || duration); NativeBridge.promptText(start ? '首端裁剪（秒）' : '末端裁剪（秒）', initial.toFixed(2), (value) => { const n = Number(value); if (!Number.isFinite(n)) return; if (start) clip.trimStart = Math.max(0, Math.min(n, (clip.trimEnd || duration) - .05)); else clip.trimEnd = Math.max(clip.trimStart + .05, Math.min(n, duration)); this.saveAudioClips(); this.rebuildAudioRows(); }); }

    private makeTrimRangeSlider(parent: Node, clip: AudioClipMeta, x: number, y: number, width: number, refreshLabels: () => void) {
        const node = new Node('TrimRange'); node.layer = Layers.Enum.UI_2D; const transform = node.addComponent(UITransform); transform.setContentSize(width, 36); node.setPosition(x, y); const g = node.addComponent(Graphics); let activeHandle: 'start' | 'end' = 'start';
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
        const finish = (e: EventTouch) => { this.saveAudioClips(); e.propagationStopped = true; };
        node.on(Node.EventType.TOUCH_END, finish, this); node.on(Node.EventType.TOUCH_CANCEL, finish, this); parent.addChild(node); draw();
    }
    private cloneAudioClip(clip: AudioClipMeta) { if (this.recordedClips.length >= 13) { this.setInfo('最多支持 13 个音频片段', new Color(255, 190, 120, 255)); return; } this.recordedClips.unshift({ ...clip, id: `clip_${Date.now()}`, name: `${clip.name} 副本` }); this.saveAudioClips(); this.rebuildAudioRows(); }
    private makeCloneButton(parent: Node, x: number, y: number, cb: () => void) { const b = this.makePanelButton(parent, '', x, y, 42, 34, cb, new Color(42, 72, 115, 255)); const icon = new Node('CloneIcon'); icon.layer = Layers.Enum.UI_2D; icon.addComponent(UITransform).setContentSize(24, 24); b.addChild(icon); const g = icon.addComponent(Graphics); g.lineWidth = 1.5; g.strokeColor = new Color(255, 255, 255, 255); g.rect(-8, -8, 12, 12); g.stroke(); g.rect(-3, -3, 12, 12); g.stroke(); return b; }

    private exportAudioClip(clip: AudioClipMeta) {
        if (NativeBridge.isAndroidNative) {
            NativeBridge.chooseAudioExportFormat(format => {
                if (!format) return;
                const path = NativeBridge.exportAudio(clip.path, clip.name, format);
                const failed = !path || path.startsWith('ERROR:');
                if (failed) this.setInfo(path.replace(/^ERROR:/, '') || '音频导出失败', new Color(255, 150, 150, 255));
                else this.showCenterMessage('导出成功，音频已保存至游戏文件根目录');
            });
            return;
        }
        this.setInfo('浏览器预览不支持导出原生录音', new Color(255, 190, 120, 255));
    }

    private makePanelButton(parent: Node, text: string, x: number, y: number, w: number, h: number, cb: () => void, color: Color): Node {
        const node = new Node(`PanelButton-${text}-${Math.random()}`); node.layer = Layers.Enum.UI_2D; node.addComponent(UITransform).setContentSize(w, h); const button = node.addComponent(Button); button.transition = Button.Transition.SCALE; node.addComponent(Graphics); (node as any).__panelButtonStyle = { w, h, color: new Color(color.r, color.g, color.b, color.a) }; this.redrawPanelButton(node); const label = this.makeLabel('Text', text, Math.max(14, Math.min(22, h * .48)), h, new Color(245, 248, 255, 255), w, h); node.addChild(label); node.setPosition(x, y); node.on(Button.EventType.CLICK, cb, this); parent.addChild(node); return node;
    }

    private redrawPanelButton(node: Node) {
        const style = (node as any).__panelButtonStyle as { w: number; h: number; color: Color } | undefined;
        const g = node.getComponent(Graphics); if (!style || !g) return;
        g.clear(); g.roundRect(-style.w / 2, -style.h / 2, style.w, style.h, Math.min(8, style.h / 3)); g.fillColor = style.color; g.fill();
        g.lineWidth = 1.2; g.strokeColor = new Color(125, 150, 188, 230); g.stroke();
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
        for (const leftButton of [save, flow, imp, clearList, clearPackages]) leftButton.addComponent(UIOpacity).opacity = 128;
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

    private renameStyle(style: StyleSnapshot) { NativeBridge.promptText('重命名样式', style.name, (value) => { if (value.trim()) style.name = value.trim(); this.saveStyles(); this.rebuildStyleRows(); }); }

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
        };
    }

    private saveCurrentStyle() { this.styles.push(this.captureStyle('style', '新样式')); this.saveStyles(); this.setInfo('已保存新样式', new Color(220, 225, 235, 255)); }

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
        const flow = this.captureStyle('flow', '新样式流'); flow.flowNodes = this.flowEditorNodes.map((n) => ({ ...n })); this.styles.push(flow); this.saveStyles(); this.closeStyleFlowEditor(); this.setInfo('已保存新样式流', new Color(220, 225, 235, 255));
    }
    private loadStyles(): StyleSnapshot[] { try { const raw = sys.localStorage.getItem('cm_styles'); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : []; } catch (e) { return []; } }
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
        // 距离节流：相对该手指上一次发声点移动 ≥ SLIDE_MIN_DIST 才更新
        const local = this.localFromEvent(event);
        if (!local) return;
        const prev = this.activeTouches.get(id);
        if (prev) {
            const dx = local.x - prev.x;
            const dy = local.y - prev.y;
            if (dx * dx + dy * dy < SLIDE_MIN_DIST * SLIDE_MIN_DIST) return;
        }
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

        this.showTouchRipple(touchId, local.x, local.y, color);
        const note = midiToName(midi);
        const summary = colorToneSummary(color.r, color.g, color.b, color.a);
        this.setInfo(
            isEnglish()
                ? `${summary}  ${note} ${params.freq.toFixed(1)}Hz  Volume ${params.volume.toFixed(2)}`
                : `${summary}  ${note} ${params.freq.toFixed(1)}Hz  音量 ${params.volume.toFixed(2)}`,
            new Color(220, 225, 235, 255),
        );
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
        // 启动校零：等平滑值收敛后（前 12 次采样），按绝对方向确定初始朝向
        if (!this.calibrated) {
            this.calibrationCount++;
            if (this.calibrationCount >= 12) {
                this.calibrated = true;
                this.calibOffset = 0;
                this.currentSnapped = this.absSnapped();
                const tgt = this.targetForSnapped(this.currentSnapped);
                this.applyRotation(tgt, false);
                console.warn('[CM] 校零完成(绝对) snapped=', this.currentSnapped, 'target=', tgt);
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
            this.settingsMenu.setPosition(view.w / 2 - 125, btnPos[4][1] - 118);
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
