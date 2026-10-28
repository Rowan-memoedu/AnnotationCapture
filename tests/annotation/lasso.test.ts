import { describe, expect, it } from "vitest";
import { polylineMatchesLasso } from "../../src/renderer/annotation/lassoGeometry";

const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
];
describe("lasso selection geometry", () => {
    it("selects a crossing stroke even when neither endpoint is inside", () => {
        const line = [
            { x: -10, y: 5 },
            { x: 20, y: 5 },
        ];
        expect(polylineMatchesLasso(line, square, "intersect")).toBe(true);
        expect(polylineMatchesLasso(line, square, "contain")).toBe(false);
    });
    it("tests actual geometry instead of an overlapping bounding box", () => {
        expect(
            polylineMatchesLasso(
                [
                    { x: -10, y: 5 },
                    { x: 5, y: 20 },
                ],
                square,
                "intersect",
            ),
        ).toBe(false);
    });
    it("accounts for visible pen width and boundary contact", () => {
        const line = [
            { x: 2, y: -1 },
            { x: 8, y: -1 },
        ];
        expect(polylineMatchesLasso(line, square, "intersect", 1)).toBe(true);
        expect(polylineMatchesLasso(line, square, "intersect", 0.5)).toBe(
            false,
        );
        expect(
            polylineMatchesLasso(
                [
                    { x: 2, y: 1 },
                    { x: 8, y: 1 },
                ],
                square,
                "contain",
                2,
            ),
        ).toBe(false);
        expect(
            polylineMatchesLasso(
                [
                    { x: 2, y: 2 },
                    { x: 8, y: 2 },
                ],
                square,
                "contain",
                1,
            ),
        ).toBe(true);
    });
    it("does not treat a concave polygon's gap as enclosed", () => {
        const concave = [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 7, y: 10 },
            { x: 7, y: 3 },
            { x: 3, y: 3 },
            { x: 3, y: 10 },
            { x: 0, y: 10 },
        ];
        expect(
            polylineMatchesLasso(
                [
                    { x: 2, y: 8 },
                    { x: 8, y: 8 },
                ],
                concave,
                "contain",
            ),
        ).toBe(false);
        expect(
            polylineMatchesLasso(
                [
                    { x: 4, y: 8 },
                    { x: 6, y: 8 },
                ],
                concave,
                "intersect",
            ),
        ).toBe(false);
    });
    it("ignores empty strokes and unfinished lassos", () => {
        expect(polylineMatchesLasso([], square, "contain")).toBe(false);
        expect(
            polylineMatchesLasso(
                [{ x: 1, y: 1 }],
                square.slice(0, 2),
                "intersect",
            ),
        ).toBe(false);
    });
});
