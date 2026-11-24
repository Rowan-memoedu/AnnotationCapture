import {
    Circle,
    Color,
    Ellipse,
    type FabricObject,
    Line,
    Path,
    Point,
    Polygon,
    Polyline,
    Rect,
    type TSimplePathData,
} from "fabric";
import type { LassoRule } from "../../../lib/annotation";
import type { setting } from "../../ShareTypes";
import { type Position, polylineMatchesLasso } from "./lassoGeometry";
import { arrowPoints } from "./shapeTools";

export function createArrow(
    start: Position,
    end: Position,
    stroke: string,
    strokeWidth: number,
    head: setting["图像编辑"]["arrow"],
) {
    const wings = arrowPoints(start, end, head.h, head.w);
    if (!wings.length) return null;
    const filled = head.type === "fill";
    const path: TSimplePathData = [
        ["M", start.x, start.y],
        ["L", end.x, end.y],
        ["M", wings[0].x, wings[0].y],
        ["L", end.x, end.y],
        ["L", wings[2].x, wings[2].y],
    ];
    if (filled) path.push(["Z"]);
    return new Path(path, {
        stroke,
        strokeWidth,
        fill: filled ? stroke : null,
        strokeLineCap: "round",
        strokeLineJoin: "round",
        形状: "arrow",
    });
}

export function shapeMatchesLasso(
    object: FabricObject,
    polygon: Position[],
    rule: LassoRule,
): boolean | undefined {
    let outline: Position[];
    let closed = true;
    if (object instanceof Line) {
        const { x1, y1, x2, y2 } = object.calcLinePoints();
        outline = [
            { x: x1, y: y1 },
            { x: x2, y: y2 },
        ];
        closed = false;
    } else if (object instanceof Ellipse || object instanceof Circle) {
        const rx = object instanceof Circle ? object.radius : object.rx;
        const ry = object instanceof Circle ? object.radius : object.ry;
        outline = Array.from({ length: 96 }, (_, index) => {
            const angle = (index * Math.PI) / 48;
            return { x: rx * Math.cos(angle), y: ry * Math.sin(angle) };
        });
    } else if (object instanceof Polyline) {
        outline = object.points.map(({ x, y }) => ({
            x: x - object.pathOffset.x,
            y: y - object.pathOffset.y,
        }));
        closed = object instanceof Polygon;
    } else if (object instanceof Rect) {
        const x = object.width / 2;
        const y = object.height / 2;
        outline = [
            { x: -x, y: -y },
            { x, y: -y },
            { x, y },
            { x: -x, y },
        ];
    } else {
        return undefined;
    }
    const matrix = object.calcTransformMatrix();
    const points = outline.map((p) => new Point(p).transform(matrix));
    if (closed && points.length) points.push(points[0]);
    const scale = Math.max(
        Math.hypot(matrix[0], matrix[1]),
        Math.hypot(matrix[2], matrix[3]),
    );
    const radius = object.stroke
        ? (object.strokeWidth * (object.strokeUniform ? 1 : scale)) / 2
        : 0;
    return (
        polylineMatchesLasso(points, polygon, rule, radius) ||
        (closed &&
            rule === "intersect" &&
            !!object.fill &&
            (typeof object.fill !== "string" ||
                new Color(object.fill).getAlpha() > 0) &&
            polylineMatchesLasso(polygon, points, "intersect"))
    );
}
