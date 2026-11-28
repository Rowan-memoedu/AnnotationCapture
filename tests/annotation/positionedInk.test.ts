import { describe, expect, it } from "vitest";
import { locateFieldInk } from "../../src/renderer/annotation/positionedInk";

function sample(entries: [number, number, number, number][]) {
    const rgba = new Uint8ClampedArray(150 * 100 * 4);
    for (const [left, top, w, h] of entries)
        for (let y = top; y < top + h; y++)
            for (let x = left; x < left + w; x++)
                rgba[(y * 150 + x) * 4 + 3] = 255;
    return rgba;
}
const box = (id: string, x: number, y: number) => ({
    id,
    x,
    y,
    width: 16,
    height: 16,
});
describe("handwriting over visible answer fields", () => {
    it("labels disjoint ink by visual position across uneven rows, including a minus and stacked fraction", () => {
        const fields = [
            box("s1", 115, 65),
            box("s2", 16, 8),
            box("s3", 20, 65),
            box("s4", 115, 8),
            box("s5", 60, 65),
        ];
        const ink = sample([
            [115, 65, 10, 14],
            [16, 8, 11, 15],
            [20, 65, 2, 15],
            [115, 8, 12, 15],
            [55, 73, 6, 1],
            [68, 65, 3, 5],
            [65, 72, 9, 1],
            [67, 75, 4, 5],
        ]);
        expect(
            locateFieldInk(ink, 150, 100, fields).map((r) => [
                r.id,
                r.x,
                r.width,
            ]),
        ).toEqual([
            ["s1", 115, 10],
            ["s2", 16, 11],
            ["s3", 20, 2],
            ["s4", 115, 12],
            ["s5", 55, 19],
        ]);
    });
    it("refuses missing entries and ambiguous subdivisions of a fraction", () => {
        const fields = [box("s1", 10, 10), box("s2", 10, 68)];
        expect(() =>
            locateFieldInk(sample([[10, 10, 9, 14]]), 150, 100, fields),
        ).toThrow();
        expect(() =>
            locateFieldInk(
                sample([
                    [10, 10, 9, 3],
                    [10, 17, 9, 1],
                    [10, 22, 9, 3],
                ]),
                150,
                100,
                fields,
            ),
        ).toThrow();
    });
});
