const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { prepareProfile, isolateWindow } = require('./acceptance-window.cjs');
const root = process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/whiteboard';
const data = path.join(root, `profile-${Date.now()}`);
prepareProfile(data);
let app, panel, current;
const checks = [], errors = [], timings = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(value) { await app.evaluate((_e, value) => Object.assign(globalThis.boardFixture, value), value); }
async function configure(whiteboard) { await panel.evaluate(async whiteboard => {
    const ipc = require('electron').ipcRenderer, state = await ipc.invoke('annotation:state');
    await ipc.invoke('annotation:configure', { ...state.config, whiteboard: { ...state.config.whiteboard, ...whiteboard } });
}, whiteboard); }
async function open() {
    const start = performance.now();
    const pending = app.waitForEvent('window');
    await panel.evaluate(() => require('electron').ipcRenderer.invoke('annotation:capture', 'full'));
    current = await pending;
    current.on('pageerror', e => errors.push(String(e)));
    await current.waitForFunction(() => document.body.dataset.acReady === 'true');
    timings.push({ coldReadyMs: performance.now() - start });
    await isolateWindow(app, current, true);
    return current;
}
async function stroke(page, from, to) { await page.mouse.move(...from); await page.mouse.down(); await page.mouse.move(...to, { steps: 6 }); await page.mouse.up(); }
async function checkpoint(page) {
    await fixture({ fail: true });
    await page.locator('#ac-capture-status').evaluate(el => { el.textContent = ''; });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#ac-capture-status').textContent.includes('画布已保留'));
    const result = await app.evaluate(() => globalThis.boardFixture.last.annotations.canvas.objects);
    await fixture({ fail: false });
    await page.locator('#ac-capture-status').evaluate(el => { el.textContent = ''; });
    return result;
}
async function finish(page) { const closed = page.waitForEvent('close'); await page.keyboard.press('Escape'); await closed; }
function boards(objects) { return objects.filter(o => o.acWhiteboard); }
async function point(page, x, y) { return page.locator('#main_photo').evaluate((c, p) => {
    const b = c.getBoundingClientRect(); return [b.x + p[0] / c.width * b.width, b.y + p[1] / c.height * b.height];
}, [x, y]); }
(async () => {
    app = await _electron.launch({ executablePath: process.env.ANNOTATION_EXE || path.resolve('node_modules/electron/dist/electron.exe'),
        args: [...(process.env.ANNOTATION_EXE ? [] : ['.']), '--userData', data, '--testMode',
            ...(process.env.ANNOTATION_SCALE ? ['--force-device-scale-factor=' + process.env.ANNOTATION_SCALE] : [])], timeout: 30000 });
    panel = await app.firstWindow(); await panel.waitForSelector('#ac-save-settings'); await isolateWindow(app, panel);
    await app.evaluate(({ ipcMain, nativeImage, screen }) => {
        globalThis.boardFixture = { fail: false, saveDelay: 0, detectionDelay: 0, rects: [], calls: 0, inputs: [] };
        const original = ipcMain._invokeHandlers.get('annotation:archive');
        ipcMain.removeHandler('annotation:archive');
        ipcMain.handle('annotation:archive', async (e, input) => {
            const s = globalThis.boardFixture; s.last = input;
            await new Promise(r => setTimeout(r, s.saveDelay));
            if (s.fail) throw new Error('Controlled archive failure');
            return original(e, input);
        });
        ipcMain.removeHandler('annotation:detectWhitespace');
        ipcMain.handle('annotation:detectWhitespace', async () => {
            const s = globalThis.boardFixture; s.calls++; const rects = s.rects;
            await new Promise(r => setTimeout(r, s.detectionDelay)); return { rects };
        });
        ipcMain.removeHandler('annotation:formula');
        ipcMain.handle('annotation:formula', (_e, input) => { globalThis.boardFixture.inputs.push(input); return { id: 'fixture' }; });
        ipcMain.removeHandler('annotation:screenshots');
        ipcMain.handle('annotation:screenshots', () => screen.getAllDisplays().map(d => {
            const width = Math.round(d.size.width * d.scaleFactor), height = Math.round(d.size.height * d.scaleFactor);
            const pixels = Buffer.alloc(width * height * 4, 220); for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
            return { id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, png: nativeImage.createFromBitmap(pixels, { width, height }).toDataURL() };
        }));
    });
    // Defaults and persistence through the real settings controls.
    assert.equal(await panel.locator('#ac-whiteboard-enabled').isChecked(), true);
    assert.equal(await panel.locator('#ac-whiteboard-limit').inputValue(), '5');
    await panel.locator('#ac-whiteboard-enabled').uncheck();
    await panel.locator('#ac-save-settings').click();
    await panel.waitForFunction(() => document.querySelector('#ac-panel-status').textContent.includes('设置已保存'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'annotation-settings.json'))).whiteboard.enabled, false);
    checks.push('default settings and disabled preference persist');
    let page = await open();
    await page.locator('#ac-whiteboard').click();
    let objects = await checkpoint(page), b = boards(objects)[0];
    assert.equal(b.acFixed, false); assert.equal(b.fill, 'white'); assert.equal(b.strokeWidth, 0);
    assert.equal(await app.evaluate(() => globalThis.boardFixture.calls), 0);
    await page.locator('#ac-whiteboard-recognize').click();
    await page.waitForFunction(() => document.querySelector('#ac-capture-status').textContent.includes('白板上没有笔迹'));
    assert.equal(await app.evaluate(() => globalThis.boardFixture.inputs.length), 0);
    const center = await point(page, b.left + b.width / 2, b.top + b.height / 2);
    await stroke(page, [center[0] - 50, center[1]], [center[0] + 50, center[1] + 20]);
    const ink = (await checkpoint(page)).filter(o => !o.acWhiteboard);
    await page.locator('#ac-whiteboard-adjust').click();
    await page.screenshot({ path: path.join(root, 'manual-controls.png') });
    await stroke(page, [center[0] + 100, center[1] + 60], [center[0] + 130, center[1] + 80]);
    await page.locator('#ac-whiteboard-adjust').click();
    objects = await checkpoint(page); let moved = boards(objects)[0];
    assert.ok(moved.left > b.left, 'board moves');
    assert.deepEqual(objects.filter(o => !o.acWhiteboard), ink, 'ink does not move with board');
    // Midpoint adjusts only width, corner adjusts both axes, using real Fabric controls.
    for (const kind of ['edge', 'corner']) {
        b = boards(await checkpoint(page))[0];
        await page.locator('#ac-whiteboard-adjust').click();
        const handle = await point(page, b.left + b.width, b.top + (kind === 'edge' ? b.height / 2 : b.height));
        await stroke(page, [handle[0] + 5, handle[1]], [handle[0] - 50, handle[1] - (kind === 'corner' ? 35 : 0)]);
        await page.locator('#ac-whiteboard-adjust').click();
        moved = boards(await checkpoint(page))[0];
        assert.ok(moved.width < b.width, `${kind} control changes width with enlarged hit area`);
        if (kind === 'edge') assert.equal(moved.height, b.height); else assert.ok(moved.height < b.height);
    }
    checks.push('manual board moves and eight-point controls resize without transforming ink');
    await page.screenshot({ path: path.join(root, 'manual-whiteboard.png') });
    // D clears strokes but cannot remove the background. Ordinary selection/Delete also cannot remove it.
    const size = await page.locator('#main_photo').evaluate(c => ({ width: c.width, height: c.height }));
    await page.keyboard.down('d');
    await page.mouse.move(...await point(page, 100, 100)); await page.mouse.down();
    for (const p of [[size.width - 120, 100], [size.width - 120, size.height - 250], [100, size.height - 250], [100, 100]]) await page.mouse.move(...await point(page, ...p), { steps: 5 });
    await page.mouse.up(); await page.keyboard.up('d');
    assert.equal(boards(await checkpoint(page)).length, 1);
    await page.keyboard.press('Delete'); assert.equal(boards(await checkpoint(page)).length, 1);
    await page.locator('#ac-whiteboard-remove').click();
    assert.equal(boards(await checkpoint(page)).length, 0);
    await page.keyboard.press('Control+z');
    objects = await checkpoint(page); assert.equal(boards(objects).length, 1);
    checks.push('D and Delete preserve whiteboards; explicit hide and undo preserve protected identity');
    await finish(page);
    // Pending detection uses a central board immediately and never replaces it.
    await configure({ enabled: true });
    await fixture({ detectionDelay: 1800, rects: [{ x: .1, y: .12, width: .25, height: .4 }] });
    page = await open(); await page.locator('#ac-whiteboard').click();
    await delay(2000); objects = await checkpoint(page); assert.equal(boards(objects).length, 1); assert.equal(boards(objects)[0].acFixed, false);
    checks.push('pending model response never replaces a manual fallback'); await finish(page);
    await fixture({ detectionDelay: 0, rects: [{ x: .1, y: .15, width: .25, height: .4 }, { x: .65, y: .15, width: .25, height: .4 }] });
    page = await open(); await page.waitForFunction(() => document.querySelector('#ac-whiteboard-status').textContent === '空白区域已就绪');
    await page.locator('#ac-whiteboard').click(); objects = await checkpoint(page);
    assert.equal(boards(objects).length, 2); assert.ok(boards(objects).every(o => o.acFixed));
    assert.equal(await page.locator('#ac-whiteboard-adjust').isVisible(), false);
    // Real ink in both boards, plus a distractor between them.
    const dimensions = await page.locator('#main_photo').evaluate(c => ({ width: c.width, height: c.height }));
    for (const x of [.2, .5, .75]) await stroke(page, await point(page, dimensions.width * x, dimensions.height * .3), await point(page, dimensions.width * x + 60, dimensions.height * .3 + 40));
    await page.screenshot({ path: path.join(root, 'detected-whiteboards.png') });
    const closed = page.waitForEvent('close'); await page.locator('#ac-whiteboard-recognize').click(); await closed;
    const result = await app.evaluate(({ nativeImage }) => {
        const input = globalThis.boardFixture.inputs.at(-1), image = nativeImage.createFromDataURL(input.png);
        const { width, height } = image.getSize(), pixels = image.toBitmap(); let left = 0, middle = 0, right = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * width + x) * 4;
            if (pixels[i + 2] > 180 && pixels[i + 1] < 120 && pixels[i] < 120) { if (x < width * .4) left++; else if (x > width * .6) right++; else middle++; } }
        return { count: globalThis.boardFixture.inputs.length, left, middle, right };
    });
    assert.equal(result.count, 1); assert.ok(result.left > 10 && result.right > 10); assert.equal(result.middle, 0);
    checks.push('two fixed whiteboards make one OCR image with outside and gap ink excluded');
    // Failure and empty results fall back; saving hides promptly and retains the final stroke.
    await fixture({ rects: [{ x: 2, y: 0, width: .2, height: .3 }] });
    page = await open(); await page.waitForFunction(() => document.querySelector('#ac-whiteboard-status').textContent.includes('不可用'));
    await page.locator('#ac-whiteboard').click(); assert.equal(boards(await checkpoint(page))[0].acFixed, false);
    await fixture({ saveDelay: 1500 });
    const closed2 = page.waitForEvent('close'), started = performance.now(); await page.keyboard.press('Escape');
    while (await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url)?.isVisible(), page.url())) await delay(5);
    const hideMs = performance.now() - started; assert.ok(hideMs < 500, `exit hides before save: ${hideMs} ms`); assert.equal(page.isClosed(), false);
    await closed2; timings.push({ hideMs, delayedSaveMs: performance.now() - started });
    checks.push('invalid model data falls back; Esc hides before delayed save; failure restores editable canvas');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, checks, timings, errors }, null, 2));
    console.log('WHITEBOARD_ACCEPTANCE_PASSED', JSON.stringify({ checks, timings }));
})().catch(async error => {
    console.error(error); if (current && !current.isClosed()) await current.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: false, checks, timings, error: String(error), errors }, null, 2)); process.exitCode = 1;
}).finally(async () => { if (app) await app.evaluate(({ app }) => app.exit()).catch(() => {}); });
