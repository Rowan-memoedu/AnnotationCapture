import { FabricObject, Path } from "fabric";
import { type PressureInk, pressurePathData } from "./pressureGeometry";

export {
    type PressureInk,
    type PressurePoint,
    pressurePathData,
} from "./pressureGeometry";
export type PressurePath = Path & { acPressure: PressureInk };
FabricObject.customProperties = [
    ...FabricObject.customProperties,
    "acPressure",
];

export function isPressurePath(object: FabricObject): object is PressurePath {
    return object instanceof Path && "acPressure" in object;
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
