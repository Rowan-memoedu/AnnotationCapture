import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const day = 24 * 60 * 60 * 1000;
const interval = 60 * 60 * 1000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ownedFile =
    /^(?:capture\.(?:png|json)|annotations\.json|formula-[a-f0-9-]{36}\.(?:png|json))$/;
const samePath = (a: string, b: string) =>
    process.platform === "win32"
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;

export async function pruneArchives(
    root: string,
    days: number,
    trash: (path: string) => Promise<void>,
    protectedArchive: (id: string) => boolean = () => false,
    now = Date.now(),
) {
    const removed: string[] = [];
    let failed = 0;
    if (!Number.isInteger(days) || days <= 0 || days > 3650)
        return { removed, failed };
    const absolute = resolve(root);
    try {
        const info = await lstat(absolute);
        if (
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            !samePath(await realpath(absolute), absolute)
        )
            return { removed, failed };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return { removed, failed };
        throw error;
    }
    for (const date of await readdir(absolute, { withFileTypes: true })) {
        if (
            !/^\d{4}-\d{2}-\d{2}$/.test(date.name) ||
            !date.isDirectory() ||
            date.isSymbolicLink()
        )
            continue;
        const directory = join(absolute, date.name);
        if (!samePath(await realpath(directory), directory)) continue;
        for (const item of await readdir(directory, { withFileTypes: true })) {
            if (
                !uuid.test(item.name) ||
                !item.isDirectory() ||
                item.isSymbolicLink() ||
                protectedArchive(item.name)
            )
                continue;
            const target = resolve(directory, item.name);
            try {
                if (
                    !target.startsWith(absolute + sep) ||
                    !samePath(await realpath(target), target)
                )
                    continue;
                const files = await readdir(target, { withFileTypes: true });
                if (
                    !files.some((f) => f.name === "capture.png") ||
                    !files.some((f) => f.name === "capture.json") ||
                    files.some(
                        (f) =>
                            !f.isFile() ||
                            f.isSymbolicLink() ||
                            !ownedFile.test(f.name),
                    )
                )
                    continue;
                const record = JSON.parse(
                    await readFile(join(target, "capture.json"), "utf8"),
                );
                const captured = Date.parse(record.capturedAt);
                if (
                    record.id !== item.name ||
                    !/^[a-f0-9]{64}$/.test(record.sha256) ||
                    !Number.isFinite(captured) ||
                    captured >= now - days * day
                )
                    continue;
                // Recheck the current busy state and resolved path immediately before moving.
                if (
                    protectedArchive(item.name) ||
                    !samePath(await realpath(target), target)
                )
                    continue;
                await trash(target);
                removed.push(item.name);
            } catch {
                failed++;
            }
        }
    }
    return { removed, failed };
}

type Options = {
    config: () => { archiveRoot: string; archiveRetentionDays: number };
    busy: () => boolean;
    trash: (path: string) => Promise<void>;
    removed: (ids: string[]) => void;
    changed: () => void;
};
export class ArchiveRetention {
    private timer?: NodeJS.Timeout;
    private running = false;
    private rerun = false;
    private lastRun = 0;
    private message = "";
    constructor(private options: Options) {}
    public() {
        return this.message;
    }
    start() {
        this.timer = setInterval(() => {
            void this.run();
        }, 60_000);
        this.timer.unref();
        void this.run();
    }
    dispose() {
        clearInterval(this.timer);
    }
    async run(force = false) {
        if (this.running) {
            this.rerun ||= force;
            return;
        }
        if (this.options.busy()) return;
        const config = this.options.config();
        if (config.archiveRetentionDays === 0) {
            if (this.message !== "自动清理已关闭，存档永久保留。") {
                this.message = "自动清理已关闭，存档永久保留。";
                this.options.changed();
            }
            return;
        }
        if (!force && this.lastRun && Date.now() - this.lastRun < interval)
            return;
        this.running = true;
        try {
            const result = await pruneArchives(
                config.archiveRoot,
                config.archiveRetentionDays,
                this.options.trash,
                () =>
                    this.options.busy() ||
                    JSON.stringify(this.options.config()) !==
                        JSON.stringify(config),
            );
            this.options.removed(result.removed);
            this.lastRun =
                this.options.busy() ||
                JSON.stringify(this.options.config()) !== JSON.stringify(config)
                    ? 0
                    : Date.now();
            this.message = result.failed
                ? `已清理 ${result.removed.length} 份过期存档；${result.failed} 份未能处理，下次重试。`
                : `已检查存档，${result.removed.length} 份过期存档已移至回收站。`;
        } catch {
            this.message = "暂时无法检查存档目录，稍后自动重试。";
        } finally {
            this.running = false;
            this.options.changed();
            if (this.rerun) {
                this.rerun = false;
                void this.run(true);
            }
        }
    }
}
