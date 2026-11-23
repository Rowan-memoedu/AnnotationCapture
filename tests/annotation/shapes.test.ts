import { Ellipse, Line, Path, Polygon } from "fabric";
import { describe, expect, it } from "vitest";
import {
    createArrow,
    shapeMatchesLasso,
} from "../../src/renderer/annotation/shapeGeometry";

const box = (x: number, y: number, w: number, h: number) => [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
];

describe("whiteboard shapes", () => {
    it("preserves an editable arrow shaft and head through Fabric serialization", async () => {
        const start = { x: 30, y: 40 };
        const end = { x: 10, y: 40 };
        const head = { type: "fill", w: 10, h: 16 } as const;
        expect(createArrow(start, start, "#333", 3, head)).toBeNull();
        const arrow = createArrow(start, end, "#333", 3, head);
        expect(arrow?.path).toEqual([
            ["M", 30, 40],
            ["L", 10, 40],
            ["M", 23, 35.9375],
            ["L", 10, 40],
            ["L", 23, 44.0625],
            ["Z"],
        ]);
        if (!arrow) throw new Error("Expected a nonzero arrow");
        const copy = await Path.fromObject(arrow.toObject(["形状"]));
        expect(copy.形状).toBe("arrow");
        expect(copy.path).toEqual(arrow.path);
        expect(copy.strokeWidth).toBe(3);
        expect(copy.fill).toBe("#333");
    });

    it("lassos line strokes without selecting empty bounding-box corners", () => {
        const line = new Line([0, 0, 100, 100], {
            stroke: "#333",
            strokeWidth: 4,
        });
        expect(shapeMatchesLasso(line, box(10, 75, 8, 8), "intersect")).toBe(
            false,
        );
        expect(shapeMatchesLasso(line, box(30, 30, 4, 4), "intersect")).toBe(
            true,
        );
    });

    it("uses transformed outlines and respects transparent fill", () => {
        const ellipse = new Ellipse({
            originX: "center",
            originY: "center",
            left: 100,
            top: 100,
            rx: 40,
            ry: 20,
            angle: 90,
            fill: "transparent",
            stroke: "#333",
        });
        expect(
            shapeMatchesLasso(ellipse, box(95, 95, 10, 10), "intersect"),
        ).toBe(false);
        expect(
            shapeMatchesLasso(ellipse, box(95, 58, 10, 5), "intersect"),
        ).toBe(true);
        ellipse.set("fill", "#fff");
        expect(
            shapeMatchesLasso(ellipse, box(95, 95, 10, 10), "intersect"),
        ).toBe(true);
    });

    it("contains a diamond along its silhouette inside a tight lasso", () => {
        const outline = [
            { x: 40, y: 15 },
            { x: 65, y: 40 },
            { x: 40, y: 65 },
            { x: 15, y: 40 },
        ];
        const diamond = new Polygon(outline, { fill: "#fff", stroke: null });
        const lasso = outline.map(({ x, y }) => ({
            x: 40 + (x - 40) * 1.1,
            y: 40 + (y - 40) * 1.1,
        }));
        expect(shapeMatchesLasso(diamond, lasso, "contain")).toBe(true);
        expect(shapeMatchesLasso(diamond, box(15, 15, 5, 5), "intersect")).toBe(
            false,
        );
    });
});
