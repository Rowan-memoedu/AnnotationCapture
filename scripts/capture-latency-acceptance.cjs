const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { prepareProfile, isolateWindow } = require('./acceptance-window.cjs');
const root = process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/whiteboard-latency';
const report = [];
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
    await app.evaluate(({ ipcMain, nativeImage, screen }) => {
        ipcMain.removeHandler('annotation:screenshots');
        ipcMain.handle('annotation:screenshots', () => screen.getAllDisplays().map(d => {
            const width = Math.round(d.size.width * d.scaleFactor), height = Math.round(d.size.height * d.scaleFactor);
            return { id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, png: nativeImage.createFromBitmap(Buffer.alloc(width * height * 4, 255), { width, height }).toDataURL() };
        }));
    });
    const ready = [], exits = [];
    for (let i = 0; i < 4; i++) {
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
        page = await pending; await page.waitForFunction(() => document.body.dataset.acReady === 'true');
        ready.push(performance.now() - started);
        await isolateWindow(app, page);
        // Every prepared renderer starts with a fresh canvas and archive identity.
        assert.equal(await page.locator('#draw_photo').evaluate(c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v)), false);
        const closed = page.waitForEvent('close', { timeout: 30000 }), exitStart = performance.now();
        await page.keyboard.press('Escape'); await closed; exits.push(performance.now() - exitStart);
        console.log('LATENCY_SAMPLE', JSON.stringify({ warm, sample: i, readyMs: ready.at(-1), archiveAndCloseMs: exits.at(-1) }));
    }
    await shutdown();
    report.push({ mode: warm ? 'preloaded' : 'new-window', readyMs: ready, archiveAndCloseMs: exits });
}
(async () => {
    await run(false); await run(true);
    const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const before = median(report[0].readyMs), after = median(report[1].readyMs);
    assert.ok(after < before, 'preloading must improve median time to drawable canvas');
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, beforeMedianMs: before, afterMedianMs: after, report }, null, 2));
    console.log('CAPTURE_LATENCY_PASSED', JSON.stringify({ beforeMedianMs: before, afterMedianMs: after, report }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await shutdown().catch(() => {}); });
