import type { Position } from "./lassoGeometry";

export const shapeTitles = {
    line: ["直线", "Line"],
    arrow: ["箭头", "Arrow"],
    rect: ["矩形", "Rectangle"],
    circle: ["圆", "Circle"],
    ellipse: ["椭圆", "Ellipse"],
    diamond: ["菱形", "Diamond"],
    polyline: ["折线", "Polyline"],
    polygon: ["多边形", "Polygon"],
} as const;

export function diamondPoints(
    x: number,
    y: number,
    w: number,
    h: number,
): Position[] {
    return [
        { x: x + w / 2, y },
        { x: x + w, y: y + h / 2 },
        { x: x + w / 2, y: y + h },
        { x, y: y + h / 2 },
    ];
}

export function arrowPoints(
    start: Position,
    end: Position,
    height: number,
    width: number,
) {
    const dx = end.x - start.x,
        dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (!length) return [];
    const ux = dx / length,
        uy = dy / length;
    const depth = Math.min(Math.max(1, height), length * 0.65);
    const half = (width * depth) / (2 * Math.max(1, height));
    const x = end.x - ux * depth,
        y = end.y - uy * depth;
    return [
        { x: x - uy * half, y: y + ux * half },
        end,
        { x: x + uy * half, y: y - ux * half },
    ];
}

export function bindToolHover(
    trigger: HTMLElement,
    open: () => void,
    leave: () => void,
) {
    let pending: ReturnType<typeof setTimeout> | undefined;
    trigger.addEventListener("mouseenter", () => {
        pending = setTimeout(open, 100);
    });
    trigger.addEventListener("pointerleave", () => {
        clearTimeout(pending);
        leave();
    });
    trigger.addEventListener("click", () => clearTimeout(pending));
}
