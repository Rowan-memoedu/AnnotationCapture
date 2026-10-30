import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ArchiveRetention,
    pruneArchives,
} from "../../src/main/annotationRetention";

const now = Date.parse("2026-10-30T08:00:00Z");
const day = 86400000;
async function fixture() {
    const base = await mkdtemp("D:/Caches/AnnotationCapture/tmp/retention-");
    const root = join(base, "Archive"),
        bin = join(base, "Recycle");
    await mkdir(root);
    await mkdir(bin);
    const trash = vi.fn(async (target: string) =>
        rename(target, join(bin, target.split(/[\\/]/).at(-1)!)),
    );
    async function entry(age: number) {
        const id = randomUUID(),
            target = join(root, "2026-10-01", id);
        await mkdir(target, { recursive: true });
        await writeFile(join(target, "capture.png"), "image-fixture");
        await writeFile(
            join(target, "capture.json"),
            JSON.stringify({
                id,
                capturedAt: new Date(now - age).toISOString(),
                sha256: "a".repeat(64),
            }),
        );
        return { id, target };
    }
    return { root, bin, trash, entry, base };
}
afterEach(() => vi.restoreAllMocks());
describe("archive retention", () => {
    it("moves only archives older than seven days; keeps the boundary, recent and future data", async () => {
        const f = await fixture();
        const old = await f.entry(7 * day + 1);
        const keep = await Promise.all([
            f.entry(7 * day),
            f.entry(2 * day),
            f.entry(-day),
        ]);
        const result = await pruneArchives(f.root, 7, f.trash, undefined, now);
        expect(result).toEqual({ removed: [old.id], failed: 0 });
        expect(existsSync(join(f.bin, old.id, "capture.png"))).toBe(true);
        expect(keep.every((e) => existsSync(e.target))).toBe(true);
    });
    it("supports custom days and never cleans when disabled or invalid", async () => {
        const f = await fixture();
        const old = await f.entry(10 * day);
        for (const days of [0, -1, 1.5, 3651, Number.NaN, 14]) {
            expect(
                (await pruneArchives(f.root, days, f.trash, undefined, now))
                    .removed,
            ).toEqual([]);
        }
        expect(f.trash).not.toHaveBeenCalled();
        expect(
            (await pruneArchives(f.root, 3, f.trash, undefined, now)).removed,
        ).toEqual([old.id]);
    });
    it("preserves unknown files, corrupt metadata and incomplete transactions", async () => {
        const f = await fixture();
        const unknown = await f.entry(20 * day),
            corrupt = await f.entry(20 * day);
        await writeFile(join(unknown.target, "personal-note.txt"), "keep");
        await writeFile(join(corrupt.target, "capture.json"), "invalid");
        await mkdir(
            join(f.root, "2026-10-01", `${randomUUID()}.pending-fixture`),
        );
        const result = await pruneArchives(f.root, 7, f.trash, undefined, now);
        expect(result.removed).toEqual([]);
        expect(result.failed).toBe(1);
        expect(f.trash).not.toHaveBeenCalled();
    });
    it("does not traverse linked roots, day folders or archive entries", async () => {
        const f = await fixture();
        const old = await f.entry(20 * day);
        const linkedRoot = join(f.base, "linked");
        await symlink(f.root, linkedRoot, "junction");
        expect(
            (await pruneArchives(linkedRoot, 7, f.trash, undefined, now))
                .removed,
        ).toEqual([]);
        await symlink(
            join(f.root, "2026-10-01"),
            join(f.root, "2026-10-02"),
            "junction",
        );
        await symlink(
            old.target,
            join(f.root, "2026-10-01", randomUUID()),
            "junction",
        );
        await pruneArchives(f.root, 7, f.trash, () => true, now);
        expect(f.trash).not.toHaveBeenCalled();
        expect(existsSync(old.target)).toBe(true);
    });
    it("rechecks active work immediately before moving a directory", async () => {
        const f = await fixture();
        await f.entry(20 * day);
        let checks = 0;
        const result = await pruneArchives(
            f.root,
            7,
            f.trash,
            () => ++checks > 1,
            now,
        );
        expect(result.removed).toEqual([]);
        expect(f.trash).not.toHaveBeenCalled();
    });
    it("retains the original when the recycle operation fails", async () => {
        const f = await fixture();
        const old = await f.entry(20 * day);
        const result = await pruneArchives(
            f.root,
            7,
            async () => {
                throw new Error("locked");
            },
            undefined,
            now,
        );
        expect(result).toEqual({ removed: [], failed: 1 });
        expect(existsSync(old.target)).toBe(true);
    });
    it("sweeps hourly, defers during capture, and applies changed settings", async () => {
        const f = await fixture();
        let busy = true;
        let days = 7;
        let time = now;
        vi.spyOn(Date, "now").mockImplementation(() => time);
        const removed = vi.fn(),
            changed = vi.fn();
        const retention = new ArchiveRetention({
            config: () => ({ archiveRoot: f.root, archiveRetentionDays: days }),
            busy: () => busy,
            trash: f.trash,
            removed,
            changed,
        });
        await retention.run();
        expect(removed).not.toHaveBeenCalled();
        busy = false;
        await retention.run();
        expect(removed).toHaveBeenCalledTimes(1);
        time += 30 * 60 * 1000;
        await retention.run();
        expect(removed).toHaveBeenCalledTimes(1);
        time += 30 * 60 * 1000;
        await retention.run();
        expect(removed).toHaveBeenCalledTimes(2);
        days = 0;
        await retention.run(true);
        expect(retention.public()).toContain("永久保留");
        days = 14;
        await retention.run(true);
        expect(removed).toHaveBeenCalledTimes(3);
        expect(changed).toHaveBeenCalled();
    });
    it("rechecks settings changed while a recycle operation is pending", async () => {
        const f = await fixture();
        await f.entry(20 * day);
        vi.spyOn(Date, "now").mockReturnValue(now);
        let days = 7;
        let release!: () => void;
        let started!: () => void;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const entered = new Promise<void>((resolve) => {
            started = resolve;
        });
        const retention = new ArchiveRetention({
            config: () => ({ archiveRoot: f.root, archiveRetentionDays: days }),
            busy: () => false,
            trash: async () => {
                started();
                await pending;
            },
            removed: () => {},
            changed: () => {},
        });
        const sweep = retention.run();
        await entered;
        days = 0;
        await retention.run(true);
        release();
        await sweep;
        expect(retention.public()).toContain("永久保留");
    });
});
