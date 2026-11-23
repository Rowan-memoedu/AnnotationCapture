const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { isolateWindow, prepareProfile } = require("./acceptance-window.cjs");

const root = process.env.ANNOTATION_EVIDENCE || "D:/Artifacts/AnnotationCapture/shape-tools";
const profile = path.join(root, `profile-${Date.now()}`);
prepareProfile(profile, { whiteboard: { enabled: false } });

async function drag(page, points) {
    await page.mouse.move(...points[0]);
    await page.mouse.down();
    for (const point of points.slice(1)) {
        await page.mouse.move(...point, { steps: 6 });
    }
    await page.mouse.up();
}

async function chooseShape(page, kind) {
    const shapes = page.locator("#draw_shapes");
    await shapes.click();
    assert.equal(await shapes.getAttribute("aria-expanded"), "true");
    await page.locator(`#draw_shapes_${kind}`).click();
    assert.equal(await shapes.getAttribute("aria-expanded"), "false");
}

async function run() {
    const executable = process.env.ANNOTATION_EXE;
    const app = await _electron.launch({
        executablePath: executable || path.resolve("node_modules/electron/dist/electron.exe"),
        args: [
            ...(executable ? [] : ["."]),
            "--userData", profile, "--testMode",
            ...(process.env.ANNOTATION_SCALE ? [`--force-device-scale-factor=${process.env.ANNOTATION_SCALE}`] : []),
        ],
        timeout: 30_000,
    });
    const checks = [];
    const seenArchives = new Set();
    const errors = [];
    try {
        const panel = await app.firstWindow();
        await panel.waitForSelector("#ac-save-settings");
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
        for (const mode of ["full", "region"]) {
            const opened = app.waitForEvent("window");
            await panel.evaluate(mode => require("electron").ipcRenderer.invoke("annotation:capture", mode), mode);
            const page = await opened;
            page.on("pageerror", error => errors.push(String(error)));
            await page.waitForFunction(() => document.body.dataset.acReady === "true");
            await isolateWindow(app, page);
            if (mode === "region") await drag(page, [[160, 130], [1010, 700]]);
            else {
                await page.locator("#ac-whiteboard").click();
                await page.locator("#ac-whiteboard-adjust").click();
            }

            const shapes = page.locator("#draw_shapes");
            await shapes.hover();
            await shapes.focus();
            await page.keyboard.press("Enter");
            assert.equal(await shapes.getAttribute("aria-expanded"), "true");
            const focus = await page.evaluate(() => ({
                activeId: document.activeElement?.id,
                shapeMenuInert: document.querySelector("#draw_side").inert,
                focused: document.hasFocus(),
            }));
            assert.equal(focus.activeId, "draw_shapes_rect", JSON.stringify({ mode, ...focus }));
            if (mode === "full" && !process.env.ANNOTATION_SCALE) {
                const toolbar = await page.locator("#draw_main").boundingBox();
                const menu = await page.locator("#draw_shapes_i").boundingBox();
                assert.ok(toolbar && menu);
                const x = Math.min(toolbar.x, menu.x);
                const y = Math.min(toolbar.y, menu.y);
                await page.screenshot({
                    path: path.join(root, "shape-toolbar.png"),
                    clip: {
                        x, y,
                        width: Math.ceil(Math.max(toolbar.x + toolbar.width, menu.x + menu.width) - x),
                        height: Math.ceil(Math.max(toolbar.y + toolbar.height, menu.y + menu.height) - y),
                    },
                });
            }
            await page.mouse.move(900, 160);
            await page.waitForTimeout(150);
            assert.equal(await shapes.getAttribute("aria-expanded"), "true");
            await page.keyboard.press("Enter");
            assert.equal(await shapes.getAttribute("aria-expanded"), "false");
            await drag(page, [[330, 250], [450, 325]]);
            await chooseShape(page, "ellipse");
            await drag(page, [[635, 325], [490, 250]]);
            await chooseShape(page, "diamond");
            await drag(page, [[680, 250], [800, 325]]);
            await chooseShape(page, "line");
            await drag(page, [[330, 425], [450, 490]]);

            const arrow = page.locator("#ac-arrow");
            await arrow.click();
            assert.equal(await arrow.getAttribute("aria-pressed"), "true");
            await drag(page, [[655, 450], [510, 450]]);
            await page.keyboard.press("Control+z");
            await page.keyboard.press("Control+y");
            await page.keyboard.press("d");
            assert.equal(await arrow.getAttribute("aria-pressed"), "false");
            await drag(page, [[500, 427], [545, 427], [545, 474], [500, 474], [500, 427]]);
            await drag(page, [[560, 450], [560, 502]]);
            await page.keyboard.press("Control+z");
            await page.keyboard.press("Control+y");
            await page.locator("#draw_free").click();
            await drag(page, [[740, 440], [790, 487]]);

            const closed = page.waitForEvent("close");
            await page.keyboard.press("Escape");
            await closed;
            const records = fs.readdirSync(path.join(profile, "Archive"), { recursive: true })
                .filter(file => path.basename(file) === "annotations.json" && !seenArchives.has(file));
            assert.equal(records.length, 1);
            seenArchives.add(records[0]);
            const record = JSON.parse(fs.readFileSync(path.join(profile, "Archive", records[0]), "utf8"));
            const objects = record.canvas.objects;
            assert.deepEqual(objects.filter(object => object.形状).map(object => object.形状), ["rect", "ellipse", "diamond", "line", "arrow"]);
            assert.ok(objects.some(object => object.type === "Path" && !object.形状));
            assert.equal(objects.some(object => object.acWhiteboard), mode === "full");
            const savedArrow = objects.find(object => object.形状 === "arrow");
            const [start, end] = savedArrow.path;
            assert.ok(start[1] > end[1], "arrow points toward drag release");
            assert.ok(savedArrow.top - start[2] > 30, "lasso moved the restored arrow");
            assert.equal(savedArrow.strokeWidth, 3);
            assert.equal(savedArrow.canChangeFill, undefined);
            checks.push({ mode, keyboardMenu: true, arrowUndoRedoAndLassoMove: true, archivedShapesAndInk: true });
        }
        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(root, `report-${process.env.ANNOTATION_SCALE || "default"}.json`), JSON.stringify({ checks, errors }, null, 2));
        console.log(JSON.stringify(checks));
    } finally {
        await app.close();
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
