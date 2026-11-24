const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { isolateWindow, prepareProfile } = require("./acceptance-window.cjs");

const root = process.env.ANNOTATION_EVIDENCE || "D:/Artifacts/AnnotationCapture/scribble-erase";
const profile = path.join(root, `profile-${Date.now()}`);
prepareProfile(profile, { whiteboard: { enabled: false } });

const near = [
    [[0, 0], [28, 0], [28, 38], [0, 38], [0, 0]],
    [[0, 18], [28, 18]],
];
const target = [[[74, 0], [74, 38]]];
const far = near.map(stroke => stroke.map(([x, y]) => [x + 103, y]));
const rub = [[62, 17], [88, 20], [62, 23], [88, 26], [62, 29], [88, 32]];
const neighbor = [...near, [[92, 11], [99, 20], [102, 9], [97, 34]], ...far];

async function draw(page, origin, paths, pointerType = "mouse") {
    if (pointerType === "mouse") {
        for (const stroke of paths) {
            const absolute = stroke.map(([x, y]) => [x + origin[0], y + origin[1]]);
            await page.mouse.move(...absolute[0]);
            await page.mouse.down();
            for (const [x, y] of absolute.slice(1)) await page.mouse.move(x, y, { steps: 4 });
            await page.mouse.up();
        }
        return;
    }
    const session = await page.context().newCDPSession(page);
    try {
        for (const stroke of paths) {
            const absolute = stroke.map(([x, y]) => [x + origin[0], y + origin[1]]);
            const send = (type, [x, y]) => session.send("Input.dispatchMouseEvent", {
                type, x, y, pointerType,
                button: type === "mouseMoved" ? "none" : "left",
                buttons: type === "mouseReleased" ? 0 : 1,
                force: type === "mouseReleased" ? 0 : 0.5,
            });
            await send("mousePressed", absolute[0]);
            for (let i = 1; i < absolute.length; i++) {
                const [x, y] = absolute[i - 1];
                const [endX, endY] = absolute[i];
                for (const fraction of [0.25, 0.5, 0.75, 1]) {
                    await send("mouseMoved", [x + (endX - x) * fraction, y + (endY - y) * fraction]);
                }
            }
            await send("mouseReleased", absolute.at(-1));
        }
    } finally {
        await session.detach();
    }
}

async function ink(page, selector, origin) {
    return page.locator(selector).evaluate((canvas, [left, top]) => {
        const box = canvas.getBoundingClientRect();
        const sx = canvas.width / box.width;
        const sy = canvas.height / box.height;
        const pixelsIn = (x, y, width, height) => {
            const pixels = canvas.getContext("2d").getImageData(
                Math.round((left - box.left + x) * sx),
                Math.round((top - box.top + y) * sy),
                Math.max(1, Math.round(width * sx)),
                Math.max(1, Math.round(height * sy)),
            ).data;
            let count = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                if (pixels[i + 3] > 80 && pixels[i] > pixels[i + 1] + 40) count++;
            }
            return count;
        };
        return {
            before: pixelsIn(-4, -4, 36, 47),
            target: pixelsIn(38, -4, 52, 47),
            after: pixelsIn(90, -4, 46, 47),
        };
    }, origin);
}

async function checkSurface(page, selector, origin, pointerType, redo) {
    await page.waitForFunction(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await draw(page, origin, neighbor, pointerType);
    await draw(page, origin, target, pointerType);
    await page.waitForFunction(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await ink(page, selector, origin);
    assert.ok(before.before && before.target && before.after, JSON.stringify(before));
    await draw(page, origin, [rub], pointerType);
    const erased = { ...before, target: 0 };
    const waitForInk = async expected => {
        for (let attempt = 0; attempt < 30; attempt++) {
            const actual = await ink(page, selector, origin);
            // Fabric rehydrates antialiased paths on undo/redo.
            if (Object.keys(expected).every(key => expected[key] === 0
                ? actual[key] === 0
                : Math.abs(actual[key] - expected[key]) <= expected[key] * 0.15))
                return;
            await page.waitForTimeout(50);
        }
        assert.deepEqual(await ink(page, selector, origin), expected);
    };
    await waitForInk(erased);
    await page.keyboard.press("Control+z");
    await waitForInk(before);
    await page.keyboard.press(redo);
    await waitForInk(erased);
}

async function run() {
    const exe = process.env.ANNOTATION_EXE;
    const app = await _electron.launch({
        executablePath: exe || path.resolve("node_modules/electron/dist/electron.exe"),
        args: [...(exe ? [] : ["."]), "--userData", profile, "--testMode"],
        timeout: 30_000,
    });
    const errors = [];
    try {
        const panel = await app.firstWindow();
        await panel.waitForSelector("#ac-scribble-enabled:checked");
        await isolateWindow(app, panel);
        await app.evaluate(({ ipcMain, screen, nativeImage }) => {
            ipcMain.removeHandler("annotation:screenshots");
            ipcMain.handle("annotation:screenshots", () => screen.getAllDisplays().map(display => {
                const width = Math.round(display.size.width * display.scaleFactor);
                const height = Math.round(display.size.height * display.scaleFactor);
                const png = nativeImage.createFromBitmap(Buffer.alloc(width * height * 4, 255), { width, height }).toDataURL();
                return { id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor, png };
            }));
        });
        const opened = app.waitForEvent("window");
        await panel.evaluate(() => require("electron").ipcRenderer.invoke("annotation:capture", "full"));
        const capture = await opened;
        capture.on("pageerror", error => errors.push(String(error)));
        await capture.waitForFunction(() => document.body.dataset.acReady === "true");
        await isolateWindow(app, capture);
        await checkSurface(capture, "#draw_photo", [415, 320], "pen", "Control+y");
        await capture.locator("#ac-whiteboard").click();
        await capture.locator("#ac-whiteboard-adjust").click();
        await checkSurface(capture, "#draw_photo", [415, 420], "mouse", "Control+y");
        const closed = capture.waitForEvent("close");
        await capture.keyboard.press("Escape");
        await closed;
        const archive = path.join(profile, "Archive");
        const records = fs.readdirSync(archive, { recursive: true }).filter(file => path.basename(file) === "annotations.json");
        assert.equal(records.length, 1);
        const recorded = JSON.parse(fs.readFileSync(path.join(archive, records[0]), "utf8"));
        assert.equal(recorded.canvas.objects.filter(object => object.acPressure).length, neighbor.length);
        assert.equal(recorded.canvas.objects.filter(object => object.acPenPoints).length, neighbor.length);
        assert.ok(recorded.canvas.objects.some(object => object.acWhiteboard));

        const whiteboardHtml = path.resolve(exe ? path.join(path.dirname(exe), "resources", "app.asar") : ".", "out/renderer/whiteboard.html");
        const [board] = await Promise.all([
            app.waitForEvent("window"),
            app.evaluate(({ BrowserWindow }, entry) => {
                const window = new BrowserWindow({ x: -10000, width: 1150, height: 850, focusable: false });
                void window.loadFile(entry);
            }, whiteboardHtml),
        ]);
        board.on("pageerror", error => errors.push(String(error)));
        await board.waitForSelector('#tools button[aria-pressed="true"]');
        await isolateWindow(app, board);
        await checkSurface(board, "#board", [415, 320], "mouse", "Control+Shift+z");
        const toggle = board.getByRole("button", { name: "涂抹删除", exact: true });
        await toggle.click();
        assert.equal(await toggle.getAttribute("aria-pressed"), "false");
        await draw(board, [415, 320], target);
        await draw(board, [415, 320], [rub]);
        assert.ok((await ink(board, "#board", [415, 320])).target > 0);
        assert.deepEqual(errors, []);
        const report = { passed: true, adjacentStrokePreserved: true, capturePen: true, quickWhiteboardMouse: true, standaloneMouse: true, archive: true, undoRedo: true, disable: true, hardwarePenTested: false };
        fs.writeFileSync(path.join(root, "scribble-desktop.json"), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
    } finally {
        await app.close();
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
