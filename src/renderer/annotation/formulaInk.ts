import { button } from "dkh-ui";
import {
    type Canvas,
    config,
    FabricObject,
    loadSVGFromString,
    util,
} from "fabric";
import type { FormulaFont } from "../../../lib/annotation";
import { invoke } from "../../../lib/annotationIpc";
import { t } from "../../../lib/translate/translate";

type Formula = {
    latex: string;
    font: FormulaFont;
    color: string;
    source: object[];
};
type InkObject = FabricObject & {
    acInk?: string;
    acBatch?: string;
    acFormula?: Formula;
};
FabricObject.customProperties = [
    ...FabricObject.customProperties,
    "acInk",
    "acBatch",
    "acFormula",
];
// MathJax coordinates are in thousandths of an em. Keep the fitted scale and
// child transforms precise when Fabric rehydrates an undo/redo snapshot.
config.NUM_FRACTION_DIGITS = 8;

/** Owns only formula ink. Normal drawing, archive and clipboard remain separate. */
export function installFormulaInk(
    canvas: Canvas,
    history: () => void,
    pencil: () => void,
) {
    let active = false;
    let batch = crypto.randomUUID();
    let revision = 0;
    let font: FormulaFont = "stix2";
    const pending = new Map<string, string>();
    const taps: { path: InkObject; x: number; y: number; time: number }[] = [];
    let tapTimer: ReturnType<typeof setTimeout> | undefined;
    let down = { x: 0, y: 0, time: 0, blank: false };
    const toolbar = document.querySelector("#ac-completion") as HTMLElement;
    const tool = button("ƒx").el;
    tool.id = "ac-formula-pen";
    tool.className = "ac-formula-tool";
    tool.setAttribute("aria-label", t("公式画笔"));
    tool.title = t(
        "写完公式后双击空白处，或按 Ctrl+Shift+T 转换；保留原笔迹供撤销",
    );
    tool.setAttribute("aria-pressed", "false");
    const convert = button(t("转换公式")).el;
    convert.id = "ac-typeset";
    convert.className = "ac-button";
    convert.textContent = t("转换公式");
    const status = document.createElement("span");
    status.id = "ac-ink-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    document.querySelector("#draw_free")!.after(tool);
    const actions = document.querySelector(
        "#ac-formula-actions",
    ) as HTMLElement;
    actions.prepend(convert);
    toolbar.prepend(status);
    const setActive = (value: boolean) => {
        active = value;
        tool.setAttribute("aria-pressed", String(value));
        tool.classList.toggle("select", value);
        actions.hidden = !value;
        if (!value) status.textContent = "";
    };
    tool.onclick = () => {
        pencil();
        setActive(true);
        for (const element of document.querySelectorAll(
            "#draw_main > .select",
        )) {
            if (element !== tool) element.classList.remove("select");
        }
        status.textContent = t("公式画笔：写完后双击空白处转换");
    };
    convert.onclick = () => {
        void transform();
    };

    function flushTaps() {
        clearTimeout(tapTimer);
        if (taps.length) {
            taps.length = 0;
            history();
        }
    }
    canvas.upperCanvasEl.addEventListener(
        "pointerdown",
        (event) => {
            if (!active || event.button !== 0) return;
            const target = canvas.findTarget(event).target;
            down = {
                x: event.clientX,
                y: event.clientY,
                time: performance.now(),
                blank: !target || taps.some((tap) => tap.path === target),
            };
        },
        true,
    );
    canvas.upperCanvasEl.addEventListener(
        "dblclick",
        (event) => {
            if (!active || !down.blank) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            // Only the actual double-click's two tap paths are discarded. A written
            // decimal point or dot elsewhere is never classified by its size alone.
            const recent = taps.slice(-2);
            if (
                recent.length === 2 &&
                recent.every(
                    (tap) =>
                        performance.now() - tap.time < 700 &&
                        Math.hypot(
                            tap.x - event.clientX,
                            tap.y - event.clientY,
                        ) < 6,
                )
            ) {
                clearTimeout(tapTimer);
                canvas.remove(...recent.map((tap) => tap.path));
                taps.splice(-2);
                canvas.requestRenderAll();
            }
            flushTaps();
            void transform();
        },
        true,
    );
    document.addEventListener(
        "keydown",
        (event) => {
            if (
                event.ctrlKey &&
                event.shiftKey &&
                event.code === "KeyT" &&
                !(
                    event.target instanceof HTMLInputElement ||
                    event.target instanceof HTMLTextAreaElement
                )
            ) {
                event.preventDefault();
                event.stopImmediatePropagation();
                void transform();
            }
        },
        true,
    );
    function pathCreated(path: FabricObject) {
        if (!active) {
            history();
            return;
        }
        const ink = path as InkObject;
        ink.acInk = crypto.randomUUID();
        ink.acBatch = batch;
        const bounds = path.getBoundingRect();
        const isTap =
            performance.now() - down.time < 350 &&
            bounds.width <= path.strokeWidth + 3 &&
            bounds.height <= path.strokeWidth + 3;
        if (isTap) {
            taps.push({
                path: ink,
                x: down.x,
                y: down.y,
                time: performance.now(),
            });
            clearTimeout(tapTimer);
            tapTimer = setTimeout(flushTaps, 650);
        } else {
            flushTaps();
            history();
        }
    }
    function cancel() {
        if (pending.size) status.textContent = t("已取消转换，当前笔迹已保留");
        revision++;
        for (const id of pending.values()) void invoke("inkCancel", id);
        pending.clear();
        flushTaps();
    }
    function current(
        objects: InkObject[],
        fingerprints: string[],
        stamp: number,
    ) {
        const valid =
            revision === stamp &&
            objects.every(
                (object, i) =>
                    canvas.getObjects().includes(object) &&
                    JSON.stringify(object.toObject()) === fingerprints[i],
            );
        if (!valid && revision === stamp)
            status.textContent = t("笔迹已变化，未应用过期结果；可重新转换");
        return valid;
    }
    async function groupFor(
        latex: string,
        chosenFont: FormulaFont,
        color: string,
        bounds: { left: number; top: number; width: number; height: number },
    ) {
        const svg = await invoke("typeset", latex, chosenFont, color);
        const result = await loadSVGFromString(svg);
        const group = util.groupSVGElements(
            result.objects.filter((o): o is FabricObject => !!o),
            result.options,
        ) as InkObject;
        const scale = Math.min(
            bounds.width / group.width,
            bounds.height / group.height,
        );
        group.set({
            originX: "left",
            originY: "top",
            left: bounds.left,
            top: bounds.top + (bounds.height - group.height * scale) / 2,
            scaleX: scale,
            scaleY: scale,
        });
        group.setCoords();
        return group;
    }
    async function transform() {
        flushTaps();
        const all = canvas.getObjects() as InkObject[];
        const first = all.find(
            (o) => o.acInk && o.acBatch && !pending.has(o.acBatch),
        );
        if (!first) {
            status.textContent = pending.size
                ? t("正在转换，请继续书写下一条公式")
                : t("请先用公式画笔书写");
            return;
        }
        if (pending.size >= 2) {
            status.textContent = t("请等待当前转换完成");
            return;
        }
        const objects = all.filter(
            (o) => o.acInk && o.acBatch === first.acBatch,
        );
        const sourceBatch = first.acBatch as string;
        const id = crypto.randomUUID();
        pending.set(sourceBatch, id);
        if (batch === sourceBatch) batch = crypto.randomUUID();
        const stamp = revision;
        const fingerprints = objects.map((o) => JSON.stringify(o.toObject()));
        const boxes = objects.map((o) => o.getBoundingRect());
        const left = Math.floor(Math.min(...boxes.map((b) => b.left))) - 8;
        const top = Math.floor(Math.min(...boxes.map((b) => b.top))) - 8;
        const width =
            Math.ceil(Math.max(...boxes.map((b) => b.left + b.width)) - left) +
            8;
        const height =
            Math.ceil(Math.max(...boxes.map((b) => b.top + b.height)) - top) +
            8;
        const chosenFont = font;
        const color = /^#[\da-f]{6}$/i.test(String(first.stroke))
            ? String(first.stroke)
            : "#ff0000";
        try {
            const ink = canvas.toCanvasElement(1, {
                left,
                top,
                width,
                height,
                filter: (o) => objects.includes(o as InkObject),
            });
            const white = document.createElement("canvas");
            white.width = width;
            white.height = height;
            const ctx = white.getContext("2d") as CanvasRenderingContext2D;
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(ink, 0, 0);
            status.textContent = t("正在识别并排版，原笔迹暂时保留");
            const result = await invoke("inkRecognize", id, white.toDataURL());
            if (!current(objects, fingerprints, stamp)) return;
            const group = await groupFor(result.latex, chosenFont, color, {
                left: left + 8,
                top: top + 8,
                width: width - 16,
                height: height - 16,
            });
            if (!current(objects, fingerprints, stamp)) return;
            group.acFormula = {
                latex: result.latex,
                font: chosenFont,
                color,
                source: objects.map((o) => o.toObject()),
            };
            // One history transaction, with all source strokes retained in metadata.
            canvas.remove(...objects);
            canvas.add(group);
            canvas.requestRenderAll();
            history();
            status.textContent = t(
                "公式已回填；请核对大小写和上下标。可撤销或选择编辑",
            );
        } catch (error) {
            if (stamp === revision)
                status.textContent = `${t("转换失败，原笔迹已保留：")}${error instanceof Error ? error.message : String(error)}`;
        } finally {
            if (pending.get(sourceBatch) === id) pending.delete(sourceBatch);
        }
    }

    const editor = document.createElement("div");
    editor.id = "ac-formula-editor";
    editor.style.cssText =
        "display:none;position:fixed;right:16px;top:16px;z-index:100020;background:var(--bg,#fff);color:var(--font-color,#222);padding:12px;border:1px solid #aaa;border-radius:8px;width:320px;box-shadow:0 4px 20px #0003";
    const text = document.createElement("textarea");
    text.id = "ac-formula-latex";
    text.className = "ac-field";
    text.setAttribute("aria-label", "LaTeX");
    const fonts = document.createElement("select");
    fonts.id = "ac-inline-font";
    fonts.className = "ac-field";
    fonts.setAttribute("aria-label", t("公式字体"));
    for (const [value, label] of [
        ["stix2", "STIX2"],
        ["newcm", "New Computer Modern"],
    ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        fonts.append(option);
    }
    const apply = document.createElement("button");
    apply.id = "ac-apply-formula";
    apply.className = "ac-button";
    apply.textContent = t("更新公式");
    const hide = document.createElement("button");
    hide.className = "ac-button";
    hide.textContent = t("关闭");
    hide.onclick = () => {
        editor.style.display = "none";
    };
    editor.append(text, fonts, apply, hide);
    document.body.append(editor);
    let selected: InkObject | undefined;
    function selection() {
        selected = canvas.getActiveObject() as InkObject | undefined;
        if (!selected?.acFormula) {
            editor.style.display = "none";
            return;
        }
        editor.style.display = "block";
        text.value = selected.acFormula.latex;
        fonts.value = selected.acFormula.font;
    }
    canvas.on("selection:created", selection);
    canvas.on("selection:updated", selection);
    canvas.on("selection:cleared", selection);
    apply.onclick = async () => {
        const original = selected;
        if (!original?.acFormula) return;
        const stamp = revision;
        const fingerprint = JSON.stringify(original.toObject());
        apply.disabled = true;
        try {
            const data = {
                ...original.acFormula,
                latex: text.value,
                font: fonts.value as FormulaFont,
            };
            const replacement = await groupFor(
                data.latex,
                data.font,
                data.color,
                {
                    left: 0,
                    top: 0,
                    width: original.width,
                    height: original.height,
                },
            );
            if (!current([original], [fingerprint], stamp)) return;
            replacement.set({
                left: original.left,
                top: original.top,
                scaleX: replacement.scaleX * original.scaleX,
                scaleY: replacement.scaleY * original.scaleY,
                angle: original.angle,
                skewX: original.skewX,
                skewY: original.skewY,
                flipX: original.flipX,
                flipY: original.flipY,
            });
            replacement.setCoords();
            replacement.acFormula = data;
            canvas.remove(original);
            canvas.add(replacement);
            canvas.setActiveObject(replacement);
            canvas.requestRenderAll();
            history();
            status.textContent = t("公式已更新");
        } catch (error) {
            status.textContent = String(error);
        } finally {
            apply.disabled = false;
        }
    };
    return {
        setActive,
        pathCreated,
        cancel,
        setFont: (value: FormulaFont) => {
            font = value;
        },
        transform,
    };
}
