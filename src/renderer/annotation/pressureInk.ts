import { FabricObject, Path, type TSimplePathData } from "fabric";
import { getStroke } from "perfect-freehand";

export type PressurePoint = [x: number, y: number, pressure: number];
export type PressureInk = {
    version: 1;
    points: PressurePoint[];
    width: number;
    sensitivity: number;
};
export type PressurePath = Path & { acPressure: PressureInk };
FabricObject.customProperties = [
    ...FabricObject.customProperties,
    "acPressure",
];

export function isPressurePath(object: FabricObject): object is PressurePath {
    return object instanceof Path && "acPressure" in object;
}

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

export function createPressurePath(ink: PressureInk, color: string) {
    const path = new Path(pressurePathData(ink), {
        fill: color,
        stroke: null,
        strokeWidth: 0,
    }) as PressurePath;
    path.acPressure = ink;
    return path;
}

export function resizePressurePath(path: PressurePath, width: number) {
    const offset = path.pathOffset.clone();
    const matrix = path.calcOwnMatrix();
    const center = path.getRelativeCenterPoint();
    path.acPressure = { ...path.acPressure, width };
    path.set("path", pressurePathData(path.acPressure));
    path.setDimensions();
    const delta = path.pathOffset.subtract(offset);
    path.setPositionByOrigin(
        center.add(delta.transform(matrix, true)),
        "center",
        "center",
    );
    if (path.clipPath && !path.clipPath.absolutePositioned) {
        path.clipPath.set({
            left: path.clipPath.left - delta.x,
            top: path.clipPath.top - delta.y,
        });
    }
    path.setCoords();
}

export function inkColor(path: FabricObject) {
    return isPressurePath(path) ? path.fill : path.stroke;
}

export function isPressureTap(path: PressurePath) {
    const [first] = path.acPressure.points;
    return (
        !!first &&
        path.acPressure.points.every(
            ([x, y]) => Math.hypot(x - first[0], y - first[1]) <= 3,
        )
    );
}
