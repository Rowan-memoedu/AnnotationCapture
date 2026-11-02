import type { Canvas } from "fabric";
import type { PixelRect } from "../../../lib/annotation";
import type { Position } from "./lassoGeometry";

export function whiteboardLasso(
    canvas: Canvas,
    kind: "rect" | "free",
    bounds: PixelRect,
    accept: (points: Position[]) => void,
    cancel: () => void,
) {
    const ns = "http://www.w3.org/2000/svg";
    const layer = document.createElementNS(ns, "svg");
    const outline = document.createElementNS(ns, "polygon");
    layer.id = "ac-whiteboard-lasso";
    layer.setAttribute("viewBox", `0 0 ${canvas.width} ${canvas.height}`);
    layer.setAttribute("preserveAspectRatio", "none");
    layer.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:crosshair";
    outline.setAttribute("fill", "var(--ac-lasso-fill)");
    outline.setAttribute("stroke", "var(--ac-lasso-color)");
    outline.setAttribute("stroke-width", "2");
    outline.setAttribute("stroke-dasharray", "6 4");
    outline.setAttribute("vector-effect", "non-scaling-stroke");
    outline.setAttribute("fill-rule", "evenodd");
    layer.append(outline);
    canvas.upperCanvasEl.after(layer);
    let pointer: number | undefined;
    let points: Position[] = [];
    const point = (e: PointerEvent) => {
        const { x, y } = canvas.getScenePoint(e);
        return {
            x: Math.max(bounds.x, Math.min(bounds.x + bounds.width, x)),
            y: Math.max(bounds.y, Math.min(bounds.y + bounds.height, y)),
        };
    };
    function append(e: PointerEvent) {
        const next = point(e),
            start = points[0];
        if (kind === "rect")
            points = [
                start,
                { x: next.x, y: start.y },
                next,
                { x: start.x, y: next.y },
            ];
        else if (next.x !== points.at(-1)?.x || next.y !== points.at(-1)?.y)
            points.push(next);
    }
    let frame = 0;
    function draw() {
        frame = 0;
        outline.setAttribute(
            "points",
            points.map((p) => `${p.x},${p.y}`).join(" "),
        );
    }
    layer.onpointerdown = (e) => {
        if (pointer !== undefined || e.button !== 0) return;
        const at = canvas.getScenePoint(e);
        if (
            at.x < bounds.x ||
            at.x > bounds.x + bounds.width ||
            at.y < bounds.y ||
            at.y > bounds.y + bounds.height
        )
            return;
        e.preventDefault();
        e.stopPropagation();
        pointer = e.pointerId;
        points = [point(e)];
        layer.setPointerCapture(pointer);
        draw();
    };
    layer.onpointermove = (e) => {
        if (pointer !== e.pointerId) return;
        e.stopPropagation();
        const events = e.getCoalescedEvents();
        for (const sample of events.length ? events : [e]) append(sample);
        if (!frame) frame = requestAnimationFrame(draw);
    };
    layer.onpointerup = (e) => {
        if (pointer !== e.pointerId) return;
        e.stopPropagation();
        append(e);
        pointer = undefined;
        // Collinear taps/drags have no interior. Leave the lasso available for a retry.
        const start = points[0],
            second = points.find(
                (p) => Math.hypot(p.x - start.x, p.y - start.y) >= 3,
            );
        if (
            second &&
            points.some(
                (p) =>
                    Math.abs(
                        (second.x - start.x) * (p.y - start.y) -
                            (second.y - start.y) * (p.x - start.x),
                    ) >= 9,
            )
        )
            accept(points);
        else {
            points = [];
            draw();
        }
    };
    layer.onlostpointercapture = () => {
        if (pointer === undefined) return;
        pointer = undefined;
        points = [];
        draw();
    };
    layer.onpointercancel = cancel;
    window.addEventListener("blur", cancel);
    return () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("blur", cancel);
        layer.remove();
    };
}
