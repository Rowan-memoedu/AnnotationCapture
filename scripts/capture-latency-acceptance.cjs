const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { prepareProfile, isolateWindow } = require('./acceptance-window.cjs');
const root = process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/whiteboard-latency';
const report = [];
const nativeFrames = process.argv.includes('--native');
const verify = process.argv.includes('--verify');
let app;
async function shutdown() {
    if (!app) return;
    const current = app; app = null;
    const closed = current.waitForEvent('close', { timeout: 15000 });
    await current.evaluate(({ app }) => { setTimeout(() => app.exit(), 0); });
    await closed;
}
async function run(warm) {
    console.log('LATENCY_RUN', warm ? 'preloaded' : 'new-window');
    const data = path.join(root, `${warm ? 'warm' : 'cold'}-${Date.now()}`);
    prepareProfile(data, { whiteboard: { enabled: false, maxRects: 5, includeTaskbar: true, includeWindowChrome: true } });
    app = await _electron.launch({ executablePath: process.env.ANNOTATION_EXE || path.resolve('node_modules/electron/dist/electron.exe'),
        args: [...(process.env.ANNOTATION_EXE ? [] : ['.']), '--userData', data, '--testMode', ...(warm ? ['--warmCapture'] : [])], timeout: 30000 });
    let panel;
    const panelDeadline = Date.now() + 20000;
    while (!panel && Date.now() < panelDeadline) {
        panel = app.windows().find(p => p.url().includes('annotation.html'));
        if (!panel) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(panel); await panel.waitForSelector('#ac-save-settings'); await isolateWindow(app, panel);
    if (nativeFrames) await app.evaluate(({ ipcMain, BrowserWindow, dialog }) => {
        // Exercise the installed capture path without saving desktop pixels or taking focus.
        globalThis.captureSample = {};
        const capture = ipcMain._invokeHandlers.get('annotation:capture');
        ipcMain.removeHandler('annotation:capture');
        ipcMain.handle('annotation:capture', (...args) => {
            globalThis.captureSample = { opening: performance.now() };
            return capture(...args);
        });
        const visibility = ipcMain._invokeHandlers.get('annotation:captureVisibility');
        ipcMain.removeHandler('annotation:captureVisibility');
        ipcMain.handle('annotation:captureVisibility', (...args) => {
            globalThis.captureSample.hideReceived = performance.now();
            return visibility(...args);
        });
        ipcMain.removeHandler('annotation:archive');
        ipcMain.handle('annotation:archive', async (_e, input) => {
            globalThis.captureSample.archiveReceived = performance.now();
            if (globalThis.pauseArchive)
                await new Promise(resolve => { globalThis.resumeArchive = resolve; });
            return { id: input.id };
        });
        const screenshot = ipcMain._invokeHandlers.get('annotation:screenshots');
        ipcMain.removeHandler('annotation:screenshots');
        ipcMain.handle('annotation:screenshots', async (...args) => {
            if (globalThis.failScreenshot) throw new Error('simulated screen capture failure');
            const start = performance.now(), frames = await screenshot(...args);
            globalThis.nativeSample = {captureMs:performance.now()-start, displays:frames.length,
                transport:frames[0].rgba ? 'native-raw' : frames[0].deflatedRgba ? 'native-deflate' : 'thumbnail',
                bytes:frames.reduce((n,f)=>n+(f.rgba?.length ?? f.deflatedRgba?.length ?? f.png.length),0)};
            return frames;
        });
        dialog.showMessageBox = async ({ message }) => {
            globalThis.captureError = message;
            return { response: 0, checkboxChecked: false };
        };
        const original = BrowserWindow.prototype.show;
        const focus = BrowserWindow.prototype.focus;
        BrowserWindow.prototype.focus = function () {
            if (!this.webContents.getURL().includes('capture.html')) return focus.call(this);
        };
        BrowserWindow.prototype.show = function () {
            if (!this.webContents.getURL().includes('capture.html')) return original.call(this);
            this.setFocusable(false);
            this.setBounds({ ...this.getBounds(), x: -10000 });
            this.once('hide', () => { globalThis.captureSample.hidden = performance.now(); });
            this.once('closed', () => { globalThis.captureSample.closed = performance.now(); });
            this.showInactive();
            globalThis.captureSample.shown = performance.now();
        };
    });
    else await app.evaluate(({ ipcMain, nativeImage, screen }) => {
        ipcMain.removeHandler('annotation:screenshots');
        ipcMain.handle('annotation:screenshots', () => screen.getAllDisplays().map(d => {
            const width = Math.round(d.size.width * d.scaleFactor), height = Math.round(d.size.height * d.scaleFactor);
            return { id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, png: nativeImage.createFromBitmap(Buffer.alloc(width * height * 4, 255), { width, height }).toDataURL() };
        }));
    });
    const ready = [], exits = [], frames = [], visibility = [];
    for (let i = 0; i < (verify ? 10 : 4); i++) {
        let page;
        if (warm) {
            const deadline = Date.now() + 20000;
            while (!page && Date.now() < deadline) {
                page = app.windows().find(p => !p.isClosed() && p.url().includes('capture.html'));
                if (!page) await new Promise(resolve => setTimeout(resolve, 25));
            }
            if (!page) console.log('PREWARM_DIAGNOSTIC', await app.evaluate(({ BrowserWindow }) => ({ argv: process.argv, windows: BrowserWindow.getAllWindows().map(w => ({ url: w.webContents.getURL(), destroyed: w.isDestroyed(), visible: w.isVisible() })) })));
            assert.ok(page, 'a hidden capture renderer is prepared');
            await page.waitForSelector('#ac-completion');
            assert.equal(await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url).isVisible(), page.url()), false);
        }
        const pending = warm ? Promise.resolve(page) : app.waitForEvent('window');
        const started = performance.now();
        await panel.evaluate(() => require('electron').ipcRenderer.invoke('annotation:capture', 'full'));
        page = await pending; await page.waitForFunction(() => document.body.dataset.acReady === 'true', undefined, {polling: 8});
        ready.push(performance.now() - started);
        if (nativeFrames) frames.push(await app.evaluate(() => globalThis.nativeSample));
        await isolateWindow(app, page);
        // Every prepared renderer starts with a fresh canvas and archive identity.
        assert.equal(await page.locator('#draw_photo').evaluate(c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v)), false);
        const closed = page.waitForEvent('close', { timeout: 30000 }), exitStart = performance.now();
        if (nativeFrames) await app.evaluate(() => { globalThis.captureSample.closing = performance.now(); });
        await page.keyboard.down('Escape'); await closed; exits.push(performance.now() - exitStart);
        if (nativeFrames) {
            let times = await app.evaluate(() => globalThis.captureSample);
            const deadline = Date.now() + 1000;
            while (!times.closed && Date.now() < deadline)
                times = await app.evaluate(() => globalThis.captureSample);
            assert.ok(times.shown && times.hidden && times.closed, JSON.stringify(times));
            visibility.push({
                openToShowMs: times.shown - times.opening,
                escapeToHideMs: times.hidden - times.closing,
                hideHandlerMs: times.hidden - times.hideReceived,
                hiddenToArchiveMs: times.archiveReceived - times.hidden,
                hiddenToCloseMs: times.closed - times.hidden,
            });
        }
        console.log('LATENCY_SAMPLE', JSON.stringify({ warm, sample: i, readyMs: ready.at(-1), archiveAndCloseMs: exits.at(-1) }));
    }
    if (verify) await verifyRecovery(panel);
    await shutdown();
    report.push({ mode: warm ? 'preloaded' : 'new-window', readyMs: ready, archiveAndCloseMs: exits, frames, visibility });
}
async function verifyRecovery(panel) {
    const currentCapture = () => app.windows().find(page => !page.isClosed() && page.url().includes('capture.html'));
    const open = mode => panel.evaluate(mode => require('electron').ipcRenderer.invoke('annotation:capture', mode), mode);
    const waitUntil = async condition => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            const result = await condition();
            if (result) return result;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        const state = await app.evaluate(({ BrowserWindow }) => ({
            windows: BrowserWindow.getAllWindows().map(w => w.webContents.getURL()),
            captureError: globalThis.captureError,
        }));
        throw new Error(`Timed out waiting for capture recovery: ${JSON.stringify(state)}`);
    };
    await app.evaluate(() => { globalThis.failScreenshot = true; });
    await open('full');
    assert.match(await waitUntil(() => app.evaluate(() => globalThis.captureError)), /simulated screen capture failure/);
    await app.evaluate(() => {
        globalThis.failScreenshot = false;
        globalThis.pauseArchive = true;
    });

    await open('full');
    const saved = await waitUntil(currentCapture);
    await saved.waitForFunction(() => document.body.dataset.acReady === 'true');
    await saved.keyboard.down('Escape');
    await waitUntil(() => app.evaluate(() => !!globalThis.resumeArchive));
    await open('region');
    assert.equal(currentCapture(), saved, 'the active canvas is retained until its archive succeeds');
    const savedClosed = saved.waitForEvent('close');
    await app.evaluate(() => {
        globalThis.resumeArchive();
        globalThis.pauseArchive = false;
    });
    await savedClosed;
    const reopened = await waitUntil(currentCapture);
    await reopened.waitForFunction(() => document.body.dataset.acReady === 'true');
    assert.notEqual(reopened, saved);
    assert.equal(await reopened.locator('#draw_free_pencil.select').count(), 0);
    const reopenedClosed = reopened.waitForEvent('close');
    await reopened.keyboard.down('Escape');
    await reopenedClosed;
    console.log('CAPTURE_RECOVERY_PASSED');
}
(async () => {
    if (!nativeFrames) await run(false);
    await run(true);
    const median = xs => { const sorted=[...xs].sort((a,b)=>a-b); return (sorted[Math.floor((xs.length-1)/2)]+sorted[Math.floor(xs.length/2)])/2; };
    if (nativeFrames) {
        const times = report[0].visibility;
        const opens = times.map(sample => sample.openToShowMs).sort((a,b) => a-b);
        const p90OpenMs = opens[Math.ceil(opens.length * 0.9) - 1];
        const medianOpenMs = median(opens);
        const maxHideMs = Math.max(...times.map(sample => sample.escapeToHideMs));
        const realNativeFrames = report[0].frames.every(frame => frame.transport === 'native-raw');
        const passed = !verify || (realNativeFrames && medianOpenMs <= 200 && p90OpenMs <= 300 && maxHideMs <= 100);
        const results = {passed, native:true, recoveryVerified:verify, medianOpenMs, p90OpenMs, maxHideMs, medianMs:median(report[0].readyMs), report};
        fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(results,null,2));
        console.log('NATIVE_CAPTURE_LATENCY', JSON.stringify(results));
        assert.ok(passed, 'native open and hide latency must meet the acceptance targets');
        return;
    }
    const before = median(report[0].readyMs), after = median(report[1].readyMs);
    assert.ok(after < before, 'preloading must improve median time to drawable canvas');
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, beforeMedianMs: before, afterMedianMs: after, report }, null, 2));
    console.log('CAPTURE_LATENCY_PASSED', JSON.stringify({ beforeMedianMs: before, afterMedianMs: after, report }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await shutdown().catch(() => {}); });
