import { randomUUID } from "node:crypto";
import {
    type FormulaResult,
    type OutputFormat,
    outputFormats,
    type PixelRect,
} from "../../lib/annotation";
import type { ArchiveStore } from "./annotationArchive";
import type { FormulaProvider } from "./formulaProvider";
import { mathAcademyOutput } from "./mathAcademy";
import {
    calculateWhiteboardFormula,
    warmWhiteboardCalculator,
} from "./whiteboardCalculator";

export type ClipboardPort = {
    revision: () => Promise<string>;
    writeText: (text: string) => Promise<void>;
};

export class FormulaJobs {
    readonly jobs = new Map<string, FormulaResult>();
    private latest = "";
    private running = new Set<string>();
    constructor(
        private archives: ArchiveStore,
        private provider: () => FormulaProvider | null,
        private clipboard: ClipboardPort,
        private changed: () => void,
    ) {}

    async create(
        archiveId: string,
        png: string,
        rect: PixelRect,
        outputFormat: OutputFormat = "latex",
    ) {
        if (!outputFormats.includes(outputFormat))
            throw new Error("识别输出格式无效");
        const id = randomUUID();
        const archive = this.archives.records.get(archiveId);
        if (
            !archive ||
            ![rect.x, rect.y, rect.width, rect.height].every(
                Number.isInteger,
            ) ||
            rect.x < 0 ||
            rect.y < 0 ||
            rect.width < 2 ||
            rect.height < 2 ||
            rect.x + rect.width > archive.rect.width ||
            rect.y + rect.height > archive.rect.height
        )
            throw new Error("公式选区超出截图");
        const path = await this.archives.formula(archiveId, id, png);
        const result: FormulaResult = {
            id,
            archiveId,
            path,
            rect,
            outputFormat,
            status: "unconfigured",
            latex: "",
            message: "请先使用邀请码登录；截图与公式图已保存",
        };
        this.jobs.set(id, result);
        await this.archives.saveResult(result);
        this.changed();
        return result;
    }

    async run(id: string, png?: string) {
        const result = this.get(id);
        if (this.running.has(id)) return result;
        this.running.add(id);
        this.latest = id;
        result.status = "recognizing";
        result.outputIssue = undefined;
        result.message = "正在识别选定批注…";
        this.changed();
        const start = Date.now();
        try {
            const provider = this.provider();
            if (!provider) {
                result.status = "unconfigured";
                result.message = "请先使用邀请码登录；截图与公式图已保存";
                return result;
            }
            const revision = this.clipboard.revision().catch(() => null);
            const useCalculator =
                result.outputFormat === "calculator" ||
                result.outputFormat === "calculatorCas";
            const cas = result.outputFormat === "calculatorCas";
            if (useCalculator)
                void warmWhiteboardCalculator(cas).catch(() => {});
            const image = png ?? (await this.archives.readFormula(result));
            const recognized = await provider.recognize(
                image,
                AbortSignal.timeout(60000),
                useCalculator
                    ? "calculator"
                    : result.outputFormat === "mathAcademy"
                      ? "latex"
                      : result.outputFormat,
            );
            result.latex = recognized.latex;
            result.recognizedLatex = recognized.latex;
            result.detectedType = recognized.detectedType;
            result.model = recognized.model;
            if (useCalculator) {
                if (recognized.calculatorSupported === false) {
                    result.status = "review";
                    result.message = "已识别原式，但计算器暂不支持这种写法";
                    return result;
                }
                try {
                    result.latex = await calculateWhiteboardFormula(
                        recognized.latex,
                        cas,
                    );
                } catch (error) {
                    result.status = "review";
                    result.message =
                        error instanceof Error ? error.message : "计算未完成";
                    return result;
                }
            } else if (result.outputFormat === "mathAcademy") {
                try {
                    result.latex = mathAcademyOutput(recognized.latex);
                } catch (error) {
                    result.status = "review";
                    result.outputIssue =
                        error instanceof Error
                            ? error.message
                            : "公式格式不兼容";
                    result.message = result.outputIssue;
                    return result;
                }
            }
            result.status = "ready";
            result.message = "识别完成";
            this.changed();
            const originalRevision = await revision;
            if (
                originalRevision !== null &&
                this.latest === id &&
                originalRevision ===
                    (await this.clipboard.revision().catch(() => null)) &&
                this.latest === id &&
                result.status === "ready"
            ) {
                await this.clipboard.writeText(result.latex);
                result.status = "copied";
                result.message =
                    result.outputFormat === "mathAcademy"
                        ? "Math Academy 公式已复制"
                        : "识别结果已复制到剪贴板";
            } else if (result.status === "ready") {
                result.status = "review";
                result.message = "识别完成；剪贴板或当前任务已变化，请手动复制";
            }
        } catch (error) {
            result.status = "error";
            result.message =
                error instanceof Error &&
                ["TimeoutError", "AbortError"].includes(error.name)
                    ? "识别超时，截图已保存，可重试"
                    : error instanceof Error
                      ? error.message
                      : "识别失败，截图已保存";
        } finally {
            result.durationMs = Date.now() - start;
            this.running.delete(id);
            try {
                await this.archives.saveResult(result);
            } catch {
                result.message += "；结果记录保存失败";
            }
            this.changed();
        }
        return result;
    }

    get(id: string) {
        const result = this.jobs.get(id);
        if (!result) throw new Error("识别任务不存在");
        return result;
    }

    async copy(id: string, text: string) {
        const result = this.get(id);
        if (!result.latex || !text.trim() || text.length > 10000)
            throw new Error("没有可复制的公式");
        const output =
            result.outputFormat === "mathAcademy"
                ? mathAcademyOutput(text)
                : text;
        await this.clipboard.writeText(output);
        result.latex = output;
        result.outputIssue = undefined;
        result.status = "copied";
        result.message =
            result.outputFormat === "mathAcademy"
                ? "Math Academy 公式已复制"
                : "公式已复制到剪贴板";
        await this.archives.saveResult(result);
        this.changed();
        return result;
    }
}
