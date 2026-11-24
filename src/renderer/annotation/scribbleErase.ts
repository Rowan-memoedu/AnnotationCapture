import type { PressurePoint } from "./pressureInk";
import {
    detectScribble,
    type Scribble,
    scribbleCoverage,
} from "./scribbleGeometry";

type Bounds = { left: number; right: number; top: number; bottom: number };
type Ink<T> = Bounds & { id: T; points: readonly PressurePoint[] };
type Unit<T> = Bounds & { strokes: Ink<T>[]; ambiguous?: boolean };

const width = (box: Bounds) => box.right - box.left;
const height = (box: Bounds) => box.bottom - box.top;
const middle = (box: Bounds) => (box.top + box.bottom) / 2;
const gap = (a: Bounds, b: Bounds) => b.left - a.right;

function bounds(points: readonly PressurePoint[]): Bounds {
    const result = {
        left: Infinity,
        right: -Infinity,
        top: Infinity,
        bottom: -Infinity,
    };
    for (const [x, y] of points) {
        result.left = Math.min(result.left, x);
        result.right = Math.max(result.right, x);
        result.top = Math.min(result.top, y);
        result.bottom = Math.max(result.bottom, y);
    }
    return result;
}

function merge<T>(a: Unit<T>, b: Unit<T>): Unit<T> {
    return {
        left: a.left,
        right: Math.max(a.right, b.right),
        top: Math.min(a.top, b.top),
        bottom: Math.max(a.bottom, b.bottom),
        strokes: [...a.strokes, ...b.strokes],
    };
}

export function readScribble(
    points: readonly PressurePoint[],
    unitsPerPixel: number,
    duration = 0,
) {
    if (
        !Number.isFinite(unitsPerPixel) ||
        unitsPerPixel <= 0 ||
        duration > 1500
    )
        return null;
    return detectScribble(points.flat(), { minSize: 9 * unitsPerPixel });
}

function separateRows<T>(strokes: Ink<T>[], scale: number) {
    const rows: { center: number; strokes: Ink<T>[] }[] = [];
    for (const stroke of strokes.sort((a, b) => height(b) - height(a))) {
        const center = middle(stroke);
        let nearest: (typeof rows)[number] | undefined;
        let distance = scale * 0.47;
        for (const row of rows) {
            const offset = Math.abs(row.center - center);
            if (offset < distance) {
                distance = offset;
                nearest = row;
            }
        }
        if (nearest) nearest.strokes.push(stroke);
        else rows.push({ center, strokes: [stroke] });
    }
    return rows;
}

function components<T>(strokes: Ink<T>[], scale: number) {
    const units: Unit<T>[] = [];
    for (const stroke of strokes.sort((a, b) => a.left - b.left)) {
        const unit = { ...stroke, strokes: [stroke] };
        const last = units.at(-1);
        if (last && gap(last, unit) <= scale * 0.065) {
            units[units.length - 1] = merge(last, unit);
        } else units.push(unit);
    }
    return units;
}

function combineRadicals<T>(units: Unit<T>[], scale: number) {
    const result: Unit<T>[] = [];
    for (let i = 0; i < units.length; i++) {
        const current = units[i];
        const next = units[i + 1];
        const previous = units[i - 1];
        const after = units[i + 2];
        if (next && Math.min(width(current), width(next)) <= scale * 0.46) {
            const distance = gap(current, next);
            const surroundingGap = Math.min(
                previous ? gap(previous, current) : Infinity,
                after ? gap(next, after) : Infinity,
            );
            if (
                next.right - current.left <= scale * 1.08 &&
                distance <= scale * 0.24 &&
                distance <= surroundingGap * 0.76
            ) {
                result.push(merge(current, next));
                i++;
                continue;
            }
        }
        result.push(current);
    }
    return result;
}

function combineWords<T>(units: Unit<T>[], scale: number) {
    // Narrow components spaced as letters can form a word. A connected cursive
    // word already arrives as one component and can include narrow end letters.
    const looksLikeLatin = (unit: Unit<T>) =>
        width(unit) < scale * 0.62 || width(unit) > scale * 1.2;
    const result: Unit<T>[] = [];
    let start = 0;
    while (start < units.length) {
        let end = start + 1;
        while (
            end < units.length &&
            looksLikeLatin(units[end - 1]) &&
            looksLikeLatin(units[end]) &&
            gap(units[end - 1], units[end]) <= scale * 0.3
        )
            end++;
        const run = units.slice(start, end);
        if (run.length > 1) {
            const hasJoinedLetters = run.some(
                (unit) => width(unit) > scale * 1.2,
            );
            if (hasJoinedLetters || run.length >= 3)
                result.push(run.reduce(merge));
            else
                result.push(
                    ...run.map((unit) => ({ ...unit, ambiguous: true })),
                );
        } else result.push(run[0]);
        start = end;
    }
    return result;
}

function coversInk(
    scribble: Scribble,
    points: readonly PressurePoint[],
    margin: number,
    minimumLength: number,
) {
    const coverage = scribbleCoverage(scribble, points.flat(), margin);
    if (coverage >= 0.22) return true;
    if (coverage < 0.04) return false;

    let length = 0;
    for (let i = 1; i < points.length; i++) {
        length += Math.hypot(
            points[i][0] - points[i - 1][0],
            points[i][1] - points[i - 1][1],
        );
    }
    return coverage * length >= minimumLength;
}

export function scribbleTargets<T>(
    scribble: Scribble,
    paths: Iterable<{ id: T; points: readonly PressurePoint[] }>,
    unitsPerPixel: number,
): Set<T> {
    const { minX, maxX, minY, maxY } = scribble.bounds;
    const nearby: Ink<T>[] = [];
    const reach = Math.max(
        maxY - minY,
        Math.min(maxX - minX, 72 * unitsPerPixel),
        24 * unitsPerPixel,
    );
    for (const path of paths) {
        if (!path.points.length) continue;
        const box = bounds(path.points);
        if (box.bottom >= minY - reach && box.top <= maxY + reach)
            nearby.push({ ...path, ...box });
    }
    const heights = nearby
        .filter(
            ({ left, right }) =>
                right >= minX - 3 * reach && left <= maxX + 3 * reach,
        )
        .map(height)
        .filter((size) => size >= 6 * unitsPerPixel && size <= 2.5 * reach)
        .sort((a, b) => a - b);
    const scale = Math.max(
        10 * unitsPerPixel,
        (heights[Math.floor(heights.length * 0.65)] ?? reach * 0.6) * 1.12,
    );
    const strokes: Ink<T>[] = [];
    const marks: Ink<T>[] = [];
    for (const stroke of nearby) {
        const w = width(stroke);
        const h = height(stroke);
        // Fraction bars, underlines and strokes crossing multiple rows don't
        // provide evidence for assigning neighbouring writing to the same word.
        if ((w > 1.25 * scale && h < 0.18 * scale) || h > 1.9 * scale) continue;
        if (Math.max(w, h) < 0.22 * scale) marks.push(stroke);
        else strokes.push(stroke);
    }
    const units = separateRows(strokes, scale).flatMap((row) =>
        combineRadicals(
            combineWords(components(row.strokes, scale), scale),
            scale,
        ),
    );
    // Attach dots only after words are separated. A dot touching two possible
    // units is ambiguous and cannot join those units together.
    for (const mark of marks) {
        const matches = units.filter(
            (unit) =>
                mark.left <= unit.right + scale * 0.11 &&
                mark.right >= unit.left - scale * 0.11 &&
                mark.top <= unit.bottom + scale * 0.42 &&
                mark.bottom >= unit.top - scale * 0.42,
        );
        if (matches.length === 1) matches[0].strokes.push(mark);
        if (matches.length > 1) {
            for (const unit of matches) unit.ambiguous = true;
        }
    }
    const result = new Set<T>();
    const margin = 1.5 * unitsPerPixel;
    const minimumLength = Math.max(8 * unitsPerPixel, 0.18 * scale);
    for (const unit of units) {
        if (
            !unit.ambiguous &&
            unit.strokes.some(
                ({ points, left, right, top, bottom }) =>
                    right >= minX - margin &&
                    left <= maxX + margin &&
                    bottom >= minY - margin &&
                    top <= maxY + margin &&
                    coversInk(scribble, points, margin, minimumLength),
            )
        ) {
            for (const stroke of unit.strokes) result.add(stroke.id);
        }
    }
    return result;
}
