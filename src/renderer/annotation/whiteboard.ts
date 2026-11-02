import { button, p, view } from "dkh-ui";
import { type Canvas, Control, FabricObject, Path, Point, Rect } from "fabric";
import type { PixelRect, PublicConfig } from "../../../lib/annotation";
import { invoke } from "../../../lib/annotationIpc";
import { t } from "../../../lib/translate/translate";
import {
    intersectRect,
    planWhiteboardRects,
    refineWhiteboardRects,
    whiteboardRects,
} from "../../../lib/whiteboard";

import { pointerPatch } from "./cursorOverlay";
import type { Position } from "./lassoGeometry";
import { whiteboardLasso } from "./whiteboardLasso";

export type WhiteboardRegion = PixelRect & { hole?: Position[] };
type Board = (Rect | Path) & {
    acWhiteboard: true;
    acFixed: boolean;
    acHole?: Position[];
};
type BoardMode = "auto" | "smart" | "center" | "rect" | "free";
FabricObject.customProperties = [
    ...FabricObject.customProperties,
    "acWhiteboard",
    "acFixed",
    "acHole",
];
export function isWhiteboard(object: unknown): object is Board {
    return !!object && (object as Board).acWhiteboard === true;
}

export function maskWhiteboardInk(
    ink: HTMLCanvasElement,
    boards: WhiteboardRegion[],
) {
    const masked = document.createElement("canvas");
    masked.width = ink.width;
    masked.height = ink.height;
    const ctx = masked.getContext("2d")!;
    ctx.fillStyle = "white";
    for (const board of boards) {
        ctx.beginPath();
        ctx.rect(board.x, board.y, board.width, board.height);
        if (board.hole?.length) {
            ctx.moveTo(board.hole[0].x, board.hole[0].y);
            for (const p of board.hole.slice(1)) ctx.lineTo(p.x, p.y);
            ctx.closePath();
        }
        ctx.fill("evenodd");
    }
    ctx.globalCompositeOperation = "source-in";
    ctx.drawImage(ink, 0, 0);
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
    create: HTMLButtonElement,
    area: () => PixelRect,
    history: () => void,
    select: () => void,
    pencil: () => void,
    recognize: () => void,
) {
    let candidates: PixelRect[] = [];
    let patch: ReturnType<typeof pointerPatch>;
    let pointer: Position | undefined,
        checkedPointer = false,
        covered = false;
    function cursorTile() {
        if (!checkedPointer && pointer) {
            checkedPointer = true;
            patch = pointerPatch(
                source,
                { x: pointer.x * source.width, y: pointer.y * source.height },
                source.width /
                    (source.getBoundingClientRect().width || source.width),
            );
        }
        return patch;
    }
    let generation = 0;
    let waiting = false;
    let endLasso: (() => void) | undefined;
    let editing = false;
    let uniformScaling = canvas.uniformScaling;
    let detection: "off" | "loading" | "ready" | "error" = "off";
    const boards = () => canvas.getObjects().filter(isWhiteboard);
    const hint = p().class("ac-status").attr({
        id: "ac-whiteboard-status",
        role: "status",
        ariaLive: "polite",
    });
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
        .add([adjust, remove, ocr, hint]);
    document.querySelector("#ac-completion")!.append(group.el);

    function sync() {
        const items = boards();
        if (!!items.length !== covered) {
            covered = !!items.length;
            const tile = cursorTile();
            if (tile) {
                const ctx = source.getContext("2d")!;
                if (covered) ctx.drawImage(tile.tile, tile.x, tile.y);
                else ctx.putImageData(tile.original, tile.x, tile.y);
            }
        }
        create.dataset.state = items.length ? "success" : detection;
        create.setAttribute("aria-pressed", String(items.length > 0));
        adjust.el.hidden = !items.some((b) => !b.acFixed);
        remove.el.hidden = ocr.el.hidden = items.length === 0;
        adjust.el.textContent = t(editing ? "完成调整" : "调整白板");
        adjust.el.setAttribute("aria-pressed", String(editing));
        group.el.dataset.state = items.length ? "success" : detection;
        create.setAttribute(
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
        if (waiting || endLasso) hint.el.textContent = "";
        waiting = false;
        endLasso?.();
        endLasso = undefined;
        if (editing) {
            canvas.discardActiveObject();
            canvas.uniformScaling = uniformScaling;
        }
        editing = false;
        for (const b of boards()) protect(b);
        sync();
        canvas.requestRenderAll();
    }
    function put(board: Rect | Path, fixed: boolean, hole?: Position[]) {
        const object = Object.assign(board, {
            acWhiteboard: true as const,
            acFixed: fixed,
            acHole: hole,
        });
        protect(object);
        canvas.add(object);
        canvas.sendObjectToBack(object);
        document.body.classList.add("ac-stationary-cursor");
    }
    function choose(mode: BoardMode) {
        if (mode === "auto" && boards().length) return;
        const finishingWait =
            mode === "smart" && waiting && detection !== "loading";
        stopEditing();
        if (mode === "smart" && detection === "loading") {
            pencil();
            waiting = true;
            hint.el.textContent = t("正在等待智能白板，可继续书写");
            return;
        }
        const bounds = area();
        if (mode === "rect" || mode === "free") {
            select();
            hint.el.textContent = t("圈出要保留的内容，其余区域将变成白板");
            endLasso = whiteboardLasso(
                canvas,
                mode,
                bounds,
                (hole) => {
                    pencil();
                    const { x, y, width, height } = bounds;
                    const outer = `M ${x} ${y} h ${width} v ${height} h ${-width} Z`;
                    const inner = hole
                        .map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`)
                        .join(" ");
                    const board = new Path(`${outer} ${inner} Z`, {
                        originX: "left",
                        originY: "top",
                        left: x,
                        top: y,
                        strokeWidth: 0,
                        fillRule: "evenodd",
                    });
                    canvas.remove(...boards());
                    put(board, true, hole);
                    hint.el.textContent = t("已保留选区，其余区域可书写");
                    history();
                    sync();
                    canvas.requestRenderAll();
                },
                pencil,
            );
            return;
        }
        const detected = candidates
            .map((r) => intersectRect(r, bounds))
            .filter(
                (r): r is PixelRect => !!r && r.width >= 16 && r.height >= 16,
            );
        const fixed = mode !== "center" && detected.length > 0;
        if (mode === "smart" && !fixed) {
            hint.el.textContent = t(
                "当前没有可用的智能白板，可选择中央白板或反选",
            );
            return;
        }
        // Keep the current brush and its in-progress stroke when an awaited result arrives.
        if (!finishingWait) pencil();
        canvas.remove(...boards());
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
            put(
                new Rect({
                    originX: "left",
                    originY: "top",
                    left: r.x,
                    top: r.y,
                    width: r.width,
                    height: r.height,
                }),
                fixed,
            );
        }
        hint.el.textContent = t(
            fixed
                ? "已按页面空白区域创建固定白板"
                : "已创建中央白板；可调整位置和大小",
        );
        canvas.requestRenderAll();
        history();
        sync();
        if (!fixed) startEditing();
    }
    function startEditing() {
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
        b.controls = { ...b.controls };
        for (const name of ["ml", "mr", "mt", "mb"]) {
            const horizontal = name === "mt" || name === "mb";
            const control = new Control({ ...b.controls[name] });
            control.calcCornerCoords = (_angle, size, x, y, touch) => {
                const hit = (touch ? 32 : 18) / scale;
                const width = horizontal
                    ? Math.max(
                          hit,
                          b.getScaledWidth() * canvas.getZoom() - 2 * size,
                      )
                    : hit;
                const height = horizontal
                    ? hit
                    : Math.max(
                          hit,
                          b.getScaledHeight() * canvas.getZoom() - 2 * size,
                      );
                return {
                    tl: new Point(x - width / 2, y - height / 2),
                    tr: new Point(x + width / 2, y - height / 2),
                    bl: new Point(x - width / 2, y + height / 2),
                    br: new Point(x + width / 2, y + height / 2),
                };
            };
            b.controls[name] = control;
        }
        b.setCoords();
        canvas.setActiveObject(b);
        canvas.requestRenderAll();
        hint.el.textContent = t(
            "拖动白板移动；角点调整宽高，边点调整单轴。笔迹保持原位。",
        );
        sync();
    }
    adjust.on("click", () => {
        if (editing) pencil();
        else startEditing();
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
        if (!isWhiteboard(target) || target.acFixed) return;
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
                1024 / Math.max(source.width, source.height),
            );
            preview.width = Math.round(source.width * scale);
            preview.height = Math.round(source.height * scale);
            preview
                .getContext("2d")!
                .drawImage(source, 0, 0, preview.width, preview.height);
            const tile = cursorTile();
            if (tile)
                preview
                    .getContext("2d")!
                    .drawImage(
                        tile.tile,
                        tile.x * scale,
                        tile.y * scale,
                        tile.tile.width * scale,
                        tile.tile.height * scale,
                    );
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
            candidates =
                result.protected !== undefined
                    ? planWhiteboardRects(
                          whiteboardRects(
                              result.protected,
                              32,
                              source.width,
                              source.height,
                              0,
                          ),
                          preview
                              .getContext("2d")!
                              .getImageData(
                                  0,
                                  0,
                                  preview.width,
                                  preview.height,
                              ),
                          source.width,
                          source.height,
                          config.whiteboard.maxRects,
                          whiteboardRects(
                              result.unprotected || [],
                              20,
                              source.width,
                              source.height,
                              0,
                          ),
                          result.contentRegions === undefined
                              ? undefined
                              : whiteboardRects(
                                    result.contentRegions,
                                    64,
                                    source.width,
                                    source.height,
                                    0,
                                ),
                          result.solid === undefined
                              ? undefined
                              : whiteboardRects(
                                    result.solid,
                                    32,
                                    source.width,
                                    source.height,
                                    0,
                                ),
                      )
                    : refineWhiteboardRects(
                          candidates,
                          preview
                              .getContext("2d")!
                              .getImageData(
                                  0,
                                  0,
                                  preview.width,
                                  preview.height,
                              ),
                          source.width,
                          source.height,
                          (result.unprotected || []).map((r) => ({
                              x: r.x * source.width,
                              y: r.y * source.height,
                              width: r.width * source.width,
                              height: r.height * source.height,
                          })),
                          config.whiteboard.maxRects,
                      );
            detection = "ready";
            if (waiting) choose("smart");
            else if (!boards().length && !endLasso)
                hint.el.textContent = t(
                    candidates.length
                        ? "空白区域已就绪"
                        : "未找到可用空白，将使用中央白板",
                );
        } catch {
            if (generation !== current) return;
            detection = "error";
            if (waiting) choose("smart");
            else if (!boards().length && !endLasso)
                hint.el.textContent = t("空白识别不可用，点击可使用中央白板");
        }
        sync();
    }
    return {
        initialize,
        choose,
        cancelChoice: () => {
            if (waiting || endLasso) stopEditing();
        },
        setPointer: (value: Position | undefined) => {
            pointer = value;
            checkedPointer = false;
            patch = undefined;
            covered = false;
        },
        stopEditing,
        invalidate: () => {
            generation++;
            candidates = [];
            detection = "off";
            stopEditing();
        },
        regions: (left: number, top: number): WhiteboardRegion[] =>
            boards().map((b) => ({
                x: b.left - left,
                y: b.top - top,
                width: b.width * b.scaleX,
                height: b.height * b.scaleY,
                hole: b.acHole?.map((p) => ({ x: p.x - left, y: p.y - top })),
            })),
    };
}
