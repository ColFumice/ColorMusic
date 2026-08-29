/**
 * FxUI.ts
 * 波形编辑器里的效果器插件 UI：8 个槽位下拉菜单（R高/R低/G高/G低/B高/B低/灰效/均效）
 * + 每个效果器的设置弹窗（反向勾选、强度滑块、专属参数滑块、滤波器 EQ 绘制、包络器 ADSR 绘制）。
 *
 * 交互规则：
 *   - 只有点击下拉框右边的小倒三角才会展开列表选择；
 *   - 点击下拉框内的文字打开该槽位效果器的设置界面；
 *   - 列表项点击后立即生效并保存，再点文字才进设置。
 */
import { Node, UITransform, Graphics, Label, Color, Vec3, EventTouch, Layers, tween, sys } from 'cc';
import {
    FX_LIBRARY, FX_SLOT_NAMES, FX_SLOT_COUNT, FxSlot,
    fxLabelOf, fxDefOf, newSlot, defaultCurve, FX_SLOT_CONCEIT,
    FX_GLOBAL_BASE, FX_GLOBAL_SLOTS_PER_CHANNEL, globalFxIndex,
} from './Effects';
import { t } from './I18n';

const CHIP_W = 200;
const CHIP_H = 44;
const ARROW_W = 44;
const LIST_ROW_H = 34;
const PORTRAIT_CHIP_SCALE = 0.72;

/** 插件库说明（下拉展开时显示）：作用 + 算法。 */
function fxDesc(id: string): string {
    switch (id) {
        case 'none': return t('无：不施加任何效果（该槽位保持原始音色）。', 'None: leaves this slot and the original timbre unchanged.');
        case 'psy': return t('作用：在该触发输入（如通道高/低于阈值、灰效、均效）生效时做振幅震颤，给音色添脉动。算法：按触发深度对输出做 0.5-0.5*cos 低频振幅调制。', 'Adds amplitude tremolo while this slot trigger is active. A low-frequency 0.5-0.5*cos modulation is scaled by trigger depth.');
        case 'glitch': return t('作用：周期性门控断顿（数字故障感）。算法：方波占空比门控输出，占空比/速度可调。', 'Creates rhythmic digital dropouts using a square-wave gate with adjustable duty cycle.');
        case 'pulse': return t('作用：叠加强烈次低频脉冲（低频冲击）。算法：叠加 20-150Hz 亚低频正弦，频率可调。', 'Adds a strong 20-150 Hz sine pulse for sub-bass impact.');
        case 'reese': return t('作用：宽厚失谐叠加（reese 音色）。算法：叠加一个基频(1+失谐)的微失谐分量，产生拍频宽度。', 'Adds a slightly detuned copy of the fundamental to create a wide Reese-style beating tone.');
        case 'laser': return t('作用：起音短促高频下滑（"pew" 激光）。算法：起音 90ms 内按扫频范围做快速频率下滑叠加。', 'Adds a short high-to-low laser sweep during the first 90 ms of the note.');
        case 'liquid': return t('作用：低频缓慢振幅摆动（液态感）。算法：0.2-8Hz 正弦振幅调制。', 'Creates a liquid motion with slow 0.2-8 Hz sine amplitude modulation.');
        case 'dist': return t('作用：tanh 过载失真，增加饱和度与撕裂感（鼓组不使用）。算法：tanh(x*(1+d*3))/(1+d*3)*(1+d) 软削波。', 'Adds tanh soft-clipping saturation and edge. Drum voices bypass this distortion.');
        case 'filter': return t('作用：多段 EQ 频率塑形（低架+中峰×2+高架）。算法：按你手绘的 EQ 增益曲线换算 4 段 RBJ biquad 系数，再按干湿比例混合。', 'Shapes tone with a four-band EQ derived from your drawn curve, then blends it using Dry / Wet.');
        case 'env': return t('作用：替换/混合音符的起音-衰减-保持-释放包络。算法：由你手绘的 ADSR 曲线解析 attack/decay/sustain/release 时长与电平，并与原包络按深度混合。', 'Replaces or blends the note ADSR envelope using attack, decay, sustain and release values parsed from your curve.');
        case 'reverb': return t('作用：空间混响，营造纵深与余音。算法：4 条梳状滤波+1 全通（Schroeder 混响），空间大小控制反馈与湿量。', 'Adds space and tail using a Schroeder reverb with four comb filters and one all-pass stage.');
        case 'delay': return t('作用：反馈回声（Echo）。算法：延迟线读-混-写，时间与反馈可调。', 'Adds a feedback echo with adjustable delay time and feedback.');
        case 'chorus': return t('作用：合唱/flanger，加厚声像。算法：延迟线读指针随 LFO 微调移动，干湿混合。', 'Thickens the stereo image with an LFO-modulated chorus / flanger delay.');
        case 'compressor': return t('作用：压低超过阈值的峰值，稳定响度并保留动态。算法：超过阈值的电平按所选压缩比缩减。', 'Reduces peaks above the threshold at the selected ratio to stabilize loudness.');
        case 'air': return t('作用：加入可控的气息或擦弦纹理。算法：伪随机噪声经一阶音色滤波后与原音混合，明亮度控制高频比例。', 'Adds controllable breath or bow texture using filtered pseudo-random noise.');
        default: return '';
    }
}
const PANEL_W_L = 1800;
const PANEL_H_L = 800;
const PANEL_W_P = 840;
const PANEL_H_P = 1860;

export class FxUI {
    private panel!: Node;
    private slots: FxSlot[] = [];
    private onChanged: (slots: FxSlot[]) => void;
    private portrait = false;
    private outputMode = false;
    private globalCounts = [1, 1, 1];
    private addButtons: Node[] = [];

    // 8 个 chip
    private chips: Node[] = [];
    private chipBgGfx: Graphics[] = [];
    private chipTextNodes: Node[] = [];
    private chipLabels: Label[] = [];
    private chipArrowGfx: Graphics[] = [];

    // 下拉列表（展开时遮罩 + 解释）
    private list!: Node;
    private listBg!: Graphics;
    private listRows: Node[] = [];
    private listLabels: Label[] = [];
    private listSlot = -1;
    private fxShade!: Node;
    private fxExplain!: Node;
    private fxHint!: Node;

    // 设置弹窗
    private modal!: Node;
    private modalShade!: Node;
    private modalPanel!: Node;
    private modalTitle!: Label;
    private modalSlot = -1;
    /** 每次打开设置时重建的内容容器。 */
    private modalBody: Node | null = null;

    constructor(onChanged: (slots: FxSlot[]) => void, outputMode = false) {
        this.onChanged = onChanged;
        this.outputMode = outputMode;
        if (!outputMode) {
            try {
                const raw = JSON.parse(sys.localStorage.getItem('cm_global_fx_counts') ?? '[1,1,1]');
                if (Array.isArray(raw)) this.globalCounts = [0, 1, 2].map((i) => Math.max(1, Math.min(4, Number(raw[i]) || 1)));
            } catch (e) { /* 忽略 */ }
        }
    }

    setSlots(slots: FxSlot[]) {
        this.slots = slots;
        if (!this.outputMode) {
            for (let ch = 0; ch < 3; ch++) {
                let used = 1;
                for (let j = 0; j < FX_GLOBAL_SLOTS_PER_CHANNEL; j++) {
                    if (slots[globalFxIndex(ch, j)]?.id !== 'none') used = j + 1;
                }
                this.globalCounts[ch] = Math.max(this.globalCounts[ch], used);
            }
        }
        this.refreshChips();
        this.refreshGlobalVisibility();
    }

    /** “全部重置”后，每个色相只保留第一个可见的全局效果器槽。 */
    resetGlobalSlotCounts() {
        if (this.outputMode) return;
        this.globalCounts = [1, 1, 1];
        try { sys.localStorage.setItem('cm_global_fx_counts', JSON.stringify(this.globalCounts)); } catch (err) { /* 忽略 */ }
        this.refreshGlobalVisibility();
        if (this.panel) this.relayout(this.portrait, false);
    }

    dismiss() {
        this.closeList();
        this.closeModal();
        if (this.list) this.list.active = false;
        if (this.modal) this.modal.active = false;
    }

    private getSlot(i: number): FxSlot {
        return this.slots[i];
    }

    /* ============================== 构建 ============================== */

    build(panel: Node) {
        this.panel = panel;

        const chipCount = this.outputMode ? 4 : FX_SLOT_COUNT;
        for (let i = 0; i < chipCount; i++) {
            const chip = new Node('FxChip' + i);
            chip.layer = Layers.Enum.UI_2D;
            chip.addComponent(UITransform).setContentSize(CHIP_W, CHIP_H);
            panel.addChild(chip);
            const bg = chip.addComponent(Graphics);
            bg.roundRect(-CHIP_W / 2, -CHIP_H / 2, CHIP_W, CHIP_H, 10);
            bg.fillColor = new Color(24, 32, 56, 255);
            bg.fill();
            this.chipBgGfx.push(bg);

            // 左侧文字（点击 → 设置）
            const textNode = new Node('Text');
            textNode.layer = Layers.Enum.UI_2D;
            textNode.addComponent(UITransform).setContentSize(CHIP_W - ARROW_W, CHIP_H);
            textNode.setPosition(-ARROW_W / 2, 0);
            chip.addChild(textNode);
            const lbl = textNode.addComponent(Label);
            lbl.fontSize = 20;
            lbl.isSystemFontUsed = true;
            lbl.horizontalAlign = Label.HorizontalAlign.CENTER;
            lbl.verticalAlign = Label.VerticalAlign.CENTER;
            lbl.color = new Color(225, 230, 242, 255);
            textNode.on(Node.EventType.TOUCH_END, () => this.openSettings(i), this);

            // 右侧小倒三角（点击 → 展开列表）
            const arrowNode = new Node('Arrow');
            arrowNode.layer = Layers.Enum.UI_2D;
            arrowNode.addComponent(UITransform).setContentSize(ARROW_W, CHIP_H);
            arrowNode.setPosition(CHIP_W / 2 - ARROW_W / 2, 0);
            chip.addChild(arrowNode);
            const ag = arrowNode.addComponent(Graphics);
            ag.moveTo(-7, 7);
            ag.lineTo(7, 7);
            ag.lineTo(0, -5);
            ag.close();
            ag.fillColor = new Color(160, 175, 205, 255);
            ag.fill();
            // 箭头区高亮底
            ag.roundRect(-ARROW_W / 2, -CHIP_H / 2, ARROW_W, CHIP_H, 0);
            ag.fillColor = new Color(255, 255, 255, 14);
            ag.fill();
            arrowNode.on(Node.EventType.TOUCH_END, () => this.toggleList(i), this);

            this.chips.push(chip);
            this.chipTextNodes.push(textNode);
            this.chipLabels.push(lbl);
            this.chipArrowGfx.push(ag);
        }

        if (!this.outputMode) {
            for (let ch = 0; ch < 3; ch++) this.addButtons.push(this.makeAddButton(ch));
        }

        // 下拉列表（初始隐藏）
        const list = new Node('FxList');
        list.layer = Layers.Enum.UI_2D;
        list.addComponent(UITransform).setContentSize(CHIP_W + 8, 20);
        list.active = false;
        panel.addChild(list);
        this.list = list;
        const lbg = list.addComponent(Graphics);
        lbg.roundRect(-(CHIP_W + 8) / 2, 0, CHIP_W + 8, 20, 8);
        lbg.fillColor = new Color(16, 22, 40, 250);
        lbg.fill();
        this.listBg = lbg;

        for (let j = 0; j < FX_LIBRARY.length; j++) {
            const row = new Node('Row' + j);
            row.layer = Layers.Enum.UI_2D;
            row.addComponent(UITransform).setContentSize(CHIP_W, LIST_ROW_H);
            const listH0 = 30 + LIST_ROW_H * FX_LIBRARY.length + 12;
            row.setPosition(0, listH0 / 2 - 24 - LIST_ROW_H * (j + 0.5));
            list.addChild(row);
            const rbgNode = new Node('Bg');
            rbgNode.layer = Layers.Enum.UI_2D;
            rbgNode.addComponent(UITransform).setContentSize(CHIP_W, LIST_ROW_H);
            row.addChild(rbgNode);
            const rbg = rbgNode.addComponent(Graphics);
            rbg.roundRect(-CHIP_W / 2, -LIST_ROW_H / 2, CHIP_W, LIST_ROW_H, 6);
            rbg.fillColor = new Color(30, 40, 68, 255);
            rbg.fill();
            // 行文字：用 makeLabel（已验证可渲染），白色、居中
            const tNode = this.makeLabel(row, FX_LIBRARY[j].label, 18, new Color(255, 255, 255, 255), CHIP_W, LIST_ROW_H);
            const rl = tNode.getComponent(Label)!;
            rl.horizontalAlign = Label.HorizontalAlign.CENTER;
            const idx = j;
            row.on(Node.EventType.TOUCH_END, () => this.pickListItem(idx), this);
            this.listRows.push(row);
            this.listLabels.push(rl);
        }
        // 列表背景重绘为完整高度（对称于节点中心）
        const listH = 30 + LIST_ROW_H * FX_LIBRARY.length + 12;
        list.getComponent(UITransform)!.setContentSize(CHIP_W + 8, listH);
        lbg.clear();
        lbg.roundRect(-(CHIP_W + 8) / 2, -listH / 2, CHIP_W + 8, listH, 8);
        lbg.fillColor = new Color(16, 22, 40, 250);
        lbg.fill();

        // 设置弹窗（初始隐藏）
        const modal = new Node('FxModal');
        modal.layer = Layers.Enum.UI_2D;
        modal.active = false;
        panel.addChild(modal);
        this.modal = modal;
        const shade = new Node('Shade');
        shade.layer = Layers.Enum.UI_2D;
        shade.addComponent(UITransform).setContentSize(4000, 4000);
        modal.addChild(shade);
        const sg = shade.addComponent(Graphics);
        sg.rect(-2000, -2000, 4000, 4000);
        sg.fillColor = new Color(0, 0, 0, 150);
        sg.fill();
        shade.on(Node.EventType.TOUCH_START, (e: EventTouch) => { e.propagationStopped = true; this.closeModal(); }, this);
        this.modalShade = shade;

        const mp = new Node('ModalPanel');
        mp.layer = Layers.Enum.UI_2D;
        mp.addComponent(UITransform).setContentSize(720, 600);
        modal.addChild(mp);
        const mg = mp.addComponent(Graphics);
        mg.roundRect(-360, -300, 720, 600, 18);
        mg.fillColor = new Color(12, 18, 34, 250);
        mg.fill();
        mg.lineWidth = 2;
        mg.strokeColor = new Color(120, 140, 180, 255);
        mg.stroke();
        const titleNode = new Node('Title');
        titleNode.layer = Layers.Enum.UI_2D;
        titleNode.addComponent(UITransform).setContentSize(660, 40);
        titleNode.setPosition(0, 265);
        mp.addChild(titleNode);
        const tl = titleNode.addComponent(Label);
        tl.fontSize = 22;
        tl.isSystemFontUsed = true;
        tl.horizontalAlign = Label.HorizontalAlign.CENTER;
        tl.verticalAlign = Label.VerticalAlign.CENTER;
        tl.color = new Color(235, 240, 250, 255);
        this.modalTitle = tl;
        this.modalPanel = mp;

        // 下拉列表展开时的遮罩（半透明黑，位于列表之下）与解释（列表旁）
        const fxShade = new Node('FxShade');
        fxShade.layer = Layers.Enum.UI_2D;
        fxShade.addComponent(UITransform).setContentSize(4000, 4000);
        fxShade.active = false;
        panel.addChild(fxShade);
        const fsg = fxShade.addComponent(Graphics);
        fsg.rect(-2000, -2000, 4000, 4000);
        fsg.fillColor = new Color(0, 0, 0, 160);
        fsg.fill();
        fxShade.on(Node.EventType.TOUCH_START, (e: EventTouch) => { e.propagationStopped = true; this.closeList(); }, this);
        this.fxShade = fxShade;
        const fxExp = new Node('FxExplain');
        fxExp.layer = Layers.Enum.UI_2D;
        fxExp.addComponent(UITransform).setContentSize(390, 330);
        fxExp.active = false;
        panel.addChild(fxExp);
        // 无框：直接文本，固定宽度内换行（超出列表宽度自动换行）
        const fet = new Node('Text');
        fet.layer = Layers.Enum.UI_2D;
        fet.addComponent(UITransform).setContentSize(380, 270);
        fet.setPosition(0, 24);
        fxExp.addChild(fet);
        const fel = fet.addComponent(Label);
        fel.fontSize = 25;
        fel.lineHeight = 31;
        fel.isSystemFontUsed = true;
        fel.horizontalAlign = Label.HorizontalAlign.LEFT;
        fel.verticalAlign = Label.VerticalAlign.TOP;
        fel.color = new Color(200, 208, 222, 255);
        fel.enableWrapText = true;
        fel.overflow = Label.Overflow.CLAMP;
        // 黄色提示行（有设置界面的插件显示）
        const fHint = new Node('Hint');
        fHint.layer = Layers.Enum.UI_2D;
        fHint.addComponent(UITransform).setContentSize(380, 52);
        fHint.setPosition(0, -142);
        fxExp.addChild(fHint);
        const fhl = fHint.addComponent(Label);
        fhl.string = t('选中后点击此槽内的文本即可设置此效果器');
        fhl.fontSize = 21;
        fhl.isSystemFontUsed = true;
        fhl.horizontalAlign = Label.HorizontalAlign.LEFT;
        fhl.verticalAlign = Label.VerticalAlign.CENTER;
        fhl.overflow = Label.Overflow.SHRINK;
        fhl.color = new Color(255, 214, 90, 255);
        this.fxHint = fHint;
        this.fxExplain = fxExp;

        // 初始状态刷新一次芯片文字（build 后才有 chip 节点）
        this.refreshChips();
        this.refreshGlobalVisibility();
    }

    private makeAddButton(channel: number): Node {
        const n = new Node('FxAdd' + channel);
        n.layer = Layers.Enum.UI_2D;
        n.addComponent(UITransform).setContentSize(38, 38);
        this.panel.addChild(n);
        n.addComponent(Graphics);
        this.redrawAddButton(n);
        n.on(Node.EventType.TOUCH_END, (e: EventTouch) => {
            e.propagationStopped = true;
            if (this.globalCounts[channel] < FX_GLOBAL_SLOTS_PER_CHANNEL) {
                this.globalCounts[channel]++;
                try { sys.localStorage.setItem('cm_global_fx_counts', JSON.stringify(this.globalCounts)); } catch (err) { /* 忽略 */ }
                this.refreshGlobalVisibility();
                this.relayout(this.portrait, false);
            }
        }, this);
        return n;
    }

    private redrawAddButton(n: Node) {
        const g = n.getComponent(Graphics)!;
        g.clear();
        g.circle(0, 0, 17);
        g.fillColor = new Color(34, 50, 82, 255);
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = new Color(170, 190, 225, 255);
        g.stroke();
        g.moveTo(-7, 0); g.lineTo(7, 0); g.moveTo(0, -7); g.lineTo(0, 7);
        g.lineWidth = 3; g.strokeColor = new Color(240, 245, 255, 255); g.stroke();
    }

    private refreshGlobalVisibility() {
        if (this.outputMode || !this.chips.length) return;
        for (let ch = 0; ch < 3; ch++) {
            for (let j = 0; j < FX_GLOBAL_SLOTS_PER_CHANNEL; j++) {
                const chip = this.chips[globalFxIndex(ch, j)];
                if (chip) chip.active = j < this.globalCounts[ch];
            }
            if (this.addButtons[ch]) this.addButtons[ch].active = this.globalCounts[ch] < FX_GLOBAL_SLOTS_PER_CHANNEL;
        }
    }

    /** 重绘弹窗底与遮罩（激活后 Graphics 数据会丢失，打开时调用）。 */
    private redrawModalChrome() {
        if (!this.modalPanel || !this.modalShade) return;
        const pw = this.portrait ? 640 : 720;
        const ph = this.portrait ? 800 : 680;
        const mg = this.modalPanel.getComponent(Graphics)!;
        mg.clear();
        mg.roundRect(-pw / 2, -ph / 2, pw, ph, 18);
        mg.fillColor = new Color(12, 18, 34, 250);
        mg.fill();
        mg.lineWidth = 2;
        mg.strokeColor = new Color(120, 140, 180, 255);
        mg.stroke();
        const sg = this.modalShade.getComponent(Graphics)!;
        sg.clear();
        sg.rect(-2000, -2000, 4000, 4000);
        sg.fillColor = new Color(0, 0, 0, 150);
        sg.fill();
    }

    /* ============================== 布局 ============================== */

    relayout(portrait: boolean, animate = false) {
        this.portrait = portrait;
        const pos: Array<[number, number]> = [];
        const scales: number[] = [];
        if (this.outputMode) {
            if (portrait) {
                for (let i = 0; i < 4; i++) { pos[i] = [0, 300 - i * 125]; scales[i] = 1.15; }
            } else {
                for (let i = 0; i < 4; i++) { pos[i] = [-360 + i * 240, 100]; scales[i] = 1; }
            }
        } else if (portrait) {
            const cy = [420, 70, -280];
            for (let ch = 0; ch < 3; ch++) {
                pos[ch * 2] = [-390, cy[ch] + 62];
                pos[ch * 2 + 1] = [-390, cy[ch] - 62];
                scales[ch * 2] = scales[ch * 2 + 1] = .56;
                for (let j = 0; j < 4; j++) {
                    const idx = globalFxIndex(ch, j);
                    pos[idx] = [390, cy[ch] + 88 - j * 56];
                    scales[idx] = .54;
                }
            }
            pos[6] = [-155, 625]; scales[6] = .68;
            pos[7] = [155, 625]; scales[7] = .68;
        } else {
            const cx = [-455, 0, 455];
            for (let ch = 0; ch < 3; ch++) {
                pos[ch * 2] = [cx[ch] - 78, 310];
                pos[ch * 2 + 1] = [cx[ch] + 78, 310];
                scales[ch * 2] = scales[ch * 2 + 1] = .70;
                for (let j = 0; j < 4; j++) {
                    const idx = globalFxIndex(ch, j);
                    pos[idx] = [cx[ch] - 108, -75 - j * 48];
                    scales[idx] = .60;
                }
            }
            pos[6] = [-610, 400]; scales[6] = .72;
            pos[7] = [610, 400]; scales[7] = .72;
        }
        for (let i = 0; i < this.chips.length; i++) {
            const cx = pos[i][0];
            const cy = pos[i][1];
            const chip = this.chips[i];
            const scale = scales[i] ?? (portrait ? PORTRAIT_CHIP_SCALE : 1);
            if (animate) {
                tween(chip).stop();
                tween(chip).to(1.0, {
                    position: new Vec3(cx, cy, 0),
                    scale: new Vec3(scale, scale, 1),
                }, { easing: 'quadInOut' }).start();
            } else {
                chip.setPosition(cx, cy);
                chip.setScale(scale, scale, 1);
            }
        }
        for (const n of this.addButtons) this.redrawAddButton(n);
        if (!this.outputMode) {
            const addPos = portrait
                ? [[390, 420 - 148], [390, 70 - 148], [390, -280 - 148]]
                : [[-563, -278], [-108, -278], [347, -278]];
            for (let ch = 0; ch < 3; ch++) {
                const n = this.addButtons[ch];
                const count = this.globalCounts[ch];
                if (portrait) n.setPosition(390, [420, 70, -280][ch] + 88 - count * 56);
                else n.setPosition([-455, 0, 455][ch] - 108, -75 - count * 48);
                n.setScale(portrait ? .85 : .8, portrait ? .85 : .8, 1);
            }
        }
        // 弹窗尺寸随方向
        if (this.modalPanel) {
            const pw = portrait ? 640 : 720;
            const ph = portrait ? 800 : 680;
            const ut = this.modalPanel.getComponent(UITransform)!;
            ut.setContentSize(pw, ph);
            this.modalTitle.getComponent(UITransform)!.setContentSize(pw - 60, 40);
            this.modalTitle.node.setPosition(0, ph / 2 - 35);
            if (this.modal.active && this.modalSlot >= 0) {
                this.redrawModalChrome();
                this.rebuildModalBody();
            }
        }
    }

    /** 重绘所有常驻 Graphics（面板激活后渲染数据需重建，打开时调用）。 */
    redrawAll() {
        for (let i = 0; i < this.chips.length; i++) {
            const bg = this.chipBgGfx[i];
            bg.clear();
            bg.roundRect(-CHIP_W / 2, -CHIP_H / 2, CHIP_W, CHIP_H, 10);
            bg.fillColor = new Color(24, 32, 56, 255);
            bg.fill();
            const ag = this.chipArrowGfx[i];
            ag.clear();
            ag.roundRect(-ARROW_W / 2, -CHIP_H / 2, ARROW_W, CHIP_H, 0);
            ag.fillColor = new Color(255, 255, 255, 14);
            ag.fill();
            ag.moveTo(-7, 7);
            ag.lineTo(7, 7);
            ag.lineTo(0, -5);
            ag.close();
            ag.fillColor = new Color(160, 175, 205, 255);
            ag.fill();
        }
        // 重绘遮罩与解释框（panel 激活后 Graphics 会丢失）
        if (this.fxShade) {
            const sg = this.fxShade.getComponent(Graphics)!;
            sg.clear();
            sg.rect(-2000, -2000, 4000, 4000);
            sg.fillColor = new Color(0, 0, 0, 160);
            sg.fill();
        }
        if (this.fxExplain) {
            // 无框，仅文本（无需重绘背景）
        }
    }

    refreshChips() {
        for (let i = 0; i < this.chips.length; i++) {
            const s = this.getSlot(i);
            this.chipLabels[i].string = !s || s.id === 'none' ? t('无') : t(fxLabelOf(s.id));
        }
    }

    /* ============================== 下拉列表 ============================== */

    private toggleList(slot: number) {
        if (this.listSlot === slot && this.list.active && this.listSlot >= 0) {
            this.closeList();
            return;
        }
        this.openList(slot);
    }

    private openList(slot: number) {
        const chip = this.chips[slot];
        const cp = chip.position;
        const panelUt = this.panel.getComponent(UITransform)!;
        const listH = 30 + LIST_ROW_H * FX_LIBRARY.length + 12;
        // 列表紧贴芯片下方展开（局部 +Y=上，行向下排）；下方空间不足则向上展开
        let y = cp.y - CHIP_H / 2 - 4 - listH / 2;
        const bottomLimit = -panelUt.contentSize.height / 2 + 16;
        if (y - listH / 2 < bottomLimit) {
            y = cp.y + CHIP_H / 2 + 4 + listH / 2;
        }
        // The effect library is taller than the free space above or below the
        // low global slots. Center it so every row stays inside both rotated
        // tablet viewports.
        if (FX_LIBRARY.length >= 12) y = 0;
        const listHalfW = (CHIP_W + 8) / 2;
        const listX = Math.max(-panelUt.contentSize.width / 2 + listHalfW,
            Math.min(panelUt.contentSize.width / 2 - listHalfW, cp.x));
        this.list.setPosition(listX, y);
        this.list.active = true;
        this.listSlot = slot;
        this.list.getComponent(UITransform)!.setContentSize(CHIP_W + 8, listH);
        this.listBg.clear();
        this.listBg.roundRect(-(CHIP_W + 8) / 2, -listH / 2, CHIP_W + 8, listH, 8);
        this.listBg.fillColor = new Color(16, 22, 40, 250);
        this.listBg.fill();
        this.list.setSiblingIndex(this.panel.children.length - 1);
        // 遮罩在列表之下；解释列表旁（最上层）；激活后需按面板尺寸重绘
        const pw = panelUt.contentSize.width;
        const ph = panelUt.contentSize.height;
        const fsg = this.fxShade.getComponent(Graphics)!;
        fsg.clear();
        fsg.rect(-pw / 2, -ph / 2, pw, ph);
        fsg.fillColor = new Color(0, 0, 0, 160);
        fsg.fill();
        this.fxShade.active = true;
        this.fxShade.setSiblingIndex(this.panel.children.length - 2);
        this.showExplain(slot, { x: listX, y });
        // 刷新行文字与高亮（构建时可能未生效）
        for (let j = 0; j < this.listRows.length; j++) {
            this.listLabels[j].string = t(FX_LIBRARY[j].label);
            const cur = FX_LIBRARY[j].id === this.getSlot(slot).id;
            const g = this.listRows[j].getChildByName('Bg')!.getComponent(Graphics)!;
            g.clear();
            g.roundRect(-CHIP_W / 2, -LIST_ROW_H / 2, CHIP_W, LIST_ROW_H, 6);
            g.fillColor = cur ? new Color(52, 72, 120, 255) : new Color(30, 40, 68, 255);
            g.fill();
            this.listLabels[j].color = cur ? new Color(255, 210, 120, 255) : new Color(225, 230, 242, 255);
        }
    }

    /** 列表旁显示该效果器的解释：槽位说明 + 插件说明（黄色提示行在说明后）。 */
    private showExplain(slot: number, cp: { x: number; y: number }) {
        const cur = this.getSlot(slot).id;
        const conceit = this.outputMode
            ? t(`输出槽 ${slot + 1}：位于 RGB 合成之后，按槽位顺序处理最终声音。`, `Output slot ${slot + 1}: processes the final sound after RGB mixing, in slot order.`)
            : t(FX_SLOT_CONCEIT[slot] ?? '');
        this.fxExplain.getChildByName('Text')!.getComponent(Label)!.string = `${conceit}\n\n${fxDesc(cur)}`;
        // "无"无设置界面 → 隐藏黄色提示
        this.fxHint.active = cur !== 'none';
        const panelUt = this.panel.getComponent(UITransform)!;
        const panelW = panelUt.contentSize.width;
        const ly = cp.y;
        // 按列表两侧的真实剩余宽度选边；必要时缩窄说明区，绝不靠边界夹回列表上。
        const explainGap = 32;
        const margin = 8;
        const listHalf = (CHIP_W + 8) / 2;
        const listLeft = cp.x - listHalf;
        const listRight = cp.x + listHalf;
        const leftAvailable = listLeft - explainGap - (-panelW / 2 + margin);
        const rightAvailable = panelW / 2 - margin - (listRight + explainGap);
        const targetW = 390;
        const placeRight = rightAvailable >= targetW || rightAvailable >= leftAvailable;
        const available = Math.max(220, placeRight ? rightAvailable : leftAvailable);
        const explainW = Math.min(targetW, available);
        const ex = placeRight
            ? listRight + explainGap + explainW / 2
            : listLeft - explainGap - explainW / 2;
        this.fxExplain.getComponent(UITransform)!.setContentSize(explainW, 330);
        this.fxExplain.getChildByName('Text')!.getComponent(UITransform)!.setContentSize(explainW - 10, 270);
        this.fxHint.getComponent(UITransform)!.setContentSize(explainW - 10, 52);
        const ph = panelUt.contentSize.height;
        const ey = Math.max(-ph / 2 + 170, Math.min(ph / 2 - 170, ly));
        this.fxExplain.setPosition(ex, ey);
        this.fxExplain.active = true;
        this.fxExplain.setSiblingIndex(this.panel.children.length - 1);
    }

    private closeList() {
        if (this.list) this.list.active = false;
        if (this.fxShade) this.fxShade.active = false;
        if (this.fxExplain) this.fxExplain.active = false;
        this.listSlot = -1;
    }

    private pickListItem(libIdx: number) {
        const def = FX_LIBRARY[libIdx];
        const slot = this.getSlot(this.listSlot);
        if (slot && slot.id !== def.id) {
            const keepCurve = def.curveType && (slot.curve.length > 4) && fxDefOf(slot.id).curveType === def.curveType
                ? slot.curve : defaultCurve(def.id);
            const keepParams = { ...slot.params };
            const repl = newSlot(def.id);
            repl.params = { ...repl.params, ...keepParams };
            repl.curve = keepCurve;
            this.slots[this.listSlot] = repl;
            this.refreshChips();
            this.onChanged(this.slots);
        }
        this.closeList();
    }

    /* ============================== 设置弹窗 ============================== */

    private openSettings(slot: number) {
        this.closeList();
        if (this.getSlot(slot).id === 'none') return; // "无"没有设置
        this.modalSlot = slot;
        this.modal.active = true;
        this.modalShade.active = true;
        this.modal.setSiblingIndex(this.panel.children.length - 1);
        this.redrawModalChrome(); // 激活后重绘遮罩与面板（Graphics 数据会丢失）
        this.rebuildModalBody();
    }

    closeModal() {
        if (this.modal) this.modal.active = false;
        this.modalSlot = -1;
    }

    /** 重建设置弹窗内容（按效果器类型；打开时调用）。 */
    private rebuildModalBody() {
        const slot = this.getSlot(this.modalSlot);
        const def = fxDefOf(slot.id);
        const pw = this.portrait ? 640 : 720;
        const ph = this.portrait ? 800 : 680; // 弹窗加长（容纳下移的画布与按钮）
        this.modalTitle.string = `${t(FX_SLOT_NAMES[this.modalSlot])} · ${t(def.label)}`;

        if (this.modalBody) this.modalBody.destroy();
        const body = new Node('Body');
        body.layer = Layers.Enum.UI_2D;
        body.addComponent(UITransform).setContentSize(pw, ph);
        this.modalPanel.addChild(body);
        this.modalBody = body;

        const lblX = -pw / 2 + 60;     // 左侧标签锚点
        const sldX = pw / 2 - 260 - 60; // 滑杆中心（右到 pw/2−60）
        const sldW = pw - 380;

        // 反向勾选行
        const cb = this.makeCheckbox(body, slot.invert, (v) => { slot.invert = v; this.push(); });
        cb.setPosition(lblX + 40, ph / 2 - 70);
        const invertLabel = this.makeLabel(body, '反向', 18, new Color(220, 225, 235, 255), 120, 36);
        invertLabel.setPosition(lblX + 100, ph / 2 - 70);

        // 效果强度行
        const intLabel = this.makeLabel(body, '效果强度', 18, new Color(220, 225, 235, 255), 130, 36);
        intLabel.setPosition(lblX + 35, ph / 2 - 125);
        this.makeSlider(body, {
            key: '__intensity__', label: '',
            min: 0, max: 1, def: slot.intensity,
            x: sldX, y: ph / 2 - 125, w: sldW, h: 36,
            current: slot.intensity,
            onVal: (v) => { slot.intensity = v; this.push(); },
        });

        // 专属设置区域：EQ 保持现有正常位置；ADSR 整体上移约弹窗高度 1/7（原偏下且底部滑块与关闭按钮重叠）
        const cY = this.portrait ? 125 : (def.curveType === 'adsr' ? 35 : -60);
        const cH = this.portrait ? 180 : 235;   // 画布高度
        const canvasTop = cY + cH / 2;
        if (def.curveType === 'eq') {
            const hint = this.makeLabel(body, 'EQ 曲线：手指绘制（中间=平直，上=增益，下=衰减）', 14, new Color(170, 180, 200, 255), pw - 80, 30);
            hint.setPosition(0, canvasTop + 24);
            this.makeCurveCanvas(body, slot, 'eq', 0, cY, this.portrait ? pw - 110 : pw - 150, cH);
        } else if (def.curveType === 'adsr') {
            const hint = this.makeLabel(body, 'ADSR 包络：绘制——从 0 快升到峰值→衰减→保持→释放；横轴时间、纵轴电平', 14, new Color(170, 180, 200, 255), pw - 80, 30);
            hint.setPosition(0, canvasTop + 24);
            this.makeCurveCanvas(body, slot, 'adsr', 0, cY, this.portrait ? pw - 110 : pw - 150, cH);
        }
        // 专属滑块（画布下方：标签左、滑杆右；无画布类插件放弹窗中部，避免与关闭按钮重叠）
        let sy = def.curveType ? (cY - cH / 2 - 48) : (this.portrait ? 120 : 60);
        if (def.sliders && def.sliders.length) {
            for (const s of def.sliders) {
                const cur = slot.params[s.key] ?? s.def;
                const sl = this.makeLabel(body, s.label, 16, new Color(200, 208, 224, 255), 120, 32);
                sl.setPosition(lblX + 30, sy);
                this.makeSlider(body, { ...s, x: sldX, y: sy, w: sldW, h: 32, current: cur, onVal: (v) => {
                    slot.params[s.key] = v;
                    this.push();
                } });
                sy -= 42;
            }
        }
        // 底部：重置（恢复此效果器默认设置）在左、关闭在右
        this.makeButton(body, '重置', -110, -ph / 2 + 62, 190, 58, () => this.resetSlot());
        this.makeButton(body, '关闭', 110, -ph / 2 + 62, 190, 58, () => this.closeModal());
    }

    /** 重置当前设置弹窗的效果器为默认（保留插件 id，恢复强度/参数/曲线/反向）。 */
    private resetSlot() {
        const slot = this.getSlot(this.modalSlot);
        if (!slot) return;
        const repl = newSlot(slot.id);
        this.slots[this.modalSlot] = repl;
        this.refreshChips();
        this.onChanged(this.slots);
        this.rebuildModalBody(); // 立即反映默认值
    }

    private push() {
        this.refreshChips();
        this.onChanged(this.slots);
    }

    /* ---------------- 基础控件 ---------------- */

    private makeLabel(parent: Node, text: string, size: number, color: Color, w: number, h: number): Node {
        const n = new Node('L');
        n.layer = Layers.Enum.UI_2D;
        n.addComponent(UITransform).setContentSize(w, h);
        const l = n.addComponent(Label);
        l.string = t(text);
        l.fontSize = size;
        l.isSystemFontUsed = true;
        l.horizontalAlign = Label.HorizontalAlign.LEFT;
        l.verticalAlign = Label.VerticalAlign.CENTER;
        l.color = color;
        parent.addChild(n);
        return n;
    }

    private makeCheckbox(parent: Node, init: boolean, onVal: (v: boolean) => void): Node {
        const n = new Node('Cb');
        n.layer = Layers.Enum.UI_2D;
        n.addComponent(UITransform).setContentSize(34, 34);
        parent.addChild(n);
        const g = n.addComponent(Graphics);
        const draw = (checked: boolean) => {
            g.clear();
            g.roundRect(-15, -15, 30, 30, 6);
            g.lineWidth = 2;
            g.strokeColor = new Color(180, 190, 210, 255);
            g.stroke();
            if (checked) {
                g.lineWidth = 4;
                g.strokeColor = new Color(120, 220, 130, 255);
                g.moveTo(-9, 0);
                g.lineTo(-2, 8);
                g.lineTo(10, -8);
                g.stroke();
            }
        };
        draw(init);
        let state = init;
        n.on(Node.EventType.TOUCH_END, () => {
            state = !state;
            draw(state);
            onVal(state);
        }, this);
        return n;
    }

    private makeSlider(
        parent: Node,
        cfg: {
            key: string; label: string; min: number; max: number; def: number;
            x: number; y: number; w: number; h: number;
            current: number; onVal: (v: number) => void;
        },
    ): Node {
        const n = new Node('Slider');
        n.layer = Layers.Enum.UI_2D;
        n.addComponent(UITransform).setContentSize(cfg.w, cfg.h);
        n.setPosition(cfg.x, cfg.y);
        parent.addChild(n);
        const g = n.addComponent(Graphics);
        let value = Math.max(cfg.min, Math.min(cfg.max, cfg.current));
        const track = (cfg.max - cfg.min);
        const draw = () => {
            g.clear();
            const t = ((value - cfg.min) / track);
            const x0 = -cfg.w / 2 + 14;
            const x1 = cfg.w / 2 - 14;
            g.lineWidth = 6;
            g.strokeColor = new Color(70, 80, 110, 255);
            g.moveTo(x0, 0);
            g.lineTo(x1, 0);
            g.stroke();
            g.lineWidth = 6;
            g.strokeColor = new Color(110, 150, 235, 255);
            g.moveTo(x0, 0);
            g.lineTo(x0 + (x1 - x0) * t, 0);
            g.stroke();
            g.circle(x0 + (x1 - x0) * t, 0, 11);
            g.fillColor = new Color(220, 230, 250, 255);
            g.fill();
            if (cfg.label) {
                g.fontSize = 16;
                g.fillColor = new Color(0, 0, 0, 0);
            }
        };
        draw();
        let dragging = false;
        const setFromEvent = (e: EventTouch) => {
            const ui = e.getUILocation();
            const local = n.getComponent(UITransform)!.convertToNodeSpaceAR(new Vec3(ui.x, ui.y, 0));
            const t = Math.max(0, Math.min(1, (local.x + cfg.w / 2 - 14) / (cfg.w - 28)));
            value = cfg.min + t * track;
            draw();
            cfg.onVal(value);
        };
        n.on(Node.EventType.TOUCH_START, (e: EventTouch) => { dragging = true; e.propagationStopped = true; setFromEvent(e); }, this);
        n.on(Node.EventType.TOUCH_MOVE, (e: EventTouch) => { if (dragging) { e.propagationStopped = true; setFromEvent(e); } }, this);
        n.on(Node.EventType.TOUCH_END, (e: EventTouch) => { dragging = false; e.propagationStopped = true; }, this);
        n.on(Node.EventType.TOUCH_CANCEL, (e: EventTouch) => { dragging = false; e.propagationStopped = true; }, this);
        return n;
    }

    /** 曲线绘制画布（EQ 16 点 / ADSR 32 点）。 */
    private makeCurveCanvas(parent: Node, slot: FxSlot, kind: 'eq' | 'adsr', cx: number, cy: number, w: number, h: number) {
        const n = new Node('Curve');
        n.layer = Layers.Enum.UI_2D;
        n.addComponent(UITransform).setContentSize(w, h);
        n.setPosition(cx, cy);
        parent.addChild(n);
        const g = n.addComponent(Graphics);
        const pts = slot.curve.length === (kind === 'eq' ? 16 : 32) ? slot.curve.slice() : defaultCurve(kind === 'eq' ? 'filter' : 'env');
        const N = kind === 'eq' ? 16 : 32;
        const ptsArr = new Float32Array(N);
        for (let i = 0; i < N; i++) pointsAssign(i);
        function pointsAssign(i: number) {
            ptsArr[i] = Math.max(0, Math.min(1, pts[i] ?? 0.5));
        }

        const draw = () => {
            g.clear();
            // 网格
            g.lineWidth = 1;
            g.strokeColor = new Color(255, 255, 255, 20);
            for (let i = 0; i <= 8; i++) {
                const x = -w / 2 + (i * w) / 8;
                g.moveTo(x, -h / 2);
                g.lineTo(x, h / 2);
            }
            for (const y of [-h / 2, 0, h / 2]) {
                g.moveTo(-w / 2, y);
                g.lineTo(w / 2, y);
            }
            g.stroke();
            // 中线（EQ 0dB / ADSR 电平中间）
            g.strokeColor = new Color(170, 170, 170, 160);
            g.lineWidth = 1.5;
            g.moveTo(-w / 2, 0);
            g.lineTo(w / 2, 0);
            g.stroke();
            // 边框
            g.lineWidth = 2;
            g.strokeColor = new Color(255, 255, 255, 220);
            g.rect(-w / 2, -h / 2, w, h);
            g.stroke();
            // 曲线
            g.lineWidth = 3;
            g.strokeColor = new Color(120, 200, 255, 255);
            for (let i = 0; i < N; i++) {
                const x = -w / 2 + (i * w) / (N - 1);
                const y = (ptsArr[i] - 0.5) * (h - 16);
                if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
            }
            g.stroke();
        };
        draw();

        // 触摸绘制：把点重采样为 N 个值
        let drawing = false;
        let lastX = 0;
        const put = (e: EventTouch) => {
            const ui = e.getUILocation();
            const local = n.getComponent(UITransform)!.convertToNodeSpaceAR(new Vec3(ui.x, ui.y, 0));
            if (local.x < -w / 2 || local.x > w / 2 || local.y < -h / 2 || local.y > h / 2) return;
            const col = Math.max(0, Math.min(N - 1, Math.round(((local.x + w / 2) / w) * (N - 1))));
            const v = Math.max(0, Math.min(1, local.y / (h - 16) + 0.5));
            // 从 last 到 col 插值填充（连续绘制）
            const dir = Math.sign(col - lastX) || 1;
            let c = col;
            for (; c !== lastX + dir; c += dir) {
                const cc = Math.max(0, Math.min(N - 1, c));
                ptsArr[cc] = v;
                if (Math.abs(c - col) > N) break;
            }
            ptsArr[col] = v;
            lastX = col;
            slot.curve = Array.from(ptsArr);
            draw();
        };
        n.on(Node.EventType.TOUCH_START, (e: EventTouch) => { drawing = true; e.propagationStopped = true; put(e); }, this);
        n.on(Node.EventType.TOUCH_MOVE, (e: EventTouch) => { if (drawing) { e.propagationStopped = true; put(e); } }, this);
        n.on(Node.EventType.TOUCH_END, (e: EventTouch) => { if (drawing) { drawing = false; e.propagationStopped = true; this.push(); } }, this);
        n.on(Node.EventType.TOUCH_CANCEL, (e: EventTouch) => { drawing = false; e.propagationStopped = true; }, this);
        return n;
    }

    private makeButton(parent: Node, text: string, x: number, y: number, w: number, h: number, cb: () => void): Node {
        const btn = new Node('Btn');
        btn.layer = Layers.Enum.UI_2D;
        btn.addComponent(UITransform).setContentSize(w, h);
        btn.setPosition(x, y);
        parent.addChild(btn);
        const bgNode = new Node('Bg');
        bgNode.layer = Layers.Enum.UI_2D;
        bgNode.addComponent(UITransform).setContentSize(w, h);
        btn.addChild(bgNode);
        const bg = bgNode.addComponent(Graphics);
        bg.roundRect(-w / 2, -h / 2, w, h, 10);
        bg.fillColor = new Color(70, 52, 52, 255);
        bg.fill();
        const tNode = new Node('Text');
        tNode.layer = Layers.Enum.UI_2D;
        tNode.addComponent(UITransform).setContentSize(w, h);
        btn.addChild(tNode);
        const l = tNode.addComponent(Label);
        l.string = t(text);
        l.fontSize = 22;
        l.isSystemFontUsed = true;
        l.horizontalAlign = Label.HorizontalAlign.CENTER;
        l.verticalAlign = Label.VerticalAlign.CENTER;
        l.color = new Color(235, 240, 250, 255);
        btn.on(Node.EventType.TOUCH_START, (e: EventTouch) => { e.propagationStopped = true; cb(); }, this);
        return btn;
    }
}
