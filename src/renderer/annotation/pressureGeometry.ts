import type { TSimplePathData } from "fabric";
import { getStroke } from "perfect-freehand";

export type PressurePoint = [x: number, y: number, pressure: number];
export type PressureInk = {
    version: 1;
    points: PressurePoint[];
    width: number;
    sensitivity: number;
};

export function pressurePathData(ink: PressureInk): TSimplePathData {
    const outline = getStroke(ink.points, {
        size: ink.width,
        thinning: (ink.sensitivity / 100) * 0.9,
        simulatePressure: false,
        streamline: 0,
        smoothing: 0.5,
        last: true,
    });
    if (!outline.length) return [];
    return [
        ["M", outline[0][0], outline[0][1]],
        ...outline.slice(1).map(([x, y]): ["L", number, number] => ["L", x, y]),
        ["Z"],
    ];
}
