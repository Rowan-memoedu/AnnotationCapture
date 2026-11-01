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
};

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
): PixelRect[] {
    if (!Array.isArray(value) || value.length > limit || value.length > 20)
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
            // Vision coordinates are approximate; keep a resolution-independent margin.
            const inset = Math.max(
                3,
                Math.ceil(Math.min(width, height) * 0.01),
            );
            const x = Math.ceil(r.x * width) + inset;
            const y = Math.ceil(r.y * height) + inset;
            return {
                x,
                y,
                width:
                    Math.floor(Math.min(1, r.x + r.width) * width) - x - inset,
                height:
                    Math.floor(Math.min(1, r.y + r.height) * height) -
                    y -
                    inset,
            };
        })
        .filter((r) => r.width >= 16 && r.height >= 16);
}

export function intersectRect(a: PixelRect, b: PixelRect): PixelRect | null {
    const x = Math.max(a.x, b.x),
        y = Math.max(a.y, b.y);
    const width = Math.min(a.x + a.width, b.x + b.width) - x;
    const height = Math.min(a.y + a.height, b.y + b.height) - y;
    return width > 0 && height > 0 ? { x, y, width, height } : null;
}
