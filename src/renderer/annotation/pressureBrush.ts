import {
    type Canvas,
    FabricObject,
    Path,
    PencilBrush,
    Point,
    Shadow,
    type TEvent,
    type TSimplePathData,
    util,
} from "fabric";
import {
    createPressurePath,
    isPressurePath,
    type PressureInk,
    type PressurePoint,
    pressurePathData,
} from "./pressureInk";
import { readScribble, scribbleTargets } from "./scribbleErase";

type PenPath = Path & { acPenPoints?: PressurePoint[] };
FabricObject.customProperties = [
    ...FabricObject.customProperties,
    "acPenPoints",
];

type Options = { pressureEnabled: boolean; pressureSensitivity: number };

export class PressureBrush extends PencilBrush {
    private ink?: PressureInk;
    private pointerId?: number;
    private frame?: number;
    private drawing = false;
    private inkColor = "";
    private inkShadow: Shadow | null = null;
    private releaseDuration?: number;
    private strokeStartedAt = 0;
    private readonly releasedPaths = new WeakMap<Path, number>();

    constructor(
        canvas: Canvas,
        private options: () => Options,
    ) {
        super(canvas);
    }

    onMouseDown(pointer: Point, event: TEvent) {
        if (!this.canvas._isMainEvent(event.e)) return;
        this.cancel();
        this.drawing = true;
        const e = event.e;
        this.strokeStartedAt = e.timeStamp;
        const options = this.options();
        if (
            !("pointerType" in e) ||
            e.pointerType !== "pen" ||
            !options.pressureEnabled
        ) {
            super.onMouseDown(pointer, event);
            return;
        }
        this.pointerId = e.pointerId;
        this.ink = {
            version: 1,
            points: [],
            width: this.width,
            sensitivity: options.pressureSensitivity,
        };
        this.inkColor = this.color;
        this.inkShadow = this.shadow ? new Shadow(this.shadow) : null;
        this._setShadow();
        this.addPoint(pointer, e.pressure);
        this._render();
    }

    onMouseMove(pointer: Point, event: TEvent) {
        if (!this.drawing) return;
        if (!this.ink) {
            super.onMouseMove(pointer, event);
            return;
        }
        const e = event.e as PointerEvent;
        if (e.pointerId !== this.pointerId || !this.canvas._isMainEvent(e))
            return;
        if (this.limitedToCanvasSize && this._isOutSideCanvas(pointer)) return;
        const coalesced = e.getCoalescedEvents?.() ?? [];
        const events = coalesced.length ? coalesced : [e];
        const bounds = this.canvas.upperCanvasEl.getBoundingClientRect();
        const inverse = util.invertTransform(this.canvas.viewportTransform);
        for (const sample of events) {
            // Fabric caches the dispatched event's scene point; coalesced samples
            // must be offset from it instead of going through that cache again.
            const delta = new Point(
                ((sample.clientX - e.clientX) * this.canvas.getWidth()) /
                    (bounds.width || 1),
                ((sample.clientY - e.clientY) * this.canvas.getHeight()) /
                    (bounds.height || 1),
            ).transform(inverse, true);
            if (e.shiftKey && this.ink.points.length > 1) this.ink.points.pop();
            this.addPoint(pointer.add(delta), sample.pressure);
        }
        if (this.frame === undefined) {
            this.frame = requestAnimationFrame(() => {
                this.frame = undefined;
                this._render();
            });
        }
    }

    onMouseUp(event: TEvent) {
        if (!this.drawing) return false;
        this.releaseDuration =
            event.e.isTrusted && !event.e.shiftKey
                ? event.e.timeStamp - this.strokeStartedAt
                : undefined;
        if (!this.ink) {
            const result = super.onMouseUp(event);
            if (!result) this.drawing = false;
            return result;
        }
        const e = event.e as PointerEvent;
        if (e.pointerId !== this.pointerId || !this.canvas._isMainEvent(e))
            return true;
        const last = this.ink.points.at(-1);
        // pointerup reports zero pressure even when the last contact was heavy.
        if (last) this.addPoint(this.canvas.getScenePoint(e), last[2]);
        const path = createPressurePath(this.ink, this.inkColor);
        if (this.releaseDuration !== undefined)
            this.releasedPaths.set(path, this.releaseDuration);
        if (this.inkShadow) {
            path.shadow = this.inkShadow;
            path.shadow.affectStroke = false;
        }
        this.cancel();
        this.canvas.fire("before:path:created", { path });
        this.canvas.add(path);
        path.setCoords();
        this.canvas.requestRenderAll();
        this.canvas.fire("path:created", { path });
        return false;
    }

    createPath(data: TSimplePathData): Path {
        const path: PenPath = super.createPath(data);
        path.acPenPoints = this._points.map(({ x, y }) => [x, y, 0.5]);
        if (this.releaseDuration !== undefined)
            this.releasedPaths.set(path, this.releaseDuration);
        return path;
    }

    eraseScribble(path: FabricObject): boolean {
        if (!(path instanceof Path)) return false;
        const duration = this.releasedPaths.get(path);
        if (duration === undefined) return false;
        const unitsPerPixel =
            this.canvas.getWidth() /
            (this.canvas.upperCanvasEl.getBoundingClientRect().width *
                this.canvas.getZoom());
        const scribble = readScribble(
            scenePoints(path) ?? [],
            unitsPerPixel,
            duration,
        );
        if (!scribble) return false;

        const candidates = this.canvas.getObjects().flatMap((object) => {
            if (
                object === path ||
                !(object instanceof Path) ||
                !object.visible ||
                object.clipPath
            )
                return [];
            const points = scenePoints(object);
            return points ? [{ id: object, points }] : [];
        });
        const targets = scribbleTargets(scribble, candidates, unitsPerPixel);
        if (!targets.size) return false;
        this.canvas.remove(path, ...targets);
        this.canvas.requestRenderAll();
        return true;
    }

    private addPoint(point: Point, pressure: number) {
        if (!this.ink || !Number.isFinite(point.x) || !Number.isFinite(point.y))
            return;
        const sample: PressurePoint = [
            point.x,
            point.y,
            Number.isFinite(pressure)
                ? Math.max(0, Math.min(1, pressure))
                : 0.5,
        ];
        const last = this.ink.points.at(-1);
        if (
            last &&
            Math.hypot(last[0] - sample[0], last[1] - sample[1]) < 0.05
        ) {
            this.ink.points[this.ink.points.length - 1] = sample;
        } else {
            this.ink.points.push(sample);
        }
    }

    _render() {
        if (!this.ink) {
            if (this.drawing) super._render();
            return;
        }
        const ctx = this.canvas.contextTop;
        this.canvas.clearContext(ctx);
        this._saveAndTransform(ctx);
        ctx.fillStyle = this.inkColor;
        const data = util.joinPath(pressurePathData(this.ink));
        ctx.fill(new Path2D(data));
        ctx.restore();
    }

    cancel() {
        if (this.frame !== undefined) cancelAnimationFrame(this.frame);
        this.frame = undefined;
        this.drawing = false;
        this.releaseDuration = undefined;
        this.ink = undefined;
        this.pointerId = undefined;
        this._points = [];
        this.oldEnd = undefined;
        this._resetShadow();
        this.canvas.clearContext(this.canvas.contextTop);
    }
}

function scenePoints(path: PenPath): PressurePoint[] | undefined {
    const source = isPressurePath(path)
        ? path.acPressure.points
        : path.acPenPoints;
    const matrix = path.calcTransformMatrix();
    return source?.map(([x, y, pressure]) => {
        const point = new Point(
            x - path.pathOffset.x,
            y - path.pathOffset.y,
        ).transform(matrix);
        return [point.x, point.y, pressure];
    });
}
