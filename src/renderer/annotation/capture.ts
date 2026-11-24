import { button, ele, p, view } from "dkh-ui";
import {
    type CaptureInput,
    type OutputFormat,
    outputFormatLabels,
    outputFormats,
    type PixelRect,
    selectedRect,
} from "../../../lib/annotation";
import { invoke } from "../../../lib/annotationIpc";
import { t } from "../../../lib/translate/translate";
import { annotationStyles } from "./styles";

export type CaptureSnapshot = {
    composite: HTMLCanvasElement;
    ink?: HTMLCanvasElement;
    rect: PixelRect;
    screenId: number;
    annotations?: object;
};

function archivePng(canvas: HTMLCanvasElement): Promise<string> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error("截图编码失败"));
                return;
            }
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    });
}

type FormulaSelection = {
    png: string;
    rect: PixelRect;
    outputFormat: OutputFormat;
};
export function installCompletion(
    snapshot: (formula: boolean) => Promise<CaptureSnapshot>,
    rawClose: () => void,
    drawingElement: HTMLElement,
    hasStroke: () => boolean,
    saveDefaults: () => Promise<void>,
) {
    annotationStyles();
    const id = crypto.randomUUID();
    const capturedAt = new Date().toISOString();
    let busy = false;
    let pointerDown: number | undefined;
    let queued: boolean | null = null;
    let selectionOpen = false;
    const status = p()
        .attr({ role: "status", ariaLive: "polite", id: "ac-capture-status" })
        .class("ac-status");
    const toolbar = view()
        .class("ac-toolbar")
        .attr({ id: "ac-completion" })
        .add([
            status,
            p().attr({ id: "ac-selection-hint", role: "status" }),
            view("x")
                .class("ac-toolbar-group")
                .add([
                    p().attr({ id: "ac-pen-width", ariaLive: "polite" }),
                    button(t("保存为默认"))
                        .class("ac-button")
                        .attr({
                            id: "ac-save-defaults",
                            title: t(
                                "保存当前画笔颜色和粗细，下次批注自动应用",
                            ),
                        })
                        .on("click", async () => {
                            try {
                                await saveDefaults();
                                status.el.textContent = t("默认画笔已保存");
                            } catch (error) {
                                status.el.textContent = String(error);
                            }
                        }),
                ]),
            button(t("归档并退出"))
                .class("ac-button")
                .attr({ id: "ac-finish", title: "归档并退出" })
                .on("click", () => {
                    void finish(false);
                }),
            view("x")
                .class("ac-toolbar-group")
                .attr({ id: "ac-formula-actions", hidden: true })
                .add([
                    button(t("选区识别"))
                        .class("ac-button", "ac-primary")
                        .attr({ id: "ac-formula", title: t("选区识别") })
                        .on("click", () => {
                            void finish(true);
                        }),
                ]),
        ])
        .addInto();
    document.addEventListener(
        "pointerdown",
        (event) => {
            if (
                event.isPrimary &&
                event.button === 0 &&
                event.target === drawingElement
            )
                pointerDown ??= event.pointerId;
        },
        true,
    );
    function released() {
        pointerDown = undefined;
        if (queued === null) return;
        const formula = queued;
        queued = null;
        // The canvas commits the final segment in the same pointer event.
        setTimeout(() => void finish(formula), 0);
    }
    function releasePointer(event: PointerEvent) {
        if (event.pointerId === pointerDown && !(event.buttons & 1)) released();
    }
    document.addEventListener("pointerup", releasePointer, true);
    document.addEventListener("pointercancel", releasePointer, true);
    drawingElement.addEventListener("lostpointercapture", releasePointer);
    drawingElement.addEventListener("ac-stroke-end", released);
    window.addEventListener("blur", released);
    document.addEventListener(
        "keydown",
        (event) => {
            if (event.isComposing || selectionOpen) return;
            if (
                event.key === "Escape" ||
                (event.key === "Enter" && event.ctrlKey)
            ) {
                event.preventDefault();
                event.stopImmediatePropagation();
                void finish(event.key === "Enter" && event.shiftKey);
            }
        },
        true,
    );

    async function finish(formula: boolean, directFormat?: OutputFormat) {
        if (busy) return;
        if (pointerDown !== undefined || hasStroke()) {
            queued = formula;
            status.el.textContent = t("抬笔后完成归档");
            return;
        }
        busy = true;
        const blocker = view()
            .class("ac-overlay")
            .style({ background: "#101828aa" })
            .add(p(t("正在保存批注…")))
            .attr({ id: "ac-saving", role: "status" })
            .addInto();
        try {
            if (!formula || directFormat)
                await invoke("captureVisibility", false);
            const frozen = await snapshot(formula);
            const input = {
                id,
                capturedAt,
                rect: frozen.rect,
                screenId: frozen.screenId,
                annotations: frozen.annotations,
            } satisfies Omit<CaptureInput, "png">;
            const png = archivePng(frozen.composite);
            const archived = png.then((image) =>
                invoke("archive", { ...input, png: image }),
            );
            // The archive can fail while the selection dialog is still open.
            void archived.catch(() => {});
            blocker.remove();
            let selection: FormulaSelection | null = null;
            if (!directFormat && frozen.ink) {
                selectionOpen = true;
                try {
                    selection = await selectFormula(
                        frozen.composite,
                        frozen.ink,
                    );
                } finally {
                    selectionOpen = false;
                }
                await invoke("captureVisibility", false);
            }
            if (directFormat) {
                selection = {
                    png: await png,
                    rect: {
                        x: 0,
                        y: 0,
                        width: frozen.rect.width,
                        height: frozen.rect.height,
                    },
                    outputFormat: directFormat,
                };
            }
            if (selection && !directFormat)
                await invoke(
                    "prepareFormula",
                    id,
                    selection.png,
                    selection.outputFormat,
                );
            await archived;
            if (selection)
                await invoke("formula", { archiveId: id, ...selection });
            rawClose();
        } catch (error) {
            void invoke("cancelPreparedFormula", id).catch(() => {});
            await invoke("captureVisibility", true);
            blocker.remove();
            status.class("ac-error");
            status.el.textContent = `${t("未能完成，画布已保留：")}${error instanceof Error ? error.message : String(error)}`;
            busy = false;
        }
    }

    async function selectFormula(
        composite: HTMLCanvasElement,
        ink: HTMLCanvasElement,
    ) {
        const config = await invoke("captureConfig");
        return new Promise<FormulaSelection | null>((resolve) => {
            const outputFormat = ele("select")
                .class("ac-field")
                .attr({ id: "ac-output-format", ariaLabel: t("识别输出格式") })
                .style({ width: "auto", maxWidth: "100%" })
                .add(
                    outputFormats.map((format) =>
                        ele("option")
                            .attr({ value: format })
                            .add(t(outputFormatLabels[format])),
                    ),
                );
            outputFormat.el.value = config.outputFormat;
            const display = ele("canvas")
                .attr({
                    id: "ac-selection",
                    width: composite.width,
                    height: composite.height,
                    ariaLabel: t("拖动框选要识别的批注"),
                })
                .style({
                    maxWidth: "calc(100vw - 80px)",
                    maxHeight: "max(120px, calc(100vh - 300px))",
                    width: "auto",
                    height: "auto",
                    cursor: "crosshair",
                    touchAction: "none",
                    background: "white",
                });
            const ctx = display.el.getContext("2d")!;
            let start: { x: number; y: number; pointerId: number } | null =
                null;
            let rect: PixelRect | null = null;
            const info = p(t("拖动框选要识别的批注"))
                .class("ac-status")
                .attr({ id: "ac-selection-status", role: "status" });
            const cancel = button(t("保留截图并退出"))
                .class("ac-button")
                .attr({ id: "ac-cancel-selection" })
                .on("click", () => close(null));
            const overlay = view()
                .class("ac-overlay")
                .attr({
                    role: "dialog",
                    ariaModal: "true",
                    ariaLabel: t("选择公式"),
                    id: "ac-formula-dialog",
                })
                .add([info, outputFormat, display, cancel])
                .addInto();
            function draw() {
                ctx.clearRect(0, 0, display.el.width, display.el.height);
                ctx.drawImage(composite, 0, 0);
                if (rect) {
                    ctx.strokeStyle = "#006cff";
                    ctx.lineWidth = 3;
                    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
                }
            }
            function point(event: PointerEvent) {
                const b = display.el.getBoundingClientRect();
                return {
                    x: Math.max(
                        0,
                        Math.min(
                            display.el.width,
                            ((event.clientX - b.left) * display.el.width) /
                                b.width,
                        ),
                    ),
                    y: Math.max(
                        0,
                        Math.min(
                            display.el.height,
                            ((event.clientY - b.top) * display.el.height) /
                                b.height,
                        ),
                    ),
                };
            }
            display.on("pointerdown", (event) => {
                if (start || event.button !== 0) return;
                start = { ...point(event), pointerId: event.pointerId };
                rect = null;
                display.el.setPointerCapture(event.pointerId);
                draw();
            });
            display.on("pointermove", (event) => {
                if (start?.pointerId !== event.pointerId) return;
                rect = selectedRect(
                    start,
                    point(event),
                    display.el.width,
                    display.el.height,
                );
                draw();
            });
            display.on("pointerup", (event) => {
                if (start?.pointerId !== event.pointerId) return;
                rect = selectedRect(
                    start,
                    point(event),
                    display.el.width,
                    display.el.height,
                );
                start = null;
                if (rect.width >= 2 && rect.height >= 2) submit(rect);
                else resetSelection(event);
            });
            function resetSelection(event: PointerEvent) {
                if (start && start.pointerId !== event.pointerId) return;
                start = rect = null;
                draw();
            }
            display.on("lostpointercapture", (event) => {
                if (start) resetSelection(event);
            });
            function key(event: KeyboardEvent) {
                event.stopImmediatePropagation();
                if (event.key === "Escape") {
                    event.preventDefault();
                    close(null);
                }
            }
            function close(selection: FormulaSelection | null) {
                document.removeEventListener("keydown", key, true);
                overlay.remove();
                resolve(selection);
            }
            function submit(rect: PixelRect) {
                const crop = ele("canvas").attr({
                    width: rect.width,
                    height: rect.height,
                }).el;
                const c = crop.getContext("2d")!;
                c.drawImage(
                    ink,
                    rect.x,
                    rect.y,
                    rect.width,
                    rect.height,
                    0,
                    0,
                    rect.width,
                    rect.height,
                );
                const data = c.getImageData(0, 0, crop.width, crop.height).data;
                if (!data.some((v, i) => i % 4 === 3 && v > 8)) {
                    info.el.textContent = t("选区没有批注笔迹，请重新框选");
                    draw();
                    return;
                }
                c.globalCompositeOperation = "destination-over";
                c.fillStyle = "white";
                c.fillRect(0, 0, crop.width, crop.height);
                close({
                    png: crop.toDataURL(),
                    rect,
                    outputFormat: outputFormat.el.value as OutputFormat,
                });
            }
            document.addEventListener("keydown", key, true);
            draw();
            cancel.el.focus();
        });
    }
    return { finish, toolbar };
}
