import type { PixelRect } from "./annotation";

export type WhiteboardSettings = {
    enabled: boolean;
    maxRects: number;
    includeTaskbar: boolean;
    includeWindowChrome: boolean;
};
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
