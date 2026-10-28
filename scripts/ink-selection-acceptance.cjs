const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { prepareProfile, isolateWindow } = require('./acceptance-window.cjs');
const root = process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/ink-selection';
const data = path.join(root, `profile-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });
prepareProfile(data);
const checks = [], errors = [];
let app, panel;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stroke(page, points) {
    await page.mouse.move(...points[0]); await page.mouse.down();
    for (const point of points.slice(1)) await page.mouse.move(...point, { steps: 5 });
    await page.mouse.up();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function open(mode = 'full') {
    const pending = app.waitForEvent('window');
    await panel.evaluate(mode => require('electron').ipcRenderer.invoke('annotation:capture', mode), mode);
    const page = await pending;
    page.on('pageerror', error => errors.push(String(error)));
    await page.waitForFunction(() => document.querySelector('#ac-completion') && document.body.style.opacity !== '0');
    await isolateWindow(app, page);
    if (mode === 'region') await stroke(page, [[200, 150], [1150, 750]]);
    await page.waitForFunction(() => document.querySelector('#draw_free_pencil')?.classList.contains('select'));
    return page;
}
function records() {
    const out = [];
    function walk(dir) {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, e.name);
            if (e.isDirectory()) walk(file);
            else if (e.name === 'annotations.json') out.push(file);
        }
    }
    walk(path.join(data, 'Archive')); return out;
}
async function finish(page) {
    const before = records(); const closing = page.waitForEvent('close');
    await page.keyboard.press('Escape'); await closing;
    const fresh = records().filter(file => !before.includes(file)); assert.equal(fresh.length, 1);
    return JSON.parse(fs.readFileSync(fresh[0], 'utf8'));
}
const loop = [[320, 270], [480, 275], [470, 390], [310, 380], [320, 270]];
const image = page => page.locator('#draw_photo').evaluate(c => c.toDataURL());
const inkPixels = page => page.locator('#draw_photo').evaluate(c => {
    const copy = document.createElement('canvas'); copy.width = c.width; copy.height = c.height;
    const ctx = copy.getContext('2d'); ctx.drawImage(c, 0, 0);
    const pixels = ctx.getImageData(0, 0, c.width, c.height);
    // Selection handles are transient UI. Compare the controlled red ink only.
    for (let i = 0; i < pixels.data.length; i += 4)
        if (pixels.data[i] < 200 || pixels.data[i+1] > 60 || pixels.data[i+2] > 60) pixels.data.fill(0, i, i+4);
    ctx.putImageData(pixels, 0, 0); return copy.toDataURL();
});
async function sameInkGeometry(page, before, after) {
    return page.evaluate(async ([before, after]) => {
        const images = await Promise.all([before, after].map(src => new Promise(resolve => { const im = new Image(); im.onload = () => resolve(im); im.src = src; })));
        const masks = images.map(im => {
            const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
            const ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0);
            return ctx.getImageData(0, 0, c.width, c.height).data;
        });
        const width = images[0].width, height = images[0].height;
        // Grouped and rehydrated Fabric paths rasterize their edges differently.
        // Check every visible ink pixel in both directions, within one device pixel.
        for (const [a, b] of [masks, [...masks].reverse()]) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            if (a[(y * width + x) * 4 + 3] <= 50) continue;
            let found = false;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx, yy = y + dy;
                if (xx >= 0 && yy >= 0 && xx < width && yy < height && b[(yy * width + xx) * 4 + 3] > 50) found = true;
            }
            if (!found) return false;
        }
        return true;
    }, [before, after]);
}
async function select(page) {
    await page.keyboard.press('d');
    assert.equal(await page.locator('.upper-canvas').getAttribute('data-ac-selection'), 'select');
    await stroke(page, loop);
}
(async () => {
    app = await _electron.launch({ executablePath: process.env.ANNOTATION_EXE || path.resolve('node_modules/electron/dist/electron.exe'), args: [...(process.env.ANNOTATION_EXE ? [] : ['.']), '--userData', data, '--testMode', ...(process.env.ANNOTATION_SCALE ? ['--force-device-scale-factor=' + process.env.ANNOTATION_SCALE] : [])], timeout: 30000 });
    panel = await app.firstWindow(); await panel.waitForSelector('#ac-start'); await isolateWindow(app, panel);
    await app.evaluate(({ ipcMain, screen, nativeImage }) => {
        ipcMain.removeHandler('annotation:screenshots');
        ipcMain.handle('annotation:screenshots', () => screen.getAllDisplays().map(d => {
            const width = Math.round(d.size.width * d.scaleFactor), height = Math.round(d.size.height * d.scaleFactor);
            return { id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, png: nativeImage.createFromBitmap(Buffer.alloc(width * height * 4, 255), { width, height }).toDataURL() };
        }));
    });
    for (const mode of ['full', 'region']) {
        let page = await open(mode);
        assert.equal(await page.locator('#draw_main > #ac-formula-pen').count(), 1);
        assert.equal(await page.locator('#ac-typeset').isVisible(), false);
        assert.equal(await page.locator('#ac-formula').isVisible(), false);
        await page.locator('#ac-formula-pen').click();
        assert.equal(await page.locator('#ac-typeset').isVisible(), true);
        assert.equal(await page.locator('#ac-formula').isVisible(), true);
        await page.screenshot({ path: path.join(root, `${mode}-formula-toolbar.png`) });
        await page.locator('#ac-completion').screenshot({ path: path.join(root, `${mode}-formula-actions.png`) });
        await page.locator('#draw_main').screenshot({ path: path.join(root, `${mode}-left-tools.png`) });
        await page.locator('#draw_free').click();
        assert.equal(await page.locator('#ac-typeset').isVisible(), false);
        await page.screenshot({ path: path.join(root, `${mode}-drawing-toolbar.png`) });
        await page.locator('#ac-completion').screenshot({ path: path.join(root, `${mode}-drawing-actions.png`) });
        await stroke(page, [[350, 310], [420, 350]]);
        await stroke(page, [[600, 320], [680, 380]]);
        const before = await image(page);
        await page.keyboard.down('d'); await delay(250);
        await stroke(page, loop);
        await delay(80); const erased = await image(page); assert.ok(erased !== before, 'Hold D should erase ink');
        await page.keyboard.up('d');
        assert.equal(await page.locator('.upper-canvas').getAttribute('data-ac-selection'), null);
        await page.keyboard.press('Control+z'); await delay(150); assert.ok(await image(page) === before, 'Undo should restore erased stroke pixels');
        await page.keyboard.press('Control+y'); await delay(150); assert.ok(await image(page) === erased, 'Redo should restore cleared pixels');
        await stroke(page, [[520, 310], [550, 370]]);
        let saved = await finish(page); assert.equal(saved.canvas.objects.length, 2);
        checks.push(`${mode}: hold D erases enclosed stroke, undo/redo and release restores pencil`);

        page = await open(mode);
        await stroke(page, [[350, 310], [420, 350]]);
        await stroke(page, [[370, 360], [430, 365]]);
        await stroke(page, [[600, 320], [680, 380]]);
        await select(page);
        await stroke(page, [[380, 327], [480, 407]]);
        const moved = await inkPixels(page);
        await page.keyboard.press('Control+z'); await delay(150); assert.ok(await inkPixels(page) !== moved, 'Undo should restore original stroke positions');
        await page.keyboard.press('Control+y'); await delay(150);
        const redone = await inkPixels(page);
        fs.writeFileSync(path.join(root, 'move-before.png'), Buffer.from(moved.split(',')[1], 'base64'));
        fs.writeFileSync(path.join(root, 'move-redone.png'), Buffer.from(redone.split(',')[1], 'base64'));
        assert.ok(await sameInkGeometry(page, moved, redone), 'Redo should restore all ink geometry');
        await page.keyboard.press('d');
        assert.equal(await page.locator('.upper-canvas').getAttribute('data-ac-selection'), null);
        const scale = await page.evaluate(() => window.devicePixelRatio);
        saved = await finish(page);
        assert.equal(saved.canvas.objects.length, 3);
        for (const [object, x, y] of [[saved.canvas.objects[0], 485, 410], [saved.canvas.objects[1], 500, 442.5]]) {
            assert.ok(Math.abs(object.left - x * scale) < 0.01 && Math.abs(object.top - y * scale) < 0.01, JSON.stringify({ object: { left: object.left, top: object.top }, x, y, scale }));
        }
        checks.push(`${mode}: tap D multi-select, move, undo/redo and tap D returns to pencil`);

        page = await open(mode);
        await stroke(page, [[350, 310], [420, 350]]);
        await stroke(page, [[600, 320], [680, 380]]);
        await select(page); await page.keyboard.press('Delete');
        saved = await finish(page); assert.equal(saved.canvas.objects.length, 1);
        checks.push(`${mode}: Delete removes only the selected ink`);
    }
    let page = await open();
    await stroke(page, [[350, 310], [370, 330]]);
    await stroke(page, [[440, 350], [455, 365]]);
    await page.keyboard.down('d');
    await stroke(page, [[300, 250], [500, 250], [300, 450], [300, 250]]);
    await page.keyboard.up('d');
    assert.equal((await finish(page)).canvas.objects.length, 1);
    checks.push('polygon selection excludes ink inside the bounding box but outside the lasso');

    page = await open();
    await stroke(page, [[350, 310], [420, 350]]);
    const before = await image(page);
    await page.keyboard.down('d'); await page.mouse.move(300, 260); await page.mouse.down(); await page.mouse.move(450, 380);
    await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
    await page.mouse.up(); await page.keyboard.up('d'); assert.ok(await image(page) === before, 'Cancel must preserve pixels');
    await page.keyboard.down('d'); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.keyboard.up('d');
    assert.equal(await page.locator('.upper-canvas').getAttribute('data-ac-selection'), null);
    await page.evaluate(() => { const f = document.createElement('textarea'); f.id = 'typing-canary'; document.body.append(f); f.focus(); });
    await page.keyboard.type('ddd'); assert.equal(await page.locator('#typing-canary').inputValue(), 'ddd');
    await page.locator('#typing-canary').evaluate(f => f.remove()); await finish(page);
    checks.push('pointer cancel, focus loss and D typing do not delete ink or leave a stuck tool');

    page = await open();
    await stroke(page, [[350, 310], [420, 350]]);
    await page.keyboard.press('d');
    await page.keyboard.down('d');
    await page.mouse.move(...loop[0]); await page.mouse.down();
    for (const point of loop.slice(1)) await page.mouse.move(...point, { steps: 3 });
    await page.keyboard.up('d'); await page.mouse.up();
    assert.equal(await page.locator('.upper-canvas').getAttribute('data-ac-selection'), null);
    assert.equal((await finish(page)).canvas.objects.length, 0);
    checks.push('hold D from selection and release before pointerup clears ink and restores pencil');

    page = await open();
    const cdp = await page.context().newCDPSession(page);
    await page.evaluate(() => {
        window.penEvents = [];
        for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, e => window.penEvents.push({ type, id: e.pointerId, target: e.target.id, classes: e.target.className, x: e.clientX, y: e.clientY }), true);
    });
    async function penStroke(points) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points[0][0], y: points[0][1], pointerType: 'pen' });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: points[0][0], y: points[0][1], pointerType: 'pen', button: 'left', buttons: 1, clickCount: 1, force: 0.6 });
        for (const [x, y] of points.slice(1)) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'pen', button: 'none', buttons: 1, force: 0.6 });
        const [x, y] = points.at(-1);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, pointerType: 'pen', button: 'left', buttons: 0, clickCount: 1 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    await penStroke([[350, 310], [420, 350]]);
    await page.keyboard.down('d'); await penStroke(loop); await page.keyboard.up('d');
    await penStroke([[600, 320], [680, 380]]);
    fs.writeFileSync(path.join(root, 'pen-events.json'), JSON.stringify(await page.evaluate(() => ({ events: window.penEvents, selection: document.querySelector('.upper-canvas').dataset.acSelection })), null, 2));
    assert.equal((await finish(page)).canvas.objects.length, 1);
    checks.push('pen pointer events support hold-to-clear and resumed writing');

    page = await open();
    for (const width of [320, 375, 414, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const formula of [false, true]) {
            await page.locator(formula ? '#ac-formula-pen' : '#draw_free').click();
            const geometry = await page.locator('#ac-completion').evaluate(el => {
                const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth, overflow: el.scrollWidth > el.clientWidth };
            });
            assert.ok(geometry.left >= 0 && geometry.right <= geometry.width && !geometry.overflow, JSON.stringify({ width, formula, geometry }));
            await page.screenshot({ path: path.join(root, `toolbar-${width}-${formula ? 'formula' : 'pencil'}.png`) });
        }
    }
    await finish(page);
    checks.push('formula controls follow tool selection; toolbar fits 320/375/414/768/1440px');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, checks, errors }, null, 2));
    console.log('INK_SELECTION_PASSED', checks);
})().catch(error => {
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: false, checks, error: String(error), errors }, null, 2));
    console.error(error, errors); process.exitCode = 1;
}).finally(async () => { if (app) await app.evaluate(({ app }) => app.exit()).catch(() => {}); });
