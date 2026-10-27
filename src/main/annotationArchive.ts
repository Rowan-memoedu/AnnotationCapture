import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
    ArchiveRecord,
    CaptureInput,
    FormulaResult,
} from "../../lib/annotation";

export function decodePng(data: string): Buffer {
    if (!data.startsWith("data:image/png;base64,") || data.length > 90_000_000)
        throw new Error("图像格式或大小不受支持");
    const png = Buffer.from(data.slice(22), "base64");
    if (
        png.length < 24 ||
        png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    )
        throw new Error("PNG 图像无效");
    const w = png.readUInt32BE(16),
        h = png.readUInt32BE(20);
    if (!w || !h || w * h > 100_000_000) throw new Error("图像尺寸无效");
    return png;
}

export async function atomicWrite(path: string, data: string | Buffer) {
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, data, { flag: "wx" });
    await rename(temp, path);
}

export class ArchiveStore {
    private saves = new Map<
        string,
        { hash: string; promise: Promise<ArchiveRecord> }
    >();
    readonly records = new Map<string, ArchiveRecord>();
    constructor(private root: () => string) {}

    save(input: CaptureInput): Promise<ArchiveRecord> {
        if (!/^[a-f0-9-]{36}$/.test(input.id)) throw new Error("归档编号无效");
        const date = new Date(input.capturedAt);
        if (!Number.isFinite(date.getTime())) throw new Error("截图时间无效");
        const png = decodePng(input.png);
        if (
            png.readUInt32BE(16) !== input.rect.width ||
            png.readUInt32BE(20) !== input.rect.height
        )
            throw new Error("归档尺寸与选区不一致");
        const hash = createHash("sha256").update(png).digest("hex");
        const pending = this.saves.get(input.id);
        if (pending) {
            if (pending.hash !== hash)
                throw new Error("同一截图已归档，不能覆盖");
            return pending.promise;
        }
        const promise = this.commit(input, png, hash).catch((error) => {
            this.saves.delete(input.id);
            throw error;
        });
        this.saves.set(input.id, { hash, promise });
        return promise;
    }

    private async commit(input: CaptureInput, png: Buffer, hash: string) {
        const date = new Date(input.capturedAt);
        const day = [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, "0"),
            String(date.getDate()).padStart(2, "0"),
        ].join("-");
        const directory = join(this.root(), day, input.id);
        const pending = `${directory}.pending-${randomUUID()}`;
        await mkdir(pending, { recursive: true });
        const record: ArchiveRecord = {
            id: input.id,
            capturedAt: input.capturedAt,
            sha256: hash,
            path: join(directory, "capture.png"),
            rect: input.rect,
            screenId: input.screenId,
        };
        await writeFile(join(pending, "capture.png"), png, { flag: "wx" });
        await writeFile(
            join(pending, "capture.json"),
            JSON.stringify(record, null, 2),
            { flag: "wx" },
        );
        await rename(pending, directory);
        this.records.set(record.id, record);
        return record;
    }

    async formula(archiveId: string, id: string, png: string) {
        const archive = this.records.get(archiveId);
        if (!archive) throw new Error("请先完成截图归档");
        const path = join(archive.path, "..", `formula-${id}.png`);
        await atomicWrite(path, decodePng(png));
        return path;
    }

    async saveResult(result: FormulaResult) {
        await atomicWrite(
            result.path.replace(/\.png$/, ".json"),
            JSON.stringify(result, null, 2),
        );
    }

    async readFormula(result: FormulaResult) {
        return `data:image/png;base64,${(await readFile(result.path)).toString("base64")}`;
    }
}
