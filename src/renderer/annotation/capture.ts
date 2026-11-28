import { button, ele, p, view } from "dkh-ui";
import {
    type AcademyFieldBox,
    type ArchiveRecord,
    inkBounds,
    type OutputFormat,
    outputFormatLabels,
    outputFormats,
    type PixelRect,
    selectedRect,
} from "../../../lib/annotation";
import { invoke } from "../../../lib/annotationIpc";
import { t } from "../../../lib/translate/translate";
import { positionedInkPng } from "./positionedInk";
import { annotationStyles } from "./styles";

export type CaptureSnapshot = {
    composite: HTMLCanvasElement;
    ink?: HTMLCanvasElement;
    selectedInk?: HTMLCanvasElement;
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
    byPosition?: boolean;
};

function inkPng(ink: HTMLCanvasElement, rect: PixelRect, trim = false) {
    const pixels = ink
        .getContext("2d")!
        .getImageData(rect.x, rect.y, rect.width, rect.height);
    const bounds = inkBounds(pixels.data, pixels.width, pixels.height);
    if (!bounds) return null;
    const source = trim
        ? {
              x: rect.x + bounds.x,
              y: rect.y + bounds.y,
              width: bounds.width,
              height: bounds.height,
          }
        : rect;
    const padding = trim ? 12 : 0;
    const crop = ele("canvas").attr({
        width: source.width + 2 * padding,
        height: source.height + 2 * padding,
    }).el;
    const ctx = crop.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, crop.width, crop.height);
    ctx.drawImage(
        ink,
        source.x,
        source.y,
        source.width,
        source.height,
        padding,
        padding,
        source.width,
        source.height,
    );
    return crop.toDataURL();
}
export function installCompletion(
    snapshot: (
        formula: boolean,
        selected?: boolean,
    ) => Promise<CaptureSnapshot>,
    rawClose: () => void,
    drawingElement: HTMLElement,
    hasStroke: () => boolean,
    saveDefaults: () => Promise<void>,
) {
    annotationStyles();
    const capturedAt = new Date().toISOString();
    let busy = false;
    let pointerDown: number | undefined;
    let queued: boolean | "submit" | "position" | null = null;
    let saved:
        | { png: string; metadata: string; record: ArchiveRecord }
        | undefined;
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
                                "保存当前画笔和圈选设置，下次批注自动应用",
                            ),
                        })
                        .on("click", async () => {
                            try {
                                await saveDefaults();
                                status.el.textContent = t("默认设置已保存");
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
        setTimeout(
            () =>
                void (typeof formula === "string"
                    ? submitAnswer(formula === "position")
                    : finish(formula)),
            0,
        );
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

    async function saveSnapshot(frozen: CaptureSnapshot, png: string) {
        const input = {
            capturedAt,
            rect: frozen.rect,
            screenId: frozen.screenId,
            annotations: frozen.annotations,
        };
        const metadata = JSON.stringify(input);
        if (saved?.png === png && saved.metadata === metadata)
            return saved.record;
        const record = await invoke("archive", {
            ...input,
            png,
            id: crypto.randomUUID(),
        });
        saved = { png, metadata, record };
        return record;
    }
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
            const png = archivePng(frozen.composite);
            const archived = png.then((image) => saveSnapshot(frozen, image));
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
            const record = await archived;
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
            if (selection)
                await invoke("formula", { archiveId: record.id, ...selection });
            rawClose();
        } catch (error) {
            await invoke("captureVisibility", true);
            blocker.remove();
            status.class("ac-error");
            status.el.textContent = `${t("未能完成，画布已保留：")}${error instanceof Error ? error.message : String(error)}`;
            busy = false;
        }
    }

    async function submitAnswer(byPosition = false) {
        if (busy) return;
        if (pointerDown !== undefined || hasStroke()) {
            queued = byPosition ? "position" : "submit";
            return;
        }
        busy = true;
        let hidden = false;
        try {
            const reason = await invoke("academyTarget");
            if (reason) throw Error(reason);
            const fields = await invoke("academyLayout");
            if (byPosition && fields.length < 2)
                throw Error("按空位填写需要至少两个待填写的空位");
            const frozen = await snapshot(true, true);
            if (!frozen.ink) throw Error("请先写下最终答案");
            const archiveImage = archivePng(frozen.composite);
            // Selection can be cancelled before the encoder settles.
            void archiveImage.catch(() => {});
            let png: string | null = null;
            if (frozen.selectedInk) {
                const { width, height } = frozen.selectedInk;
                const rect = { x: 0, y: 0, width, height };
                png = byPosition
                    ? positionedInkPng(frozen.selectedInk, rect, fields)
                    : inkPng(frozen.selectedInk, rect, true);
            }
            if (!png) {
                selectionOpen = true;
                try {
                    const selection = await selectFormula(
                        frozen.composite,
                        frozen.ink,
                        true,
                        fields,
                        byPosition,
                    );
                    png = selection?.png ?? null;
                    byPosition = !!selection?.byPosition;
                } finally {
                    selectionOpen = false;
                }
            }
            if (!png) return;
            await invoke("captureVisibility", false);
            hidden = true;
            await saveSnapshot(frozen, await archiveImage);
            await invoke("academyFill", png, byPosition);
            rawClose();
        } catch (error) {
            status.class("ac-error");
            status.el.textContent =
                error instanceof Error
                    ? error.message.replace(
                          /^Error invoking remote method '[^']+': Error: /,
                          "",
                      )
                    : String(error);
            if (hidden) await invoke("academyRetryAvailable");
        } finally {
            busy = false;
        }
    }
    async function selectFormula(
        composite: HTMLCanvasElement,
        ink: HTMLCanvasElement,
        forSubmit = false,
        fields: AcademyFieldBox[] = [],
        byPosition = false,
    ) {
        const format = forSubmit
            ? "latex"
            : (await invoke("captureConfig")).outputFormat;
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
            outputFormat.el.value = format;
            const mode = ele("select")
                .class("ac-field")
                .attr({
                    id: "ac-answer-placement",
                    ariaLabel: t("手写答案的位置"),
                })
                .style({ width: "auto", maxWidth: "100%" })
                .add([
                    ele("option")
                        .attr({ value: "expression" })
                        .add(t("完整答案")),
                    ele("option")
                        .attr({ value: "position" })
                        .add(t("按原题空位填写")),
                ]);
            mode.el.value = byPosition ? "position" : "expression";
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
            const info = p(
                t(
                    forSubmit
                        ? "框选手写的最终答案，松开后填写原题"
                        : "拖动框选要识别的批注",
                ),
            )
                .class("ac-status")
                .attr({ id: "ac-selection-status", role: "status" });
            const cancel = button(t(forSubmit ? "返回批注" : "保留截图并退出"))
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
                .add([
                    info,
                    ...(forSubmit
                        ? fields.length > 1
                            ? [mode]
                            : []
                        : [outputFormat]),
                    display,
                    cancel,
                ])
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
                const positioned =
                    forSubmit &&
                    fields.length > 1 &&
                    mode.el.value === "position";
                let png: string | null;
                try {
                    png = positioned
                        ? positionedInkPng(ink, rect, fields)
                        : inkPng(ink, rect, forSubmit);
                } catch (error) {
                    info.el.textContent =
                        error instanceof Error ? error.message : String(error);
                    draw();
                    return;
                }
                if (!png) {
                    info.el.textContent = t("选区没有批注笔迹，请重新框选");
                    draw();
                    return;
                }
                close({
                    png,
                    rect,
                    outputFormat: outputFormat.el.value as OutputFormat,
                    byPosition: positioned,
                });
            }
            document.addEventListener("keydown", key, true);
            draw();
            cancel.el.focus();
        });
    }
    return { finish, submitAnswer, toolbar };
}
