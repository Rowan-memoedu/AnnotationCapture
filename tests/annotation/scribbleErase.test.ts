import { describe, expect, it } from "vitest";
import type { PressurePoint } from "../../src/renderer/annotation/pressureInk";
import { readScribble } from "../../src/renderer/annotation/scribbleErase";

const points = (xy: number[][]): PressurePoint[] =>
    xy.map(([x, y]) => [x, y, 0.5]);

function rub(passes = 5) {
    return points(
        Array.from({ length: passes + 1 }, (_, i) => [
            i % 2 ? 55 : 38,
            11 + i * 2,
        ]),
    );
}

describe("scribble detection", () => {
    it("recognizes the same gesture at different canvas zoom levels", () => {
        expect(readScribble(rub(), 1)).not.toBeNull();
        const doubled = rub().map(
            ([x, y, p]): PressurePoint => [2 * x, 2 * y, p],
        );
        expect(readScribble(doubled, 2)).not.toBeNull();
    });

    it("keeps normal strokes, short scratches, and slow handwriting as ink", () => {
        expect(
            readScribble(
                points([
                    [20, 12],
                    [70, 12],
                ]),
                1,
            ),
        ).toBeNull();
        expect(readScribble(rub(4), 1)).toBeNull();
        expect(readScribble(rub(), 1, 2000)).toBeNull();
    });
});
