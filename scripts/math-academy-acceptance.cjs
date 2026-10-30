const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { prepareProfile, isolateWindow } = require('./acceptance-window.cjs');
const root = path.join(process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/math-academy', 'app');
fs.mkdirSync(root, { recursive: true });
const data = path.join(root, `profile-${Date.now()}`);
prepareProfile(data);
let app, panel, responseLatex = '', responseDelay = 0;
const requests = [], checks = [], outputs = [];
const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/login') return res.end(JSON.stringify({ token: 'T'.repeat(43), accountId: 'fixture', label: '输入适配验收', providerReady: true }));
    if (req.url === '/session') return res.end(JSON.stringify({ label: '输入适配验收', providerReady: true }));
    if (req.url === '/recognize') {
        const input = JSON.parse(body);
        requests.push({ format: input.outputFormat || 'latex', png: input.png.startsWith('data:image/png;base64,') });
        const latex = responseLatex;
        await new Promise(resolve => setTimeout(resolve, responseDelay));
        return res.end(JSON.stringify({ latex, model: 'controlled-output-fixture' }));
    }
    res.writeHead(404); res.end('{}');
});
const state = () => panel.evaluate(() => require('electron').ipcRenderer.invoke('annotation:state'));
async function launch() {
    app = await _electron.launch({ executablePath: process.env.ANNOTATION_EXE || path.resolve('node_modules/electron/dist/electron.exe'), args: [...(process.env.ANNOTATION_EXE ? [] : ['.']), '--userData', data, '--testMode'], env: { ...process.env, ANNOTATION_SERVICE_URL: `http://127.0.0.1:${server.address().port}` } });
    panel = await app.firstWindow(); await panel.waitForSelector('#ac-save-settings'); await isolateWindow(app, panel);
}
async function waitJob(id) {
    for (let attempt = 0; attempt < 150; attempt++) {
        const job = (await state()).jobs.find(j => j.id === id);
        if (['copied', 'review', 'error'].includes(job?.status)) return job;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Recognition did not finish: ${id}`);
}
async function createJob(source, format = 'mathAcademy') {
    responseLatex = source;
    const job = await panel.evaluate(async format => {
        const ipc = require('electron').ipcRenderer;
        const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 120, 80); ctx.fillStyle = 'black'; ctx.fillText('fixture', 10, 30);
        const png = canvas.toDataURL();
        const a = await ipc.invoke('annotation:archive', { id: crypto.randomUUID(), capturedAt: new Date().toISOString(), png, rect: { x: 0, y: 0, width: 120, height: 80 }, screenId: 1 });
        return ipc.invoke('annotation:formula', { archiveId: a.id, png, rect: { x: 0, y: 0, width: 120, height: 80 }, outputFormat: format });
    }, format);
    return waitJob(job.id);
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); await launch();
    await panel.locator('#ac-default-output-format').selectOption('mathAcademy');
    await panel.locator('#ac-save-settings').click();
    await panel.waitForFunction(() => document.querySelector('#ac-panel-status').textContent.includes('设置已保存'));
    await app.evaluate(({ app }) => app.exit()); app = null; await launch();
    assert.equal(await panel.locator('#ac-default-output-format').inputValue(), 'mathAcademy');
    checks.push('Math Academy output preference survives restart');
    await panel.locator('#ac-invite-code').fill('AC-controlled-fixture'); await panel.locator('#ac-login').click();
    await panel.waitForFunction(() => document.querySelector('#ac-login-status').textContent.includes('识别服务可用'));
    // Deterministic screenshots only; exercise the real selection -> archive -> job path.
    await app.evaluate(({ ipcMain, screen, nativeImage }) => {
        ipcMain.removeHandler('annotation:screenshots');
        ipcMain.handle('annotation:screenshots', () => screen.getAllDisplays().map(d => {
            const width = Math.round(d.size.width * d.scaleFactor), height = Math.round(d.size.height * d.scaleFactor);
            return { id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, png: nativeImage.createFromBitmap(Buffer.alloc(width * height * 4, 255), { width, height }).toDataURL() };
        }));
    });
    const pending = app.waitForEvent('window');
    await panel.evaluate(() => require('electron').ipcRenderer.invoke('annotation:capture', 'full'));
    const capture = await pending; await capture.waitForSelector('#ac-formula-pen'); await isolateWindow(app, capture);
    await capture.mouse.move(350, 300); await capture.mouse.down(); await capture.mouse.move(450, 400, { steps: 8 }); await capture.mouse.up();
    await capture.keyboard.press('Control+Shift+Enter'); await capture.waitForSelector('#ac-output-format');
    assert.equal(await capture.locator('#ac-output-format').inputValue(), 'mathAcademy');
    const box = await capture.locator('#ac-selection').boundingBox();
    await capture.mouse.move(box.x + 10, box.y + 10); await capture.mouse.down(); await capture.mouse.move(box.x + box.width - 10, box.y + box.height - 10, { steps: 6 }); await capture.mouse.up();
    responseLatex = '\\displaystyle \\dfrac{X+x}{2}';
    const closed = capture.waitForEvent('close'); await capture.locator('#ac-recognize').click(); await closed;
    const first = await waitJob((await state()).jobs[0].id);
    assert.equal(first.status, 'copied'); assert.equal(first.latex, '\\frac{X+x}{2}');
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), first.latex);
    checks.push('selection dialog enables Math Academy; production archive and clipboard path passes');
    const cases = [
        ['display-fraction', '$$\\displaystyle \\dfrac{X+x}{2}$$'],
        ['nested-root', '\\sqrt[3]{x_1^2+\\frac{1}{y}}'],
        ['exponential', 'e^{-2t}+\\left(1-p+pe^t\\right)^n'],
        ['integral-spacing', '\\int_0^1 x^2\\,dx'],
        ['sum', '\\sum_{i=1}^{n}i^2'],
        ['functions', '\\operatorname{sin}\\left(x\\right)+\\log_{2}(x)'],
        ['binomial', '\\binom{n}{k}'],
        ['greek', '\\alpha_1+\\theta^2+\\lambda'],
        ['relations', 'x≤2π+\\infty'],
        ['semantic-fonts', '\\mathrm{e}^{x}+\\mathbf{x}'],
        ['set-braces', '\\left\\{a,b\\right\\}'],
    ];
    for (const [name, source] of cases) {
        const job = await createJob(source); assert.equal(job.status, 'copied', job.message);
        const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText()); assert.equal(clipboard, job.latex);
        outputs.push({ name, source, output: clipboard, original: job.recognizedLatex });
    }
    assert.ok(requests.every(r => r.format === 'latex' && r.png));
    checks.push('11 output samples produced through gateway client, jobs, archive and real clipboard');
    await app.evaluate(({ clipboard }) => clipboard.writeText('keep-this-clipboard'));
    const unsupported = '\\begin{aligned}x&=1\\\\y&=2\\end{aligned}';
    const review = await createJob(unsupported);
    assert.equal(review.status, 'review'); assert.equal(review.latex, unsupported); assert.ok(review.outputIssue);
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'keep-this-clipboard');
    await panel.locator(`#copy-${review.id}`).click();
    await panel.waitForFunction(() => document.querySelector('#ac-panel-status').textContent.includes('Math Academy'));
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'keep-this-clipboard');
    await panel.locator(`#result-${review.id}`).scrollIntoViewIfNeeded();
    await panel.screenshot({ path: path.join(root, 'unsupported-preserved.png') });
    await panel.locator(`#result-${review.id}`).fill('\\dfrac{a}{b}'); await panel.locator(`#copy-${review.id}`).click();
    await panel.waitForFunction(() => document.querySelector('[data-status="copied"]'));
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '\\frac{a}{b}');
    assert.equal((await state()).jobs.find(j => j.id === review.id).recognizedLatex, unsupported);
    responseLatex = '\\sqrt{x+1}';
    await panel.locator(`#retry-${review.id}`).click(); await waitJob(review.id);
    assert.equal((await state()).jobs.find(j => j.id === review.id).outputFormat, 'mathAcademy');
    checks.push('unsupported structures retain source and clipboard; edited copy and retry keep selected format');
    responseDelay = 700;
    const beforeRequests = requests.length;
    const delayed = createJob('x+1');
    for (let i = 0; requests.length === beforeRequests && i < 150; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(requests.length > beforeRequests, 'Gateway request must have started before testing a clipboard change');
    await app.evaluate(({ clipboard }) => clipboard.writeText('newer-user-copy'));
    const race = await delayed; assert.equal(race.status, 'review');
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'newer-user-copy');
    responseDelay = 0;
    checks.push('clipboard changed during recognition is protected');
    const ordinary = await createJob(unsupported, 'latex'); assert.equal(ordinary.status, 'copied'); assert.equal(ordinary.latex, unsupported);
    checks.push('raw LaTeX output remains unrestricted');
    await createJob('\\frac{x^2+1}{\\sqrt{y}}');
    for (const width of [320, 375, 414, 768, 1440]) {
        await panel.setViewportSize({ width, height: 900 });
        await panel.locator('#ac-results').scrollIntoViewIfNeeded();
        const layout = await panel.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        assert.ok(layout.scroll <= layout.width, JSON.stringify(layout));
        const buttons = await panel.locator('#ac-results .ac-button').evaluateAll(elements => elements.map(e => ({ height: e.getBoundingClientRect().height, nowrap: getComputedStyle(e).whiteSpace })));
        assert.ok(buttons.every(b => b.height >= 44 && b.nowrap === 'nowrap'), 'Result action labels must stay on one line at every width');
        await panel.screenshot({ path: path.join(root, `results-${width}.png`) });
    }
    assert.equal(requests.at(-1).format, 'latex');
    fs.writeFileSync(path.join(root, 'math-academy-outputs.json'), JSON.stringify(outputs, null, 2));
    fs.writeFileSync(path.join(root, 'math-academy-report.json'), JSON.stringify({ passed: true, checks, sampleCount: outputs.length, gateway: 'controlled local fixture; not live OCR', version: (await state()).config.version }, null, 2));
    console.log('MATH_ACADEMY_APP_ACCEPTANCE_PASSED', JSON.stringify(checks));
})().catch(error => { fs.writeFileSync(path.join(root, 'math-academy-report.json'), JSON.stringify({ passed: false, checks, error: String(error.stack) }, null, 2)); console.error(error); process.exitCode = 1; }).finally(async () => { if (app) await app.evaluate(({ app }) => app.exit()).catch(() => {}); server.close(); });
