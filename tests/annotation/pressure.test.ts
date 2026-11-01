import { Path, Point } from "fabric";
import { describe, expect, it } from "vitest";
import {
    createPressurePath,
    isPressurePath,
    isPressureTap,
    type PressureInk,
    pressurePathData,
    resizePressurePath,
} from "../../src/renderer/annotation/pressureInk";

function line(pressure: number, sensitivity = 50): PressureInk {
    return {
        version: 1,
        width: 10,
        sensitivity,
        points: Array.from({ length: 51 }, (_, i) => [i * 4, 50, pressure]),
    };
}
function thickness(ink: PressureInk) {
    const ys = pressurePathData(ink).flatMap((command) =>
        command[0] === "L" && command[1] > 50 && command[1] < 150
            ? [command[2]]
            : [],
    );
    return Math.max(...ys) - Math.min(...ys);
}

describe("pressure ink geometry and storage", () => {
    it("makes heavier pressure wider without relying on movement speed", () => {
        expect(thickness(line(0.9))).toBeGreaterThan(
            thickness(line(0.1)) * 1.5,
        );
        const ink = line(0.9);
        ink.points = ink.points.filter((_, i) => i % 2 === 0);
        expect(thickness(ink)).toBeCloseTo(thickness(line(0.9)), 5);
    });
    it("increases the light-heavy range with sensitivity and retains neutral width", () => {
        expect(
            thickness(line(0.9, 100)) - thickness(line(0.1, 100)),
        ).toBeGreaterThan(thickness(line(0.9, 10)) - thickness(line(0.1, 10)));
        expect(thickness(line(0.5, 100))).toBeCloseTo(10, 5);
    });
    it("survives JSON rehydration with geometry, pressure samples and color", async () => {
        const path = createPressurePath(line(0.7), "#2266cc");
        const json = path.toObject();
        const restored = await Path.fromObject(
            JSON.parse(JSON.stringify(json)),
        );
        expect(isPressurePath(restored)).toBe(true);
        expect(restored.toObject()).toEqual(json);
        expect(restored.fill).toBe("#2266cc");
        expect(restored.stroke).toBeNull();
    });
    it("resizes rotated, moved ink without shifting the source trajectory", () => {
        const ink = line(0.4);
        ink.points = ink.points.map(([x, y], i) => [x, y + i * 0.5, i / 50]);
        const path = createPressurePath(ink, "#ff0000");
        path.set({ angle: 25, scaleX: 1.3, scaleY: 0.8, left: 300, top: 200 });
        const anchor = () =>
            new Point(100, 62.5)
                .subtract(path.pathOffset)
                .transform(path.calcTransformMatrix());
        const before = anchor();
        resizePressurePath(path, 25);
        expect(anchor().distanceFrom(before)).toBeLessThan(0.00001);
        expect(path.acPressure.width).toBe(25);
        expect(path.strokeWidth).toBe(0);
    });
    it("keeps stationary pressure dots visible and distinguishes movement from a tap", () => {
        const dot = createPressurePath(
            { version: 1, width: 8, sensitivity: 100, points: [[25, 25, 0.8]] },
            "#000000",
        );
        expect(dot.width).toBeGreaterThan(4);
        expect(dot.height).toBeGreaterThan(4);
        expect(isPressureTap(dot)).toBe(true);
        expect(isPressureTap(createPressurePath(line(0.8), "#000000"))).toBe(
            false,
        );
    });
});
