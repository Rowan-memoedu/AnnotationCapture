const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/acceptance';
fs.mkdirSync(root, { recursive: true });
const run = `ui-${Date.now()}`;
const data = path.join(root, run);
const errors = [];
let app;
async function launch(extra = []) {
    app = await _electron.launch({ executablePath: process.env.ANNOTATION_EXE || path.resolve('node_modules/electron/dist/electron.exe'), cwd: process.env.ANNOTATION_EXE ? path.dirname(process.env.ANNOTATION_EXE) : process.cwd(), args: [...(process.env.ANNOTATION_EXE ? [] : ['.']), '--userData', data, '--archiveRoot', path.join(data, 'Archive'), '--testMode', ...extra], env: { ...process.env, ...(process.env.ANNOTATION_EXE ? { PATH: `${process.env.SystemRoot}/System32;${process.env.SystemRoot}`, NODE_PATH: '', NODE_OPTIONS: '' } : {}), DEEPSEEK_API_KEY: '', ANNOTATION_DEEPSEEK_API_KEY: '' }, timeout: 30000 });
    app.on('window', page => { page.on('pageerror', e => errors.push(e.message)); });
    const page = await app.firstWindow();
    await page.waitForSelector('#ac-start');
    return page;
}
async function capture(panel) {
    const pending = app.waitForEvent('window');
    await panel.locator('#ac-start').click();
    const page = await pending;
    await page.waitForSelector('#ac-completion', { state: 'visible' });
    await page.waitForFunction(() => document.body.style.opacity !== '0');
    return page;
}
async function archiveFiles() {
    const all = [];
    const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name === 'capture.png') all.push(p); } };
    if (fs.existsSync(path.join(data, 'Archive'))) walk(path.join(data, 'Archive'));
    return all;
}
async function finish(page, key = 'Escape') {
    const closed = page.waitForEvent('close');
    await page.keyboard.press(key);
    await closed;
}
async function showPanel() { await app.evaluate(({ BrowserWindow }) => { const p = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('annotation.html')); p.show(); }); return app.windows().find(p => p.url().endsWith('annotation.html')); }
async function draw(page, points) {
    await page.mouse.move(...points[0]); await page.mouse.down();
    for (const p of points.slice(1)) await page.mouse.move(...p, { steps: 3 });
    await page.mouse.up();
}

(async () => {
    const panel = await launch();
    assert.match(await panel.locator('#ac-key-status').innerText(), /未配置/);
    await panel.screenshot({ path: path.join(root, 'settings-unconfigured.png') });
    const page = await capture(panel);
    await page.screenshot({ path: path.join(root, 'capture-before.png') });
    const size = await page.locator('#main_photo').evaluate(c => ({ width: c.width, height: c.height })).catch(() => page.evaluate(() => [...document.querySelectorAll('canvas')].map(c => ({ id: c.id, width: c.width, height: c.height }))));
    console.log('CAPTURE_GEOMETRY', JSON.stringify(size));
    await page.locator('#draw_free').click();
    await draw(page, [[350, 270], [390, 310], [430, 350]]);
    await draw(page, [[350, 350], [390, 310], [430, 270]]);
    await page.screenshot({ path: path.join(root, 'ink-before-archive.png') });
    await finish(page);
    const files = await archiveFiles(); assert.equal(files.length, 1);
    console.log('ARCHIVE_OK', files[0]);
    const p2 = await capture(await showPanel());
    await p2.locator('#draw_free').click();
    await draw(p2, [[350, 270], [390, 310], [430, 350]]);
    await draw(p2, [[350, 350], [390, 310], [430, 270]]);
    await p2.keyboard.press('Control+Shift+Enter');
    await p2.waitForSelector('#ac-selection');
    const bounds = await p2.locator('#ac-selection').boundingBox();
    await draw(p2, [[bounds.x + bounds.width * 0.1, bounds.y + bounds.height * 0.1], [bounds.x + bounds.width * 0.9, bounds.y + bounds.height * 0.9]]);
    await p2.screenshot({ path: path.join(root, 'formula-selection.png') });
    const closed = p2.waitForEvent('close'); await p2.locator('#ac-recognize').click(); await closed;
    const resultPanel = await showPanel();
    await resultPanel.waitForSelector('[data-status="unconfigured"]');
    await resultPanel.screenshot({ path: path.join(root, 'unconfigured-result.png') });
    const state = await resultPanel.evaluate(() => require('electron').ipcRenderer.invoke('annotation:state'));
    assert.equal(state.jobs[0].status, 'unconfigured'); assert.equal(state.jobs[0].latex, '');
    assert.equal((await archiveFiles()).length, 2);
    assert.equal(errors.length, 0, errors.join('\n'));
    fs.writeFileSync(path.join(root, 'ui-report.json'), JSON.stringify({ run, data, files: await archiveFiles(), size, jobs: state.jobs, errors, passed: true }, null, 2));
    console.log('UI_ACCEPTANCE_PASSED');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (app) { await app.evaluate(({ app }) => app.exit()); } });
