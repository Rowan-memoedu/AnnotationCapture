import { ActiveSelection, type Canvas, Path, Point, util } from "fabric";
import { t } from "../../../lib/translate/translate";

type Position = { x: number; y: number };

export function insideLasso(point: Position, polygon: Position[]) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i];
        const b = polygon[j];
        if (
            a.y > point.y !== b.y > point.y &&
            point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
        )
            inside = !inside;
    }
    return inside;
}

export function installInkSelection(
    canvas: Canvas,
    history: () => void,
    select: () => void,
    pencil: () => void,
) {
    let mode: "off" | "select" | "erase" = "off";
    let pressedAt: number | undefined;
    let pressedFromSelection = false;
    let used = false;
    let pointer: number | undefined;
    let polygon: Position[] = [];
    const upper = canvas.upperCanvasEl;
    const overlay = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
    );
    overlay.id = "ac-ink-lasso";
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText =
        "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;display:none";
    const outline = document.createElementNS(overlay.namespaceURI, "polygon");
    outline.setAttribute("stroke-width", "2");
    outline.setAttribute("stroke-dasharray", "6 4");
    overlay.append(outline);
    document.body.append(overlay);
    const hint = document.querySelector("#ac-selection-hint") as HTMLElement;

    function cancel() {
        mode = "off";
        pressedAt = undefined;
        polygon = [];
        overlay.style.display = "none";
        hint.textContent = "";
        upper.removeAttribute("data-ac-selection");
    }
    function enter(value: "select" | "erase") {
        select();
        mode = value;
        canvas.discardActiveObject();
        canvas.selection = false;
        canvas.defaultCursor = "crosshair";
        upper.dataset.acSelection = value;
        hint.textContent = t(
            value === "erase"
                ? "按住 D 圈选清除，松开恢复画笔"
                : "圈选后拖动，Delete 删除；再按 D 恢复画笔",
        );
    }
    function blocked(target: EventTarget | null) {
        const element = target instanceof Element ? target : null;
        return (
            !!element?.closest(
                "input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='dialog'],.ac-overlay",
            ) ||
            document.querySelector(".ac-overlay,[role='dialog'][open]") !==
                null ||
            !!(canvas.getActiveObject() as { isEditing?: boolean } | undefined)
                ?.isEditing
        );
    }
    document.addEventListener(
        "keydown",
        (event) => {
            if (
                event.code !== "KeyD" ||
                event.ctrlKey ||
                event.altKey ||
                event.metaKey ||
                event.shiftKey ||
                event.isComposing ||
                blocked(event.target)
            )
                return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.repeat || pressedAt !== undefined) return;
            pressedFromSelection = mode === "select";
            enter("erase");
            pressedAt = performance.now();
            used = false;
        },
        true,
    );
    document.addEventListener(
        "keyup",
        (event) => {
            if (event.code !== "KeyD" || pressedAt === undefined) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            const tap = !used && performance.now() - pressedAt < 220;
            pressedAt = undefined;
            if (tap && !pressedFromSelection) enter("select");
            else {
                complete();
                cancel();
                pencil();
            }
        },
        true,
    );

    function complete() {
        overlay.style.display = "none";
        if (polygon.length < 3) return;
        const objects = canvas.getObjects().filter((object) => {
            if (!object.selectable) return false;
            if (object instanceof Path) {
                const segments = util.getPathSegmentsInfo(object.path);
                const length = segments.at(-1)?.length ?? 0;
                const samples = Math.min(
                    2000,
                    Math.max(1, Math.ceil(length / 2)),
                );
                const matrix = object.calcTransformMatrix();
                for (let i = 0; i <= samples; i++) {
                    const point = util.getPointOnPath(
                        object.path,
                        (length * i) / samples,
                        segments,
                    );
                    if (
                        point &&
                        !insideLasso(
                            new Point(
                                point.x - object.pathOffset.x,
                                point.y - object.pathOffset.y,
                            ).transform(matrix),
                            polygon,
                        )
                    )
                        return false;
                }
                return true;
            }
            return object
                .getCoords()
                .every((point) => insideLasso(point, polygon));
        });
        polygon = [];
        if (!objects.length) return;
        if (mode === "erase") {
            canvas.remove(...objects);
            history();
        } else {
            canvas.setActiveObject(
                objects.length === 1
                    ? objects[0]
                    : new ActiveSelection(objects, { canvas }),
            );
        }
        canvas.requestRenderAll();
    }
    upper.addEventListener(
        "pointerdown",
        (event) => {
            if (mode === "off" || event.button !== 0 || pointer !== undefined)
                return;
            if (
                mode === "select" &&
                canvas.getActiveObject() &&
                canvas.findTarget(event).target
            )
                return;
            event.preventDefault();
            event.stopImmediatePropagation();
            pointer = event.pointerId;
            used = true;
            canvas.discardActiveObject();
            polygon = [canvas.getScenePoint(event)];
            outline.setAttribute("points", `${event.clientX},${event.clientY}`);
            outline.setAttribute("stroke", "var(--ac-lasso-color)");
            outline.setAttribute("fill", "var(--ac-lasso-fill)");
            overlay.style.display = "block";
            upper.setPointerCapture(pointer);
        },
        true,
    );
    document.addEventListener(
        "pointermove",
        (event) => {
            if (event.pointerId !== pointer) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (mode === "off") return;
            polygon.push(canvas.getScenePoint(event));
            outline.setAttribute(
                "points",
                `${outline.getAttribute("points")} ${event.clientX},${event.clientY}`,
            );
        },
        true,
    );
    function release(event: PointerEvent, cancelled = false) {
        if (event.pointerId !== pointer) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!cancelled) complete();
        polygon = [];
        overlay.style.display = "none";
        const id = pointer;
        pointer = undefined;
        if (upper.hasPointerCapture(id)) upper.releasePointerCapture(id);
    }
    document.addEventListener("pointerup", (event) => release(event), true);
    document.addEventListener(
        "pointercancel",
        (event) => release(event, true),
        true,
    );
    upper.addEventListener("lostpointercapture", () => {
        pointer = undefined;
        polygon = [];
        overlay.style.display = "none";
    });
    window.addEventListener("blur", () => {
        const active = mode !== "off";
        cancel();
        if (pointer !== undefined && upper.hasPointerCapture(pointer))
            upper.releasePointerCapture(pointer);
        pointer = undefined;
        if (active) pencil();
    });
    canvas.on("object:modified", () => {
        if (mode === "select") history();
    });
    return { cancel };
}
