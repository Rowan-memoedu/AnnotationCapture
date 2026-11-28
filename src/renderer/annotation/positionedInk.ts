import type { AcademyFieldBox, PixelRect } from "../../../lib/annotation";

type Run = { start: number; end: number };
const unclear =
    "无法分清每个空位的笔迹。请把各空的答案写开，框选全部空位，或改用完整答案。";

// Split at the widest empty bands. A fraction, decimal point or detached minus
// can have internal whitespace, so never split at an arbitrary pixel or stroke.
function bands(projection: Uint8Array, count: number): Run[] {
    const first = projection.indexOf(1);
    const last = projection.lastIndexOf(1);
    if (first < 0) throw Error(unclear);
    if (count === 1) return [{ start: first, end: last + 1 }];
    const gaps: Run[] = [];
    for (let i = first + 1; i < last; i++) {
        if (projection[i]) continue;
        const start = i;
        while (i < last && !projection[i]) i++;
        gaps.push({ start, end: i });
    }
    const length = (r: Run) => r.end - r.start;
    gaps.sort((a, b) => length(b) - length(a));
    const boundary = gaps[count - 2];
    const internal = gaps[count - 1];
    if (
        !boundary ||
        length(boundary) < 3 ||
        (internal && length(boundary) < 1.5 * length(internal))
    )
        throw Error(unclear);
    const splits = gaps.slice(0, count - 1).sort((a, b) => a.start - b.start);
    return [first, ...splits.map((s) => s.end)].map((start, i) => ({
        start,
        end: splits[i]?.start ?? last + 1,
    }));
}

export function locateFieldInk(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    fields: AcademyFieldBox[],
) {
    if (
        fields.length < 2 ||
        fields.some(
            (f) =>
                !/^s\d+$/.test(f.id) ||
                ![f.x, f.y, f.width, f.height].every(Number.isFinite) ||
                f.width <= 0 ||
                f.height <= 0,
        )
    )
        throw Error(unclear);
    const cx = (f: AcademyFieldBox) => f.x + f.width / 2;
    const cy = (f: AcademyFieldBox) => f.y + f.height / 2;
    const rows: AcademyFieldBox[][] = [];
    for (const field of [...fields].sort((a, b) => cy(a) - cy(b))) {
        const row = rows.at(-1);
        if (
            row &&
            cy(field) - cy(row[0]) < Math.min(field.height, row[0].height) * 0.6
        )
            row.push(field);
        else rows.push([field]);
    }
    const horizontal = new Uint8Array(height);
    const rowStarts = new Int32Array(height).fill(width);
    const rowEnds = new Int32Array(height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (pixels[(y * width + x) * 4 + 3] <= 8) continue;
            horizontal[y] = 1;
            rowStarts[y] = Math.min(rowStarts[y], x);
            rowEnds[y] = x + 1;
        }
    }
    const ranges = bands(horizontal, rows.length);
    const crops = new Map<string, PixelRect>();
    for (const [i, row] of rows.entries()) {
        const vertical = new Uint8Array(width);
        const ys = ranges[i];
        for (let y = ys.start; y < ys.end; y++)
            for (let x = rowStarts[y]; x < rowEnds[y]; x++)
                if (pixels[(y * width + x) * 4 + 3] > 8) vertical[x] = 1;
        const columns = bands(vertical, row.length);
        row.sort((a, b) => cx(a) - cx(b));
        row.forEach((field, j) => {
            const xs = columns[j];
            crops.set(field.id, {
                x: xs.start,
                y: ys.start,
                width: xs.end - xs.start,
                height: ys.end - ys.start,
            });
        });
    }
    // Check the alignment across rows as well. A missing entry plus a detached
    // stroke must not silently move a neighboring answer into an empty box.
    for (const axis of ["x", "y"] as const) {
        const size = axis === "x" ? "width" : "height";
        const page = fields.map((f) => f[axis] + f[size] / 2);
        const ink = fields.map((f) => {
            const r = crops.get(f.id)!;
            return r[axis] + r[size] / 2;
        });
        const span = Math.max(...page) - Math.min(...page);
        if (span <= Math.max(...fields.map((f) => f[size]))) continue;
        const scale = (Math.max(...ink) - Math.min(...ink)) / span;
        for (const [j, f] of fields.entries()) {
            const offset =
                (page[j] - Math.min(...page)) * scale + Math.min(...ink);
            const tolerance =
                Math.max(f[size] * scale, crops.get(f.id)![size]) * 0.75 + 4;
            if (Math.abs(ink[j] - offset) > tolerance) throw Error(unclear);
        }
    }
    return fields.map((f) => ({ id: f.id, ...crops.get(f.id)! }));
}

export function positionedInkPng(
    ink: HTMLCanvasElement,
    rect: PixelRect,
    fields: AcademyFieldBox[],
) {
    const data = ink
        .getContext("2d")!
        .getImageData(rect.x, rect.y, rect.width, rect.height);
    const crops = locateFieldInk(data.data, data.width, data.height, fields);
    const output = document.createElement("canvas");
    const rowHeight = 76;
    const size = (crop: PixelRect) =>
        Math.min(1.8, 56 / crop.height, 510 / crop.width);
    output.width = Math.ceil(
        84 + Math.max(...crops.map((c) => c.width * size(c))),
    );
    output.height = rowHeight * crops.length;
    const ctx = output.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, output.width, output.height);
    ctx.font = "bold 22px sans-serif";
    ctx.textBaseline = "middle";
    for (const [i, crop] of crops.entries()) {
        const middle = (i + 0.5) * rowHeight;
        const w = crop.width * size(crop),
            h = crop.height * size(crop);
        ctx.fillStyle = "#263647";
        ctx.fillText(crop.id, 8, middle);
        ctx.drawImage(
            ink,
            rect.x + crop.x,
            rect.y + crop.y,
            crop.width,
            crop.height,
            68,
            middle - h / 2,
            w,
            h,
        );
    }
    return output.toDataURL();
}
