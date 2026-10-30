const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { prepareProfile, isolateWindow } = require('./acceptance-window.cjs');
const root = process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/settings';
const data = path.join(root, 'settings-profile-' + Date.now());
fs.mkdirSync(root, { recursive: true }); prepareProfile(data);
let app;
const checks = [], errors = [];
async function launch() {
    app = await _electron.launch({ executablePath: process.env.ANNOTATION_EXE || path.resolve('node_modules/electron/dist/electron.exe'), args: [...(process.env.ANNOTATION_EXE ? [] : ['.']), '--userData', data, '--testMode'] });
    const panel = await app.firstWindow(); panel.on('pageerror', e => errors.push(String(e)));
    await panel.waitForSelector('#ac-save-settings'); await isolateWindow(app, panel);
    return panel;
}
async function trayClick() {
    return app.evaluate(async ({ Tray, BrowserWindow }) => {
        const session = new (process.getBuiltinModule('inspector').Session)(); session.connect();
        const post = (method, args = {}) => new Promise((resolve, reject) => session.post(method, args, (e, r) => e ? reject(e) : resolve(r)));
        globalThis.acTrayPrototype = Tray.prototype;
        try {
            const prototype = await post('Runtime.evaluate', { expression: 'globalThis.acTrayPrototype', objectGroup: 'tray-acceptance' });
            const objects = await post('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: 'tray-acceptance' });
            const result = await post('Runtime.callFunctionOn', { objectId: objects.objects.objectId, functionDeclaration: 'function() { const trays = this.filter(t => t.listenerCount?.("click") > 0); if (trays.length !== 1) throw new Error("Expected one live tray click listener, found " + trays.length + " of " + this.length); return trays[0].emit("click"); }', returnByValue: true });
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
            return BrowserWindow.getAllWindows().map(w => ({ url: w.webContents.getURL(), visible: w.isVisible() }));
        } finally { delete globalThis.acTrayPrototype; await post('Runtime.releaseObjectGroup', { objectGroup: 'tray-acceptance' }); session.disconnect(); }
    });
}
(async () => {
    let panel = await launch();
    assert.equal(await panel.locator('#ac-start, #ac-start-full, #ac-start-ocr').count(), 0);
    assert.equal(await panel.locator('#ac-lasso-rule').inputValue(), 'intersect');
    assert.equal(await panel.locator('#ac-retention-days').inputValue(), '7');
    const state = await panel.evaluate(() => require('electron').ipcRenderer.invoke('annotation:state'));
    assert.equal(await app.evaluate(({ globalShortcut }, keys) => keys.every(k => globalShortcut.isRegistered(k)), [state.config.shortcut, state.config.fullShortcut, state.config.ocrShortcut]), true);
    checks.push('capture buttons removed; three shortcuts remain registered; legacy settings default to intersect');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.hide()));
    const windows = await trayClick();
    assert.equal(windows.length, 1); assert.equal(windows[0].visible, true); assert.match(windows[0].url, /annotation\.html$/);
    await isolateWindow(app, panel);
    checks.push('actual tray click listener opens settings, creates no capture');
    await panel.locator('#ac-lasso-rule').selectOption('contain');
    await panel.locator('#ac-retention-days').fill('14');
    await panel.locator('#ac-save-settings').click();
    await panel.waitForFunction(() => document.querySelector('#ac-panel-status').textContent.includes('设置已保存'));
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'annotation-settings.json'), 'utf8'));
    assert.equal(saved.lassoRule, 'contain');
    assert.equal(saved.archiveRetentionDays, 14);
    await app.evaluate(({ app }) => app.exit()); app = undefined;
    panel = await launch(); assert.equal(await panel.locator('#ac-lasso-rule').inputValue(), 'contain');
    assert.equal(await panel.locator('#ac-retention-days').inputValue(), '14');
    for (const days of [-1, 1.5, 3651]) await assert.rejects(panel.evaluate(async days => { const ipc = require('electron').ipcRenderer; const s = await ipc.invoke('annotation:state'); return ipc.invoke('annotation:configure', { ...s.config, archiveRetentionDays: days }); }, days));
    assert.equal((await panel.evaluate(() => require('electron').ipcRenderer.invoke('annotation:state'))).config.archiveRetentionDays, 14);
    checks.push('legacy retention defaults to 7 days; custom value survives restart; invalid days preserve settings');
    await assert.rejects(panel.evaluate(async () => { const ipc = require('electron').ipcRenderer; const s = await ipc.invoke('annotation:state'); return ipc.invoke('annotation:configure', { ...s.config, lassoRule: 'invalid' }); }));
    assert.equal((await panel.evaluate(() => require('electron').ipcRenderer.invoke('annotation:state'))).config.lassoRule, 'contain');
    checks.push('saved containment rule survives process restart; invalid values are rejected without overwriting');
    for (const width of [320, 375, 414, 768, 1440]) {
        await panel.setViewportSize({ width, height: 900 });
        const layout = await panel.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        assert.ok(layout.scroll <= layout.width, JSON.stringify(layout));
        const select = await panel.locator('#ac-lasso-rule').evaluate(el => { const s = getComputedStyle(el); const ctx = document.createElement('canvas').getContext('2d'); ctx.font = `${s.fontSize} ${s.fontFamily}`; const m = ctx.measureText(el.selectedOptions[0].textContent); return { contentHeight: el.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom), textHeight: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent }; });
        assert.ok(select.contentHeight >= select.textHeight, JSON.stringify(select));
        await panel.locator('#ac-lasso-rule').scrollIntoViewIfNeeded();
        await panel.screenshot({ path: path.join(root, `settings-${width}.png`) });
    }
    checks.push('settings fit 320/375/414/768/1440px'); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(root, 'settings-report.json'), JSON.stringify({ passed: true, checks, errors }, null, 2));
    console.log('SETTINGS_ACCEPTANCE_PASSED', checks);
})().catch(error => { fs.writeFileSync(path.join(root, 'settings-report.json'), JSON.stringify({ passed: false, checks, errors, error: String(error) }, null, 2)); console.error(error); process.exitCode = 1; }).finally(async () => { if (app) await app.evaluate(({ app }) => app.exit()).catch(() => {}); });
