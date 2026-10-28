import {
    ActiveSelection,
    type Canvas,
    type FabricObject,
    Group,
    Path,
    Point,
    util,
} from "fabric";
import type { LassoRule } from "../../../lib/annotation";
import { t } from "../../../lib/translate/translate";
import { type Position, polylineMatchesLasso } from "./lassoGeometry";

export function installInkSelection(
    canvas: Canvas,
    history: () => void,
    select: () => void,
    pencil: () => void,
) {
    let rule: LassoRule = "intersect";
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
        function matches(object: FabricObject): boolean {
            if (!object.visible) return false;
            if (object instanceof Group) {
                const children = object
                    .getObjects()
                    .filter((child) => child.visible);
                return (
                    children.length > 0 &&
                    (rule === "contain"
                        ? children.every(matches)
                        : children.some(matches))
                );
            }
            if (object instanceof Path) {
                const matrix = object.calcTransformMatrix();
                const scale = Math.max(
                    Math.hypot(matrix[0], matrix[1]),
                    Math.hypot(matrix[2], matrix[3]),
                );
                const paths: (typeof object.path)[] = [];
                for (const command of object.path) {
                    if (command[0] === "M" || !paths.length) paths.push([]);
                    paths.at(-1)?.push(command);
                }
                const results = paths.map((path) => {
                    const segments = util.getPathSegmentsInfo(path);
                    const length = segments.at(-1)?.length ?? 0;
                    const samples = Math.min(
                        10000,
                        Math.max(1, Math.ceil((length * scale) / 2)),
                    );
                    const points: Position[] = [];
                    for (let i = 0; i <= samples; i++) {
                        const p = util.getPointOnPath(
                            path,
                            (length * i) / samples,
                            segments,
                        );
                        if (p)
                            points.push(
                                new Point(
                                    p.x - object.pathOffset.x,
                                    p.y - object.pathOffset.y,
                                ).transform(matrix),
                            );
                    }
                    return polylineMatchesLasso(
                        points,
                        polygon,
                        rule,
                        object.stroke
                            ? (object.strokeWidth *
                                  (object.strokeUniform ? 1 : scale)) /
                                  2
                            : 0,
                    );
                });
                return (
                    results.length > 0 &&
                    (rule === "contain"
                        ? results.every(Boolean)
                        : results.some(Boolean))
                );
            }
            const points = object.getCoords();
            return (
                polylineMatchesLasso([...points, points[0]], polygon, rule) ||
                (rule === "intersect" &&
                    polylineMatchesLasso(polygon, points, "intersect"))
            );
        }
        const objects = canvas
            .getObjects()
            .filter((object) => object.selectable && matches(object));
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
    return {
        cancel,
        setRule: (value: LassoRule) => {
            rule = value;
        },
    };
}
