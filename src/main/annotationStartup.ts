import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StartupState } from "../../lib/annotation";

export function quoteStartupArgument(value: string) {
    if (/[\0\r\n]/.test(value)) throw new Error("Invalid startup argument");
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export function startupArguments(dataRoot: string, archiveRoot: string) {
    return [
        "--background",
        "--userData",
        quoteStartupArgument(resolve(dataRoot)),
        "--archiveRoot",
        quoteStartupArgument(resolve(archiveRoot)),
    ].join(" ");
}

type Options = {
    dataRoot: string;
    archiveRoot: () => string;
    executable: string;
    worker: string;
    testName?: string;
    disabled: boolean;
    changed: () => void;
};

export class AnnotationStartup {
    readonly state: StartupState;
    private pending: Promise<StartupState> | null = null;
    constructor(private options: Options) {
        this.state = {
            supported: !options.disabled,
            enabled: false,
            busy: false,
            method: "unavailable",
            message: "",
        };
    }
    ensure() {
        return this.apply();
    }
    setEnabled(enabled: boolean) {
        if (typeof enabled !== "boolean")
            return Promise.reject(new Error("Invalid startup setting"));
        return this.apply(enabled);
    }
    private apply(enabled?: boolean): Promise<StartupState> {
        if (!this.state.supported) return Promise.resolve({ ...this.state });
        if (this.pending) return this.pending.then(() => this.apply(enabled));
        this.pending = this.run(enabled).finally(() => {
            this.pending = null;
        });
        return this.pending;
    }
    private async run(enabled?: boolean): Promise<StartupState> {
        const root = join(this.options.dataRoot, "Startup");
        const request = join(root, `request-${randomUUID()}.json`);
        this.state.busy = true;
        this.options.changed();
        try {
            const saved = JSON.parse(
                await readFile(join(root, "state.json"), "utf8"),
            );
            if (typeof saved.enabled === "boolean")
                this.state.enabled = saved.enabled;
            if (saved.method === "task" || saved.method === "run")
                this.state.method = saved.method;
        } catch {}
        try {
            await mkdir(root, { recursive: true });
            await writeFile(
                request,
                JSON.stringify({
                    executable: resolve(this.options.executable),
                    dataRoot: resolve(this.options.dataRoot),
                    name: this.options.testName,
                    arguments:
                        startupArguments(
                            this.options.dataRoot,
                            this.options.archiveRoot(),
                        ) +
                        (this.options.testName
                            ? ` --testMode --startupTestName ${this.options.testName}`
                            : ""),
                    enabled,
                }),
                "utf8",
            );
            const powershell = join(
                process.env.SystemRoot || "C:\\Windows",
                "System32/WindowsPowerShell/v1.0/powershell.exe",
            );
            const stdout = await new Promise<string>((accept, reject) =>
                execFile(
                    powershell,
                    [
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                        this.options.worker,
                        "-RequestPath",
                        request,
                    ],
                    { windowsHide: true, timeout: 60000, encoding: "utf8" },
                    (error, output) => (error ? reject(error) : accept(output)),
                ),
            );
            const result = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
            if (
                typeof result.enabled !== "boolean" ||
                !["task", "run"].includes(result.method)
            )
                throw new Error("Invalid startup worker response");
            Object.assign(this.state, result, { supported: true });
        } catch (error) {
            this.state.message = `无法设置开机自启动：${String(error)}`;
        } finally {
            await unlink(request).catch(() => {});
            this.state.busy = false;
            this.options.changed();
        }
        return { ...this.state };
    }
}
