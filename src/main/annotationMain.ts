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
import { handle } from "../../lib/annotationIpc";
import { mainOn, mainSend } from "../../lib/ipc";
import Store from "../../lib/store/store";
import { ArchiveStore, decodePng } from "./annotationArchive";
import { AnnotationConfig } from "./annotationConfig";
import { captureDefaults } from "./captureDefaults";
import { FormulaJobs } from "./formulaJobs";
import { deepSeekProvider } from "./formulaProvider";

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

async function capture(imagePath?: string) {
    if (activeCapture || captureStarting) {
        captureWindow?.focus();
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
        ]);
    } catch (error) {
        showPanel();
        dialog.showErrorBox("无法开始截图", String(error));
    } finally {
        captureStarting = false;
    }
}

function finishCapture() {
    activeCapture = false;
    closing = true;
    captureWindow?.close();
    closing = false;
    if (quitting) app.quit();
}

function registerShortcut(key: string) {
    const old = config.public().shortcut;
    if (key === old && globalShortcut.isRegistered(key)) return;
    if (
        key &&
        !globalShortcut.register(key, () => {
            void capture();
        })
    )
        throw new Error("截图快捷键已被占用，请更换组合");
    if (old && old !== key) globalShortcut.unregister(old);
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
mainOn("clip_show", () => {
    captureWindow?.show();
    captureWindow?.setSimpleFullScreen(true);
});
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
    const result = await jobs.create(input.archiveId, input.png, input.rect);
    setTimeout(() => {
        showPanel();
        void jobs.run(result.id);
    }, 200);
    return result;
});
handle("state", () => ({
    config: config.public(),
    jobs: [...jobs.jobs.values()].reverse(),
    shortcutError,
}));
handle("configure", (input) => {
    const old = config.public().shortcut;
    registerShortcut(input.shortcut);
    try {
        const result = config.save(input);
        shortcutError = "";
        changed();
        return result;
    } catch (error) {
        if (input.shortcut !== old) {
            globalShortcut.unregister(input.shortcut);
            if (old)
                globalShortcut.register(old, () => {
                    void capture();
                });
        }
        throw error;
    }
});
handle("copy", (id, text) => jobs.copy(id, text));
handle("retry", (id) => {
    const result = jobs.get(id);
    void jobs.run(id);
    return result;
});
handle("capture", () => {
    void capture();
});
handle("openPanel", () => showPanel());
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
        jobs = new FormulaJobs(
            archive,
            () =>
                config.key()
                    ? deepSeekProvider(config.key(), config.public().model)
                    : null,
            {
                revision: clipboardRevision,
                writeText: (text) => clipboard.writeText(text),
            },
            changed,
        );
        try {
            registerShortcut(config.public().shortcut);
        } catch (error) {
            shortcutError = String(error);
        }
        tray = new Tray(icon);
        tray.setToolTip("AnnotationCapture");
        tray.setContextMenu(
            Menu.buildFromTemplate([
                {
                    label: "截图并批注",
                    click: () => {
                        void capture();
                    },
                },
                { label: "识别结果与设置", click: showPanel },
                { type: "separator" },
                { label: "退出", click: () => app.quit() },
            ]),
        );
        tray.on("click", () => {
            void capture();
        });
        if (args.input) void capture(args.input);
        else if (args.capture) void capture();
        else showPanel();
    });
}
