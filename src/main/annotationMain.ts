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
import { captureDefaults } from "./captureDefaults";
import { FormulaJobs } from "./formulaJobs";
import { FormulaTypesetter } from "./formulaTypeset";

app.setName("AnnotationCapture");
const args = minimist(process.argv.slice(1));
const runPath = resolve(__dirname, "../..");
const portableRoot =
    process.env.PORTABLE_EXECUTABLE_DIR || dirname(app.getPath("exe"));
const dataRoot =
    args.userData ||
    process.env.ANNOTATION_DATA_DIR ||
    (app.isPackaged
        ? join(portableRoot, "AnnotationCapture-data")
        : "D:\\AppData\\AnnotationCapture");
mkdirSync(dataRoot, { recursive: true });
app.setPath("userData", dataRoot);
app.setPath("sessionData", join(dataRoot, "browser"));
const store = new Store({ configPath: join(dataRoot, "config.json") });
let config: AnnotationConfig;
let auth: AnnotationAuth;
let archive: ArchiveStore;
let jobs: FormulaJobs;
let captureWindow: BrowserWindow | null = null;
let panel: BrowserWindow | null = null;
let tray: Tray | null = null;
let activeCapture = false;
let captureStarting = false;
let closing = false;
let quitting = false;
let shortcutError = "";
const typesetter = new FormulaTypesetter();
const inkRequests = new Map<string, AbortController>();
function cancelInk() {
    for (const controller of inkRequests.values()) controller.abort();
    inkRequests.clear();
}
const icon = join(runPath, "assets/logo/64x64.png");

function load(win: BrowserWindow, file: string) {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    return win.loadFile(join(__dirname, "../renderer", file));
}
function changed() {
    panel?.webContents.send("annotation:changed");
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

async function capture(imagePath?: string, mode: CaptureMode = "region") {
    if (activeCapture || captureStarting) {
        showCaptureWindow();
        return;
    }
    captureStarting = true;
    panel?.hide();
    try {
        const display = screen.getDisplayNearestPoint(
            screen.getCursorScreenPoint(),
        );
        const win = new BrowserWindow({
            ...display.bounds,
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
            },
        });
        captureWindow = win;
        win.on("close", (event) => {
            if (activeCapture && !closing) {
                event.preventDefault();
                mainSend(win.webContents, "annotation_finish", []);
            }
        });
        win.on("closed", () => {
            cancelInk();
            captureWindow = null;
            activeCapture = false;
        });
        win.webContents.on("render-process-gone", () => {
            activeCapture = false;
            win.destroy();
            showPanel();
            dialog.showErrorBox(
                "批注窗口异常退出",
                "本次尚未完成归档的批注可能丢失；已归档图片仍保留。",
            );
        });
        await load(win, "capture.html");
        activeCapture = true;
        mainSend(win.webContents, "clip_init", [
            screen.getAllDisplays(),
            imagePath ? readFileSync(imagePath) : undefined,
            display.id,
            undefined,
            mode,
        ]);
    } catch (error) {
        showPanel();
        dialog.showErrorBox("无法开始截图", String(error));
    } finally {
        captureStarting = false;
    }
}

function finishCapture() {
    cancelInk();
    activeCapture = false;
    closing = true;
    captureWindow?.close();
    closing = false;
    if (quitting) app.quit();
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
    const command =
        "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class ClipboardSequence { [DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber(); }'; [ClipboardSequence]::GetClipboardSequenceNumber()";
    const result = await promisify(execFile)(
        join(
            process.env.SystemRoot || "C:\\Windows",
            "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true, timeout: 10000 },
    );
    return result.stdout.trim();
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
    const win = captureWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    if (process.platform === "darwin") win.setSimpleFullScreen(true);
    win.setAlwaysOnTop(!args.testMode, "screen-saver");
    win.focus();
    win.webContents.focus();
}
mainOn("clip_show", showCaptureWindow);
mainOn("clip_close", finishCapture);
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

handle("screenshots", async () => {
    const displays = screen.getAllDisplays();
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
        const source = sources.find((s) => s.display_id === String(d.id));
        if (!source || source.thumbnail.isEmpty())
            throw new Error("无法获取屏幕图像");
        return {
            id: d.id,
            bounds: d.bounds,
            scaleFactor: d.scaleFactor,
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
    setTimeout(() => {
        showPanel();
        void jobs.run(result.id);
    }, 200);
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
    config: config.public(),
    login: auth.public(),
    jobs: [...jobs.jobs.values()].reverse(),
    shortcutError,
}));
handle("configure", (input) => {
    const rollback = registerShortcuts(input);
    try {
        const result = config.save(input);
        shortcutError = "";
        changed();
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
    app.on("second-instance", () => showPanel());
    app.on("window-all-closed", () => {});
    app.on("before-quit", (event) => {
        if (activeCapture) {
            event.preventDefault();
            quitting = true;
            mainSend(captureWindow?.webContents, "annotation_finish", []);
        }
    });
    app.on("will-quit", () => {
        globalShortcut.unregisterAll();
        tray?.destroy();
    });
    app.whenReady().then(() => {
        config = new AnnotationConfig(
            dataRoot,
            args.archiveRoot || join(dataRoot, "Archive"),
        );
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
        tray.setContextMenu(
            Menu.buildFromTemplate([
                {
                    label: "区域截图并批注",
                    click: () => {
                        void capture();
                    },
                },
                {
                    label: "全屏截图并批注",
                    click: () => {
                        void capture(undefined, "full");
                    },
                },
                { label: "识别结果与设置", click: showPanel },
                {
                    label: "区域 OCR（框选后直接识别）",
                    click: () => {
                        void capture(undefined, "ocr");
                    },
                },
                { type: "separator" },
                { label: "退出", click: quitImmediately },
            ]),
        );
        tray.on("click", () => {
            void capture();
        });
        if (args.input) void capture(args.input, args.ocr ? "ocr" : "region");
        else if (args.full) void capture(undefined, "full");
        else if (args.capture) void capture();
        else showPanel();
        void auth.refresh();
    });
}
