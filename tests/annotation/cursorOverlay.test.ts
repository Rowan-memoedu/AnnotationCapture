import { describe, expect, it } from "vitest";
import { clearPointerHalo } from "../../src/renderer/annotation/cursorOverlay";

function patch(scale: number, halo: boolean) {
    const size = 96 * scale,
        data = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
            const dx = x / scale - 48,
                dy = y / scale - 48,
                i = 4 * (y * size + x);
            const alpha = halo
                ? 0.65 * Math.exp(-((dx - 4) ** 2 + (dy - 5) ** 2) / 130)
                : 0;
            for (const [k, c] of [232, 78, 52].entries())
                data[i + k] = 255 - (255 - c) * alpha;
            if (
                (dx >= 0 && dy >= 0 && dx + dy < 14) ||
                (dy >= -11 && dy <= -8 && Math.abs(dx) < 20)
            )
                data.fill(20, i, i + 3);
        }
    return { size, data };
}

describe("screen-painted pointer", () => {
    for (const scale of [1, 2])
        it(`removes a tinted pointer but preserves neighboring text at ${scale}x`, () => {
            const { size, data } = patch(scale, true);
            expect(
                clearPointerHalo(
                    data,
                    size,
                    size,
                    48 * scale,
                    48 * scale,
                    scale,
                ),
            ).toBe(true);
            expect(data[4 * (49 * scale * size + 49 * scale)]).toBe(255);
            expect(data[4 * (39 * scale * size + 45 * scale)]).toBe(20);
        });
    it("keeps a highlighted circular graph marker intact", () => {
        const { size, data } = patch(1, true);
        for (let y = 44; y <= 64; y++)
            for (let x = 44; x <= 64; x++) {
                const i = 4 * (y * size + x);
                if (Math.hypot(x - 54, y - 54) <= 6) data.fill(15, i, i + 3);
                else if (data[i] === 20) data.set([246, 190, 182], i);
            }
        const original = data.slice();
        expect(clearPointerHalo(data, size, size, 50, 51, 1)).toBe(false);
        expect(data).toEqual(original);
    });
    it("keeps an isolated glyph under the system pointer intact", () => {
        const { size, data } = patch(1, false),
            original = data.slice();
        expect(clearPointerHalo(data, size, size, 48, 48, 1)).toBe(false);
        expect(data).toEqual(original);
    });
});
