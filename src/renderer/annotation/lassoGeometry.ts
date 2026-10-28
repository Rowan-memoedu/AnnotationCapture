import type { LassoRule } from "../../../lib/annotation";

export type Position = { x: number; y: number };
const epsilon = 1e-7;
const cross = (a: Position, b: Position) => a.x * b.y - a.y * b.x;
const minus = (a: Position, b: Position) => ({ x: a.x - b.x, y: a.y - b.y });

function pointDistance(p: Position, a: Position, b: Position) {
    const d = minus(b, a);
    const length = d.x * d.x + d.y * d.y;
    const t = length
        ? Math.max(
              0,
              Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / length),
          )
        : 0;
    return Math.hypot(p.x - a.x - t * d.x, p.y - a.y - t * d.y);
}

export function insideLasso(point: Position, polygon: Position[]) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i],
            b = polygon[j];
        if (pointDistance(point, a, b) < epsilon) return true;
        if (
            a.y > point.y !== b.y > point.y &&
            point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
        )
            inside = !inside;
    }
    return inside;
}

export function polylineMatchesLasso(
    points: Position[],
    polygon: Position[],
    rule: LassoRule,
    radius = 0,
) {
    if (!points.length || polygon.length < 3) return false;
    const edges = polygon.map(
        (a, i) => [a, polygon[(i + 1) % polygon.length]] as const,
    );
    const contained = (p: Position) =>
        insideLasso(p, polygon) &&
        edges.every(([a, b]) => pointDistance(p, a, b) + epsilon >= radius);
    if (rule === "contain" && !points.every(contained)) return false;
    if (rule === "intersect" && points.some((p) => insideLasso(p, polygon)))
        return true;
    for (let i = 0; i < points.length; i++) {
        const a = points[i],
            b = points[i + 1] ?? a,
            d = minus(b, a);
        const cuts = [0, 1];
        for (const [c, e] of edges) {
            const edge = minus(e, c),
                denominator = cross(d, edge);
            const t = cross(minus(c, a), edge) / denominator;
            const u = cross(minus(c, a), d) / denominator;
            const crossing =
                Math.abs(denominator) > epsilon &&
                t >= 0 &&
                t <= 1 &&
                u >= 0 &&
                u <= 1;
            const distance = crossing
                ? 0
                : Math.min(
                      pointDistance(a, c, e),
                      pointDistance(b, c, e),
                      pointDistance(c, a, b),
                      pointDistance(e, a, b),
                  );
            if (rule === "intersect" && distance <= radius + epsilon)
                return true;
            if (rule === "contain" && distance + epsilon < radius) return false;
            if (crossing) cuts.push(t);
        }
        if (rule === "contain") {
            cuts.sort((x, y) => x - y);
            for (let j = 1; j < cuts.length; j++) {
                const t = (cuts[j - 1] + cuts[j]) / 2;
                if (
                    !insideLasso(
                        { x: a.x + t * d.x, y: a.y + t * d.y },
                        polygon,
                    )
                )
                    return false;
            }
        }
    }
    return rule === "contain";
}
