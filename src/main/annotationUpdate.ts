import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    statfsSync,
    writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { app, net } from "electron";
import type { UpdateState } from "../../lib/annotation";

export const releaseRepository = "Rowan-memoedu/AnnotationCapture";
export const updateInterval = 24 * 60 * 60 * 1000;
export function updaterHandoff(
    powershell: string,
    worker: string,
    request: string,
) {
    for (const value of [powershell, worker, request])
        if (/["\0\r\n]/.test(value))
            throw new Error("更新路径包含不支持的命令字符，未修改软件");
    if (/[%&|<>^]/.test(powershell))
        throw new Error("系统 PowerShell 路径无效");
    const script = `& '${worker.replaceAll("'", "''")}' -Mode Apply -RequestPath '${request.replaceAll("'", "''")}'`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return `start "" /b "${powershell}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}
export function newerVersion(next: string, current: string) {
    const parse = (v: string) =>
        /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null;
    const a = parse(next),
        b = parse(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
}
type Release = {
    tag_name: string;
    draft: boolean;
    assets: {
        name: string;
        browser_download_url: string;
        digest?: string;
        size: number;
    }[];
};
export function selectRelease(releases: Release[], current: string) {
    return (
        releases
            .filter(
                (r) =>
                    !r.draft &&
                    newerVersion(r.tag_name.replace(/^v/, ""), current),
            )
            .sort((a, b) =>
                newerVersion(a.tag_name.slice(1), b.tag_name.slice(1)) ? -1 : 1,
            )
            .map((r) => {
                const version = r.tag_name.replace(/^v/, "");
                const name = `AnnotationCapture-${version}-windows-x64.zip`;
                const asset = r.assets.find((a) => a.name === name);
                const url = `https://github.com/${releaseRepository}/releases/download/v${version}/${name}`;
                return asset &&
                    asset.browser_download_url === url &&
                    /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") &&
                    asset.size > 0 &&
                    asset.size < 1024 ** 3
                    ? {
                          version,
                          url,
                          sha256: asset.digest!.slice(7),
                          size: asset.size,
                      }
                    : null;
            })
            .find((r) => r !== null) ?? null
    );
}
export function updateDue(last: string | undefined, now = Date.now()) {
    const time = Date.parse(last ?? "");
    return !Number.isFinite(time) || now < time || now - time >= updateInterval;
}
type Preferences = {
    enabled: boolean;
    lastCheckedAt?: string;
    pending?: string;
};
type Options = {
    dataRoot: string;
    archiveRoot: () => string;
    worker: string;
    busy: (manual?: boolean) => boolean;
    changed: () => void;
    quit: () => void;
    testFeed?: string;
    disabled?: boolean;
};
export class AnnotationUpdater {
    private prefs: Preferences = { enabled: true };
    private root: string;
    private file: string;
    private checking = false;
    private timer?: NodeJS.Timeout;
    private first?: NodeJS.Timeout;
    readonly state: UpdateState = {
        enabled: true,
        phase: "idle",
        message: "每天自动检查并安装更新，批注或识别中延后。",
    };
    constructor(private options: Options) {
        this.root = join(options.dataRoot, "Updates");
        this.file = join(this.root, "preferences.json");
        if (existsSync(this.file)) {
            try {
                this.prefs = {
                    ...this.prefs,
                    ...JSON.parse(readFileSync(this.file, "utf8")),
                };
            } catch {}
        }
        this.state.enabled = this.prefs.enabled;
        this.state.lastCheckedAt = this.prefs.lastCheckedAt;
        if (
            this.prefs.pending?.startsWith(resolve(this.root) + sep) &&
            existsSync(this.prefs.pending)
        ) {
            try {
                const request = JSON.parse(
                    readFileSync(this.prefs.pending, "utf8"),
                );
                const receipt = join(
                    dirname(this.prefs.pending),
                    "receipt.json",
                );
                if (existsSync(receipt)) {
                    const result = JSON.parse(readFileSync(receipt, "utf8"));
                    this.state.message =
                        result.status === "installed"
                            ? `已自动更新到 ${result.version}`
                            : "上次更新失败，已恢复旧版；可重新检查。";
                    delete this.prefs.pending;
                } else if (newerVersion(request.version, app.getVersion())) {
                    this.state.phase = "ready";
                    this.state.version = request.version;
                    this.state.message = "新版已下载，空闲时自动安装。";
                } else delete this.prefs.pending;
            } catch {
                delete this.prefs.pending;
            }
        }
    }
    get installing() {
        return this.state.phase === "installing";
    }
    public() {
        return { ...this.state };
    }
    private save() {
        mkdirSync(this.root, { recursive: true });
        writeFileSync(`${this.file}.tmp`, JSON.stringify(this.prefs, null, 2));
        renameSync(`${this.file}.tmp`, this.file);
    }
    private publish(phase: UpdateState["phase"], message: string) {
        this.state.phase = phase;
        this.state.message = message;
        this.options.changed();
    }
    setEnabled(enabled: boolean) {
        if (typeof enabled !== "boolean") throw new Error("自动更新设置无效");
        this.prefs.enabled = enabled;
        this.state.enabled = enabled;
        this.save();
        this.options.changed();
        return this.public();
    }
    start() {
        if (
            this.options.disabled ||
            !app.isPackaged ||
            process.platform !== "win32"
        )
            return;
        const tick = () => {
            if (!this.prefs.enabled || this.installing) return;
            if (this.state.phase === "ready") {
                if (!this.options.busy()) void this.install();
            } else if (updateDue(this.prefs.lastCheckedAt)) void this.check();
        };
        this.first = setTimeout(tick, 30000);
        this.timer = setInterval(tick, 30000);
    }
    dispose() {
        clearTimeout(this.first);
        clearInterval(this.timer);
    }
    async check() {
        if (this.checking || this.installing || this.state.phase === "ready")
            return this.public();
        this.checking = true;
        this.prefs.lastCheckedAt = new Date().toISOString();
        this.state.lastCheckedAt = this.prefs.lastCheckedAt;
        this.save();
        this.publish("checking", "正在检查发布页…");
        try {
            const response = await net.fetch(
                this.options.testFeed ??
                    `https://api.github.com/repos/${releaseRepository}/releases?per_page=20`,
                {
                    headers: {
                        Accept: "application/vnd.github+json",
                        "User-Agent": "AnnotationCapture",
                    },
                    credentials: "omit",
                    signal: AbortSignal.timeout(30000),
                },
            );
            if (!response.ok) throw new Error(`发布页响应 ${response.status}`);
            const text = await response.text();
            if (text.length > 2 * 1024 * 1024)
                throw new Error("发布页数据过大");
            const releases = JSON.parse(text);
            if (!Array.isArray(releases)) throw new Error("发布页数据无效");
            const release = selectRelease(releases, app.getVersion());
            if (!release) {
                if (
                    releases.some(
                        (r: Release) =>
                            !r.draft &&
                            newerVersion(
                                r.tag_name.replace(/^v/, ""),
                                app.getVersion(),
                            ),
                    )
                )
                    throw new Error(
                        "新版缺少可验证的 Windows 安装包，现有软件保留",
                    );
                this.publish("current", "当前已是最新版本。");
                return this.public();
            }
            this.state.version = release.version;
            this.publish("downloading", `正在下载 ${release.version}…`);
            const disk = statfsSync(this.options.dataRoot);
            if (disk.bavail * disk.bsize < 2 * 1024 ** 3)
                throw new Error("自动更新需要至少 2 GB 可用空间");
            const transaction = join(this.root, randomUUID());
            mkdirSync(transaction, { recursive: true });
            const zip = join(transaction, "update.zip");
            // Only the isolated test process can substitute a local download source.
            const url = this.options.testFeed
                ? new URL("/package.zip", this.options.testFeed).href
                : release.url;
            const download = await net.fetch(url, {
                credentials: "omit",
                signal: AbortSignal.timeout(10 * 60 * 1000),
            });
            if (!download.ok || !download.body)
                throw new Error(`下载失败 ${download.status}`);
            const file = await open(zip, "wx"),
                hash = createHash("sha256"),
                reader = download.body.getReader();
            let size = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.length;
                    if (size > release.size) throw new Error("安装包大小不符");
                    hash.update(value);
                    await file.write(value);
                }
            } finally {
                await file.close();
                reader.releaseLock();
            }
            if (size !== release.size || hash.digest("hex") !== release.sha256)
                throw new Error("安装包校验失败，未修改现有软件");
            const requestPath = join(transaction, "request.json");
            writeFileSync(
                requestPath,
                JSON.stringify(
                    {
                        version: release.version,
                        currentVersion: app.getVersion(),
                        appRoot: dirname(app.getPath("exe")),
                        dataRoot: this.options.dataRoot,
                        archiveRoot: this.options.archiveRoot(),
                        zip,
                        sha256: release.sha256,
                        parentPid: process.pid,
                        testMode: !!this.options.testFeed,
                        transaction,
                    },
                    null,
                    2,
                ),
            );
            await promisify(execFile)(
                this.powershell(),
                [
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    this.options.worker,
                    "-Mode",
                    "Prepare",
                    "-RequestPath",
                    requestPath,
                ],
                { windowsHide: true, timeout: 180000 },
            );
            this.prefs.pending = requestPath;
            this.save();
            this.publish(
                "ready",
                "新版已下载，批注或识别结束且设置页不在前台时自动安装。",
            );
        } catch (error) {
            this.publish(
                "error",
                `更新未完成：${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            this.checking = false;
        }
        return this.public();
    }
    private powershell() {
        return join(
            process.env.SystemRoot || "C:\\Windows",
            "System32/WindowsPowerShell/v1.0/powershell.exe",
        );
    }
    async install(manual = false) {
        if (
            this.installing ||
            this.state.phase !== "ready" ||
            !this.prefs.pending
        )
            return this.public();
        if (this.options.busy(manual)) {
            this.publish("ready", "批注或识别进行中，结束后再安装更新。");
            return this.public();
        }
        this.publish("installing", "正在安装更新，软件将自动重新启动…");
        try {
            const requestPath = this.prefs.pending;
            const request = JSON.parse(readFileSync(requestPath, "utf8"));
            request.parentPid = process.pid;
            writeFileSync(requestPath, JSON.stringify(request, null, 2));
            const ready = join(dirname(requestPath), "worker-ready.json");
            rmSync(ready, { force: true });
            const output = openSync(
                join(dirname(requestPath), "worker.log"),
                "a",
            );
            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(
                    join(
                        process.env.SystemRoot || "C:\\Windows",
                        "System32/cmd.exe",
                    ),
                    [
                        "/d",
                        "/s",
                        "/v:off",
                        "/c",
                        updaterHandoff(
                            this.powershell(),
                            this.options.worker,
                            requestPath,
                        ),
                    ],
                    {
                        detached: false,
                        windowsHide: true,
                        windowsVerbatimArguments: true,
                        stdio: ["ignore", output, output],
                    },
                );
            } finally {
                closeSync(output);
            }
            let failed = false;
            child.once("error", () => {
                failed = true;
            });
            child.once("exit", (code) => {
                if (code !== 0) failed = true;
            });
            child.unref();
            const deadline = Date.now() + 30000;
            while (!existsSync(ready)) {
                if (failed || Date.now() > deadline)
                    throw new Error("更新安装器未能启动，现有软件保留");
                await new Promise((r) => setTimeout(r, 100));
            }
            this.dispose();
            this.options.quit();
        } catch (error) {
            this.publish(
                "error",
                `更新未安装：${error instanceof Error ? error.message : String(error)}`,
            );
        }
        return this.public();
    }
}
export function acknowledgeUpdate(requestPath: unknown, dataRoot: string) {
    if (
        typeof requestPath !== "string" ||
        !resolve(requestPath).startsWith(resolve(dataRoot, "Updates") + sep)
    )
        return;
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    if (
        request.version !== app.getVersion() ||
        resolve(request.appRoot) !== dirname(app.getPath("exe"))
    )
        return;
    writeFileSync(
        join(dirname(requestPath), "healthy.json"),
        JSON.stringify({ version: app.getVersion(), pid: process.pid }),
    );
}
