import { describe, expect, it } from "vitest";
import {
    coverWhiteboardMask,
    intersectRect,
    planWhiteboardRects,
    refineWhiteboardRects,
    whiteboardDefaults,
    whiteboardRects,
    whiteboardSettings,
} from "../../lib/whiteboard";

describe("whiteboard geometry and settings", () => {
    it("uses actual ink bounds when a model reports full-width choice rows", () => {
        const width = 400,
            height = 300,
            data = new Uint8ClampedArray(width * height * 4).fill(255);
        for (let y = 70; y < 240; y += 40)
            for (let yy = y; yy < y + 10; yy++)
                for (let x = 110; x < 150; x++)
                    for (let c = 0; c < 3; c++)
                        data[(yy * width + x) * 4 + c] = 0;
        const rects = planWhiteboardRects(
            [{ x: 100, y: 60, width: 250, height: 200 }],
            { width, height, data },
            width,
            height,
            5,
            [],
            [{ x: 90, y: 50, width: 270, height: 220 }],
            [],
        );
        expect(
            rects.some(
                (r) =>
                    r.x <= 200 &&
                    r.x + r.width === 400 &&
                    r.y === 0 &&
                    r.height === 300,
            ),
        ).toBe(true);
        for (const r of rects)
            for (let y = 70; y < 240; y += 40)
                expect(
                    intersectRect(r, { x: 110, y, width: 40, height: 10 }),
                ).toBeNull();
    });
    it("retains a trailing choice missed by both model boxes while clearing remote UI", () => {
        const width = 400,
            height = 300,
            data = new Uint8ClampedArray(width * height * 4).fill(255);
        for (const [x, y] of [
            [110, 100],
            [110, 210],
            [5, 100],
            [380, 100],
        ])
            for (let yy = y; yy < y + 8; yy++)
                for (let xx = x; xx < x + 10; xx++)
                    for (let c = 0; c < 3; c++)
                        data[(yy * width + xx) * 4 + c] = 0;
        const rects = planWhiteboardRects(
            [{ x: 100, y: 90, width: 80, height: 60 }],
            { width, height, data },
            width,
            height,
            5,
            [],
            [{ x: 95, y: 80, width: 100, height: 105 }],
        );
        for (const r of rects)
            expect(
                intersectRect(r, { x: 110, y: 210, width: 10, height: 8 }),
            ).toBeNull();
        for (const x of [5, 380])
            expect(
                rects.some(
                    (r) =>
                        r.x <= x &&
                        r.x + r.width >= x + 10 &&
                        r.y <= 100 &&
                        r.y + r.height >= 108,
                ),
            ).toBe(true);
    });
    it("trims missed image edges on both light and dark pages without moving outside model areas", () => {
        for (const background of [20, 255]) {
            const width = 120,
                height = 80,
                data = new Uint8ClampedArray(width * height * 4).fill(
                    background,
                );
            for (let x = 0; x < width; x++)
                for (let c = 0; c < 3; c++)
                    data[(30 * width + x) * 4 + c] =
                        background === 20 ? 240 : 0;
            const input = [{ x: 0, y: 0, width: 240, height: 160 }];
            const result = refineWhiteboardRects(
                input,
                { width, height, data },
                240,
                160,
                [],
                5,
            );
            expect(result.length).toBeGreaterThan(0);
            for (const r of result) {
                expect(r.y > 62 || r.y + r.height < 60).toBe(true);
                expect(r.x + r.width).toBeLessThanOrEqual(240);
                expect(r.y + r.height).toBeLessThanOrEqual(160);
            }
            expect(
                refineWhiteboardRects(
                    input,
                    { width, height, data },
                    240,
                    160,
                    input,
                    1,
                ),
            ).toEqual(input);
        }
    });
    it("keeps defaults for old settings and rejects invalid limits", () => {
        expect(whiteboardSettings()).toEqual(whiteboardDefaults);
        for (const maxRects of [0, -1, 21, NaN, 2.5])
            expect(() => whiteboardSettings({ maxRects })).toThrow();
        expect(
            whiteboardSettings({ enabled: false, maxRects: 20 }).enabled,
        ).toBe(false);
    });
    it("maps shared normalized boundaries without seams at different display scales", () => {
        for (const scale of [1, 1.5, 2]) {
            const [rect] = whiteboardRects(
                [{ x: 0.25, y: 0.1, width: 0.5, height: 0.3 }],
                5,
                1600 * scale,
                1000 * scale,
            );
            expect(rect.x).toBe(400 * scale);
            expect(rect.y).toBe(100 * scale);
            expect(rect.x + rect.width).toBe(1200 * scale);
            expect(rect.y + rect.height).toBe(400 * scale);
            expect(rect.width).toBeGreaterThan(720 * scale);
            expect(rect.height).toBeGreaterThan(270 * scale);
        }
        const result = whiteboardRects(
            [
                { x: 0, y: 0, width: 0.333, height: 1 },
                { x: 0.333, y: 0, width: 0.667, height: 1 },
            ],
            5,
            1921,
            1081,
        );
        expect(result[0].x + result[0].width).toBe(result[1].x);
        expect(result[1].x + result[1].width).toBe(1921);
    });
    it("covers a connected empty surface around content with five overlapping boards", () => {
        const cols = 100,
            rows = 80,
            mask = new Uint8Array(cols * rows);
        // A paragraph above a short choice column, inside a larger card.
        for (let y = 15; y < 39; y++)
            mask.fill(1, y * cols + 25, y * cols + 75);
        for (let y = 45; y < 65; y++)
            mask.fill(1, y * cols + 25, y * cols + 37);
        const rects = coverWhiteboardMask(mask, cols, rows, 5);
        const covered = new Uint8Array(mask.length);
        for (const r of rects)
            for (let y = r.y; y < r.y + r.height; y++)
                for (let x = r.x; x < r.x + r.width; x++) {
                    expect(mask[y * cols + x]).toBe(0);
                    covered[y * cols + x] = 1;
                }
        const eligible = mask.filter((v) => !v).length;
        expect(covered.reduce((n, v) => n + v, 0) / eligible).toBeGreaterThan(
            0.98,
        );
        // Continuous vertical writing strip spans both former card and page margin.
        for (let y = 0; y < rows; y++) expect(covered[y * cols + 80]).toBe(1);
        expect(rects.length).toBeLessThanOrEqual(5);
    });
    it("ignores decorative card edges but protects content and nearby missed glyphs", () => {
        const width = 400,
            height = 300,
            data = new Uint8ClampedArray(width * height * 4).fill(255);
        for (let y = 10; y < 290; y++)
            for (const x of [30, 370])
                for (let c = 0; c < 3; c++) data[(y * width + x) * 4 + c] = 0;
        for (let x = 95; x < 300; x++)
            for (let c = 0; c < 3; c++) data[(70 * width + x) * 4 + c] = 0;
        const rects = planWhiteboardRects(
            [{ x: 110, y: 65, width: 190, height: 20 }],
            { width, height, data },
            width,
            height,
            5,
        );
        expect(rects.some((r) => r.x === 0 && r.y === 0)).toBe(true);
        for (const r of rects) {
            expect(
                intersectRect(r, { x: 95, y: 70, width: 205, height: 1 }),
            ).toBeNull();
        }
        expect(
            rects.some(
                (r) =>
                    r.x <= 30 &&
                    r.x + r.width > 30 &&
                    r.y < 100 &&
                    r.y + r.height === 300,
            ),
        ).toBe(true);
    });
    it("rejects malformed, excessive, non-finite or out-of-screen model coordinates", () => {
        for (const value of [
            null,
            {},
            [{ x: -1, y: 0, width: 1, height: 1 }],
            [{ x: 0.8, y: 0, width: 0.3, height: 1 }],
            [{ x: 0, y: 0, width: NaN, height: 1 }],
            [{ x: "0", y: 0, width: 1, height: 1 }],
            Array(6).fill({ x: 0, y: 0, width: 1, height: 1 }),
        ])
            expect(() => whiteboardRects(value, 5, 1600, 1000)).toThrow();
    });
    it("clips to the archive scope and omits unusable tiny regions", () => {
        expect(
            intersectRect(
                { x: 0, y: 0, width: 200, height: 100 },
                { x: 100, y: 50, width: 200, height: 100 },
            ),
        ).toEqual({ x: 100, y: 50, width: 100, height: 50 });
        expect(
            whiteboardRects(
                [{ x: 0.1, y: 0.2, width: 0.001, height: 0.2 }],
                5,
                1600,
                1000,
            ),
        ).toEqual([]);
    });
});
