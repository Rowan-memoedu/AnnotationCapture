import { type Position, polylineMatchesLasso } from "./lassoGeometry";
import { type PressurePoint, pressurePathData } from "./pressureGeometry";
import { readScribble, scribbleTargets } from "./scribbleErase";
import {
    arrowPoints,
    bindToolHover,
    diamondPoints,
    shapeTitles,
} from "./shapeTools";
import "./whiteboardEditor.css";

type Stroke = {
    kind: "pen" | keyof typeof shapeTitles;
    color: string;
    width: number;
    points: PressurePoint[];
    pressure?: true;
};
type Label = {
    kind: "text";
    color: string;
    x: number;
    y: number;
    text: string;
    fontSize?: number;
};
type Resize = { anchor: Position; handle: Position; factor: number };
type Item = Stroke | Label;
type Tool = Stroke["kind"] | "lasso" | "erase";

const board = document.querySelector<HTMLCanvasElement>("#board")!;
const tools = document.querySelector<HTMLElement>("#tools")!;
const context = board.getContext("2d")!;
const controls = new Map<Tool, HTMLButtonElement>();
const undo: Item[][] = [];
const redo: Item[][] = [];
let items: Item[] = [];
let selected = new Set<number>();
let selectionId = 0;
let selectionPort: MessagePort | undefined;
let selectionAnchor: Position | undefined;
let tool: Tool = "pen";
let locked = false;
let scribbleEnabled = true;
let pointer: number | undefined;
let strokeStartedAt = 0;
let stroke: Stroke | undefined;
let vertices: PressurePoint[] = [];
let polygon: Position[] = [];
let start: Position | undefined;
let movement: Position | undefined;
let resizing: Resize | undefined;
let frame = 0;
const english = new URL(location.href).searchParams.get("lang") === "en";

function button(
    zh: string,
    en: string,
    action: () => void,
    parent: HTMLElement = tools,
) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = english ? en : zh;
    element.addEventListener("click", () => {
        if (!locked) action();
    });
    parent.append(element);
    return element;
}

const shapeGroup = document.createElement("div");
shapeGroup.className = "whiteboardShapeGroup";
const shapeOptions = document.createElement("div");
shapeOptions.className = "whiteboardShapeOptions";
function showShapes(show: boolean) {
    if (show && locked) return;
    shapeOptions.hidden = !show;
    shapeTrigger.setAttribute("aria-expanded", String(show));
}
controls.set(
    "pen",
    button("画笔", "Pen", () => choose("pen")),
);
const shapeTrigger = button(
    "形状",
    "Shapes",
    () => showShapes(true),
    shapeGroup,
);
showShapes(false);
shapeGroup.append(shapeOptions);
tools.append(shapeGroup);
bindToolHover(
    shapeGroup,
    () => showShapes(true),
    () => {
        if (!shapeOptions.contains(document.activeElement)) showShapes(false);
    },
);
shapeGroup.addEventListener("focusout", (event) => {
    if (!shapeGroup.contains(event.relatedTarget as Node | null))
        showShapes(false);
});
shapeGroup.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        showShapes(false);
        shapeTrigger.focus();
    }
});
for (const [name, [zh, en]] of Object.entries(shapeTitles)) {
    const mode = name as Tool;
    controls.set(
        mode,
        button(
            zh,
            en,
            () => {
                choose(mode);
                showShapes(false);
                board.focus({ preventScroll: true });
            },
            shapeOptions,
        ),
    );
}
controls.set(
    "lasso",
    button("套索", "Lasso", () => choose("lasso")),
);
controls.set(
    "erase",
    button("橡皮", "Eraser", () => choose("erase")),
);
const undoButton = button("撤销", "Undo", () => history(undo, redo));
const redoButton = button("重做", "Redo", () => history(redo, undo));
const scribbleButton = button("涂抹删除", "Scribble to erase", () => {
    scribbleEnabled = !scribbleEnabled;
    scribbleButton.setAttribute("aria-pressed", String(scribbleEnabled));
});
scribbleButton.setAttribute("aria-pressed", String(scribbleEnabled));
const deleteButton = button("删除所选", "Delete selection", () =>
    remove(selected),
);
button("清屏", "Clear", () => {
    if (items.length) update([]);
});
const color = document.createElement("input");
color.type = "color";
color.value = "#c32631";
color.setAttribute("aria-label", english ? "Ink color" : "笔色");
const width = document.createElement("input");
width.type = "range";
width.min = "1";
width.max = "16";
width.value = "3";
width.setAttribute("aria-label", english ? "Stroke width" : "笔宽");
tools.append(color, width);
if (window.parent === window) {
    const text = document.createElement("input");
    text.type = "text";
    text.maxLength = 1000;
    text.setAttribute("aria-label", english ? "Text" : "文字");
    tools.append(text);
    button("添加文字", "Add text", () => {
        if (text.value.trim()) {
            insert(text.value);
            text.value = "";
        }
    });
}

function choose(mode: Tool) {
    tool = mode;
    vertices = [];
    select();
    for (const [name, control] of controls)
        control.setAttribute("aria-pressed", String(name === mode));
    shapeTrigger.setAttribute(
        "aria-pressed",
        String(Object.hasOwn(shapeTitles, mode)),
    );
    render();
}

function select(next = new Set<number>()) {
    if (!selected.size && !next.size) return;
    selected = next;
    selectionAnchor = undefined;
    selectionPort?.postMessage({
        selection: { id: ++selectionId, count: next.size },
    });
}

function update(next: Item[]) {
    undo.push(items);
    if (undo.length > 80) undo.shift();
    redo.length = 0;
    items = next;
    select();
    render();
}

function history(from: Item[][], to: Item[][]) {
    const next = from.pop();
    if (next) {
        to.push(items);
        items = next;
        select();
        render();
    }
}

function remove(indices: Set<number>) {
    if (indices.size) update(items.filter((_, index) => !indices.has(index)));
}

function itemPath(item: Stroke) {
    const path = new Path2D();
    const [first] = item.points;
    if (item.pressure) {
        const segments = pressurePathData({
            version: 1,
            points: item.points,
            width: item.width,
            sensitivity: 50,
        });
        return new Path2D(segments.map((part) => part.join(" ")).join(" "));
    }
    const points = samples(item);
    path.moveTo(points[0].x, points[0].y);
    if (points.length === 1) path.lineTo(first[0] + 0.01, first[1]);
    for (const point of points.slice(1)) path.lineTo(point.x, point.y);
    return path;
}

function draw(item: Item, highlighted = false, surface = context) {
    surface.fillStyle = surface.strokeStyle = highlighted
        ? "#2e67cf"
        : item.color;
    if (item.kind === "text") {
        surface.font = `${item.fontSize ?? 25}px Cambria Math, serif`;
        surface.fillText(
            item.text,
            item.x,
            item.y,
            board.width - Math.max(item.x, 20),
        );
    } else {
        surface.lineWidth = item.width;
        surface.lineCap = surface.lineJoin = "round";
        const path = itemPath(item);
        if (item.pressure) surface.fill(path);
        else surface.stroke(path);
    }
}

function paint(guides = true) {
    context.fillStyle = "white";
    context.fillRect(0, 0, board.width, board.height);
    items.forEach((item, index) => {
        const active = guides && selected.has(index);
        context.save();
        if (active && movement) context.translate(movement.x, movement.y);
        draw(active && resizing ? scaled(item, resizing) : item, active);
        context.restore();
    });
    if (!guides) return;
    if (selected.size && !polygon.length) paintSelection();
    if (vertices.length && (tool === "polyline" || tool === "polygon"))
        draw({
            kind: tool,
            color: color.value,
            width: Number(width.value),
            points: vertices,
        });
    if (stroke) draw(stroke);
    if (!polygon.length) return;
    context.beginPath();
    for (const point of polygon) context.lineTo(point.x, point.y);
    context.closePath();
    context.setLineDash([8, 6]);
    context.lineWidth = 2;
    context.strokeStyle = "#2e67cf";
    context.stroke();
    context.setLineDash([]);
}

function render() {
    undoButton.disabled = locked || !undo.length;
    redoButton.disabled = locked || !redo.length;
    deleteButton.disabled = locked || !selected.size;
    if (!frame)
        frame = requestAnimationFrame(() => {
            frame = 0;
            paint();
        });
}

function point(event: PointerEvent): PressurePoint {
    const bounds = board.getBoundingClientRect();
    return [
        ((event.clientX - bounds.left) * board.width) / bounds.width,
        ((event.clientY - bounds.top) * board.height) / bounds.height,
        event.pressure,
    ];
}

function samples(item: Item): Position[] {
    if (item.kind === "text")
        return [
            { x: item.x, y: item.y - (item.fontSize ?? 25) },
            {
                x:
                    item.x +
                    Math.min(
                        item.text.length * (item.fontSize ?? 25) * 0.54,
                        board.width - item.x,
                    ),
                y: item.y + (item.fontSize ?? 25) / 5,
            },
        ];
    const [x, y] = item.points[0];
    const [right, bottom] = item.points.at(-1) ?? item.points[0];
    if (item.kind === "rect") {
        return [
            { x, y },
            { x: right, y },
            { x: right, y: bottom },
            { x, y: bottom },
            { x, y },
        ];
    }
    if (item.kind === "ellipse" || item.kind === "circle") {
        const size = Math.max(Math.abs(right - x), Math.abs(bottom - y));
        const rx = (item.kind === "circle" ? size : Math.abs(right - x)) / 2;
        const ry = (item.kind === "circle" ? size : Math.abs(bottom - y)) / 2;
        const cx = Math.min(x, right) + rx,
            cy = Math.min(y, bottom) + ry;
        return Array.from({ length: 65 }, (_, index) => {
            const angle = (index * Math.PI) / 32;
            return {
                x: cx + rx * Math.cos(angle),
                y: cy + ry * Math.sin(angle),
            };
        });
    }
    if (item.kind === "diamond") {
        const points = diamondPoints(
            Math.min(x, right),
            Math.min(y, bottom),
            Math.abs(x - right),
            Math.abs(y - bottom),
        );
        return [...points, points[0]];
    }
    if (item.kind === "arrow") {
        const start = { x, y },
            end = { x: right, y: bottom };
        return [
            start,
            end,
            ...arrowPoints(start, end, item.width * 6, item.width * 5),
        ];
    }
    const points = item.points.map(([px, py]) => ({ x: px, y: py }));
    return item.kind === "polygon" && points.length > 2
        ? [...points, points[0]]
        : points;
}

function matching(boundary: Position[]) {
    const xs = boundary.map(({ x }) => x),
        ys = boundary.map(({ y }) => y);
    const left = Math.min(...xs),
        right = Math.max(...xs);
    const top = Math.min(...ys),
        bottom = Math.max(...ys);
    const result = new Set<number>();
    items.forEach((item, index) => {
        const points = samples(item);
        if (
            points.every((p) => p.x < left) ||
            points.every((p) => p.x > right) ||
            points.every((p) => p.y < top) ||
            points.every((p) => p.y > bottom)
        )
            return;
        if (polylineMatchesLasso(points, boundary, "intersect"))
            result.add(index);
    });
    return result;
}

function moved(item: Item, { x, y }: Position): Item {
    if (item.kind === "text") return { ...item, x: item.x + x, y: item.y + y };
    return {
        ...item,
        points: item.points.map(([px, py, pressure]) => [
            px + x,
            py + y,
            pressure,
        ]),
    };
}

function scaled(item: Item, { anchor, factor }: Resize): Item {
    const x = (value: number) => anchor.x + (value - anchor.x) * factor;
    const y = (value: number) => anchor.y + (value - anchor.y) * factor;
    if (item.kind === "text") {
        return {
            ...item,
            x: x(item.x),
            y: y(item.y),
            fontSize: Math.max(
                5,
                Math.min(160, (item.fontSize ?? 25) * factor),
            ),
        };
    }
    return {
        ...item,
        width: Math.max(1, Math.min(16, item.width * factor)),
        points: item.points.map(([px, py, pressure]) => [
            x(px),
            y(py),
            pressure,
        ]),
    };
}

function selectionCorners() {
    const pad = (8 * board.width) / board.getBoundingClientRect().width;
    let x1 = Infinity,
        y1 = Infinity,
        x2 = -Infinity,
        y2 = -Infinity;
    for (const index of selected) {
        const item = items[index];
        for (const point of samples(resizing ? scaled(item, resizing) : item)) {
            const x = point.x + (movement?.x ?? 0),
                y = point.y + (movement?.y ?? 0);
            x1 = Math.min(x1, x);
            y1 = Math.min(y1, y);
            x2 = Math.max(x2, x);
            y2 = Math.max(y2, y);
        }
    }
    const top = Math.max(2, y1 - pad),
        bottom = Math.min(board.height - 2, y2 + pad);
    const left = Math.max(2, x1 - pad),
        right = Math.min(board.width - 2, x2 + pad);
    return [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
    ];
}

function paintSelection() {
    const corners = selectionCorners();
    const unit = board.width / board.getBoundingClientRect().width;
    context.strokeStyle = "#2e67cf";
    context.lineWidth = unit;
    context.strokeRect(
        corners[0].x,
        corners[0].y,
        corners[2].x - corners[0].x,
        corners[2].y - corners[0].y,
    );
    for (const { x, y } of corners) {
        const radius = 4 * unit;
        context.fillStyle = "white";
        context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
        context.strokeRect(x - radius, y - radius, radius * 2, radius * 2);
    }
}

board.addEventListener("pointerdown", (event) => {
    if (locked || pointer !== undefined || event.button !== 0) return;
    board.focus({ preventScroll: true });
    if (tool === "polyline" || tool === "polygon") {
        if (vertices.length < 128 && event.detail <= 1)
            vertices.push(point(event));
        render();
        return;
    }
    pointer = event.pointerId;
    strokeStartedAt = event.timeStamp;
    board.setPointerCapture(pointer);
    const p = point(event);
    start = { x: p[0], y: p[1] };
    if (tool === "lasso" && selected.size) {
        const { x, y } = start;
        const corners = selectionCorners();
        const tolerance =
            (12 * board.width) / board.getBoundingClientRect().width;
        const corner = corners.findIndex(
            (p) => Math.hypot(p.x - x, p.y - y) <= tolerance,
        );
        if (corner !== -1) {
            resizing = {
                anchor: corners[(corner + 2) % 4],
                handle: corners[corner],
                factor: 1,
            };
            return;
        }
        const touched = matching([
            { x: x - 20, y: y - 20 },
            { x: x + 20, y: y - 20 },
            { x: x + 20, y: y + 20 },
            { x: x - 20, y: y + 20 },
        ]);
        if ([...selected].some((index) => touched.has(index))) {
            movement = { x: 0, y: 0 };
            return;
        }
    }
    if (tool === "lasso" || tool === "erase") polygon = [start];
    else
        stroke = {
            kind: tool,
            width: Number(width.value),
            color: color.value,
            points: [p],
            ...(tool === "pen" &&
                event.pointerType === "pen" && { pressure: true as const }),
        };
    render();
});
board.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointer || !start) return;
    const p = point(event);
    if (resizing) {
        const { anchor, handle } = resizing;
        const dx = handle.x - anchor.x,
            dy = handle.y - anchor.y;
        const change =
            ((p[0] - start.x) * dx + (p[1] - start.y) * dy) /
            Math.max(1, dx * dx + dy * dy);
        resizing.factor = Math.min(5, Math.max(0.2, 1 + change));
    } else if (movement) movement = { x: p[0] - start.x, y: p[1] - start.y };
    else if (stroke?.kind === "pen" && stroke.points.length < 6000) {
        const events = event.getCoalescedEvents?.();
        stroke.points.push(
            ...(events?.length ? events : [event])
                .slice(0, 6000 - stroke.points.length)
                .map(point),
        );
    } else if (stroke && stroke.kind !== "pen") stroke.points[1] = p;
    else if (polygon.length < 512 && polygon.length) {
        const last = polygon.at(-1)!;
        if (Math.hypot(last.x - p[0], last.y - p[1]) >= 3)
            polygon.push({ x: p[0], y: p[1] });
    }
    render();
});
function end(commit: boolean, duration?: number) {
    pointer = undefined;
    if (commit && stroke) {
        const unitsPerPixel = board.width / board.getBoundingClientRect().width;
        const scribble =
            duration !== undefined && scribbleEnabled && stroke.kind === "pen"
                ? readScribble(stroke.points, unitsPerPixel, duration)
                : null;
        const targets =
            scribble &&
            scribbleTargets(
                scribble,
                items.flatMap((item, id) =>
                    item.kind === "pen" ? [{ id, points: item.points }] : [],
                ),
                unitsPerPixel,
            );
        if (targets?.size) remove(targets);
        else if (items.length < 1000) update([...items, stroke]);
    } else if (commit && resizing && Math.abs(resizing.factor - 1) > 0.01) {
        const transform = resizing;
        const sameSelection = new Set(selected);
        update(
            items.map((item, index) =>
                selected.has(index) ? scaled(item, transform) : item,
            ),
        );
        select(sameSelection);
    } else if (commit && movement && (movement.x || movement.y)) {
        const delta = movement;
        update(
            items.map((item, index) =>
                selected.has(index) ? moved(item, delta) : item,
            ),
        );
    } else if (commit && start && tool === "erase") {
        const hits = new Set<number>();
        for (const { x, y } of polygon) {
            for (const index of matching([
                { x: x - 12, y: y - 12 },
                { x: x + 12, y: y - 12 },
                { x: x + 12, y: y + 12 },
                { x: x - 12, y: y + 12 },
            ]))
                hits.add(index);
        }
        remove(hits);
    } else if (commit && polygon.length > 2) select(matching(polygon));
    movement = stroke = start = undefined;
    resizing = undefined;
    polygon = [];
    render();
}
board.addEventListener("pointerup", (event) => {
    if (event.pointerId === pointer)
        end(
            true,
            event.shiftKey ? undefined : event.timeStamp - strokeStartedAt,
        );
});
board.addEventListener("lostpointercapture", () => {
    if (pointer !== undefined) end(false);
});
function finishVertices() {
    if (locked || (tool !== "polyline" && tool !== "polygon")) return;
    if (vertices.length >= (tool === "polygon" ? 3 : 2) && items.length < 1000)
        update([
            ...items,
            {
                kind: tool,
                width: Number(width.value),
                color: color.value,
                points: vertices,
            },
        ]);
    vertices = [];
    render();
}
board.addEventListener("dblclick", finishVertices);
board.addEventListener("keydown", (event) => {
    if (locked) return;
    if (event.key === "Delete") remove(selected);
    else if (event.key === "Enter" && vertices.length) finishVertices();
    else if (event.key === "Escape" && (selected.size || vertices.length)) {
        vertices = [];
        select();
        render();
    } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "a"
    ) {
        choose("lasso");
        select(new Set(items.keys()));
        render();
    } else if (event.key.toLowerCase() === "d")
        choose(tool === "lasso" ? "pen" : "lasso");
    else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "z"
    ) {
        if (event.shiftKey) history(redo, undo);
        else history(undo, redo);
    } else return;
    event.preventDefault();
});

function insert(value: string) {
    const lines = value.trim().split(/\r?\n/).filter(Boolean).slice(0, 30);
    let bottom = 10;
    for (const item of items) {
        if (item.kind === "text") bottom = Math.max(bottom, item.y);
        else for (const [, y] of item.points) bottom = Math.max(bottom, y);
    }
    const y = Math.min(bottom + 34, board.height - 28 * lines.length);
    const added = lines.map(
        (text, index): Label => ({
            kind: "text",
            text: text.slice(0, 1000),
            x: 24,
            y: y + index * 28,
            color: color.value,
        }),
    );
    if (items.length + added.length <= 1000 && added.length)
        update([...items, ...added]);
}

function restore(scene: { version: number; items: Item[] }) {
    if (
        scene?.version !== 1 ||
        !Array.isArray(scene.items) ||
        scene.items.length > 1000
    )
        throw Error("Invalid whiteboard scene");
    for (const item of scene.items) {
        if (!item || !/^#[\da-f]{6}$/i.test(item.color))
            throw Error("Invalid ink");
        if (item.kind === "text") {
            if (
                !Number.isFinite(item.x) ||
                !Number.isFinite(item.y) ||
                typeof item.text !== "string" ||
                item.text.length > 1000 ||
                (item.fontSize !== undefined &&
                    (!Number.isFinite(item.fontSize) ||
                        item.fontSize < 5 ||
                        item.fontSize > 160))
            )
                throw Error("Invalid text");
        } else if (
            (item.kind !== "pen" && !Object.hasOwn(shapeTitles, item.kind)) ||
            !Number.isFinite(item.width) ||
            item.width < 1 ||
            item.width > 16 ||
            !Array.isArray(item.points) ||
            !item.points.length ||
            item.points.length > 6500 ||
            item.points.some(
                (p) =>
                    !Array.isArray(p) ||
                    p.length !== 3 ||
                    !p.every(Number.isFinite),
            )
        )
            throw Error("Invalid stroke");
    }
    items = scene.items;
    select();
    undo.length = 0;
    redo.length = 0;
    render();
}

function setLocked(value: boolean) {
    if (value && pointer !== undefined) end(true);
    if (value && vertices.length) finishVertices();
    locked = value;
    if (value) showShapes(false);
    for (const control of tools.querySelectorAll("button, input"))
        (control as HTMLButtonElement).disabled = value;
    render();
}

function encodePng(canvas: HTMLCanvasElement) {
    const png = canvas.toDataURL("image/png").split(",")[1];
    if (!png) throw Error("Image unavailable");
    return new Blob([Uint8Array.from(atob(png), (byte) => byte.charCodeAt(0))], {
        type: "image/png",
    });
}

function scene() {
    return { version: 1, items };
}

function snapshot() {
    paint(false);
    const png = encodePng(board);
    render();
    return { scene: scene(), png, empty: items.length === 0 };
}

function snapshotSelection() {
    if (!selected.size || pointer !== undefined) return null;
    const id = selectionId;
    const layer = document.createElement("canvas");
    layer.width = board.width;
    layer.height = board.height;
    const surface = layer.getContext("2d", { willReadFrequently: true })!;
    for (const index of selected) draw(items[index], false, surface);
    const { data } = surface.getImageData(0, 0, layer.width, layer.height);
    let left = layer.width,
        top = layer.height,
        right = -1,
        bottom = -1;
    for (let y = 0; y < layer.height; y++) {
        for (let x = 0; x < layer.width; x++) {
            if (data[(y * layer.width + x) * 4 + 3] === 0) continue;
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
        }
    }
    if (right < left) return null;
    const cropped = document.createElement("canvas");
    const padding = 20;
    const w = right - left + 1,
        h = bottom - top + 1;
    cropped.width = Math.max(80, w + 2 * padding);
    cropped.height = Math.max(62, h + 2 * padding);
    const output = cropped.getContext("2d")!;
    output.fillStyle = "white";
    output.fillRect(0, 0, cropped.width, cropped.height);
    output.drawImage(layer, left, top, w, h, padding, padding, w, h);
    selectionAnchor = {
        x: left,
        y: Math.min(layer.height - 2, Math.max(24, bottom)),
    };
    const [index] = selected;
    const item = selected.size === 1 ? items[index] : undefined;
    const text = item?.kind === "text" ? item.text.trim() : undefined;
    const expression =
        text &&
        text.length <= 64 &&
        /^[\p{Script=Greek}a-z0-9_+*/^%.,()[\]=!<>×÷−≤≥≠√ \t-]+$/iu.test(
            text,
        ) &&
        !/[\p{L}\d][ \t]+[\p{L}\d]/u.test(text) &&
        (/^[\p{Script=Greek}a-z](?:_\d+)?$/iu.test(text) ||
            /[0-9_+*/^%=<>×÷−≤≥≠√()-]/u.test(text))
            ? text
            : undefined;
    return {
        id,
        png: encodePng(cropped),
        ...(expression ? { expression } : {}),
    };
}

function replaceSelection(value: { id: number; text: string }) {
    if (
        locked ||
        pointer !== undefined ||
        !selected.size ||
        !selectionAnchor ||
        value?.id !== selectionId ||
        typeof value.text !== "string" ||
        !value.text.trim() ||
        value.text.length > 64 ||
        /[\r\n]/.test(value.text)
    )
        return false;
    const first = Math.min(...selected);
    const label: Label = {
        kind: "text",
        ...selectionAnchor,
        text: value.text,
        color: items[first].color,
    };
    update(
        items.flatMap((item, index) =>
            index === first ? [label] : selected.has(index) ? [] : [item],
        ),
    );
    return true;
}

choose("pen");
function connect(event: MessageEvent) {
    if (
        window.parent === window ||
        event.source !== window.parent ||
        event.data?.type !== "annotation-whiteboard:v1" ||
        !event.ports[0]
    )
        return;
    window.removeEventListener("message", connect);
    const port = event.ports[0];
    selectionPort = port;
    port.onmessage = ({ data }) => {
        const { id, command, value } = data;
        try {
            let result: unknown;
            if (command === "lock") setLocked(value === true);
            else if (command === "scene") result = scene();
            else if (command === "snapshot") result = snapshot();
            else if (command === "snapshotSelection" && !locked)
                result = snapshotSelection();
            else if (command === "replaceSelection")
                result = replaceSelection(value);
            else if (command === "restore") restore(value);
            else if (
                command === "insert" &&
                !locked &&
                typeof value === "string" &&
                value.length <= 4000
            )
                insert(value);
            else throw Error("Invalid whiteboard command");
            port.postMessage({ id, result });
        } catch {
            port.postMessage({ id, failed: true });
        }
    };
    port.postMessage({
        ready: 1,
        selection: { id: selectionId, count: selected.size },
    });
}
window.addEventListener("message", connect);
