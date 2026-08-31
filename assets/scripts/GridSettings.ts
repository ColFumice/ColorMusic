import { Node, UITransform, Graphics, Label, Color, Vec3, EventTouch, Layers, EditBox, sys } from 'cc';
import { Dropdown } from './Dropdown';
import { MIDI_MIN, MIDI_MAX, midiToName } from './SynthMapping';
import { isEnglish, t } from './I18n';

export interface GridState {
    visible: boolean;
    showToneInfo: boolean;
    horizontalColor: string;
    verticalColor: string;
    horizontalAlpha: number;
    verticalAlpha: number;
    midiMin: number;
    midiMax: number;
    volumeMin: number;
    volumeMax: number;
    columns: number;
    rows: number;
    /** 以屏幕左下角为原点的内部竖线/横线归一化坐标（0~1，不含边框）。 */
    verticalLines: number[];
    horizontalLines: number[];
    /** 自左下原点开始重复的横纵网格图案周期；1 表示正好覆盖一屏。 */
    verticalPeriod: number;
    horizontalPeriod: number;
}

export function uniformGridLines(divisions: number): number[] {
    return Array.from({ length: Math.max(1, divisions) - 1 }, (_, i) => (i + 1) / divisions);
}

function sanitizeLines(value: unknown, divisions: number): number[] {
    const fallback = uniformGridLines(divisions);
    if (!Array.isArray(value) || value.length !== divisions - 1) return fallback;
    const lines = value.map(Number);
    // 双指从原点整体放大时，远端线允许暂时移出屏幕；缩小时可重新进入。
    if (lines.some((v) => !Number.isFinite(v) || v <= 0 || v >= 8)) return fallback;
    for (let i = 1; i < lines.length; i++) if (lines[i] <= lines[i - 1]) return fallback;
    return lines;
}

export const GRID_COLORS: Record<string, Color> = {
    black: new Color(0, 0, 0, 255),
    white: new Color(255, 255, 255, 255),
    red: new Color(255, 70, 70, 255),
    yellow: new Color(255, 220, 60, 255),
    green: new Color(70, 230, 100, 255),
    blue: new Color(70, 120, 255, 255),
    cyan: new Color(55, 225, 235, 255),
    purple: new Color(180, 80, 235, 255),
};

export const DEFAULT_GRID_COLUMNS = 30;
export const DEFAULT_GRID_ROWS = 12;

export function defaultGridState(): GridState {
    const columns = DEFAULT_GRID_COLUMNS, rows = DEFAULT_GRID_ROWS;
    return {
        visible: true,
        showToneInfo: true,
        horizontalColor: 'white', verticalColor: 'white',
        horizontalAlpha: .35, verticalAlpha: .35,
        midiMin: MIDI_MIN, midiMax: MIDI_MAX,
        volumeMin: .06, volumeMax: 1,
        columns, rows,
        verticalLines: uniformGridLines(columns),
        horizontalLines: uniformGridLines(rows),
        verticalPeriod: 1,
        horizontalPeriod: 1,
    };
}

export function loadGridState(): GridState {
    const d = defaultGridState();
    try {
        const raw = sys.localStorage.getItem('cm_grid_state');
        const p = raw ? JSON.parse(raw) : {};
        return sanitizeGridState({ ...d, ...p });
    } catch (e) { return d; }
}

export function saveGridState(s: GridState) {
    try { sys.localStorage.setItem('cm_grid_state', JSON.stringify(sanitizeGridState(s))); } catch (e) { /* 忽略 */ }
}

export function sanitizeGridState(s: GridState): GridState {
    const d = defaultGridState();
    const midiMin = Math.max(MIDI_MIN, Math.min(MIDI_MAX - 1, Math.round(Number(s.midiMin) || d.midiMin)));
    const midiMax = Math.max(midiMin + 1, Math.min(MIDI_MAX, Math.round(Number(s.midiMax) || d.midiMax)));
    const volumeMin = Math.max(0, Math.min(.95, Number(s.volumeMin)));
    const volumeMax = Math.max(volumeMin + .01, Math.min(1, Number(s.volumeMax)));
    const columns = Math.max(2, Math.min(64, Math.round(Number(s.columns) || d.columns)));
    const rows = Math.max(2, Math.min(48, Math.round(Number(s.rows) || d.rows)));
    const verticalLines = sanitizeLines(s.verticalLines, columns);
    const horizontalLines = sanitizeLines(s.horizontalLines, rows);
    const period = (value: unknown, lines: number[]) => {
        const requested = Number(value);
        const afterLast = lines.length ? lines[lines.length - 1] + .004 : .02;
        return Math.max(.008, Math.min(8, Math.max(Number.isFinite(requested) ? requested : 1, afterLast)));
    };
    return {
        visible: !!s.visible,
        showToneInfo: s.showToneInfo !== false,
        horizontalColor: GRID_COLORS[s.horizontalColor] ? s.horizontalColor : d.horizontalColor,
        verticalColor: GRID_COLORS[s.verticalColor] ? s.verticalColor : d.verticalColor,
        horizontalAlpha: Math.max(0, Math.min(1, Number(s.horizontalAlpha))),
        verticalAlpha: Math.max(0, Math.min(1, Number(s.verticalAlpha))),
        midiMin, midiMax, volumeMin, volumeMax,
        columns, rows,
        verticalLines,
        horizontalLines,
        verticalPeriod: period(s.verticalPeriod, verticalLines),
        horizontalPeriod: period(s.horizontalPeriod, horizontalLines),
    };
}

type SliderRef = { node: Node; gfx: Graphics; valueLabel: Label; value: number; min: number; max: number; format: (v: number) => string };

export class GridSettingsUI {
    readonly panel: Node;
    private panelTransform: UITransform;
    private panelGfx: Graphics;
    private state: GridState;
    private onChanged: (state: GridState) => void;
    private onClose: () => void;
    private title: Node;
    private visibilityNode: Node;
    private toneInfoNode: Node;
    private horizontalDd: Dropdown;
    private verticalDd: Dropdown;
    private hAlpha: SliderRef;
    private vAlpha: SliderRef;
    private colSlider: SliderRef;
    private rowSlider: SliderRef;
    private inputs: Record<string, EditBox> = {};
    private labels: Node[] = [];
    private buttons: Node[] = [];
    private soloSnapshot: Map<Node, boolean> | null = null;

    constructor(parent: Node, state: GridState, onChanged: (state: GridState) => void, onClose: () => void) {
        this.state = sanitizeGridState(state);
        this.onChanged = onChanged;
        this.onClose = onClose;
        const panel = new Node('GridSettingsPanel');
        panel.layer = Layers.Enum.UI_2D;
        this.panelTransform = panel.addComponent(UITransform);
        this.panelTransform.setContentSize(1440, 900);
        this.panelGfx = panel.addComponent(Graphics);
        parent.addChild(panel);
        this.panel = panel;

        this.title = this.makeLabel('网格设置', 32, 600, 46);
        const colorItems = [
            ['black', '黑'], ['white', '白'], ['red', '红'], ['yellow', '黄'],
            ['green', '绿'], ['blue', '蓝'], ['cyan', '青'], ['purple', '紫'],
        ].map(([id, label]) => ({ id, label }));
        const colorDesc = (id: string) => {
            const color = colorItems.find((x) => x.id === id)?.label ?? '';
            return t(`选择网格线颜色：${color}。边缘 0.3mm 始终保持白色且完全不透明。`,
                `Grid line color: ${t(color)}. The outer 0.3 mm edge stays solid white.`);
        };
        this.horizontalDd = new Dropdown(panel, colorItems, this.state.horizontalColor, colorDesc, (id) => { this.state.horizontalColor = id; this.commit(); });
        this.verticalDd = new Dropdown(panel, colorItems, this.state.verticalColor, colorDesc, (id) => { this.state.verticalColor = id; this.commit(); });

        this.visibilityNode = this.makeCheckbox('显示网格线', this.state.visible, (v) => { this.state.visible = v; this.commit(); });
        this.toneInfoNode = this.makeCheckbox('显示音色提示', this.state.showToneInfo, (v) => { this.state.showToneInfo = v; this.commit(); });
        this.hAlpha = this.makeSlider(this.state.horizontalAlpha, 0, 1, (v) => { this.state.horizontalAlpha = v; this.commit(); }, true, (v) => `${Math.round(v * 100)}%`);
        this.vAlpha = this.makeSlider(this.state.verticalAlpha, 0, 1, (v) => { this.state.verticalAlpha = v; this.commit(); }, true, (v) => `${Math.round(v * 100)}%`);
        this.colSlider = this.makeSlider(this.state.columns, 2, 64, (v) => {
            const columns = Math.round(v);
            if (columns !== this.state.columns) {
                this.state.verticalLines = uniformGridLines(columns);
                this.state.verticalPeriod = 1;
            }
            this.state.columns = columns; this.syncInputs(); this.commit();
        }, false, (v) => isEnglish() ? `${Math.round(v)} cols` : `${Math.round(v)} 列`);
        this.rowSlider = this.makeSlider(this.state.rows, 2, 48, (v) => {
            const rows = Math.round(v);
            if (rows !== this.state.rows) {
                this.state.horizontalLines = uniformGridLines(rows);
                this.state.horizontalPeriod = 1;
            }
            this.state.rows = rows; this.syncInputs(); this.commit();
        }, false, (v) => isEnglish() ? `${Math.round(v)} rows` : `${Math.round(v)} 行`);

        this.inputs.midiMin = this.makeInput(String(this.state.midiMin), (v) => { this.state.midiMin = Number(v); this.commitAndSync(); });
        this.inputs.midiMax = this.makeInput(String(this.state.midiMax), (v) => { this.state.midiMax = Number(v); this.commitAndSync(); });
        this.inputs.volumeMin = this.makeInput(String(Math.round(this.state.volumeMin * 100)), (v) => { this.state.volumeMin = Number(v) / 100; this.commitAndSync(); });
        this.inputs.volumeMax = this.makeInput(String(Math.round(this.state.volumeMax * 100)), (v) => { this.state.volumeMax = Number(v) / 100; this.commitAndSync(); });
        this.inputs.columns = this.makeInput(String(this.state.columns), (v) => {
            const columns = Math.round(Number(v));
            if (Number.isFinite(columns) && columns !== this.state.columns) {
                this.state.columns = columns; this.state.verticalLines = uniformGridLines(columns); this.state.verticalPeriod = 1;
            }
            this.commitAndSync();
        });
        this.inputs.rows = this.makeInput(String(this.state.rows), (v) => {
            const rows = Math.round(Number(v));
            if (Number.isFinite(rows) && rows !== this.state.rows) {
                this.state.rows = rows; this.state.horizontalLines = uniformGridLines(rows); this.state.horizontalPeriod = 1;
            }
            this.commitAndSync();
        });

        this.buttons.push(this.makeButton('重置', () => { this.state = defaultGridState(); this.refresh(); this.commit(); }));
        this.buttons.push(this.makeButton('关闭', () => this.onClose()));
        panel.active = false;
    }

    get value(): GridState { return this.state; }

    open(width: number, height: number, portrait: boolean) {
        this.panel.active = true;
        this.panel.setSiblingIndex(this.panel.parent!.children.length - 1);
        this.relayout(width, height, portrait);
        this.refresh();
        this.redrawChrome();
    }

    close() { this.horizontalDd.close(); this.verticalDd.close(); this.panel.active = false; }

    relayout(width: number, height: number, portrait: boolean) {
        this.panelTransform.setContentSize(width, height);
        this.redrawBackground();
        const set = (n: Node, x: number, y: number) => n.setPosition(x, y);
        if (portrait) {
            set(this.title, 0, height / 2 - 52);
            set(this.visibilityNode, -260, height / 2 - 125);
            set(this.toneInfoNode, 200, height / 2 - 125);
            this.placeRowLabel('横线颜色', -250, height / 2 - 210, 0); set(this.horizontalDd.chip, 120, height / 2 - 210);
            this.placeRowLabel('横线透明度', -250, height / 2 - 285, 1); set(this.hAlpha.node, 130, height / 2 - 285);
            this.placeRowLabel('竖线颜色', -250, height / 2 - 380, 2); set(this.verticalDd.chip, 120, height / 2 - 380);
            this.placeRowLabel('竖线透明度', -250, height / 2 - 455, 3); set(this.vAlpha.node, 130, height / 2 - 455);
            this.placeRangeRows(0, height / 2 - 555, true);
            this.placeDensityRows(0, height / 2 - 790, true);
            set(this.buttons[0], -120, -height / 2 + 70); set(this.buttons[1], 120, -height / 2 + 70);
        } else {
            set(this.title, 0, height / 2 - 46);
            set(this.visibilityNode, -width / 2 + 170, height / 2 - 105);
            set(this.toneInfoNode, -width / 2 + 500, height / 2 - 105);
            this.placeRowLabel('横线颜色', -560, 255, 0); set(this.horizontalDd.chip, -280, 255);
            this.placeRowLabel('横线透明度', -560, 165, 1); set(this.hAlpha.node, -270, 165);
            this.placeRowLabel('竖线颜色', 160, 255, 2); set(this.verticalDd.chip, 440, 255);
            this.placeRowLabel('竖线透明度', 160, 165, 3); set(this.vAlpha.node, 450, 165);
            this.placeRangeRows(-300, 45, false);
            this.placeDensityRows(300, 45, false);
            set(this.buttons[0], -120, -height / 2 + 62); set(this.buttons[1], 120, -height / 2 + 62);
        }
    }

    private placeRangeRows(cx: number, top: number, portrait: boolean) {
        this.placeRowLabel('左右音阶范围（MIDI）', cx - (portrait ? 250 : 250), top, 4);
        this.inputs.midiMin.node.setPosition(cx + 80, top);
        this.inputs.midiMax.node.setPosition(cx + 250, top);
        this.placeRowLabel(`${midiToName(this.state.midiMin)} → ${midiToName(this.state.midiMax)}`, cx - (portrait ? 250 : 250), top - 72, 5);
        this.placeRowLabel('上下音量范围（%）', cx - (portrait ? 250 : 250), top - 145, 6);
        this.inputs.volumeMin.node.setPosition(cx + 80, top - 145);
        this.inputs.volumeMax.node.setPosition(cx + 250, top - 145);
    }

    private placeDensityRows(cx: number, top: number, portrait: boolean) {
        // 收窄并右移标签，避开左侧范围输入框，同时与本组数据框保留间距。
        this.placeRowLabel('横向疏密（列）', cx - 165, top, 7);
        this.labels[7].getComponent(UITransform)!.setContentSize(220, 42);
        this.inputs.columns.node.setPosition(cx + 20, top);
        this.colSlider.node.setPosition(cx + 235, top);
        this.placeRowLabel('纵向疏密（行）', cx - 165, top - 120, 8);
        this.labels[8].getComponent(UITransform)!.setContentSize(220, 42);
        this.inputs.rows.node.setPosition(cx + 20, top - 120);
        this.rowSlider.node.setPosition(cx + 235, top - 120);
    }

    private placeRowLabel(text: string, x: number, y: number, index: number) {
        while (this.labels.length <= index) this.labels.push(this.makeLabel('', 23, 300, 42));
        const n = this.labels[index];
        n.getComponent(Label)!.string = t(text);
        n.setPosition(x, y);
    }

    private makeLabel(text: string, size: number, w: number, h: number): Node {
        const n = new Node('GridLabel'); n.layer = Layers.Enum.UI_2D;
        n.addComponent(UITransform).setContentSize(w, h); this.panel.addChild(n);
        const l = n.addComponent(Label); l.string = t(text); l.fontSize = size; l.lineHeight = size + 6; l.isSystemFontUsed = true;
        l.overflow = Label.Overflow.SHRINK; l.enableWrapText = false;
        l.horizontalAlign = Label.HorizontalAlign.CENTER; l.verticalAlign = Label.VerticalAlign.CENTER; l.color = new Color(235, 240, 250, 255);
        return n;
    }

    private makeCheckbox(text: string, initial: boolean, onVal: (v: boolean) => void): Node {
        const n = new Node('GridCheckbox'); n.layer = Layers.Enum.UI_2D; n.addComponent(UITransform).setContentSize(300, 48); this.panel.addChild(n);
        const box = new Node('Box'); box.layer = Layers.Enum.UI_2D; box.addComponent(UITransform).setContentSize(38, 38); box.setPosition(-120, 0); n.addChild(box);
        const label = this.makeChildLabel(n, text, 23, 240, 48); label.node.setPosition(30, 0);
        const redraw = (v: boolean) => { const g = box.getComponent(Graphics) ?? box.addComponent(Graphics); g.clear(); g.roundRect(-17,-17,34,34,5); g.fillColor=new Color(24,32,56,255); g.fill(); g.lineWidth=2; g.strokeColor=new Color(170,190,225,255); g.stroke(); if(v){g.moveTo(-9,0);g.lineTo(-2,-8);g.lineTo(11,10);g.lineWidth=4;g.strokeColor=new Color(90,235,130,255);g.stroke();} };
        let value = initial; redraw(value);
        n.on(Node.EventType.TOUCH_END, (e: EventTouch) => { e.propagationStopped = true; value = !value; redraw(value); onVal(value); }, this);
        (n as any).__setChecked = (v: boolean) => { value = v; redraw(v); };
        return n;
    }

    private makeSlider(value: number, min: number, max: number, onVal: (v: number) => void, solo: boolean, format: (v: number) => string): SliderRef {
        const n = new Node('GridSlider'); n.layer = Layers.Enum.UI_2D; n.addComponent(UITransform).setContentSize(340, 62); this.panel.addChild(n);
        const g = n.addComponent(Graphics);
        const valueLabel = this.makeChildLabel(n, '', 20, 80, 34); valueLabel.node.setPosition(125, 22);
        const ref: SliderRef = { node:n, gfx:g, valueLabel, value, min, max, format };
        const update = (event: EventTouch) => {
            const p = n.getComponent(UITransform)!.convertToNodeSpaceAR(new Vec3(event.getUILocation().x, event.getUILocation().y, 0));
            ref.value = min + Math.max(0, Math.min(1, (p.x + 140) / 280)) * (max - min);
            this.redrawSlider(ref); onVal(ref.value);
        };
        n.on(Node.EventType.TOUCH_START, (e: EventTouch) => { e.propagationStopped=true; if(solo)this.setSolo(n,true); update(e); }, this);
        n.on(Node.EventType.TOUCH_MOVE, (e: EventTouch) => { e.propagationStopped=true; update(e); }, this);
        const end = (e: EventTouch) => { e.propagationStopped=true; update(e); if(solo)this.setSolo(n,false); };
        n.on(Node.EventType.TOUCH_END, end, this); n.on(Node.EventType.TOUCH_CANCEL, end, this);
        this.redrawSlider(ref); return ref;
    }

    private redrawSlider(s: SliderRef) {
        const t = Math.max(0, Math.min(1, (s.value - s.min) / (s.max - s.min)));
        const g=s.gfx; g.clear(); g.roundRect(-140,-5,280,10,5); g.fillColor=new Color(70,82,110,255); g.fill(); g.roundRect(-140,-5,280*t,10,5); g.fillColor=new Color(90,150,240,255); g.fill(); g.circle(-140+280*t,0,15); g.fillColor=new Color(240,245,255,255); g.fill();
        s.valueLabel.string=s.format(s.value);
    }

    private makeInput(initial: string, onEnd: (value: string) => void): EditBox {
        const n=new Node('GridInput'); n.active=false; n.layer=Layers.Enum.UI_2D; n.addComponent(UITransform).setContentSize(130,52); this.panel.addChild(n);
        const bg=new Node('Bg');bg.layer=Layers.Enum.UI_2D;bg.addComponent(UITransform).setContentSize(130,52);n.addChild(bg);
        const g=bg.addComponent(Graphics); g.roundRect(-65,-26,130,52,8);g.fillColor=new Color(24,32,56,255);g.fill();g.lineWidth=1.5;g.strokeColor=new Color(120,145,190,255);g.stroke();
        const text=this.makeChildLabel(n,initial,22,118,46); text.horizontalAlign=Label.HorizontalAlign.CENTER;text.overflow=Label.Overflow.CLAMP;
        const placeholder=this.makeChildLabel(n,t('输入'),20,118,46); placeholder.color=new Color(130,140,160,255);placeholder.overflow=Label.Overflow.CLAMP;
        // EditBox positions labels from the input's top-left corner. Its native
        // implementation expects this anchor; the default center anchor puts
        // the value above and to the left of the visible input background.
        text.node.getComponent(UITransform)!.setAnchorPoint(0, 1);
        placeholder.node.getComponent(UITransform)!.setAnchorPoint(0, 1);
        const eb=n.addComponent(EditBox); eb.textLabel=text; eb.placeholderLabel=placeholder; eb.string=initial; eb.inputMode=EditBox.InputMode.NUMERIC; eb.returnType=EditBox.KeyboardReturnType.DONE;
        n.on(EditBox.EventType.EDITING_DID_ENDED,()=>onEnd(eb.string),this);
        n.active=true;
        // Activation runs EditBox.__preload(), which rewrites label geometry.
        // Apply the final centered geometry after that native initialization.
        for (const label of [text, placeholder]) {
            const ut=label.node.getComponent(UITransform)!;
            ut.setAnchorPoint(0,1);ut.setContentSize(130,52);
            label.node.setPosition(-65,26);
            label.horizontalAlign=Label.HorizontalAlign.CENTER;
            label.verticalAlign=Label.VerticalAlign.CENTER;
            label.overflow=Label.Overflow.CLAMP;
            label.enableWrapText=false;
        }
        return eb;
    }

    private makeChildLabel(parent: Node,text:string,size:number,w:number,h:number):Label{
        const n=new Node('Text');n.layer=Layers.Enum.UI_2D;n.addComponent(UITransform).setContentSize(w,h);parent.addChild(n);const l=n.addComponent(Label);l.string=t(text);l.fontSize=size;l.lineHeight=size+5;l.isSystemFontUsed=true;l.horizontalAlign=Label.HorizontalAlign.LEFT;l.verticalAlign=Label.VerticalAlign.CENTER;l.overflow=Label.Overflow.SHRINK;l.enableWrapText=false;l.color=new Color(235,240,250,255);return l;
    }

    private makeButton(text:string,cb:()=>void):Node{
        const n=new Node('GridButton');n.layer=Layers.Enum.UI_2D;n.addComponent(UITransform).setContentSize(190,58);this.panel.addChild(n);const g=n.addComponent(Graphics);g.roundRect(-95,-29,190,58,10);g.fillColor=new Color(44,64,104,255);g.fill();const l=this.makeChildLabel(n,text,24,190,58);l.horizontalAlign=Label.HorizontalAlign.CENTER;n.on(Node.EventType.TOUCH_END,(e:EventTouch)=>{e.propagationStopped=true;cb();},this);return n;
    }

    private setSolo(slider:Node,active:boolean){
        if(active){this.soloSnapshot=new Map();for(const c of this.panel.children){this.soloSnapshot.set(c,c.active);if(c!==slider)c.active=false;}this.panelGfx.clear();}
        else if(this.soloSnapshot){
            for(const [n,v] of this.soloSnapshot)n.active=v;
            this.soloSnapshot=null;
            // Android native drops dynamic Graphics buffers while nodes are inactive.
            this.redrawChrome();
        }
    }

    private redrawBackground(){const w=this.panelTransform.contentSize.width,h=this.panelTransform.contentSize.height,g=this.panelGfx;g.clear();g.rect(-w/2,-h/2,w,h);g.fillColor=new Color(8,12,24,242);g.fill();g.lineWidth=2;g.strokeColor=new Color(120,140,180,255);g.stroke();}
    private redrawChrome(){
        this.redrawBackground();this.horizontalDd.redraw();this.verticalDd.redraw();
        for(const s of [this.hAlpha,this.vAlpha,this.colSlider,this.rowSlider])this.redrawSlider(s);
        for(const eb of Object.values(this.inputs)){const g=eb.node.getChildByName('Bg')?.getComponent(Graphics);if(g){g.clear();g.roundRect(-65,-26,130,52,8);g.fillColor=new Color(24,32,56,255);g.fill();g.lineWidth=1.5;g.strokeColor=new Color(120,145,190,255);g.stroke();}}
        for(const n of this.buttons){const g=n.getComponent(Graphics)!;g.clear();g.roundRect(-95,-29,190,58,10);g.fillColor=new Color(44,64,104,255);g.fill();}
        (this.visibilityNode as any).__setChecked?.(this.state.visible);
        (this.toneInfoNode as any).__setChecked?.(this.state.showToneInfo);
    }
    private commit(){this.state=sanitizeGridState(this.state);saveGridState(this.state);this.onChanged(this.state);}
    private commitAndSync(){this.commit();this.refresh();}
    private syncInputs(){this.inputs.midiMin.string=String(this.state.midiMin);this.inputs.midiMax.string=String(this.state.midiMax);this.inputs.volumeMin.string=String(Math.round(this.state.volumeMin*100));this.inputs.volumeMax.string=String(Math.round(this.state.volumeMax*100));this.inputs.columns.string=String(this.state.columns);this.inputs.rows.string=String(this.state.rows);}
    private refresh(){this.state=sanitizeGridState(this.state);(this.visibilityNode as any).__setChecked?.(this.state.visible);(this.toneInfoNode as any).__setChecked?.(this.state.showToneInfo);this.horizontalDd.setValue(this.state.horizontalColor);this.verticalDd.setValue(this.state.verticalColor);this.hAlpha.value=this.state.horizontalAlpha;this.vAlpha.value=this.state.verticalAlpha;this.colSlider.value=this.state.columns;this.rowSlider.value=this.state.rows;for(const s of [this.hAlpha,this.vAlpha,this.colSlider,this.rowSlider])this.redrawSlider(s);this.syncInputs();}
}
