import { randomUUID } from "node:crypto";
import type { FormulaResult, PixelRect } from "../../lib/annotation";
import type { ArchiveStore } from "./annotationArchive";
import type { FormulaProvider } from "./formulaProvider";

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

    async create(archiveId: string, png: string, rect: PixelRect) {
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
            status: "unconfigured",
            latex: "",
            message: "请先使用邀请码登录；截图与公式图已保存",
        };
        this.jobs.set(id, result);
        await this.archives.saveResult(result);
        this.changed();
        return result;
    }

    async run(id: string) {
        const result = this.get(id);
        if (this.running.has(id)) return result;
        this.running.add(id);
        this.latest = id;
        result.status = "recognizing";
        result.message = "正在识别选定公式…";
        this.changed();
        const start = Date.now();
        try {
            const provider = this.provider();
            if (!provider) {
                result.status = "unconfigured";
                result.message = "请先使用邀请码登录；截图与公式图已保存";
                return result;
            }
            const revision = await this.clipboard.revision();
            const recognized = await provider.recognize(
                await this.archives.readFormula(result),
                AbortSignal.timeout(60000),
            );
            result.latex = recognized.latex;
            result.recognizedLatex = recognized.latex;
            result.model = recognized.model;
            result.status = "ready";
            result.message = "识别完成";
            await this.archives.saveResult(result);
            if (
                this.latest === id &&
                revision === (await this.clipboard.revision())
            ) {
                await this.clipboard.writeText(result.latex);
                result.status = "copied";
                result.message = "公式已复制到剪贴板";
            } else {
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
        await this.clipboard.writeText(text);
        result.latex = text;
        result.status = "copied";
        result.message = "公式已复制到剪贴板";
        await this.archives.saveResult(result);
        this.changed();
        return result;
    }
}
