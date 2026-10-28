import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { type CaptureInput, selectedRect } from "../../lib/annotation";
import { ArchiveStore } from "../../src/main/annotationArchive";
import { type ClipboardPort, FormulaJobs } from "../../src/main/formulaJobs";
import {
    deepSeekProvider,
    type FormulaProvider,
    normalizeLatex,
    normalizeOutput,
} from "../../src/main/formulaProvider";

describe("OCR output formats", () => {
    it("formats automatic detection without changing the transcription", () => {
        expect(normalizeOutput("x^2+1", "auto", "formula")).toBe("$x^2+1$");
        expect(normalizeOutput("Hello", "auto", "text")).toBe("Hello");
        expect(normalizeOutput("# Heading\n- Item", "auto", "markdown")).toBe(
            "# Heading\n- Item",
        );
        expect(() => normalizeOutput("x", "auto")).toThrow();
    });
    it("wraps display math exactly once without changing symbols", () => {
        expect(normalizeOutput("$$\n\\frac{X+x}{2}\n$$", "markdown")).toBe(
            "$$\n\\frac{X+x}{2}\n$$",
        );
        expect(normalizeOutput("x^2+1", "latex")).toBe("x^2+1");
    });
    it("keeps Mermaid labels and arrow direction in one code block", () => {
        const code = 'flowchart LR\n  a["A"] --> b["B"]';
        expect(
            normalizeOutput(`\`\`\`mermaid\n${code}\n\`\`\``, "mermaid"),
        ).toBe(`\`\`\`mermaid\n${code}\n\`\`\``);
        expect(() => normalizeOutput("UNREADABLE", "mermaid")).toThrow();
        expect(() =>
            normalizeOutput("Here is your diagram", "mermaid"),
        ).toThrow();
    });
});

function png(width = 4, height = 4) {
    function chunk(type: string, data: Buffer) {
        const body = Buffer.concat([Buffer.from(type), data]);
        let crc = 0xffffffff;
        for (const b of body) {
            crc ^= b;
            for (let k = 0; k < 8; k++)
                crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
        const header = Buffer.alloc(4);
        header.writeUInt32BE(data.length);
        const tail = Buffer.alloc(4);
        tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([header, body, tail]);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const data = Buffer.alloc((width * 4 + 1) * height, 255);
    for (let i = 0; i < height; i++) data[i * (width * 4 + 1)] = 0;
    return `data:image/png;base64,${Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(data)), chunk("IEND", Buffer.alloc(0))]).toString("base64")}`;
}
async function fixture() {
    const root = await mkdtemp(
        join(
            process.env.TEMP || "D:/Caches/AnnotationCapture/tmp",
            "archive-test-",
        ),
    );
    const archive = new ArchiveStore(() => root);
    const input: CaptureInput = {
        id: randomUUID(),
        png: png(),
        capturedAt: "2026-10-27T09:20:00+08:00",
        rect: { x: 10, y: 20, width: 4, height: 4 },
        screenId: 7,
    };
    return { root, archive, input };
}

describe("archive correctness", () => {
    it("stores recoverable formula sources in the same atomic archive", async () => {
        const { archive, input } = await fixture();
        const annotations = {
            version: 1,
            canvas: {
                objects: [
                    {
                        acFormula: {
                            latex: "X+x",
                            font: "stix2",
                            source: [
                                {
                                    type: "Path",
                                    path: [
                                        ["M", 1, 2],
                                        ["L", 4, 5],
                                    ],
                                },
                            ],
                        },
                    },
                ],
            },
        };
        const record = await archive.save({ ...input, annotations });
        expect(
            JSON.parse(
                await readFile(
                    join(record.path, "..", "annotations.json"),
                    "utf8",
                ),
            ),
        ).toEqual(annotations);
        expect(() =>
            archive.save({
                ...input,
                id: randomUUID(),
                annotations: { large: "x".repeat(20_000_001) },
            }),
        ).toThrow("批注源数据过大");
    });
    it("commits annotated PNG and metadata atomically and deduplicates repeated finish", async () => {
        const { root, archive, input } = await fixture();
        const records = await Promise.all([
            archive.save(input),
            archive.save(input),
        ]);
        expect(records[0]).toEqual(records[1]);
        expect((await readFile(records[0].path)).toString("base64")).toBe(
            input.png.slice(22),
        );
        expect(await readdir(join(root, "2026-10-27"))).toEqual([input.id]);
        const meta = JSON.parse(
            await readFile(records[0].path.replace(".png", ".json"), "utf8"),
        );
        expect(meta.rect).toEqual(input.rect);
        expect(meta.sha256).toHaveLength(64);
    });
    it("retains full capture when adding a separate formula crop", async () => {
        const { archive, input } = await fixture();
        const record = await archive.save(input);
        const before = await readFile(record.path);
        await archive.formula(record.id, randomUUID(), png(2, 2));
        expect(await readFile(record.path)).toEqual(before);
    });
    it("reports write failures without pretending to save, and permits retry", async () => {
        const { root, input } = await fixture();
        const blocked = join(root, "file");
        await writeFile(blocked, "occupied");
        let destination = blocked;
        const archive = new ArchiveStore(() => destination);
        await expect(archive.save(input)).rejects.toThrow();
        expect(archive.records.size).toBe(0);
        destination = root;
        expect((await archive.save(input)).id).toBe(input.id);
    });
    it("rejects invalid IDs, PNGs and mismatching dimensions", async () => {
        const { archive, input } = await fixture();
        expect(() => archive.save({ ...input, id: "../../escape" })).toThrow();
        expect(() =>
            archive.save({ ...input, png: "data:image/png;base64,eA==" }),
        ).toThrow();
        expect(() =>
            archive.save({ ...input, rect: { ...input.rect, width: 10 } }),
        ).toThrow();
    });
});

describe("formula task boundaries", () => {
    async function setup(provider: FormulaProvider | null) {
        const { archive, input } = await fixture();
        await archive.save(input);
        let revision = "0";
        const writes: string[] = [];
        const clipboard: ClipboardPort = {
            revision: async () => revision,
            writeText: async (text) => {
                writes.push(text);
                revision += "x";
            },
        };
        const jobs = new FormulaJobs(
            archive,
            () => provider,
            clipboard,
            () => {},
        );
        const create = () =>
            jobs.create(input.id, png(2, 2), {
                x: 1,
                y: 1,
                width: 2,
                height: 2,
            });
        return {
            jobs,
            create,
            writes,
            changeClipboard: () => {
                revision = "changed";
            },
        };
    }
    it("leaves clipboard untouched with no provider", async () => {
        const { jobs, create, writes } = await setup(null);
        const job = await create();
        await jobs.run(job.id);
        expect(job.status).toBe("unconfigured");
        expect(writes).toEqual([]);
        expect(
            JSON.parse(
                await readFile(job.path.replace(".png", ".json"), "utf8"),
            ).status,
        ).toBe("unconfigured");
    });
    it("copies a successful result once despite repeated triggers", async () => {
        const provider = {
            recognize: vi.fn(async () => ({ latex: "x^2+1=0", model: "test" })),
        };
        const { jobs, create, writes } = await setup(provider);
        const job = await create();
        await Promise.all([jobs.run(job.id), jobs.run(job.id)]);
        expect(provider.recognize).toHaveBeenCalledTimes(1);
        expect(writes).toEqual(["x^2+1=0"]);
        expect(job.status).toBe("copied");
    });
    it("does not overwrite a clipboard changed while recognition is running", async () => {
        let resolve!: (value: { latex: string; model: string }) => void;
        const task = new Promise<{ latex: string; model: string }>((r) => {
            resolve = r;
        });
        const { jobs, create, writes, changeClipboard } = await setup({
            recognize: () => task,
        });
        const job = await create();
        const running = jobs.run(job.id);
        await vi.waitFor(() => expect(job.status).toBe("recognizing"));
        await new Promise((r) => setTimeout(r, 20));
        changeClipboard();
        resolve({ latex: "x", model: "test" });
        await running;
        expect(job.status).toBe("review");
        expect(writes).toEqual([]);
    });
    it("retains archive and clipboard on provider failure", async () => {
        const { jobs, create, writes } = await setup({
            recognize: async () => {
                throw new Error("HTTP 503");
            },
        });
        const job = await create();
        await jobs.run(job.id);
        expect(job.status).toBe("error");
        expect(await readFile(job.path)).toBeTruthy();
        expect(writes).toEqual([]);
    });
    it("rejects formula rectangles outside the archived capture", async () => {
        const { jobs } = await setup(null);
        await expect(
            jobs.create("absent", png(), { x: -1, y: 0, width: 4, height: 4 }),
        ).rejects.toThrow();
    });
});

describe("provider and pixel mapping", () => {
    it("normalizes presentation wrappers without simplifying mathematics", () => {
        expect(normalizeLatex("```latex\n\\frac{a+b}{c}\n```")).toBe(
            "\\frac{a+b}{c}",
        );
        expect(normalizeLatex("$$x^{2}+1=0$$")).toBe("x^{2}+1=0");
        expect(() => normalizeLatex("UNREADABLE")).toThrow();
    });
    it("sends only the formula image to the vision model", async () => {
        const request = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        model: "deepseek-flash",
                        choices: [
                            {
                                finish_reason: "stop",
                                message: {
                                    content: "X^{2}+x=0",
                                    reasoning_content:
                                        "This must not enter the clipboard.",
                                },
                            },
                        ],
                    }),
                ),
        ) as unknown as typeof fetch;
        const provider = deepSeekProvider(
            "test-key",
            "deepseek-flash",
            request,
        );
        expect(
            (await provider.recognize(png(), new AbortController().signal))
                .latex,
        ).toBe("X^{2}+x=0");
        const body = JSON.parse(
            vi.mocked(request).mock.calls[0][1]?.body as string,
        );
        expect(body.messages[1].content[1].image_url.url).toBe(png());
        expect(body.model).toBe("deepseek-flash");
    });
    it("does not return partial or error responses as successful OCR", async () => {
        const request = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        choices: [
                            {
                                finish_reason: "length",
                                message: { content: "x+" },
                            },
                        ],
                    }),
                ),
        ) as unknown as typeof fetch;
        await expect(
            deepSeekProvider("key", "model", request).recognize(
                png(),
                new AbortController().signal,
            ),
        ).rejects.toThrow("完整");
    });
    it("maps reversed, fractional and clipped coordinates to pixel bounds", () => {
        expect(
            selectedRect({ x: 30.4, y: 24.2 }, { x: 5.5, y: 2.2 }, 100, 100),
        ).toEqual({ x: 5, y: 2, width: 26, height: 23 });
        expect(
            selectedRect({ x: -2, y: -10 }, { x: 150, y: 50 }, 100, 60),
        ).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    });
});
