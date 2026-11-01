import { describe, expect, it } from "vitest";
import {
    intersectRect,
    refineWhiteboardRects,
    whiteboardDefaults,
    whiteboardRects,
    whiteboardSettings,
} from "../../lib/whiteboard";

describe("whiteboard geometry and settings", () => {
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
    it("maps normalized model coordinates conservatively at different display scales", () => {
        for (const scale of [1, 1.5, 2]) {
            const [rect] = whiteboardRects(
                [{ x: 0.25, y: 0.1, width: 0.5, height: 0.3 }],
                5,
                1600 * scale,
                1000 * scale,
            );
            expect(rect.x).toBeGreaterThan(400 * scale);
            expect(rect.y).toBeGreaterThan(100 * scale);
            expect(rect.x + rect.width).toBeLessThan(1200 * scale);
            expect(rect.y + rect.height).toBeLessThan(400 * scale);
            expect(rect.width).toBeGreaterThan(720 * scale);
            expect(rect.height).toBeGreaterThan(270 * scale);
        }
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
