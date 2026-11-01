import type { PixelRect } from "./annotation";

export type WhiteboardSettings = {
    enabled: boolean;
    maxRects: number;
    includeTaskbar: boolean;
    includeWindowChrome: boolean;
};
export type WhiteboardDetection = {
    rects: PixelRect[];
    unprotected?: PixelRect[];
    protected?: PixelRect[];
    contentRegions?: PixelRect[];
    solid?: PixelRect[];
};

// All boards are planned on one mask. Overlap is intentional: a shared white
// surface must not spend its rectangle budget on the gaps of a partition.
export function planWhiteboardRects(
    protectedRects: PixelRect[],
    image: Pick<ImageData, "width" | "height" | "data">,
    width: number,
    height: number,
    limit: number,
    unprotected: PixelRect[] = [],
    contentRegions?: PixelRect[],
    solidRects?: PixelRect[],
): PixelRect[] {
    const cell = 4;
    const cols = Math.ceil(image.width / cell),
        rows = Math.ceil(image.height / cell);
    const mask = new Uint8Array(cols * rows);
    const sx = image.width / width,
        sy = image.height / height;
    for (const r of solidRects ?? protectedRects) {
        // Pad content once, rather than shrinking each writing rectangle.
        const margin = Math.max(4, Math.min(image.width, image.height) * 0.008);
        let left = r.x * sx - margin,
            top = r.y * sy - margin,
            right = (r.x + r.width) * sx + margin,
            bottom = (r.y + r.height) * sy + margin;
        left = Math.max(0, Math.floor(left / cell));
        top = Math.max(0, Math.floor(top / cell));
        right = Math.min(cols, Math.ceil(right / cell));
        bottom = Math.min(rows, Math.ceil(bottom / cell));
        for (let y = top; y < bottom; y++)
            mask.fill(1, y * cols + left, y * cols + right);
    }
    // Catch omitted glyphs across the entire image. Only semantic exemptions
    // and long straight UI dividers are ignored; figure interiors stay protected.
    const edges = new Uint8Array(image.width * image.height);
    const dividers = new Uint8Array(edges.length);
    for (let y = 1; y < image.height; y++)
        for (let x = 1; x < image.width; x++) {
            const p = (y * image.width + x) * 4;
            for (let c = 0; c < 3; c++)
                if (
                    Math.abs(image.data[p + c] - image.data[p - 4 + c]) > 40 ||
                    Math.abs(
                        image.data[p + c] - image.data[p - image.width * 4 + c],
                    ) > 40
                ) {
                    edges[y * image.width + x] = 1;
                    break;
                }
        }
    for (const vertical of [false, true]) {
        const length = vertical ? image.height : image.width,
            lines = vertical ? image.width : image.height;
        for (let line = 0; line < lines; line++) {
            let start = 0;
            for (let pos = 0; pos <= length; pos++) {
                const index = vertical
                    ? pos * image.width + line
                    : line * image.width + pos;
                if (pos < length && edges[index]) continue;
                if (pos - start >= Math.max(64, length * 0.12)) {
                    let touchesContent = false;
                    for (let i = start; i < pos; i++)
                        if (
                            mask[
                                Math.floor((vertical ? i : line) / cell) *
                                    cols +
                                    Math.floor((vertical ? line : i) / cell)
                            ]
                        ) {
                            touchesContent = true;
                            break;
                        }
                    if (!touchesContent)
                        for (let i = start; i < pos; i++)
                            dividers[
                                vertical
                                    ? i * image.width + line
                                    : line * image.width + i
                            ] = 1;
                }
                start = pos + 1;
            }
        }
    }
    const ignored = new Uint8Array(edges.length).fill(
        contentRegions?.length ? 1 : 0,
    );
    if (contentRegions)
        for (const r of contentRegions) {
            // Region estimates can miss a trailing paragraph or choice row.
            // Search a generous halo; actual pixels, not this halo, are blocked.
            const margin = Math.min(image.width, image.height) * 0.15;
            const left = Math.max(0, Math.floor(r.x * sx - margin)),
                right = Math.min(
                    image.width,
                    Math.ceil((r.x + r.width) * sx + margin),
                );
            for (
                let y = Math.max(0, Math.floor(r.y * sy - margin));
                y <
                Math.min(
                    image.height,
                    Math.ceil((r.y + r.height) * sy + margin),
                );
                y++
            )
                ignored.fill(
                    0,
                    y * image.width + left,
                    y * image.width + right,
                );
        }
    for (const r of unprotected) {
        const left = Math.max(0, Math.floor(r.x * sx)),
            right = Math.min(image.width, Math.ceil((r.x + r.width) * sx));
        for (
            let y = Math.max(0, Math.floor(r.y * sy));
            y < Math.min(image.height, Math.ceil((r.y + r.height) * sy));
            y++
        )
            ignored.fill(1, y * image.width + left, y * image.width + right);
    }
    // Content wins when approximate UI exemptions overlap the first/last glyph.
    for (const r of protectedRects) {
        const left = Math.max(0, Math.floor(r.x * sx)),
            right = Math.min(image.width, Math.ceil((r.x + r.width) * sx));
        for (
            let y = Math.max(0, Math.floor(r.y * sy));
            y < Math.min(image.height, Math.ceil((r.y + r.height) * sy));
            y++
        )
            ignored.fill(0, y * image.width + left, y * image.width + right);
    }
    for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++) {
            const index = y * image.width + x;
            if (!edges[index] || dividers[index] || ignored[index]) continue;
            const gx = Math.floor(x / cell),
                gy = Math.floor(y / cell);
            for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++)
                    if (
                        gx + dx >= 0 &&
                        gx + dx < cols &&
                        gy + dy >= 0 &&
                        gy + dy < rows
                    )
                        mask[(gy + dy) * cols + gx + dx] = 1;
        }
    const preferred = new Uint8Array(mask.length);
    if (limit >= 4)
        for (const r of unprotected) {
            const left = Math.max(0, Math.floor((r.x * sx) / cell)),
                right = Math.min(
                    cols,
                    Math.ceil(((r.x + r.width) * sx) / cell),
                );
            for (
                let y = Math.max(0, Math.floor((r.y * sy) / cell));
                y < Math.min(rows, Math.ceil(((r.y + r.height) * sy) / cell));
                y++
            )
                preferred.fill(1, y * cols + left, y * cols + right);
        }
    return coverWhiteboardMask(mask, cols, rows, limit, preferred).map((r) => {
        const x = Math.round(Math.min(image.width, r.x * cell) / sx),
            y = Math.round(Math.min(image.height, r.y * cell) / sy);
        return {
            x,
            y,
            width:
                Math.round(Math.min(image.width, (r.x + r.width) * cell) / sx) -
                x,
            height:
                Math.round(
                    Math.min(image.height, (r.y + r.height) * cell) / sy,
                ) - y,
        };
    });
}

export function coverWhiteboardMask(
    mask: Uint8Array,
    cols: number,
    rows: number,
    limit: number,
    preferred = new Uint8Array(cols * rows),
): PixelRect[] {
    const candidates: PixelRect[] = [],
        heights = new Uint16Array(cols);
    for (let y = 0; y < rows; y++) {
        const stack: [number, number][] = [];
        for (let x = 0; x <= cols; x++) {
            const h = x === cols || mask[y * cols + x] ? 0 : heights[x] + 1;
            if (x < cols) heights[x] = h;
            let start = x;
            while (stack.length && stack.at(-1)![1] > h) {
                const [left, tall] = stack.pop()!;
                if (x - left >= 4 && tall >= 4)
                    candidates.push({
                        x: left,
                        y: y - tall + 1,
                        width: x - left,
                        height: tall,
                    });
                start = left;
            }
            if (h && (!stack.length || stack.at(-1)![1] < h))
                stack.push([start, h]);
        }
    }
    const result: PixelRect[] = [],
        covered = new Uint8Array(cols * rows);
    for (let n = 0; n < limit; n++) {
        const stride = cols + 1,
            prefix = new Uint32Array(stride * (rows + 1));
        for (let y = 0; y < rows; y++) {
            let row = 0;
            for (let x = 0; x < cols; x++) {
                // Join allowed chrome/tool areas into the surface before using
                // the last rectangle on a small extra gap between paragraphs.
                row += covered[y * cols + x]
                    ? 0
                    : preferred[y * cols + x]
                      ? 12
                      : 1;
                prefix[(y + 1) * stride + x + 1] =
                    prefix[y * stride + x + 1] + row;
            }
        }
        let best: PixelRect | undefined,
            bestGain = 0,
            connectedBest = false;
        for (const r of candidates) {
            const right = r.x + r.width,
                bottom = r.y + r.height;
            const gain =
                prefix[bottom * stride + right] -
                prefix[r.y * stride + right] -
                prefix[bottom * stride + r.x] +
                prefix[r.y * stride + r.x];
            const connected =
                !result.length ||
                result.some((b) => {
                    const dx =
                            Math.min(right, b.x + b.width) - Math.max(r.x, b.x),
                        dy =
                            Math.min(bottom, b.y + b.height) -
                            Math.max(r.y, b.y);
                    return dx >= 0 && dy >= 0 && (dx > 0 || dy > 0);
                });
            if (
                gain > 0 &&
                ((connected && !connectedBest) ||
                    (connected === connectedBest &&
                        (gain > bestGain ||
                            (gain === bestGain &&
                                r.width * r.height >
                                    (best ? best.width * best.height : 0)))))
            ) {
                best = r;
                bestGain = gain;
                connectedBest = connected;
            }
        }
        if (!best) break;
        result.push(best);
        for (let y = best.y; y < best.y + best.height; y++)
            covered.fill(1, y * cols + best.x, y * cols + best.x + best.width);
    }
    return result;
}

export function refineWhiteboardRects(
    rects: PixelRect[],
    image: Pick<ImageData, "width" | "height" | "data">,
    width: number,
    height: number,
    unprotected: PixelRect[],
    limit: number,
): PixelRect[] {
    const cell = 8,
        cols = Math.ceil(image.width / cell),
        rows = Math.ceil(image.height / cell);
    const sx = width / image.width,
        sy = height / image.height;
    const edges = new Uint8Array(cols * rows),
        mask = new Uint8Array(cols * rows);
    for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
            const low = [255, 255, 255],
                high = [0, 0, 0];
            for (
                let py = Math.max(0, y * cell - 1);
                py < Math.min(image.height, (y + 1) * cell);
                py++
            )
                for (
                    let px = Math.max(0, x * cell - 1);
                    px < Math.min(image.width, (x + 1) * cell);
                    px++
                )
                    for (let c = 0; c < 3; c++) {
                        const v = image.data[(py * image.width + px) * 4 + c];
                        low[c] = Math.min(low[c], v);
                        high[c] = Math.max(high[c], v);
                    }
            edges[y * cols + x] = high.some((v, c) => v - low[c] > 24) ? 1 : 0;
        }
    for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
            const left = x * cell * sx,
                top = y * cell * sy;
            const right = Math.min(image.width, (x + 1) * cell) * sx;
            const bottom = Math.min(image.height, (y + 1) * cell) * sy;
            const inside = rects.some(
                (r) =>
                    left >= r.x &&
                    top >= r.y &&
                    right <= r.x + r.width &&
                    bottom <= r.y + r.height,
            );
            const exempt = unprotected.some(
                (r) =>
                    left >= r.x &&
                    top >= r.y &&
                    right <= r.x + r.width &&
                    bottom <= r.y + r.height,
            );
            let edge = false;
            for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++)
                    if (
                        x + dx >= 0 &&
                        x + dx < cols &&
                        y + dy >= 0 &&
                        y + dy < rows &&
                        edges[(y + dy) * cols + x + dx]
                    )
                        edge = true;
            mask[y * cols + x] = !inside || (!exempt && edge) ? 1 : 0;
        }
    const result: PixelRect[] = [];
    for (let n = 0; n < limit; n++) {
        const heights = new Uint16Array(cols);
        let best: number[] | undefined,
            bestArea = 0;
        for (let y = 0; y < rows; y++) {
            const stack: [number, number][] = [];
            for (let x = 0; x <= cols; x++) {
                const h = x === cols || mask[y * cols + x] ? 0 : heights[x] + 1;
                if (x < cols) heights[x] = h;
                let start = x;
                while (stack.length && stack.at(-1)![1] > h) {
                    const [left, tall] = stack.pop()!,
                        wide = x - left;
                    if (wide >= 4 && tall >= 4 && wide * tall > bestArea) {
                        best = [left, y - tall + 1, wide, tall];
                        bestArea = wide * tall;
                    }
                    start = left;
                }
                if (h && (!stack.length || stack.at(-1)![1] < h))
                    stack.push([start, h]);
            }
        }
        if (!best) break;
        const [left, top, wide, tall] = best;
        const x = Math.ceil(left * cell * sx),
            y = Math.ceil(top * cell * sy);
        result.push({
            x,
            y,
            width:
                Math.floor(Math.min(image.width, (left + wide) * cell) * sx) -
                x,
            height:
                Math.floor(Math.min(image.height, (top + tall) * cell) * sy) -
                y,
        });
        for (let row = top; row < top + tall; row++)
            mask.fill(1, row * cols + left, row * cols + left + wide);
    }
    return result;
}
export const whiteboardDefaults: WhiteboardSettings = {
    enabled: true,
    maxRects: 5,
    includeTaskbar: true,
    includeWindowChrome: true,
};

export function whiteboardSettings(
    value: Partial<WhiteboardSettings> = {},
): WhiteboardSettings {
    const result = { ...whiteboardDefaults, ...value };
    if (
        [
            result.enabled,
            result.includeTaskbar,
            result.includeWindowChrome,
        ].some((v) => typeof v !== "boolean") ||
        !Number.isInteger(result.maxRects) ||
        result.maxRects < 1 ||
        result.maxRects > 20
    )
        throw new Error("白板设置无效；矩形上限须为 1 到 20");
    return result;
}

// Coordinates are normalized to the original screenshot, independent of DPI.
export function whiteboardRects(
    value: unknown,
    limit: number,
    width: number,
    height: number,
    minimumSize = 16,
): PixelRect[] {
    if (!Array.isArray(value) || value.length > limit || value.length > 128)
        throw new Error("空白区域坐标无效");
    return value
        .map((r) => {
            if (
                !r ||
                [r.x, r.y, r.width, r.height].some(
                    (n) => typeof n !== "number" || !Number.isFinite(n),
                ) ||
                r.x < 0 ||
                r.y < 0 ||
                r.width <= 0 ||
                r.height <= 0 ||
                r.x + r.width > 1.000001 ||
                r.y + r.height > 1.000001
            )
                throw new Error("空白区域坐标越界");
            const x = Math.round(r.x * width);
            const y = Math.round(r.y * height);
            return {
                x,
                y,
                width: Math.round(Math.min(1, r.x + r.width) * width) - x,
                height: Math.round(Math.min(1, r.y + r.height) * height) - y,
            };
        })
        .filter((r) => r.width >= minimumSize && r.height >= minimumSize);
}

export function intersectRect(a: PixelRect, b: PixelRect): PixelRect | null {
    const x = Math.max(a.x, b.x),
        y = Math.max(a.y, b.y);
    const width = Math.min(a.x + a.width, b.x + b.width) - x;
    const height = Math.min(a.y + a.height, b.y + b.height) - y;
    return width > 0 && height > 0 ? { x, y, width, height } : null;
}
