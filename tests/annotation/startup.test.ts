import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const execution = vi.hoisted(() => ({
    failure: false,
    requests: [] as Record<string, unknown>[],
}));
vi.mock("node:child_process", () => ({
    execFile: (
        _file: string,
        args: string[],
        options: { windowsHide: boolean },
        callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
        expect(options.windowsHide).toBe(true);
        const file = args[args.indexOf("-RequestPath") + 1];
        const request = JSON.parse(readFileSync(file, "utf8"));
        execution.requests.push(request);
        if (execution.failure) callback(new Error("worker blocked"), "", "");
        else
            callback(
                null,
                JSON.stringify({
                    enabled: request.enabled ?? true,
                    method: "task",
                    message: "",
                }),
                "",
            );
    },
}));

import {
    AnnotationStartup,
    quoteStartupArgument,
    startupArguments,
} from "../../src/main/annotationStartup";

const fixtures: string[] = [];
function startup(disabled = false) {
    const root = "D:/Quarantine/AnnotationCapture/startup-unit";
    mkdirSync(root, { recursive: true });
    const dataRoot = mkdtempSync(join(root, "case-"));
    fixtures.push(dataRoot);
    return new AnnotationStartup({
        dataRoot,
        executable: "D:/Programs/AnnotationCapture.exe",
        worker: "D:/Programs/startup-worker.ps1",
        archiveRoot: () => join(dataRoot, "归档 & 数学"),
        disabled,
        changed: () => {},
    });
}
afterEach(() => {
    execution.failure = false;
    execution.requests.length = 0;
    for (const root of fixtures.splice(0)) rmSync(root, { recursive: true });
});

describe("Windows login startup", () => {
    it("quotes spaces, Unicode and shell characters without shell evaluation", () => {
        expect(quoteStartupArgument("D:\\学习 & 公式\\")).toBe(
            '"D:\\学习 & 公式\\\\"',
        );
        expect(quoteStartupArgument('x\\"y')).toBe('"x\\\\\\"y"');
        for (const value of ["a\nnext", "a\0next", "a\rnext"])
            expect(() => quoteStartupArgument(value)).toThrow();
        const args = startupArguments("D:/User's 数据", "D:/公式 & 归档");
        expect(args).toContain('--userData "D:\\User\'s 数据"');
        expect(args).toContain('--archiveRoot "D:\\公式 & 归档"');
    });
    it("does not register startup in development, test mode or other platforms", async () => {
        expect((await startup(true).ensure()).supported).toBe(false);
        expect(execution.requests).toHaveLength(0);
    });
    it("serializes requests and preserves an explicit opt-out", async () => {
        const service = startup();
        await Promise.all([service.ensure(), service.setEnabled(false)]);
        expect(execution.requests).toHaveLength(2);
        expect(execution.requests[0].enabled).toBeUndefined();
        expect(execution.requests[1].enabled).toBe(false);
        expect(service.state.enabled).toBe(false);
        expect(service.state.busy).toBe(false);
    });
    it("keeps the running application usable when the worker is blocked", async () => {
        const service = startup();
        await service.ensure();
        execution.failure = true;
        const state = await service.setEnabled(false);
        expect(state.enabled).toBe(true);
        expect(state.message).toContain("worker blocked");
        expect(state.busy).toBe(false);
    });
});
