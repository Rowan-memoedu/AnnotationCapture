const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { prepareProfile, isolateWindow } = require('./acceptance-window.cjs');
const root = process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/whiteboard-live';
const data = path.join(root, `profile-${Date.now()}`); prepareProfile(data, { shortcut: '', fullShortcut: '', ocrShortcut: '' });
let app;
const checks = [];
(async () => {
    app = await _electron.launch({ executablePath: process.env.ANNOTATION_EXE || path.resolve('node_modules/electron/dist/electron.exe'),
        args: [...(process.env.ANNOTATION_EXE ? [] : ['.']), '--userData', data, '--testMode'], timeout: 30000 });
    const panel = await app.firstWindow(); await panel.waitForSelector('#ac-save-settings'); await isolateWindow(app, panel);
    const invitation = JSON.parse(fs.readFileSync(process.env.ANNOTATION_INVITE_FILE));
    await panel.evaluate(code => require('electron').ipcRenderer.invoke('annotation:login', code), invitation.inviteCode);
    for (const { layout, allowed, cached } of [{ layout: 'lesson', allowed: true }, { layout: 'lesson', allowed: true, cached: true },
        { layout: 'lesson', allowed: false }, { layout: 'notes', allowed: false }, { layout: 'dashboard', allowed: false }, { layout: 'document', allowed: false }]) {
    console.log('WHITEBOARD_LIVE_RUN', layout, allowed);
    const fixture = await panel.evaluate(layout => {
        const c = document.createElement('canvas'); c.width = 1200; c.height = 800; const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = '#e5e7eb'; ctx.fillRect(0, 0, 1200, 42); ctx.fillRect(0, 758, 1200, 42);
        const protectedAreas = [];
        function text(value, x, y, size = 26) { ctx.font = `${size}px Arial`; ctx.fillStyle = layout === 'dashboard' ? '#f9fafb' : '#111827'; ctx.fillText(value, x, y);
            const m = ctx.measureText(value); protectedAreas.push({ x: x - 4, y: y - m.actualBoundingBoxAscent - 4, width: m.width + 8, height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + 8 }); }
        ctx.font = '18px Arial'; ctx.fillStyle = '#1f2937'; ctx.fillText('Lesson viewer   -   [ ]   X', 24, 28); ctx.fillText('Start          Browser          Notes                                         12:30', 24, 784);
        if (layout === 'lesson') {
        text('Quadratic functions', 250, 125, 34);
        text('A parabola is the graph of a quadratic function.', 250, 182);
        text('y = x² - 2x + 1', 250, 245, 32);
        text('The vertex is at (1, 0).', 250, 302);
        ctx.strokeStyle = '#172554'; ctx.lineWidth = 3; ctx.strokeRect(250, 352, 600, 270);
        ctx.beginPath(); ctx.moveTo(300, 575); ctx.lineTo(790, 575); ctx.moveTo(480, 380); ctx.lineTo(480, 600); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(360, 400); ctx.quadraticCurveTo(540, 740, 720, 400); ctx.stroke();
        protectedAreas.push({ x: 246, y: 348, width: 608, height: 278 });
        } else if (layout === 'notes') {
            ctx.fillStyle = '#dbeafe'; ctx.fillRect(0, 42, 190, 716);
            text('Notebook', 24, 102, 24); text('Reading', 24, 160, 22); text('Practice', 24, 208, 22);
            protectedAreas.push({ x: 0, y: 42, width: 190, height: 716 });
            ctx.fillStyle = '#f1f5f9'; ctx.fillRect(245, 100, 470, 230);
            text('Daily notes', 268, 152, 30); text('1. Read chapter three.', 268, 214, 24); text('2. Review the definitions.', 268, 274, 24);
            protectedAreas.push({ x: 245, y: 100, width: 470, height: 230 });
            text('Next session: 14:00', 280, 590, 26);
        } else if (layout === 'dashboard') {
            ctx.fillStyle='#111827'; ctx.fillRect(0,42,1200,716);
            ctx.fillStyle='#1f2937'; ctx.fillRect(0,42,180,716);
            text('Dashboard',18,100,22); text('Reports',18,150,22);
            protectedAreas.push({x:0,y:42,width:180,height:716});
            for(const [x,w,label] of [[230,360,'Completed  78'],[650,340,'Pending  12']]){
                ctx.fillStyle='#374151';ctx.fillRect(x,100,w,200);text(label,x+22,155,28);
                protectedAreas.push({x,y:100,width:w,height:200});
            }
            ctx.strokeStyle='#d1d5db';ctx.lineWidth=3;ctx.strokeRect(230,380,760,260);
            text('Weekly activity',250,420,24);ctx.beginPath();ctx.moveTo(280,590);ctx.lineTo(950,590);ctx.moveTo(280,460);ctx.lineTo(280,590);ctx.stroke();
            protectedAreas.push({x:226,y:376,width:768,height:268});
        } else {
            text('Linear algebra notes',80,110,34);
            for(const x of [80,640])for(let i=0;i<5;i++)text('A vector space has a basis.',x,180+i*52,24);
            ctx.strokeStyle='#111827';ctx.lineWidth=2;ctx.strokeRect(80,470,1000,170);
            for(const x of [400,740]){ctx.beginPath();ctx.moveTo(x,470);ctx.lineTo(x,640);ctx.stroke();}
            text('Dimension',105,515,24);text('Rank',435,515,24);text('Nullity',775,515,24);
            protectedAreas.push({x:76,y:466,width:1008,height:178});
        }
        return { png: c.toDataURL(), protectedAreas, width: c.width, height: c.height };
    }, layout);
    fs.writeFileSync(path.join(root, `synthetic-${layout}.png`), Buffer.from(fixture.png.split(',')[1], 'base64'));
    await app.evaluate(({ ipcMain, screen }, png) => {
        ipcMain.removeHandler('annotation:screenshots');
        ipcMain.handle('annotation:screenshots', () => screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, png })));
    }, fixture.png);
        await panel.evaluate(async allowed => { const ipc = require('electron').ipcRenderer, s = await ipc.invoke('annotation:state');
            await ipc.invoke('annotation:configure', { ...s.config, whiteboard: { enabled: true, maxRects: 5, includeTaskbar: allowed, includeWindowChrome: allowed } });
        }, allowed);
        const next = app.waitForEvent('window'), started = performance.now();
        await panel.evaluate(() => require('electron').ipcRenderer.invoke('annotation:capture', 'full'));
        const page = await next; await page.waitForFunction(() => document.body.dataset.acReady === 'true');
        const drawableAt = performance.now(); await isolateWindow(app, page);
        const alignment = await page.evaluate(() => {
            const a = document.querySelector('#main_photo').getBoundingClientRect(), b = document.querySelector('#draw_photo').getBoundingClientRect();
            return ['x', 'y', 'width', 'height'].map(key => Math.abs(a[key] - b[key]));
        });
        assert.ok(alignment.every(delta => delta < 1), `screenshot and whiteboard must align on screen: ${alignment}`);
        await page.waitForFunction(() => !document.querySelector('#ac-whiteboard-status').textContent.startsWith('正在'), undefined, { timeout: 15000 });
        const status = await page.locator('#ac-whiteboard-status').textContent();
        assert.equal(status, '空白区域已就绪', `real model must return usable regions: ${status}`);
        const durationMs = performance.now() - started;
        const captureReadyMs = drawableAt - started, detectionAfterReadyMs = durationMs - captureReadyMs;
        assert.ok(durationMs < 8000, `capture and blank-area detection must be responsive: ${durationMs} ms`);
        assert.ok(!cached || detectionAfterReadyMs < 1500, `cached detection after drawable canvas must be responsive: ${detectionAfterReadyMs} ms`);
        await page.locator('#ac-whiteboard').click();
        await page.screenshot({ path: path.join(root, `live-${layout}-${allowed ? 'chrome-allowed' : 'chrome-protected'}.png`) });
        const closed = page.waitForEvent('close'); await page.keyboard.press('Escape'); await closed;
        const all = [];
        function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'annotations.json') all.push(p); } }
        walk(path.join(data, 'Archive')); const file = all.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        const rects = JSON.parse(fs.readFileSync(file)).canvas.objects.filter(o => o.acWhiteboard).map(o => ({ x: o.left, y: o.top, width: o.width, height: o.height, fixed: o.acFixed }));
        assert.ok(rects.length > 0 && rects.length <= 5 && rects.every(r => r.fixed));
        function overlap(a, b) { return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)); }
        const protectedAreas = [...fixture.protectedAreas, ...(!allowed ? [{ x: 0, y: 0, width: 1200, height: 42 }, { x: 0, y: 758, width: 1200, height: 42 }] : [])];
        const overlapPixels = rects.reduce((total, r) => total + protectedAreas.reduce((n, p) => n + overlap(r, p), 0), 0);
        const coverage = rects.reduce((n, r) => n + r.width * r.height, 0) / (1200 * 800);
        checks.push({ layout, cached: !!cached, chromeAllowed: allowed, count: rects.length, durationMs, captureReadyMs, detectionAfterReadyMs, protectedOverlapPixels: overlapPixels, coverage, rects });
        assert.equal(overlapPixels, 0, 'model rectangles must not cover the known content or protected chrome in this fixture');
        assert.ok(coverage > .15, 'model should find substantial blank writing space');
    }
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, checks, fixture: 'synthetic lesson, notebook, dark dashboard and two-column document with measured content bounds', cacheMeasurement: 'Detection after drawable canvas; cold window creation is reported separately and still included in the overall 8-second bound.', liveProvider: true }, null, 2));
    console.log('WHITEBOARD_LIVE_PASSED', JSON.stringify(checks));
})().catch(error => { fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: false, checks, error: String(error) }, null, 2)); console.error(error); process.exitCode = 1; })
.finally(async () => { if (app) await app.close().catch(() => {}); });
