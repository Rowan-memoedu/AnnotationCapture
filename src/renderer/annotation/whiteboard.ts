import { button, p, view } from "dkh-ui";
import { type Canvas, FabricObject, Rect } from "fabric";
import type { PixelRect, PublicConfig } from "../../../lib/annotation";
import { invoke } from "../../../lib/annotationIpc";
import { t } from "../../../lib/translate/translate";
import { intersectRect, whiteboardRects } from "../../../lib/whiteboard";

type Board = Rect & { acWhiteboard: true; acFixed: boolean };
FabricObject.customProperties = [
    ...FabricObject.customProperties,
    "acWhiteboard",
    "acFixed",
];
export function isWhiteboard(object: unknown): object is Board {
    return !!object && (object as Board).acWhiteboard === true;
}

export function maskWhiteboardInk(ink: HTMLCanvasElement, boards: PixelRect[]) {
    const masked = document.createElement("canvas");
    masked.width = ink.width;
    masked.height = ink.height;
    const ctx = masked.getContext("2d")!;
    ctx.save();
    ctx.beginPath();
    for (const board of boards) {
        const r = intersectRect(board, {
            x: 0,
            y: 0,
            width: ink.width,
            height: ink.height,
        });
        if (r) ctx.rect(r.x, r.y, r.width, r.height);
    }
    ctx.clip();
    ctx.drawImage(ink, 0, 0);
    ctx.restore();
    if (
        !ctx
            .getImageData(0, 0, masked.width, masked.height)
            .data.some((v, i) => i % 4 === 3 && v > 8)
    )
        throw new Error(t("白板上没有笔迹，请先书写"));
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, masked.width, masked.height);
    return masked;
}

export function installWhiteboard(
    canvas: Canvas,
    source: HTMLCanvasElement,
    area: () => PixelRect,
    history: () => void,
    select: () => void,
    pencil: () => void,
    recognize: () => void,
) {
    let candidates: PixelRect[] = [];
    let generation = 0;
    let editing = false;
    let uniformScaling = canvas.uniformScaling;
    let detection: "off" | "loading" | "ready" | "error" = "off";
    const boards = () => canvas.getObjects().filter(isWhiteboard);
    const hint = p().class("ac-status").attr({
        id: "ac-whiteboard-status",
        role: "status",
        ariaLive: "polite",
    });
    const create = button(t("快速白板"))
        .class("ac-button")
        .attr({ id: "ac-whiteboard", title: t("在页面上创建白色书写区域") });
    const adjust = button(t("调整白板"))
        .class("ac-button")
        .attr({ id: "ac-whiteboard-adjust", hidden: true });
    const remove = button(t("收起白板"))
        .class("ac-button")
        .attr({ id: "ac-whiteboard-remove", hidden: true });
    const ocr = button(t("识别白板"))
        .class("ac-button", "ac-primary")
        .attr({ id: "ac-whiteboard-recognize", hidden: true })
        .on("click", recognize);
    const group = view("x")
        .class("ac-toolbar-group")
        .attr({ id: "ac-whiteboard-tools" })
        .add([create, adjust, remove, ocr, hint]);
    document.querySelector("#ac-completion")!.append(group.el);

    function sync() {
        const items = boards();
        create.el.disabled = items.length > 0;
        adjust.el.hidden = !items.some((b) => !b.acFixed);
        remove.el.hidden = ocr.el.hidden = items.length === 0;
        adjust.el.textContent = t(editing ? "完成调整" : "调整白板");
        adjust.el.setAttribute("aria-pressed", String(editing));
        group.el.dataset.state = items.length ? "success" : detection;
        create.el.setAttribute(
            "aria-busy",
            String(detection === "loading" && !items.length),
        );
    }
    function protect(object: FabricObject) {
        if (!isWhiteboard(object)) return;
        object.set({
            selectable: editing && !object.acFixed,
            evented: editing && !object.acFixed,
            fill: "white",
            stroke: null,
            strokeWidth: 0,
            lockRotation: true,
            lockScalingFlip: true,
        });
        object.set("erasable", false);
        object.setControlsVisibility({ mtr: false });
    }
    function stopEditing() {
        if (editing) {
            canvas.discardActiveObject();
            canvas.uniformScaling = uniformScaling;
        }
        editing = false;
        for (const b of boards()) protect(b);
        sync();
        canvas.requestRenderAll();
    }
    create.on("click", () => {
        if (boards().length) return;
        pencil();
        const bounds = area();
        const detected = candidates
            .map((r) => intersectRect(r, bounds))
            .filter(
                (r): r is PixelRect => !!r && r.width >= 16 && r.height >= 16,
            );
        const fixed = detected.length > 0;
        const width = Math.min(bounds.width * 0.6, 960 * devicePixelRatio);
        const height = Math.min(bounds.height * 0.6, 600 * devicePixelRatio);
        const rects = fixed
            ? detected
            : [
                  {
                      x: bounds.x + (bounds.width - width) / 2,
                      y: bounds.y + (bounds.height - height) / 2,
                      width,
                      height,
                  },
              ];
        for (const r of rects) {
            const object = new Rect({
                originX: "left",
                originY: "top",
                left: r.x,
                top: r.y,
                width: r.width,
                height: r.height,
            }) as Board;
            object.acWhiteboard = true;
            object.acFixed = fixed;
            protect(object);
            canvas.add(object);
            canvas.sendObjectToBack(object);
        }
        hint.el.textContent = t(
            fixed
                ? "已按页面空白区域创建固定白板"
                : "已创建中央白板；可调整位置和大小",
        );
        canvas.requestRenderAll();
        history();
        sync();
    });
    adjust.on("click", () => {
        if (editing) {
            pencil();
            return;
        }
        select();
        editing = true;
        uniformScaling = canvas.uniformScaling;
        canvas.uniformScaling = false;
        canvas.selection = false;
        const b = boards().find((b) => !b.acFixed);
        if (!b) return;
        protect(b);
        const scale =
            canvas.upperCanvasEl.getBoundingClientRect().width /
            canvas.getWidth();
        b.set({
            cornerSize: 18 / scale,
            touchCornerSize: 32 / scale,
            transparentCorners: false,
            cornerColor: "#ffffff",
            cornerStrokeColor: "#2b78e4",
            borderColor: "#2b78e4",
        });
        b.setCoords();
        canvas.setActiveObject(b);
        canvas.requestRenderAll();
        hint.el.textContent = t(
            "拖动白板移动；角点调整宽高，边点调整单轴。笔迹保持原位。",
        );
        sync();
    });
    remove.on("click", () => {
        pencil();
        canvas.remove(...boards());
        history();
        hint.el.textContent = t("白板已收起，笔迹保留；可撤销恢复");
        sync();
    });
    canvas.on("object:added", ({ target }) => {
        protect(target);
        sync();
    });
    canvas.on("object:removed", sync);
    canvas.on("object:modified", ({ target }) => {
        if (!isWhiteboard(target)) return;
        const a = area();
        const width = Math.max(
            32,
            Math.min(a.width, target.width * target.scaleX),
        );
        const height = Math.max(
            32,
            Math.min(a.height, target.height * target.scaleY),
        );
        target.set({
            width,
            height,
            scaleX: 1,
            scaleY: 1,
            left: Math.max(a.x, Math.min(a.x + a.width - width, target.left)),
            top: Math.max(a.y, Math.min(a.y + a.height - height, target.top)),
        });
        target.setCoords();
        history();
    });
    async function initialize(config: PublicConfig, full: boolean) {
        const current = ++generation;
        candidates = [];
        detection = full && config.whiteboard.enabled ? "loading" : "off";
        hint.el.textContent =
            detection === "loading"
                ? t("正在查找空白区域；现在点击将使用中央白板")
                : "";
        sync();
        if (detection !== "loading") return;
        // Wait until the capture is drawable; model latency never gates the pen.
        await new Promise((resolve) => setTimeout(resolve, 0));
        try {
            const preview = document.createElement("canvas");
            const scale = Math.min(
                1,
                1600 / Math.max(source.width, source.height),
            );
            preview.width = Math.round(source.width * scale);
            preview.height = Math.round(source.height * scale);
            preview
                .getContext("2d")!
                .drawImage(source, 0, 0, preview.width, preview.height);
            const result = await invoke(
                "detectWhitespace",
                preview.toDataURL(),
            );
            if (generation !== current) return;
            candidates = whiteboardRects(
                result.rects,
                config.whiteboard.maxRects,
                source.width,
                source.height,
            );
            detection = "ready";
            if (!boards().length)
                hint.el.textContent = t(
                    candidates.length
                        ? "空白区域已就绪"
                        : "未找到可用空白，将使用中央白板",
                );
        } catch {
            if (generation !== current) return;
            detection = "error";
            if (!boards().length)
                hint.el.textContent = t("空白识别不可用，点击可使用中央白板");
        }
        sync();
    }
    return {
        initialize,
        stopEditing,
        invalidate: () => {
            generation++;
            candidates = [];
        },
        rectangles: () =>
            boards().map((b) => ({
                x: b.left,
                y: b.top,
                width: b.width * b.scaleX,
                height: b.height * b.scaleY,
            })),
    };
}
