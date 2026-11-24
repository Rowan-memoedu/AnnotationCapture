import { type Position, polylineMatchesLasso } from "./lassoGeometry";
import { type PressurePoint, pressurePathData } from "./pressureInk";
import { readScribble, scribbleTargets } from "./scribbleErase";
import "./whiteboardEditor.css";

type Stroke = {
    kind: "pen" | "line" | "rect" | "ellipse";
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
};
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
let tool: Tool = "pen";
let locked = false;
let scribbleEnabled = true;
let pointer: number | undefined;
let strokeStartedAt = 0;
let stroke: Stroke | undefined;
let polygon: Position[] = [];
let start: Position | undefined;
let movement: Position | undefined;
let frame = 0;
const doubles = {
    pen: "Pen",
    line: "Line",
    rect: "Rectangle",
    ellipse: "Ellipse",
    lasso: "Lasso",
    erase: "Eraser",
};
const english = new URL(location.href).searchParams.get("lang") === "en";

function button(zh: string, en: string, action: () => void) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = english ? en : zh;
    element.addEventListener("click", () => {
        if (!locked) action();
    });
    tools.append(element);
    return element;
}

for (const [name, label] of Object.entries({
    pen: "画笔",
    line: "直线",
    rect: "矩形",
    ellipse: "椭圆",
    lasso: "套索",
    erase: "橡皮",
})) {
    const mode = name as Tool;
    controls.set(
        mode,
        button(label, doubles[mode], () => choose(mode)),
    );
}
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
    selected.clear();
    for (const [name, control] of controls)
        control.setAttribute("aria-pressed", String(name === mode));
    render();
}

function update(next: Item[]) {
    undo.push(items);
    if (undo.length > 80) undo.shift();
    redo.length = 0;
    items = next;
    selected.clear();
    render();
}

function history(from: Item[][], to: Item[][]) {
    const next = from.pop();
    if (next) {
        to.push(items);
        items = next;
        selected.clear();
        render();
    }
}

function remove(indices: Set<number>) {
    if (indices.size) update(items.filter((_, index) => !indices.has(index)));
}

function itemPath(item: Stroke) {
    const path = new Path2D();
    const [first] = item.points;
    const last = item.points.at(-1) ?? first;
    if (item.pressure) {
        const segments = pressurePathData({
            version: 1,
            points: item.points,
            width: item.width,
            sensitivity: 50,
        });
        return new Path2D(segments.map((part) => part.join(" ")).join(" "));
    }
    const [x, y] = first;
    const [endX, endY] = last;
    if (item.kind === "rect") path.rect(x, y, endX - x, endY - y);
    else if (item.kind === "ellipse") {
        path.ellipse(
            (x + endX) / 2,
            (y + endY) / 2,
            Math.abs(endX - x) / 2,
            Math.abs(endY - y) / 2,
            0,
            0,
            Math.PI * 2,
        );
    } else {
        path.moveTo(x, y);
        if (item.points.length === 1) path.lineTo(x + 0.01, y);
        for (const [px, py] of item.points) path.lineTo(px, py);
    }
    return path;
}

function draw(item: Item, highlighted = false) {
    context.fillStyle = context.strokeStyle = highlighted
        ? "#2e67cf"
        : item.color;
    if (item.kind === "text") {
        context.font = "25px Cambria Math, serif";
        context.fillText(
            item.text,
            item.x,
            item.y,
            board.width - Math.max(item.x, 20),
        );
    } else {
        context.lineWidth = item.width;
        context.lineCap = context.lineJoin = "round";
        const path = itemPath(item);
        if (item.pressure) context.fill(path);
        else context.stroke(path);
    }
}

function paint(guides = true) {
    context.fillStyle = "white";
    context.fillRect(0, 0, board.width, board.height);
    items.forEach((item, index) => {
        const active = guides && selected.has(index);
        context.save();
        if (active && movement) context.translate(movement.x, movement.y);
        draw(item, active);
        context.restore();
    });
    if (!guides) return;
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
            { x: item.x, y: item.y - 12 },
            {
                x:
                    item.x +
                    Math.min(item.text.length * 13, board.width - item.x),
                y: item.y - 12,
            },
        ];
    const [x, y] = item.points[0];
    const [right, bottom] = item.points.at(-1) ?? item.points[0];
    if (item.kind === "rect" || item.kind === "ellipse") {
        return [
            { x, y },
            { x: right, y },
            { x: right, y: bottom },
            { x, y: bottom },
            { x, y },
        ];
    }
    return item.points.map(([px, py]) => ({ x: px, y: py }));
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

board.addEventListener("pointerdown", (event) => {
    if (locked || pointer !== undefined || event.button !== 0) return;
    board.focus({ preventScroll: true });
    pointer = event.pointerId;
    strokeStartedAt = event.timeStamp;
    board.setPointerCapture(pointer);
    const p = point(event);
    start = { x: p[0], y: p[1] };
    if (tool === "lasso" && selected.size) {
        const { x, y } = start;
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
    if (movement) movement = { x: p[0] - start.x, y: p[1] - start.y };
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
    } else if (commit && polygon.length > 2) selected = matching(polygon);
    movement = stroke = start = undefined;
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
board.addEventListener("keydown", (event) => {
    if (locked) return;
    if (event.key === "Delete") remove(selected);
    else if (event.key.toLowerCase() === "d")
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
                item.text.length > 1000
            )
                throw Error("Invalid text");
        } else if (
            !["pen", "rect", "ellipse", "line"].includes(item.kind) ||
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
    selected.clear();
    undo.length = 0;
    redo.length = 0;
    render();
}

function setLocked(value: boolean) {
    if (value && pointer !== undefined) end(true);
    locked = value;
    for (const control of tools.querySelectorAll("button, input"))
        (control as HTMLButtonElement).disabled = value;
    render();
}

async function snapshot() {
    paint(false);
    const png = await new Promise<Blob>((resolve, reject) => {
        board.toBlob((blob) =>
            blob ? resolve(blob) : reject(Error("Image unavailable")),
        );
        render();
    });
    return { scene: { version: 1, items }, png, empty: items.length === 0 };
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
    port.onmessage = async ({ data }) => {
        const { id, command, value } = data;
        try {
            let result: Awaited<ReturnType<typeof snapshot>> | undefined;
            if (command === "lock") setLocked(value === true);
            else if (command === "snapshot") result = await snapshot();
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
    port.postMessage({ ready: 1 });
}
window.addEventListener("message", connect);
