const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { isolateWindow, prepareProfile } = require("./acceptance-window.cjs");

async function run() {
    const root = process.env.ANNOTATION_EVIDENCE;
    if (!root || !path.isAbsolute(root)) throw Error("Set ANNOTATION_EVIDENCE to an absolute output directory");
    fs.mkdirSync(root, { recursive: true });
    const profile = fs.mkdtempSync(path.join(root, "background-"));
    prepareProfile(profile, { archiveRoot: path.join(profile, "archives"), whiteboardAutoOpen: false });
    const exe = process.env.ANNOTATION_EXE;
    const app = await _electron.launch({
        executablePath: exe || path.resolve("node_modules/electron/dist/electron.exe"),
        args: [...(exe ? [] : ["."]), "--userData", profile, "--testMode"],
    });
    try {
        const panel = await app.firstWindow();
        await panel.waitForSelector("#ac-invite-code");
        await isolateWindow(app, panel);
        await app.evaluate(({ ipcMain, nativeImage, screen }) => {
            const replace = (name, fn) => {
                ipcMain.removeHandler("annotation:" + name);
                ipcMain.handle("annotation:" + name, fn);
            };
            replace("screenshots", () => screen.getAllDisplays().map(d => {
                const width = Math.round(d.size.width * d.scaleFactor), height = Math.round(d.size.height * d.scaleFactor);
                const png = nativeImage.createFromBitmap(Buffer.alloc(width * height * 4, 255), { width, height }).toDataURL();
                return { id:d.id, bounds:d.bounds, scaleFactor:d.scaleFactor, png };
            }));
            replace("academyTarget", () => "");
            replace("academyFill", () => new Promise((resolve, reject) => { globalThis.pendingTestFill = { resolve, reject }; }));
        });
        const opened = app.waitForEvent("window");
        const capture = () => panel.evaluate(() => require("electron").ipcRenderer.invoke("annotation:capture", "full"));
        await capture();
        const canvas = await opened;
        await canvas.waitForFunction(() => document.body.dataset.acReady === "true");
        await isolateWindow(app, canvas, true);
        await canvas.waitForFunction(() => document.querySelector("#draw_free_pencil")?.classList.contains("select"));
        await canvas.mouse.move(220, 180); await canvas.mouse.down();
        await canvas.mouse.move(280, 220, { steps:8 }); await canvas.mouse.up();
        const win = await app.browserWindow(canvas);
        const attempt = async () => {
            await canvas.locator("#tool_academy_submit").click();
            const selection = canvas.locator("#ac-selection");
            await selection.waitFor();
            const b = await selection.boundingBox();
            await canvas.mouse.move(b.x+1,b.y+1); await canvas.mouse.down();
            await canvas.mouse.move(b.x+b.width-1,b.y+b.height-1,{steps:4}); await canvas.mouse.up();
            await panel.waitForFunction(async () => !!(await require("electron").ipcRenderer.invoke("test:pending")));
            assert.equal(await win.evaluate(w=>w.isVisible()), false);
            assert.equal(await canvas.locator("#ac-submitting").count(), 0);
        };
        await app.evaluate(({ipcMain}) => ipcMain.handle("test:pending",()=>!!globalThis.pendingTestFill));
        await attempt();
        await app.evaluate(() => { globalThis.pendingTestFill.reject(Error("test failure")); delete globalThis.pendingTestFill; });
        await canvas.waitForFunction(() => document.querySelector("#ac-capture-status")?.textContent.includes("test failure"));
        assert.equal(await win.evaluate(w=>w.isVisible()), false);
        await capture();
        await canvas.locator("#ac-capture-status.ac-error").waitFor();
        assert.equal(await win.evaluate(w=>w.isVisible()), true);
        await attempt();
        const closed = canvas.waitForEvent("close");
        await app.evaluate(() => globalThis.pendingTestFill.resolve(1));
        await closed;
        console.log("Verified a hidden native window during fill, silent failure, explicit retry and successful completion");
    } finally {
        await app.evaluate(({app}) => app.exit()).catch(()=>{});
    }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
