import { describe, expect, it } from "vitest";
import {
    intersectRect,
    whiteboardDefaults,
    whiteboardRects,
    whiteboardSettings,
} from "../../lib/whiteboard";

describe("whiteboard geometry and settings", () => {
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
