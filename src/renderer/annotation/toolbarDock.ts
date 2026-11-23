import { button, image } from "dkh-ui";
import { t } from "../../../lib/translate/translate";
import { getImgUrl } from "../root/root";

type Edge = "left" | "right" | "top" | "bottom";
const margin = 8;

export function installToolbarDock(
    toolbar: HTMLElement,
    bars: HTMLElement[],
    setExpanded: (expanded: boolean) => void,
) {
    const controls = [toolbar, ...bars].map(({ id }) => id).join(" ");
    const collapse = button(t("收起工具栏"))
        .class("ac-button")
        .attr({ id: "ac-collapse-tools" })
        .addInto(toolbar).el;
    collapse.setAttribute("aria-controls", controls);
    collapse.setAttribute("aria-expanded", "true");
    const label = t("展开工具栏");
    const ball = button("")
        .class("ac-button")
        .attr({
            id: "ac-toolbar-ball",
            hidden: true,
            ariaLabel: label,
            ariaExpanded: "false",
        })
        .add(image(getImgUrl("draw.svg"), "").class("icon"))
        .addInto().el;
    ball.setAttribute("aria-controls", controls);
    ball.title = label;

    let edge: Edge = "right";
    let x = window.innerWidth,
        y = window.innerHeight * 0.75;
    let drag:
        | { id: number; x: number; y: number; left: number; top: number }
        | undefined;
    let dragged = false;

    function place(left: number, top: number, snap = false) {
        const right = Math.max(
            margin,
            window.innerWidth - ball.offsetWidth - margin,
        );
        const bottom = Math.max(
            margin,
            window.innerHeight - ball.offsetHeight - margin,
        );
        x = Math.max(margin, Math.min(right, left));
        y = Math.max(margin, Math.min(bottom, top));
        if (snap) {
            const distances = {
                left: x - margin,
                right: right - x,
                top: y - margin,
                bottom: bottom - y,
            };
            for (const side of ["left", "right", "top", "bottom"] as const) {
                if (distances[side] < distances[edge]) edge = side;
            }
            if (edge === "left") x = margin;
            if (edge === "right") x = right;
            if (edge === "top") y = margin;
            if (edge === "bottom") y = bottom;
        }
        ball.style.left = `${x}px`;
        ball.style.top = `${y}px`;
    }

    function restorePosition() {
        place(
            edge === "right" ? window.innerWidth : edge === "left" ? 0 : x,
            edge === "bottom" ? window.innerHeight : edge === "top" ? 0 : y,
        );
    }

    ball.onpointerdown = (event) => {
        if (event.button !== 0 || drag) return;
        drag = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: x,
            top: y,
        };
        dragged = false;
        ball.setPointerCapture(event.pointerId);
    };
    ball.onpointermove = (event) => {
        if (event.pointerId !== drag?.id) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!dragged && Math.hypot(dx, dy) < 5) return;
        dragged = true;
        ball.dataset.dragging = "true";
        place(drag.left + dx, drag.top + dy);
    };
    function end(event: PointerEvent) {
        if (event.pointerId !== drag?.id) return;
        drag = undefined;
        delete ball.dataset.dragging;
        if (dragged) place(x, y, true);
    }
    ball.onpointerup = ball.onpointercancel = ball.onlostpointercapture = end;
    ball.onclick = (event) => {
        if (dragged && event.detail) return;
        setExpanded(true);
        if (event.detail === 0) collapse.focus({ preventScroll: true });
    };
    collapse.onclick = (event) => {
        setExpanded(false);
        if (event.detail === 0) ball.focus({ preventScroll: true });
    };
    window.addEventListener("resize", () => {
        if (!ball.hidden) restorePosition();
    });

    return (expanded: boolean) => {
        for (const bar of [toolbar, ...bars]) {
            bar.classList.toggle("ac-toolbar-collapsed", !expanded);
            bar.inert = !expanded;
        }
        ball.hidden = expanded;
        if (!expanded) restorePosition();
    };
}
