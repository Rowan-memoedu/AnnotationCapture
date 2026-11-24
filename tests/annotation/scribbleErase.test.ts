import { describe, expect, it } from "vitest";
import type { PressurePoint } from "../../src/renderer/annotation/pressureInk";
import {
    readScribble,
    scribbleTargets,
} from "../../src/renderer/annotation/scribbleErase";

const points = (xy: number[][]): PressurePoint[] =>
    xy.map(([x, y]) => [x, y, 0.5]);
const stroke = (id: string, ...xy: number[][]) => ({ id, points: points(xy) });

function rub(left: number, right: number, top: number, passes = 5) {
    return points(
        Array.from({ length: passes + 1 }, (_, i) => [
            i % 2 ? right : left,
            top + i * 2,
        ]),
    );
}

function targets(
    gesture: PressurePoint[],
    paths: ReturnType<typeof stroke>[],
    unitsPerPixel = 1,
) {
    const scribble = readScribble(gesture, unitsPerPixel);
    return scribble
        ? [...scribbleTargets(scribble, paths, unitsPerPixel)].sort()
        : [];
}

describe("scribble erase", () => {
    const chinese = [
        // Two parts of a wide character, written between two nearby characters.
        stroke("left", [0, 0], [17, 0], [17, 24], [0, 24], [0, 0]),
        stroke("left-inner", [0, 12], [17, 12]),
        stroke("target-left", [31, 0], [27, 9], [34, 9], [30, 19], [35, 16]),
        stroke("target-right", [41, 0], [41, 8]),
        stroke("target-right-top", [39, 6], [54, 6]),
        stroke(
            "target-right-box",
            [40, 10],
            [54, 10],
            [54, 24],
            [40, 24],
            [40, 10],
        ),
        stroke("target-right-inner", [40, 17], [53, 17]),
        stroke("right", [64, 0], [84, 0], [84, 24], [64, 24], [64, 0]),
        stroke("right-inner", [64, 12], [84, 12]),
    ];

    it("erases both components of a Chinese character after crossing only its right half", () => {
        const expected = chinese
            .filter(({ id }) => id.startsWith("target"))
            .map(({ id }) => id)
            .sort();
        expect(targets(rub(38, 55, 11), chinese)).toEqual(expected);
    });

    it("recognizes the same target in zoomed canvas coordinates", () => {
        const double = (samples: PressurePoint[]) =>
            samples.map(([x, y, p]): PressurePoint => [2 * x, 2 * y, p]);
        expect(
            targets(
                double(rub(38, 55, 11)),
                chinese.map((path) => ({
                    ...path,
                    points: double(path.points),
                })),
                2,
            ),
        ).toEqual(targets(rub(38, 55, 11), chinese));
    });

    it("erases the connected word and its delayed dot while preserving the next word", () => {
        const english = [
            stroke(
                "word",
                [0, 26],
                [4, 8],
                [6, 21],
                [12, 25],
                [16, 14],
                [18, 25],
                [23, 14],
                [27, 25],
                [30, 14],
                [34, 25],
                [40, 15],
                [45, 17],
                [39, 22],
                [48, 25],
            ),
            stroke("cross", [1, 12], [9, 12]),
            stroke("next", [65, 25], [73, 9], [79, 24], [88, 17], [92, 25]),
            stroke("dot", [16, 8]),
        ];
        expect(targets(rub(22, 45, 17), english)).toEqual([
            "cross",
            "dot",
            "word",
        ]);
    });

    it("collects individually written letters within a word and stops at the wider inter-word gap", () => {
        const print = [
            stroke("w", [0, 10], [2, 27], [5, 19], [8, 27], [11, 10]),
            stroke(
                "o",
                [15, 11],
                [13, 24],
                [20, 27],
                [23, 20],
                [22, 12],
                [15, 11],
            ),
            stroke("r", [27, 27], [27, 12], [34, 11]),
            stroke(
                "d",
                [42, 10],
                [37, 14],
                [37, 25],
                [42, 26],
                [46, 8],
                [46, 27],
            ),
            stroke("next", [61, 27], [65, 10], [73, 27], [80, 11]),
        ];
        expect(targets(rub(15, 35, 14), print)).toEqual(["d", "o", "r", "w"]);
    });

    it("keeps the lower line and a horizontal fraction bar", () => {
        const twoLines = [
            ...chinese,
            stroke("bar", [27, 26], [85, 26]),
            ...chinese.map((path) => ({
                id: `below-${path.id}`,
                points: path.points.map(
                    ([x, y, p]): PressurePoint => [x, y + 29, p],
                ),
            })),
        ];
        expect(targets(rub(37, 57, 12), twoLines)).toEqual(
            targets(rub(37, 57, 12), chinese),
        );
    });

    it("checks the complete word beyond the area used to estimate letter size", () => {
        const word = Array.from({ length: 12 }, (_, i) =>
            stroke(String(i), [12 * i, 18], [12 * i, 0], [12 * i + 8, 18]),
        );
        expect(targets(rub(0, 22, 3), word)).toEqual(
            word.map(({ id }) => id).sort(),
        );
    });

    it("erases a connected glyph when the rub crosses a substantial part of only one side", () => {
        const boxes = [
            stroke("target", [0, 0], [29, 0], [29, 38], [0, 38], [0, 0]),
            stroke("next", [48, 0], [80, 0], [80, 38], [48, 38], [48, 0]),
        ];
        expect(targets(rub(21, 39, 11), boxes)).toEqual(["target"]);
    });

    it("leaves normal strokes, unsupported scratches and blank areas alone", () => {
        expect(
            targets(
                points([
                    [20, 12],
                    [70, 12],
                ]),
                chinese,
            ),
        ).toEqual([]);
        expect(targets(rub(38, 55, 11, 4), chinese)).toEqual([]);
        expect(targets(rub(110, 150, 12), chinese)).toEqual([]);
        expect(readScribble(rub(38, 55, 11), 1, 2000)).toBeNull();
    });
});
