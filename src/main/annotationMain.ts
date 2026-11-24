import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
    app,
    BrowserWindow,
    clipboard,
    desktopCapturer,
    dialog,
    globalShortcut,
    ipcMain,
    Menu,
    nativeImage,
    screen,
    shell,
    Tray,
} from "electron";
import minimist from "minimist";
import type { CaptureMode } from "../../lib/annotation";
import { handle } from "../../lib/annotationIpc";
import { mainOn, mainSend } from "../../lib/ipc";
import Store from "../../lib/store/store";
import { ArchiveStore, decodePng } from "./annotationArchive";
import { AnnotationAuth } from "./annotationAuth";
import { AnnotationConfig } from "./annotationConfig";
import { ArchiveRetention } from "./annotationRetention";
import { AnnotationStartup } from "./annotationStartup";
import { AnnotationUpdater, acknowledgeUpdate } from "./annotationUpdate";
import { captureDefaults } from "./captureDefaults";
import { FormulaJobs } from "./formulaJobs";
import { FormulaTypesetter } from "./formulaTypeset";
import { prepareFrameReader } from "./nativeFrames";
import { screenshotSource } from "./screenshotSource";

app.setName("AnnotationCapture");
const args = minimist(process.argv.slice(1));
const runPath = resolve(__dirname, "../..");
const portableRoot =
    process.env.PORTABLE_EXECUTABLE_DIR || dirname(app.getPath("exe"));
const portableDataRoot = join(portableRoot, "AnnotationCapture-data");
const dataRoot =
    args.userData ||
    process.env.ANNOTATION_DATA_DIR ||
    (app.isPackaged ? portableDataRoot : "D:\\AppData\\AnnotationCapture");
mkdirSync(dataRoot, { recursive: true });
app.setPath("userData", dataRoot);
app.setPath("sessionData", join(dataRoot, "browser"));
const store = new Store({ configPath: join(dataRoot, "config.json") });
let config: AnnotationConfig;
let auth: AnnotationAuth;
let archive: ArchiveStore;
let jobs: FormulaJobs;
let updater: AnnotationUpdater;
let retention: ArchiveRetention;
let startup: AnnotationStartup;
let captureWindow: BrowserWindow | null = null;
let panel: BrowserWindow | null = null;
let tray: Tray | null = null;
let activeCapture = false;
let captureStarting = false;
let captureSaving = false;
let captureReady: Promise<void> | null = null;
let captureStartTimer: NodeJS.Timeout | undefined;
let queuedCapture: { imagePath?: string; mode: CaptureMode } | undefined;
const frameReaders = new Map<number, ReturnType<typeof prepareFrameReader>>();
const frameHelper = app.isPackaged
    ? join(process.resourcesPath, "ScreenFrame.exe")
    : join(runPath, "out/native/ScreenFrame.exe");
let whitespaceRequest: AbortController | null = null;
let quitting = false;
let shortcutError = "";
const typesetter = new FormulaTypesetter();
const inkRequests = new Map<string, AbortController>();
function cancelInk() {
    for (const controller of inkRequests.values()) controller.abort();
    inkRequests.clear();
}
const icon = join(runPath, "assets/logo/64x64.png");

function refreshTray() {
    if (!tray) return;
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: "区域截图并批注", click: () => void capture() },
            {
                label: "全屏截图并批注",
                click: () => void capture(undefined, "full"),
            },
            { label: "识别结果与设置", click: showPanel },
            { label: "打开独立白板", click: showWhiteboard },
            {
                label: "区域 OCR（框选后直接识别）",
                click: () => void capture(undefined, "ocr"),
            },
            { type: "separator" },
            ...(startup?.state.supported
                ? [
                      {
                          label: "开机自启动",
                          type: "checkbox" as const,
                          checked: startup.state.enabled,
                          enabled: !startup.state.busy,
                          click: async (item: Electron.MenuItem) => {
                              const state = await startup.setEnabled(
                                  item.checked,
                              );
                              if (state.message)
                                  dialog.showErrorBox(
                                      "开机自启动",
                                      state.message,
                                  );
                          },
                      },
                  ]
                : []),
            { label: "退出", click: quitImmediately },
        ]),
    );
}

function load(win: BrowserWindow, file: string) {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    return win.loadFile(join(__dirname, "../renderer", file));
}
function changed() {
    panel?.webContents.send("annotation:changed");
}
let whiteboardWindow: BrowserWindow | null = null;

function showWhiteboard() {
    if (whiteboardWindow) {
        whiteboardWindow.focus();
        return;
    }
    const window = new BrowserWindow({
        title: "AnnotationCapture · 白板",
        width: 1050,
        height: 850,
        icon,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });
    whiteboardWindow = window;
    window.on("closed", () => {
        whiteboardWindow = null;
    });
    void load(window, "whiteboard.html");
}
function showPanel() {
    if (panel && !panel.isDestroyed()) {
        panel.show();
        panel.focus();
        changed();
        return;
    }
    panel = new BrowserWindow({
        title: "AnnotationCapture",
        width: 760,
        height: 810,
        minWidth: 560,
        icon,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
        },
    });
    panel.on("closed", () => {
        panel = null;
    });
    void load(panel, "annotation.html");
}

function prepareCaptureWindow() {
    if (captureWindow && !captureWindow.isDestroyed() && captureReady)
        return captureReady;
    const win = new BrowserWindow({
        ...screen.getPrimaryDisplay().bounds,
        icon,
        frame: false,
        transparent: true,
        show: false,
        alwaysOnTop: !args.testMode,
        skipTaskbar: !args.testMode,
        fullscreenable: true,
        resizable: false,
        minimizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
            backgroundThrottling: false,
        },
    });
    captureWindow = win;
    win.on("close", (event) => {
        if (activeCapture) {
            event.preventDefault();
            mainSend(win.webContents, "annotation_finish", []);
        }
    });
    win.on("closed", () => {
        clearTimeout(captureStartTimer);
        captureStarting = false;
        cancelInk();
        whitespaceRequest?.abort();
        whitespaceRequest = null;
        captureWindow = null;
        captureReady = null;
        activeCapture = false;
        captureSaving = false;
    });
    win.webContents.on("render-process-gone", () => {
        if (activeCapture || captureStarting)
            failCapture(
                win,
                "批注窗口异常退出",
                "本次尚未完成归档的批注可能丢失；已归档图片仍保留。",
            );
        else win.destroy();
    });
    captureReady = load(win, "capture.html");
    return captureReady;
}
function frameReader(id: number) {
    const existing = frameReaders.get(id);
    if (existing?.available) return existing;
    const reader = prepareFrameReader(frameHelper);
    frameReaders.set(id, reader);
    return reader;
}
function prewarmCapture() {
    if (quitting || (args.testMode && !args.warmCapture)) return;
    if (process.platform === "win32")
        for (const display of screen.getAllDisplays()) frameReader(display.id);
    const ready = prepareCaptureWindow();
    const win = captureWindow;
    void ready.catch(() => {
        if (win === captureWindow && !captureStarting) win?.destroy();
    });
}
function failCapture(win: BrowserWindow, title: string, message: string) {
    if (win !== captureWindow) return;
    queuedCapture = undefined;
    win.destroy();
    showPanel();
    void dialog.showMessageBox({ type: "error", title, message });
}
async function capture(imagePath?: string, mode: CaptureMode = "region") {
    if (updater?.installing || quitting) return;
    if (captureSaving) {
        queuedCapture = { imagePath, mode };
        return;
    }
    if (activeCapture || captureStarting) {
        if (activeCapture) showCaptureWindow();
        return;
    }
    captureStarting = true;
    panel?.hide();
    let win = captureWindow;
    try {
        const ready = prepareCaptureWindow();
        win = captureWindow!;
        const startingWindow = win;
        captureStartTimer = setTimeout(() => {
            failCapture(
                startingWindow,
                "无法开始截图",
                "截图等待超时，请重试。",
            );
        }, 4000);
        const display = screen.getDisplayNearestPoint(
            screen.getCursorScreenPoint(),
        );
        await ready;
        if (win !== captureWindow) return;
        const bounds = win.getBounds();
        if (
            bounds.x !== display.bounds.x ||
            bounds.y !== display.bounds.y ||
            bounds.width !== display.bounds.width ||
            bounds.height !== display.bounds.height
        )
            win.setBounds(display.bounds);
        mainSend(win.webContents, "clip_init", [
            screen.getAllDisplays(),
            imagePath ? readFileSync(imagePath) : undefined,
            display.id,
            undefined,
            mode,
        ]);
    } catch (error) {
        if (win) failCapture(win, "无法开始截图", String(error));
        else {
            captureStarting = false;
            void dialog.showMessageBox({
                type: "error",
                title: "无法开始截图",
                message: String(error),
            });
        }
    }
}

function finishCapture() {
    const next = queuedCapture;
    queuedCapture = undefined;
    activeCapture = false;
    captureWindow?.destroy();
    if (quitting) app.quit();
    else if (next) void capture(next.imagePath, next.mode);
    else setImmediate(prewarmCapture);
}

function quitImmediately() {
    globalShortcut.unregisterAll();
    tray?.destroy();
    app.exit(0);
}

type ShortcutEntry = { key: string; mode: CaptureMode };
let registeredShortcuts: ShortcutEntry[] = [];
function registerEntry(entry: ShortcutEntry) {
    if (!entry.key) return;
    if (
        !globalShortcut.register(entry.key, () => {
            void capture(undefined, entry.mode);
        })
    )
        throw new Error(
            `${entry.mode === "full" ? "全屏批注" : entry.mode === "ocr" ? "区域 OCR" : "区域截图"}快捷键 ${entry.key} 已被占用，请更换组合`,
        );
    registeredShortcuts.push(entry);
}
function setShortcuts(entries: ShortcutEntry[]) {
    for (const entry of registeredShortcuts)
        globalShortcut.unregister(entry.key);
    registeredShortcuts = [];
    for (const entry of entries) registerEntry(entry);
}
function registerShortcuts(next: {
    shortcut: string;
    fullShortcut: string;
    ocrShortcut?: string;
}) {
    if (
        next.shortcut &&
        next.shortcut.toLowerCase() === next.fullShortcut.toLowerCase()
    )
        throw new Error("两种截图入口不能使用相同快捷键");
    const ocrShortcut = next.ocrShortcut ?? config.public().ocrShortcut;
    const keys = [next.shortcut, next.fullShortcut, ocrShortcut]
        .filter(Boolean)
        .map((key) => key.toLowerCase());
    if (new Set(keys).size !== keys.length)
        throw new Error("截图与 OCR 入口不能使用相同快捷键");
    const previous = [...registeredShortcuts];
    try {
        setShortcuts([
            { key: next.shortcut, mode: "region" },
            { key: next.fullShortcut, mode: "full" },
            { key: ocrShortcut, mode: "ocr" },
        ]);
    } catch (error) {
        setShortcuts(previous);
        throw error;
    }
    return () => setShortcuts(previous);
}

async function clipboardRevision(): Promise<string> {
    if (process.platform !== "win32") return await clipboard.readText();
    const result = await promisify(execFile)(
        frameHelper,
        ["--clipboard-sequence"],
        { windowsHide: true, timeout: 2000 },
    );
    const revision = result.stdout.trim();
    if (!/^[1-9]\d*$/.test(revision)) throw new Error("无法读取剪贴板状态");
    return revision;
}

ipcMain.on("store", (event, message) => {
    if (message.type === "get") event.returnValue = store.get(message.path);
    else if (message.type === "getAll") event.returnValue = store.getAll();
    else if (message.type === "path") event.returnValue = store.path();
    else if (message.type === "set") {
        store.set(message.path, message.value);
        event.returnValue = null;
    }
});
mainOn("runPath", () => runPath);
mainOn("userDataPath", () => dataRoot);
mainOn("systemLan", () => "zh-HANS");
function showCaptureWindow() {
    if (captureSaving) return;
    const win = captureWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    if (process.platform === "darwin") win.setSimpleFullScreen(true);
    win.setAlwaysOnTop(!args.testMode, "screen-saver");
    win.focus();
    win.webContents.focus();
}
mainOn("clip_show", (_, event) => {
    if (event.sender !== captureWindow?.webContents) return;
    clearTimeout(captureStartTimer);
    captureStarting = false;
    activeCapture = true;
    showCaptureWindow();
});
mainOn("annotation_capture_failed", ([message], event) => {
    if (captureStarting && event.sender === captureWindow?.webContents)
        failCapture(captureWindow, "无法开始截图", message);
});
mainOn("clip_close", (_, event) => {
    if (event.sender === captureWindow?.webContents) finishCapture();
});
mainOn("clip_hide", () => captureWindow?.hide());
mainOn("windowIgnoreMouse", ([ignore]) =>
    captureWindow?.setIgnoreMouseEvents(ignore),
);
mainOn("getScreens", () => screen.getAllDisplays());
mainOn("dialogMessage", ([options]) => dialog.showMessageBoxSync(options));
mainOn("getMousePos", () => {
    const p = screen.getCursorScreenPoint();
    const b = captureWindow?.getBounds();
    return { ab: p, po: { x: p.x - (b?.x ?? 0), y: p.y - (b?.y ?? 0) } };
});
mainOn("clip_save", async ([ext]) => {
    const r = await dialog.showSaveDialog({
        defaultPath: join(config.public().archiveRoot, `capture.${ext}`),
        filters: [{ name: "Image", extensions: [ext] }],
    });
    captureWindow?.show();
    return r.filePath || "";
});
mainOn("save_file_path", ([ext]) =>
    join(config.public().archiveRoot, `capture-${Date.now()}.${ext}`),
);
mainOn("ok_save", () => {});
handle("captureVisibility", (visible) => {
    captureSaving = !visible;
    if (visible) {
        quitting = false;
        queuedCapture = undefined;
        showCaptureWindow();
    } else {
        whitespaceRequest?.abort();
        captureWindow?.hide();
    }
});
handle("detectWhitespace", async (png) => {
    const settings = config.public().whiteboard;
    if (!settings.enabled || !activeCapture || captureSaving)
        return { rects: [] };
    const image = nativeImage.createFromBuffer(decodePng(png));
    const size = image.getSize();
    if (image.isEmpty() || size.width > 1600 || size.height > 1600)
        throw new Error("页面预览无效");
    whitespaceRequest?.abort();
    const controller = new AbortController();
    whitespaceRequest = controller;
    const timer = setTimeout(() => controller.abort(), 13_000);
    try {
        return await auth.detectWhitespace(png, settings, controller.signal);
    } finally {
        clearTimeout(timer);
        if (whitespaceRequest === controller) whitespaceRequest = null;
    }
});

handle("screenshots", async () => {
    const displays = screen.getAllDisplays();
    const pointer = screen.getCursorScreenPoint();
    function frameInfo(d: Electron.Display) {
        const x = pointer.x - d.bounds.x,
            y = pointer.y - d.bounds.y;
        return {
            id: d.id,
            bounds: d.bounds,
            scaleFactor: d.scaleFactor,
            pointer:
                x >= 0 && y >= 0 && x < d.bounds.width && y < d.bounds.height
                    ? { x: x / d.bounds.width, y: y / d.bounds.height }
                    : undefined,
        };
    }
    if (process.platform === "win32") {
        const frames = await Promise.allSettled(
            displays.map(async (d) => {
                const rect = screen.dipToScreenRect(null, d.bounds);
                const rgba = await frameReader(d.id).read(rect);
                return {
                    ...frameInfo(d),
                    width: rect.width,
                    height: rect.height,
                    rgba,
                };
            }),
        );
        if (frames.every((frame) => frame.status === "fulfilled"))
            return frames.map((frame) => frame.value);
        // Remote sessions and secure desktops may not offer a readable GDI surface.
    }
    const width = Math.max(
        ...displays.map((d) => Math.round(d.size.width * d.scaleFactor)),
    );
    const height = Math.max(
        ...displays.map((d) => Math.round(d.size.height * d.scaleFactor)),
    );
    const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width, height },
    });
    return displays.map((d) => {
        const source = screenshotSource(d.id, displays.length, sources);
        if (!source || source.thumbnail.isEmpty())
            throw new Error("无法获取屏幕图像");
        return {
            ...frameInfo(d),
            png: source.thumbnail.toDataURL(),
        };
    });
});
handle("archive", async (input) => {
    if (nativeImage.createFromBuffer(decodePng(input.png)).isEmpty())
        throw new Error("截图数据无法解码");
    return archive.save(input);
});
handle("formula", async (input) => {
    const result = await jobs.create(
        input.archiveId,
        input.png,
        input.rect,
        input.outputFormat,
    );
    setTimeout(showPanel, 200);
    void jobs.run(result.id);
    return result;
});
handle("typeset", (latex, font, color) =>
    typesetter.render(latex, font, color),
);
handle("inkCancel", (id) => {
    inkRequests.get(id)?.abort();
    inkRequests.delete(id);
});
handle("inkRecognize", async (id, png) => {
    if (
        !/^[a-f0-9-]{36}$/.test(id) ||
        inkRequests.has(id) ||
        inkRequests.size >= 2
    )
        throw new Error("公式识别请求无效或过多");
    if (nativeImage.createFromBuffer(decodePng(png)).isEmpty())
        throw new Error("公式笔迹图无效");
    const provider = auth.provider();
    if (!provider) throw new Error("请先使用邀请码登录");
    const controller = new AbortController();
    inkRequests.set(id, controller);
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
        const result = await provider.recognize(
            png,
            controller.signal,
            "latex",
        );
        if (controller.signal.aborted) throw new Error("公式识别已取消");
        return result;
    } finally {
        clearTimeout(timer);
        if (inkRequests.get(id) === controller) inkRequests.delete(id);
    }
});
handle("state", () => ({
    startup: { ...startup.state },
    update: updater.public(),
    archiveCleanup: retention?.public() ?? "",
    config: config.public(),
    login: auth.public(),
    jobs: [...jobs.jobs.values()].reverse(),
    shortcutError,
}));
handle("captureConfig", () => config.public());
handle("configure", (input) => {
    const rollback = registerShortcuts(input);
    try {
        const previousArchive = config.public().archiveRoot;
        const result = config.save(input);
        if (result.archiveRoot !== previousArchive) void startup.ensure();
        shortcutError = "";
        changed();
        void retention.run(true);
        return result;
    } catch (error) {
        rollback();
        throw error;
    }
});
handle("copy", (id, text) => jobs.copy(id, text));
handle("retry", (id) => {
    const result = jobs.get(id);
    void jobs.run(id);
    return result;
});
handle("capture", (mode = "region") => {
    if (!["region", "full", "ocr"].includes(mode))
        throw new Error("截图模式无效");
    void capture(undefined, mode);
});
handle("login", (code) => auth.login(code));
handle("logout", () => auth.logout());
handle("refreshLogin", () => auth.refresh());
handle("openPanel", () => showPanel());
handle("quit", quitImmediately);
handle("checkUpdates", () => updater.check());
handle("setAutoUpdate", (enabled) => updater.setEnabled(enabled));
handle("setAutoStart", (enabled) => startup.setEnabled(enabled));
handle("installUpdate", () => updater.install(true));
handle("chooseArchive", async () => {
    const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
});
handle("openArchive", async () => {
    const path = config.public().archiveRoot;
    mkdirSync(path, { recursive: true });
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on("second-instance", (_event, argv) => {
        if (!minimist(argv.slice(1)).background) showPanel();
    });
    app.on("window-all-closed", () => {});
    app.on("before-quit", (event) => {
        if (activeCapture) {
            event.preventDefault();
            quitting = true;
            mainSend(captureWindow?.webContents, "annotation_finish", []);
        }
    });
    app.on("will-quit", () => {
        for (const reader of frameReaders.values()) reader.stop();
        updater?.dispose();
        retention?.dispose();
        globalShortcut.unregisterAll();
        tray?.destroy();
    });
    app.whenReady().then(() => {
        config = new AnnotationConfig(
            dataRoot,
            args.archiveRoot || join(dataRoot, "Archive"),
        );
        app.setAppUserModelId("AnnotationCapture");
        const startupTestName =
            args.testMode &&
            typeof args.startupTestName === "string" &&
            /^AnnotationCapture-Test-[a-zA-Z0-9-]+$/.test(args.startupTestName)
                ? args.startupTestName
                : undefined;
        startup = new AnnotationStartup({
            dataRoot,
            archiveRoot: () => config.public().archiveRoot,
            executable: process.execPath,
            testName: startupTestName,
            worker: app.isPackaged
                ? join(process.resourcesPath, "startup-worker.ps1")
                : join(runPath, "src/main/startup-worker.ps1"),
            disabled:
                process.platform !== "win32" ||
                !app.isPackaged ||
                (!!args.testMode && !startupTestName),
            changed: () => {
                refreshTray();
                changed();
            },
        });
        store.setDefaultData(
            captureDefaults(app.getVersion(), config.public().archiveRoot),
        );
        archive = new ArchiveStore(() => config.public().archiveRoot);
        auth = new AnnotationAuth(config, changed);
        jobs = new FormulaJobs(
            archive,
            () => auth.provider(),
            {
                revision: clipboardRevision,
                writeText: (text) => clipboard.writeText(text),
            },
            changed,
        );
        updater = new AnnotationUpdater({
            dataRoot,
            archiveRoot: () => config.public().archiveRoot,
            worker: app.isPackaged
                ? join(process.resourcesPath, "update-worker.ps1")
                : join(runPath, "src/main/update-worker.ps1"),
            busy: (manual) =>
                activeCapture ||
                captureStarting ||
                inkRequests.size > 0 ||
                [...jobs.jobs.values()].some(
                    (j) => j.status === "recognizing",
                ) ||
                (!manual && !!panel?.isFocused()),
            changed,
            quit: quitImmediately,
            disabled: !!args.testMode,
            testFeed:
                args.testMode && typeof args.updateTestFeed === "string"
                    ? args.updateTestFeed
                    : undefined,
        });
        retention = new ArchiveRetention({
            config: () => ({
                archiveRoot: config.public().archiveRoot,
                archiveRetentionDays: config.public().archiveRetentionDays,
            }),
            busy: () =>
                activeCapture ||
                captureStarting ||
                updater.installing ||
                [...jobs.jobs.values()].some((j) => j.status === "recognizing"),
            trash: (path) => shell.trashItem(path),
            removed: (ids) => {
                archive.forget(ids);
                for (const [id, job] of jobs.jobs) {
                    if (ids.includes(job.archiveId)) jobs.jobs.delete(id);
                }
            },
            changed,
        });
        const shortcuts = config.public();
        const shortcutErrors: string[] = [];
        for (const entry of [
            { key: shortcuts.shortcut, mode: "region" as const },
            { key: shortcuts.fullShortcut, mode: "full" as const },
            { key: shortcuts.ocrShortcut, mode: "ocr" as const },
        ]) {
            try {
                registerEntry(entry);
            } catch (error) {
                shortcutErrors.push(String(error));
            }
        }
        shortcutError = shortcutErrors.join("；");
        tray = new Tray(icon);
        tray.setToolTip("AnnotationCapture");
        refreshTray();
        tray.on("click", showPanel);
        screen.on("display-removed", (_, display) => {
            frameReaders.get(display.id)?.stop();
            frameReaders.delete(display.id);
        });
        void startup.ensure();
        if (args.input) void capture(args.input, args.ocr ? "ocr" : "region");
        else if (args.full) void capture(undefined, "full");
        else if (args.capture) void capture();
        else if (!args.updateReceipt && !args.background) showPanel();
        acknowledgeUpdate(args.updateReceipt, dataRoot);
        updater.start();
        retention.start();
        void auth.refresh();
        setTimeout(prewarmCapture, 0);
    });
}
