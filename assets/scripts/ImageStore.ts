/**
 * ImageStore.ts
 * 图片数据仓库：保存选中图片的像素信息，提供 UV → RGB 采样。
 *
 * 数据来源（双通道，自动选择）：
 *   1. 原生颜色网格（优先）：Android 原生层在选图时对图片做等比缩放（最长边 ≤ 2048px），
 *      同时采样出一张 RGB 网格（行序从上到下，方向与显示一致、无 GPU 回读）；
 *   2. 引擎回退：Texture2D.readPixels 读取全量像素（OpenGL 约定：行 0 为纹理底部）。
 */
import { Texture2D } from 'cc';
import { PickedImageInfo } from './NativeBridge';

export interface SampledColor {
    r: number;
    g: number;
    b: number;
    a: number; // 0~255（JPEG 恒 255；PNG 保留透明度）
}

export class ImageStore {
    private _width = 0;
    private _height = 0;
    /** 颜色网格 [gridW*gridH*4]（RGBA），行序：从上到下（与显示一致） */
    private _grid: Uint8Array | null = null;
    private _gridW = 0;
    private _gridH = 0;
    /** 回退：全量 RGBA 像素（readPixels），行 0 = 纹理底部 */
    private _full: Uint8Array | null = null;
    private _fullW = 0;
    private _fullH = 0;

    get ready(): boolean {
        return (this._grid !== null || this._full !== null) && this._width > 0 && this._height > 0;
    }
    get width(): number { return this._width; }
    get height(): number { return this._height; }
    get hasNativeGrid(): boolean { return this._grid !== null; }

    /** 用原生回调信息初始化（颜色网格优先）。 */
    initFromNative(info: PickedImageInfo): void {
        this._width = info.width;
        this._height = info.height;
        if (info.gridBase64 && info.gridW > 0 && info.gridH > 0) {
            try {
                this._grid = decodeBase64(info.gridBase64);
                this._gridW = info.gridW;
                this._gridH = info.gridH;
            } catch (e) {
                console.warn('[ColorMusic] 颜色网格解码失败，回退 readPixels:', e);
                this._grid = null;
            }
        }
    }

    /**
     * 从引擎纹理读取全量像素（回退/校验用）。
     * 注意：readPixels 要求纹理已上传到 GPU（至少渲染一帧后调用）。
     */
    readFullFromTexture(tex: Texture2D): boolean {
        if (!tex || tex.width <= 0) return false;
        const data = tex.readPixels(0, 0, tex.width, tex.height);
        if (!data) return false;
        this._full = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        this._fullW = tex.width;
        this._fullH = tex.height;
        if (this._width === 0) {
            this._width = tex.width;
            this._height = tex.height;
        }
        return true;
    }

    /**
     * 采样颜色（RGBA）。
     * @param u     0~1，左→右
     * @param vTop  0~1，下→上
     */
    sample(u: number, vTop: number): SampledColor {
        u = Math.min(1, Math.max(0, u));
        vTop = Math.min(1, Math.max(0, vTop));
        if (this._grid && this._gridW > 0 && this._gridH > 0) {
            const gx = Math.min(this._gridW - 1, Math.floor(u * this._gridW));
            const gy = Math.min(this._gridH - 1, Math.floor((1 - vTop) * this._gridH)); // 网格行 0 = 顶部
            const off = (gy * this._gridW + gx) * 4;
            return { r: this._grid[off], g: this._grid[off + 1], b: this._grid[off + 2], a: this._grid[off + 3] };
        }
        if (this._full && this._fullW > 0 && this._fullH > 0) {
            const px = Math.min(this._fullW - 1, Math.floor(u * this._fullW));
            // readPixels 行 0 = 纹理底部（OpenGL 约定）→ 显示顶部 = 最后一行
            const row = Math.min(this._fullH - 1, Math.floor((1 - vTop) * this._fullH));
            const off = (row * this._fullW + px) * 4;
            return { r: this._full[off], g: this._full[off + 1], b: this._full[off + 2], a: this._full[off + 3] };
        }
        return { r: 128, g: 128, b: 128, a: 255 };
    }

    /** 四角采样（用于调试校验方向一致性）。 */
    sampleCorners(): { tl: SampledColor; tr: SampledColor; bl: SampledColor; br: SampledColor } {
        return {
            tl: this.sample(0.02, 0.98),
            tr: this.sample(0.98, 0.98),
            bl: this.sample(0.02, 0.02),
            br: this.sample(0.98, 0.02),
        };
    }
}

/** base64 → 字节数组（不依赖 atob，JSB/浏览器通用）。 */
export function decodeBase64(b64: string): Uint8Array {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
    let out: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < clean.length; i++) {
        const ch = clean[i];
        if (ch === '=') break;
        const val = chars.indexOf(ch);
        if (val < 0) continue;
        buffer = (buffer << 6) | val;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buffer >> bits) & 0xff);
        }
    }
    return new Uint8Array(out);
}
