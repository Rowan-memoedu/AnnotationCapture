import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, net: {} }));

import {
    newerVersion,
    selectRelease,
    updateDue,
    updateInterval,
    updaterHandoff,
} from "../../src/main/annotationUpdate";

describe("portable update release policy", () => {
    it("encodes Unicode, spaces and shell characters as literal paths", () => {
        const command = updaterHandoff(
            "C:\\Windows\\powershell.exe",
            "D:\\软件 & 文件\\worker.ps1",
            "D:\\数'据%\\request.json",
        );
        const script = Buffer.from(
            command.split("-EncodedCommand ")[1],
            "base64",
        ).toString("utf16le");
        expect(script).toContain("'D:\\软件 & 文件\\worker.ps1'");
        expect(script).toContain("'D:\\数''据%\\request.json'");
        expect(command).not.toContain("& 文件");
        for (const part of ['x" y', "x\nnext", "x\0next"])
            expect(() => updaterHandoff("ps", part, "request")).toThrow();
    });
    it("checks at most once daily and catches up after clock changes", () => {
        const now = Date.now();
        expect(updateDue(undefined, now)).toBe(true);
        expect(updateDue(new Date(now - 1000).toISOString(), now)).toBe(false);
        expect(
            updateDue(new Date(now - updateInterval).toISOString(), now),
        ).toBe(true);
        expect(updateDue(new Date(now + 1000).toISOString(), now)).toBe(true);
    });
    it("does not downgrade or accept malformed versions", () => {
        expect(newerVersion("0.4.10", "0.4.9")).toBe(true);
        for (const version of [
            "0.4.1",
            "0.3.9",
            "../1.0.0",
            "1.0",
            "1.0.0-beta",
        ])
            expect(newerVersion(version, "0.4.1")).toBe(false);
    });
    it("requires a published matching asset, fixed repository and SHA256", () => {
        const release = (v: string) => ({
            tag_name: `v${v}`,
            draft: false,
            assets: [
                {
                    name: `AnnotationCapture-${v}-windows-x64.zip`,
                    browser_download_url: `https://github.com/Rowan-memoedu/AnnotationCapture/releases/download/v${v}/AnnotationCapture-${v}-windows-x64.zip`,
                    digest: `sha256:${"a".repeat(64)}`,
                    size: 123,
                },
            ],
        });
        expect(
            selectRelease([release("0.4.3"), release("0.4.2")], "0.4.1")
                ?.version,
        ).toBe("0.4.3");
        const r = release("0.4.4");
        r.assets[0].browser_download_url = "https://evil.example/app.zip";
        expect(selectRelease([r], "0.4.1")).toBe(null);
        r.assets[0].browser_download_url =
            release("0.4.4").assets[0].browser_download_url;
        r.assets[0].digest = "";
        expect(selectRelease([r], "0.4.1")).toBe(null);
        expect(
            selectRelease([{ ...release("0.4.4"), draft: true }], "0.4.1"),
        ).toBe(null);
    });
});
