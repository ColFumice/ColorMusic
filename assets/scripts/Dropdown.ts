/**
 * Dropdown.ts
 * 通用下拉菜单：下拉框（文字+小倒三角）+ 展开列表 + 半透明黑遮罩 + 列表旁的详细解释。
 * - 展开时：屏幕蒙一层半透明黑色（列表图层之下），列表旁紧挨显示该下拉的解释文字；
 * - 遮罩点击关闭；解释/列表不超出屏幕（横竖屏由调用方 relayout 传位置）。
 */
import { Node, UITransform, Graphics, Label, Color, Vec3, EventTouch, Layers } from 'cc';
import { t } from './I18n';

export interface DdItem {
    id: string;
    label: string;
}

const W = 200;
const H = 42;
const ROW_H = 36;
const EXPLAIN_W = 380;
const EXPLAIN_H = 280;

export class Dropdown {
    /** 挂载父节点（panel，随其旋转）。 */
    readonly panel: Node;
    readonly chip: Node;
    readonly label: Label;
    readonly list: Node;
    readonly shade: Node;
    readonly explain: Node;

    private items: DdItem[];
    private descOf: (id: string) => string;
    private onPick: (id: string) => void;
    private value: string;

    constructor(panel: Node, items: DdItem[], value: string, descOf: (id: string) => string, onPick: (id: string) => void) {
        this.panel = panel;
        this.items = items;
        this.descOf = descOf;
        this.onPick = onPick;
        this.value = value;

        const chip = new Node('Dd');
        chip.layer = Layers.Enum.UI_2D;
        chip.addComponent(UITransform).setContentSize(W, H);
        panel.addChild(chip);
        const bg = chip.addComponent(Graphics);
        bg.roundRect(-W / 2, -H / 2, W, H, 10);
        bg.fillColor = new Color(24, 32, 56, 255);
        bg.fill();
        this.chip = chip;

        const txt = new Node('Text');
        txt.layer = Layers.Enum.UI_2D;
        txt.addComponent(UITransform).setContentSize(W - 42, H);
        txt.setPosition(-21, 0);
        chip.addChild(txt);
        const lb = txt.addComponent(Label);
        lb.fontSize = 18;
        lb.isSystemFontUsed = true;
        lb.horizontalAlign = Label.HorizontalAlign.CENTER;
        lb.verticalAlign = Label.VerticalAlign.CENTER;
        lb.overflow = Label.Overflow.SHRINK;
        lb.enableWrapText = false;
        lb.color = new Color(225, 230, 242, 255);
        this.label = lb;
        // 文字区点击 → 打开列表（需求：点文字打开/展开；这里统一点整框展开）
        txt.on(Node.EventType.TOUCH_END, () => this.toggle(), this);

        const arrow = new Node('Arrow');
        arrow.layer = Layers.Enum.UI_2D;
        arrow.addComponent(UITransform).setContentSize(42, H);
        arrow.setPosition(W / 2 - 21, 0);
        chip.addChild(arrow);
        const ag = arrow.addComponent(Graphics);
        ag.moveTo(-7, 7);
        ag.lineTo(7, 7);
        ag.lineTo(0, -5);
        ag.close();
        ag.fillColor = new Color(160, 175, 205, 255);
        ag.fill();
        arrow.on(Node.EventType.TOUCH_END, () => this.toggle(), this);

        // 遮罩（覆盖面板，半透明黑；在列表/解释图层之下）
        const shade = new Node('DdShade');
        shade.layer = Layers.Enum.UI_2D;
        shade.addComponent(UITransform).setContentSize(4000, 4000);
        shade.active = false;
        panel.addChild(shade);
        const sg = shade.addComponent(Graphics);
        sg.rect(-2000, -2000, 4000, 4000);
        sg.fillColor = new Color(0, 0, 0, 160);
        sg.fill();
        shade.on(Node.EventType.TOUCH_START, (e: EventTouch) => { e.propagationStopped = true; this.close(); }, this);
        this.shade = shade;

        // 列表
        const list = new Node('DdList');
        list.layer = Layers.Enum.UI_2D;
        const listH = 12 + ROW_H * items.length + 8;
        list.addComponent(UITransform).setContentSize(W, listH);
        list.active = false;
        panel.addChild(list);
        const lbg = list.addComponent(Graphics);
        lbg.roundRect(-W / 2, -listH / 2, W, listH, 8);
        lbg.fillColor = new Color(16, 22, 40, 252);
        lbg.fill();
        this.list = list;
        for (let i = 0; i < items.length; i++) {
            const row = new Node('Row' + i);
            row.layer = Layers.Enum.UI_2D;
            row.addComponent(UITransform).setContentSize(W, ROW_H);
            row.setPosition(0, listH / 2 - 6 - ROW_H * (i + 0.5));
            list.addChild(row);
            const rb = new Node('Bg');
            rb.layer = Layers.Enum.UI_2D;
            rb.addComponent(UITransform).setContentSize(W, ROW_H);
            row.addChild(rb);
            const rg = rb.addComponent(Graphics);
            rg.roundRect(-W / 2, -ROW_H / 2, W, ROW_H, 6);
            rg.fillColor = new Color(30, 40, 68, 255);
            rg.fill();
            const rt = new Node('Text');
            rt.layer = Layers.Enum.UI_2D;
            rt.addComponent(UITransform).setContentSize(W, ROW_H);
            row.addChild(rt);
            const rl = rt.addComponent(Label);
            rl.string = t(items[i].label);
            rl.fontSize = 16;
            rl.isSystemFontUsed = true;
            rl.horizontalAlign = Label.HorizontalAlign.CENTER;
            rl.verticalAlign = Label.VerticalAlign.CENTER;
            rl.overflow = Label.Overflow.SHRINK;
            rl.enableWrapText = false;
            rl.color = new Color(255, 255, 255, 255);
            const id = items[i].id;
            row.on(Node.EventType.TOUCH_END, () => this.pick(id), this);
        }

        // 解释：作用/算法说明（无框，固定宽度换行，超出列表宽度自动换行）
        const explain = new Node('DdExplain');
        explain.layer = Layers.Enum.UI_2D;
        explain.addComponent(UITransform).setContentSize(EXPLAIN_W, EXPLAIN_H);
        explain.active = false;
        panel.addChild(explain);
        const et = new Node('Text');
        et.layer = Layers.Enum.UI_2D;
        et.addComponent(UITransform).setContentSize(EXPLAIN_W - 12, EXPLAIN_H - 8);
        explain.addChild(et);
        const el = et.addComponent(Label);
        el.string = '';
        el.fontSize = 25;
        el.lineHeight = 31;
        el.isSystemFontUsed = true;
        el.horizontalAlign = Label.HorizontalAlign.LEFT;
        el.verticalAlign = Label.VerticalAlign.TOP;
        el.color = new Color(190, 200, 216, 255);
        el.enableWrapText = true;
        el.overflow = Label.Overflow.CLAMP;
        this.explain = explain;

        this.refreshLabel();
    }

    setPosition(x: number, y: number) {
        this.chip.setPosition(x, y);
    }

    setValue(v: string) {
        this.value = v;
        this.refreshLabel();
    }

    private refreshLabel() {
        const it = this.items.find((d) => d.id === this.value);
        this.label.string = it ? t(it.label) : '';
    }

    toggle() {
        if (this.list.active) this.close();
        else this.open();
    }

    open() {
        const cp = this.chip.position;
        const panelUt = this.panel.getComponent(UITransform)!;
        const listH = 12 + ROW_H * this.items.length + 8;
        // 列表尽量在芯片下方；不够则上方
        let ly = cp.y - H / 2 - 4 - listH / 2;
        if (ly - listH / 2 < -panelUt.contentSize.height / 2 + 10) {
            ly = cp.y + H / 2 + 4 + listH / 2;
        }
        // A long effect list can be taller than the free space on either side
        // of its chip. Keep the entire list inside the current rotated viewport.
        ly = Math.max(
            -panelUt.contentSize.height / 2 + listH / 2 + 10,
            Math.min(panelUt.contentSize.height / 2 - listH / 2 - 10, ly),
        );
        // Effect menus are long enough that anchoring to a low slot can still
        // cross the native viewport after the root is rotated/scaled. Center
        // long lists vertically; their horizontal position still identifies
        // the originating slot.
        if (this.items.length >= 12) ly = 0;
        // 重绘遮罩（按面板尺寸，激活后 Graphics 数据丢失）+ 列表底
        const sg = this.shade.getComponent(Graphics)!;
        const pw = panelUt.contentSize.width;
        const ph = panelUt.contentSize.height;
        sg.clear();
        sg.rect(-pw / 2, -ph / 2, pw, ph);
        sg.fillColor = new Color(0, 0, 0, 160);
        sg.fill();
        const lbg = this.list.getComponent(Graphics)!;
        lbg.clear();
        lbg.roundRect(-W / 2, -listH / 2, W, listH, 8);
        lbg.fillColor = new Color(16, 22, 40, 252);
        lbg.fill();

        this.list.setPosition(cp.x, ly);
        this.list.active = true;
        this.list.setSiblingIndex(this.panel.children.length - 1);
        this.shade.active = true;
        this.shade.setSiblingIndex(this.panel.children.length - 2);
        // 按列表两侧的真实剩余宽度选边；必要时缩窄说明区，绝不靠边界夹回列表上。
        const explainGap = 32;
        const margin = 8;
        const listLeft = cp.x - W / 2;
        const listRight = cp.x + W / 2;
        const leftAvailable = listLeft - explainGap - (-pw / 2 + margin);
        const rightAvailable = pw / 2 - margin - (listRight + explainGap);
        const placeRight = rightAvailable >= EXPLAIN_W || rightAvailable >= leftAvailable;
        const available = Math.max(180, placeRight ? rightAvailable : leftAvailable);
        const explainW = Math.min(EXPLAIN_W, available);
        this.explain.getComponent(UITransform)!.setContentSize(explainW, EXPLAIN_H);
        this.explain.getChildByName('Text')!.getComponent(UITransform)!.setContentSize(explainW - 12, EXPLAIN_H - 8);
        const ex = placeRight
            ? listRight + explainGap + explainW / 2
            : listLeft - explainGap - explainW / 2;
        this.explain.getChildByName('Text')!.getComponent(Label)!.string = t(this.descOf(this.value));
        const ey = Math.max(-ph / 2 + EXPLAIN_H / 2 + 8, Math.min(ph / 2 - EXPLAIN_H / 2 - 8, ly));
        this.explain.setPosition(ex, ey);
        this.explain.active = true;
        this.explain.setSiblingIndex(this.panel.children.length - 1);
    }

    close() {
        this.list.active = false;
        this.shade.active = false;
        this.explain.active = false;
    }

    /** 供 relayout 在面板大小/方向改变时同步遮罩与解释尺寸（半透明遮罩覆盖面板）。 */
    private pick(id: string) {
        this.value = id;
        this.refreshLabel();
        this.onPick(id);
        this.close();
    }

    /** 重绘（激活后 Graphics 数据丢失时调用）。 */
    redraw() {
        const g = this.chip.getComponent(Graphics)!;
        g.clear();
        g.roundRect(-W / 2, -H / 2, W, H, 10);
        g.fillColor = new Color(24, 32, 56, 255);
        g.fill();
        const sg = this.shade.getComponent(Graphics)!;
        sg.clear();
        sg.rect(-2000, -2000, 4000, 4000);
        sg.fillColor = new Color(0, 0, 0, 160);
        sg.fill();
    }
}
