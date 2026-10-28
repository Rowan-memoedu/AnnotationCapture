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
    ink: HTMLCanvasElement;
    rect: PixelRect;
    screenId: number;
    annotations?: object;
};
export function installCompletion(
    snapshot: () => Promise<CaptureSnapshot>,
    rawClose: () => Promise<void>,
    drawingElement: HTMLElement,
    saveDefaults: () => Promise<void>,
) {
    annotationStyles();
    const id = crypto.randomUUID();
    const capturedAt = new Date().toISOString();
    let busy = false;
    let pointerDown = false;
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
            if (event.button === 0 && event.target === drawingElement)
                pointerDown = true;
        },
        true,
    );
    document.addEventListener(
        "pointerup",
        () => {
            pointerDown = false;
            if (queued !== null) {
                const formula = queued;
                queued = null;
                setTimeout(() => {
                    void finish(formula);
                }, 0);
            }
        },
        true,
    );
    document.addEventListener(
        "pointercancel",
        () => {
            pointerDown = false;
        },
        true,
    );
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
        if (pointerDown) {
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
            const frozen = await snapshot();
            const input: CaptureInput = {
                id,
                capturedAt,
                png: frozen.composite.toDataURL(),
                rect: frozen.rect,
                screenId: frozen.screenId,
                annotations: frozen.annotations,
            };
            await invoke("archive", input);
            blocker.remove();
            if (directFormat) {
                await invoke("formula", {
                    archiveId: id,
                    png: frozen.composite.toDataURL(),
                    rect: {
                        x: 0,
                        y: 0,
                        width: frozen.rect.width,
                        height: frozen.rect.height,
                    },
                    outputFormat: directFormat,
                });
            } else if (formula) {
                selectionOpen = true;
                await selectFormula(frozen);
                selectionOpen = false;
            }
            await rawClose();
        } catch (error) {
            blocker.remove();
            status.class("ac-error");
            status.el.textContent = `${t("未能完成，画布已保留：")}${error instanceof Error ? error.message : String(error)}`;
            busy = false;
        }
    }

    async function selectFormula(frozen: CaptureSnapshot) {
        const { config } = await invoke("state");
        return new Promise<void>((resolve) => {
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
            outputFormat.add(
                ele("option")
                    .attr({ value: "ma", disabled: true })
                    .add(t("Math Academy（后续接入）")),
            );
            const display = ele("canvas")
                .attr({
                    id: "ac-selection",
                    width: frozen.composite.width,
                    height: frozen.composite.height,
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
            let start: { x: number; y: number } | null = null;
            let rect: PixelRect | null = null;
            let submitting = false;
            const info = p(
                t(
                    "截图已归档。选择输出格式，再框选公式或图示；仅发送选区内的批注笔迹。",
                ),
            )
                .class("ac-status")
                .attr({ id: "ac-selection-status", role: "status" });
            const accept = button(t("识别选区"))
                .class("ac-button", "ac-primary")
                .attr({ id: "ac-recognize", disabled: true })
                .on("click", submit);
            const cancel = button(t("保留截图并退出"))
                .class("ac-button")
                .attr({ id: "ac-cancel-selection" })
                .on("click", close);
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
                    outputFormat,
                    display,
                    view("x").style({ gap: "12px" }).add([accept, cancel]),
                ])
                .addInto();
            function draw() {
                ctx.clearRect(0, 0, display.el.width, display.el.height);
                ctx.drawImage(frozen.composite, 0, 0);
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
                if (submitting || event.button !== 0) return;
                start = point(event);
                rect = null;
                display.el.setPointerCapture(event.pointerId);
                accept.el.disabled = true;
                draw();
            });
            display.on("pointermove", (event) => {
                if (!start || submitting) return;
                rect = selectedRect(
                    start,
                    point(event),
                    display.el.width,
                    display.el.height,
                );
                draw();
            });
            display.on("pointerup", (event) => {
                if (!start || submitting) return;
                rect = selectedRect(
                    start,
                    point(event),
                    display.el.width,
                    display.el.height,
                );
                start = null;
                accept.el.disabled = rect.width < 2 || rect.height < 2;
                draw();
            });
            function key(event: KeyboardEvent) {
                event.stopImmediatePropagation();
                if (event.key === "Escape") {
                    event.preventDefault();
                    close();
                }
                if (event.key === "Enter" && !accept.el.disabled) {
                    event.preventDefault();
                    void submit();
                }
            }
            function close() {
                if (submitting) return;
                document.removeEventListener("keydown", key, true);
                overlay.remove();
                resolve();
            }
            async function submit() {
                if (!rect || submitting) return;
                const crop = ele("canvas").attr({
                    width: rect.width,
                    height: rect.height,
                }).el;
                const c = crop.getContext("2d")!;
                c.drawImage(
                    frozen.ink,
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
                    return;
                }
                c.globalCompositeOperation = "destination-over";
                c.fillStyle = "white";
                c.fillRect(0, 0, crop.width, crop.height);
                submitting = true;
                accept.el.disabled = true;
                cancel.el.disabled = true;
                outputFormat.el.disabled = true;
                info.el.textContent = t("正在保存公式图…");
                try {
                    await invoke("formula", {
                        archiveId: id,
                        png: crop.toDataURL(),
                        rect,
                        outputFormat: outputFormat.el.value as OutputFormat,
                    });
                    submitting = false;
                    close();
                } catch (error) {
                    submitting = false;
                    accept.el.disabled = false;
                    cancel.el.disabled = false;
                    outputFormat.el.disabled = false;
                    info.class("ac-error");
                    info.el.textContent = `${t("公式图保存失败，可重试：")}${String(error)}`;
                }
            }
            document.addEventListener("keydown", key, true);
            draw();
            cancel.el.focus();
        });
    }
    return { finish, toolbar };
}
