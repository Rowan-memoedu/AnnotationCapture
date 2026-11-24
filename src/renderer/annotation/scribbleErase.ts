import type { PixelRect } from "../../../lib/annotation";
import type { PressurePoint } from "./pressureInk";
import { detectScribble } from "./scribbleGeometry";

export function readScribble(
    points: readonly PressurePoint[],
    unitsPerPixel: number,
    duration = 0,
) {
    if (
        !Number.isFinite(unitsPerPixel) ||
        unitsPerPixel <= 0 ||
        duration > 1500
    )
        return null;
    return detectScribble(points.flat(), { minSize: 9 * unitsPerPixel });
}

type Ink = {
    bounds: PixelRect;
    draw: (context: CanvasRenderingContext2D) => void;
};

function mask(width: number, height: number) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas.getContext("2d", { willReadFrequently: true })!;
}

export function scribbleTargets<T>(
    gesture: Ink,
    candidates: Iterable<{ id: T } & Ink>,
    unitsPerPixel: number,
): Set<T> {
    const targets = new Set<T>();
    const { x, y, width, height } = gesture.bounds;
    if (
        ![x, y, width, height].every(Number.isFinite) ||
        width <= 0 ||
        height <= 0
    )
        return targets;
    const scale = Math.min(4 / unitsPerPixel, 2048 / Math.max(width, height));
    const w = Math.ceil(width * scale);
    const h = Math.ceil(height * scale);
    const trace = mask(w, h);
    trace.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
    gesture.draw(trace);
    const tracePixels = trace.getImageData(0, 0, w, h).data;
    const candidate = mask(w, h);

    for (const ink of candidates) {
        const b = ink.bounds;
        const left = Math.max(0, Math.floor((b.x - x) * scale));
        const top = Math.max(0, Math.floor((b.y - y) * scale));
        const right = Math.min(w, Math.ceil((b.x + b.width - x) * scale));
        const bottom = Math.min(h, Math.ceil((b.y + b.height - y) * scale));
        if (left >= right || top >= bottom) continue;

        candidate.save();
        candidate.beginPath();
        candidate.rect(left, top, right - left, bottom - top);
        candidate.clip();
        candidate.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
        ink.draw(candidate);
        candidate.restore();
        const pixels = candidate.getImageData(
            left,
            top,
            right - left,
            bottom - top,
        ).data;
        candidate.clearRect(left, top, right - left, bottom - top);

        // Require overlapping ink coverage, excluding adjacent antialiased edges.
        let index = 3;
        for (let row = top; row < bottom && !targets.has(ink.id); row++) {
            for (let col = left; col < right; col++, index += 4) {
                if (
                    pixels[index] > 128 &&
                    tracePixels[(row * w + col) * 4 + 3] > 128
                ) {
                    targets.add(ink.id);
                    break;
                }
            }
        }
    }
    return targets;
}
