const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { prepareProfile, isolateWindow } = require('./acceptance-window.cjs');
const root = process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/pressure-0.6.0';
const data = path.join(root, `profile-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });
prepareProfile(data, { penWidth: 14, penColor: '#2266cc' });
let app, panel;
const checks = [], errors = [];
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function configure(values) {
    await panel.evaluate(async values => { const ipc = require('electron').ipcRenderer; const s = await ipc.invoke('annotation:state'); await ipc.invoke('annotation:configure', { ...s.config, ...values }); }, values);
}
async function open(mode = 'full') {
    const next = app.waitForEvent('window');
    await panel.evaluate(mode => require('electron').ipcRenderer.invoke('annotation:capture', mode), mode);
    const page = await next;
    page.on('pageerror', e => errors.push(String(e)));
    await page.waitForFunction(() => document.querySelector('#ac-completion') && document.body.style.opacity !== '0');
    await isolateWindow(app, page);
    if (mode === 'region') {
        await page.mouse.move(180, 130); await page.mouse.down(); await page.mouse.move(1120, 730, { steps: 8 }); await page.mouse.up();
    }
    await page.waitForFunction(() => document.querySelector('#draw_free_pencil').classList.contains('select'));
    return page;
}
async function input(page) {
    const cdp = await page.context().newCDPSession(page);
    return async (type, x, y, force = 0.5, pointerType = 'pen') => cdp.send('Input.dispatchMouseEvent', {
        type, x, y, pointerType, button: type === 'mouseMoved' ? 'none' : 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: type === 'mouseMoved' ? 0 : 1, force: type === 'mouseReleased' ? 0 : force,
    });
}
async function line(page, y, force, pointerType = 'pen') {
    const send = await input(page);
    const initial = typeof force === 'number' ? force : 0.05;
    await send('mouseMoved', 340, y, initial, pointerType);
    await send('mousePressed', 340, y, initial, pointerType);
    const box = await page.locator('.upper-canvas').boundingBox();
    assert.ok(box && 340 >= box.x && 640 < box.x + box.width && y >= box.y && y < box.y + box.height, 'Test stroke must stay inside the canvas: '+JSON.stringify({box,y}));
    for (let x = 350; x <= 640; x += 10) await send('mouseMoved', x, y, typeof force === 'number' ? force : (x - 340) / 300, pointerType);
    await send('mouseReleased', 640, y, 0, pointerType);
    await settle(page);
}
async function thickness(page, y, x = 520) {
    return page.locator('#draw_photo').evaluate((canvas, { x, y }) => {
        const b = canvas.getBoundingClientRect(), sx = canvas.width / b.width, sy = canvas.height / b.height;
        const top = Math.max(0, Math.round((y - 40 - b.top) * sy)), bottom = Math.min(canvas.height, Math.round((y + 40 - b.top) * sy));
        const pixels = canvas.getContext('2d').getImageData(Math.round((x - b.left) * sx), top, 1, bottom - top).data;
        let count = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 80) count++;
        return count / sy * devicePixelRatio;
    }, { x, y });
}
const image = page => page.locator('#draw_photo').evaluate(c => c.toDataURL());
async function sameGeometry(page, before, label) {
    const after = await image(page);
    const stats = await page.evaluate(async ([before, after]) => {
        const images = await Promise.all([before, after].map(async src => { const image = new Image(); image.src = src; await image.decode(); return image; }));
        const width = images[0].width, height = images[0].height;
        const masks = images.map(image => { const c = document.createElement('canvas'); c.width = width; c.height = height; const ctx = c.getContext('2d'); ctx.drawImage(image,0,0); return ctx.getImageData(0,0,width,height).data; });
        const missing = [0,0], counts = [0,0];
        for (let side=0; side<2; side++) {
            const a=masks[side],b=masks[1-side];
            for(let y=0;y<height;y++)for(let x=0;x<width;x++){
                if(a[(y*width+x)*4+3]<=80)continue;
                counts[side]++;
                let found=false;
                for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
                    const xx=x+dx,yy=y+dy;
                    if(xx>=0&&yy>=0&&xx<width&&yy<height&&b[(yy*width+xx)*4+3]>80)found=true;
                }
                if(!found)missing[side]++;
            }
        }
        return {missing,counts};
    },[before,after]);
    if(stats.missing.some(Boolean)){
        fs.writeFileSync(path.join(root,label+'-before.png'),Buffer.from(before.split(',')[1],'base64'));
        fs.writeFileSync(path.join(root,label+'-after.png'),Buffer.from(after.split(',')[1],'base64'));
    }
    // Fabric rehydration may move an antialiased edge by one device pixel.
    assert.deepEqual(stats.missing,[0,0],label+': '+JSON.stringify(stats));
}
function records() {
    const out = [];
    function walk(dir) { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (e.name === 'annotations.json') out.push(f); } }
    walk(path.join(data, 'Archive')); return out;
}
async function finish(page) {
    const before = records(); const closing = page.waitForEvent('close');
    await page.keyboard.press('Escape'); await closing;
    const fresh = records().filter(f => !before.includes(f)); assert.equal(fresh.length, 1);
    return JSON.parse(fs.readFileSync(fresh[0], 'utf8'));
}
async function lasso(page, points) {
    await page.keyboard.press('d'); await page.mouse.move(...points[0]); await page.mouse.down();
    for (const p of points.slice(1)) await page.mouse.move(...p, { steps: 3 });
    await page.mouse.up(); await settle(page);
}
(async () => {
    app = await _electron.launch({ executablePath: process.env.ANNOTATION_EXE || path.resolve('node_modules/electron/dist/electron.exe'), args: [...(process.env.ANNOTATION_EXE ? [] : ['.']), '--userData', data, '--testMode', `--force-device-scale-factor=${process.env.ANNOTATION_SCALE || 1}`], timeout: 30000 });
    panel = await app.firstWindow(); await panel.waitForSelector('#ac-save-settings'); await isolateWindow(app, panel);
    await app.evaluate(({ ipcMain, nativeImage, screen }) => {
        ipcMain.removeHandler('annotation:screenshots');
        ipcMain.handle('annotation:screenshots', () => screen.getAllDisplays().map(d => { const width = Math.round(d.size.width * d.scaleFactor), height = Math.round(d.size.height * d.scaleFactor); return { id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, png: nativeImage.createFromBitmap(Buffer.alloc(width * height * 4, 255), { width, height }).toDataURL() }; }));
        ipcMain.removeHandler('annotation:inkRecognize');
        ipcMain.handle('annotation:inkRecognize', async (_e, _id, png) => { globalThis.pressureOcrInput = png; return { latex: 'x+1', model: 'isolated-fixture' }; });
    });
    let page = await open();
    await line(page, 200, 0.1); await line(page, 260, 0.9);
    await line(page, 320, 0.1, 'mouse'); await line(page, 380, 0.9, 'mouse');
    const widths = await Promise.all([200,260,320,380].map(y => thickness(page, y)));
    assert.ok(widths[1] > widths[0] * 1.5, JSON.stringify(widths));
    assert.ok(Math.abs(widths[2] - widths[3]) <= 1, JSON.stringify(widths));
    const beforeUndo = await image(page);
    await page.keyboard.press('Control+z'); await settle(page); assert.ok(await thickness(page, 380) < 1);
    await page.keyboard.press('Control+y'); await settle(page); await sameGeometry(page,beforeUndo,'mixed-redo');
    await page.screenshot({ path: path.join(root, 'pressure-mouse.png') });
    const mixed = await finish(page);
    assert.equal(mixed.canvas.objects.filter(o => o.acPressure).length, 2);
    assert.equal(mixed.canvas.objects.filter(o => !o.acPressure).length, 2);
    assert.ok(Math.abs(mixed.canvas.objects[0].acPressure.points[0][2] - 0.1) < 0.00001);
    checks.push({ name: 'real pressure changes width; mouse stays equal; undo/redo and JSON', widths });

    await configure({ pressureEnabled: false }); page = await open('region');
    await line(page, 310, 0.1); await line(page, 410, 0.9);
    assert.ok(Math.abs(await thickness(page,310) - await thickness(page,410)) <= 1);
    assert.ok((await finish(page)).canvas.objects.every(o => !o.acPressure));
    checks.push({ name: 'switch off restores original equal-width brush in region capture' });

    const differences = [];
    for (const sensitivity of [10, 100]) {
        await configure({ pressureEnabled: true, pressureSensitivity: sensitivity }); page = await open();
        await line(page, 300, 0.1); await line(page, 420, 0.9);
        differences.push(await thickness(page, 420) - await thickness(page, 300));
        await finish(page);
    }
    assert.ok(differences[1] > differences[0] * 3, JSON.stringify(differences));
    checks.push({ name: 'saved sensitivity changes pressure range', differences });

    page = await open(); await line(page,350,'ramp');
    const ramp = [await thickness(page,350,410),await thickness(page,350,600)];
    assert.ok(ramp[1]>ramp[0]*1.5,JSON.stringify(ramp));
    await finish(page); checks.push({name:'pressure varies within one continuous stroke',widths:ramp});

    page=await open(); const cancelInput=await input(page);
    await cancelInput('mousePressed',340,330,0.6); await cancelInput('mouseMoved',500,330,0.8);
    await page.locator('.upper-canvas').evaluate(c=>c.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerType:'pen',pointerId:2})));
    await cancelInput('mouseReleased',500,330); await settle(page); assert.ok(await thickness(page,330)<1);
    await line(page,420,0.8); assert.ok(await thickness(page,420)>10);
    assert.equal((await finish(page)).canvas.objects.length,1);
    checks.push({name:'cancel discards incomplete ink and next pen stroke works'});

    page=await open();
    await page.locator('.upper-canvas').evaluate(canvas=>{
        const event=(type,x,pressure)=>new PointerEvent(type,{bubbles:true,isPrimary:true,pointerType:'pen',pointerId:77,button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:330,pressure});
        canvas.dispatchEvent(event('pointerdown',350,0.1));
        const move=event('pointermove',500,0.8);
        Object.defineProperty(move,'getCoalescedEvents',{value:()=>[event('pointermove',380,0.2),event('pointermove',440,0.6),event('pointermove',500,0.8)]});
        canvas.dispatchEvent(move);canvas.dispatchEvent(event('pointerup',500,0));
    });
    const coalesced=(await finish(page)).canvas.objects.find(o=>o.acPressure).acPressure.points;
    assert.equal(coalesced.length,4);
    for(let i=0;i<4;i++){
        assert.ok(Math.abs(coalesced[i][2]-[0.1,0.2,0.6,0.8][i])<0.00001);
        assert.ok(Math.abs((coalesced[i][0]-coalesced[0][0])/(coalesced[3][0]-coalesced[0][0])-[0,0.2,0.6,1][i])<0.00001);
    }
    checks.push({name:'coalesced samples preserve distinct coordinates and pressure; pen-up does not insert zero pressure'});

    page = await open(); await line(page, 330, 0.8);
    const original = await image(page);
    await page.locator('#draw_free').hover(); await page.locator('#draw_free_eraser').click();
    await page.mouse.move(520, 280); await page.mouse.down(); await page.mouse.move(520, 380, { steps: 15 }); await page.mouse.up(); await settle(page);
    assert.ok(await thickness(page,330) < 1);
    await page.keyboard.press('Control+z'); await settle(page); await sameGeometry(page,original,'erase-undo');
    await page.keyboard.press('Control+y'); await settle(page); assert.ok(await thickness(page,330) < 1);
    assert.ok((await finish(page)).canvas.objects.some(o => o.acPressure && o.clipPath));
    checks.push({ name: 'eraser cuts pressure fill, undo/redo and archived mask survive' });

    await configure({ lassoRule: 'intersect', penWidth: 40 }); page = await open(); await line(page,330,0.9);
    await lasso(page, [[510,327],[530,327],[530,333],[510,333],[510,327]]);
    await page.keyboard.press('Delete'); await settle(page); assert.ok(await thickness(page,330) < 1);
    await page.keyboard.press('Control+z'); await settle(page); assert.ok(await thickness(page,330) > 35);
    await finish(page); checks.push({ name: 'a lasso inside thick pressure ink selects the whole stroke; undo restores it' });

    await configure({ penWidth: 8 }); page = await open(); await page.locator('#ac-formula-pen').click();
    await line(page,330,0.2); await line(page,390,0.8);
    await page.locator('#ac-typeset').click();
    await page.waitForFunction(() => document.querySelector('#ac-ink-status').textContent.includes('公式已回填'));
    await page.keyboard.press('Control+z'); await settle(page); assert.ok(await thickness(page,330) > 1);
    await page.keyboard.press('Control+y'); await settle(page);
    const formula = (await finish(page)).canvas.objects.find(o => o.acFormula).acFormula;
    assert.equal(formula.color,'#2266cc'); assert.equal(formula.source.filter(o => o.acPressure).length,2);
    checks.push({ name: 'formula conversion keeps pressure color/source and supports undo/redo; recognition uses isolated fixture' });

    const priorRecords = records(); page = await open(); const send = await input(page);
    await send('mousePressed',340,330,0.5); await send('mouseMoved',500,330,0.9);
    await page.keyboard.press('Control+Enter'); assert.match(await page.locator('#ac-capture-status').innerText(),/抬笔/);
    const closed=page.waitForEvent('close'); await send('mouseReleased',500,330); await closed;
    const last=JSON.parse(fs.readFileSync(records().find(f=>!priorRecords.includes(f)),'utf8')); assert.ok(last.canvas.objects.some(o=>o.acPressure));
    checks.push({ name: 'finish waits for pen-up and includes the final pressure stroke' });
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(root,'pressure-report.json'),JSON.stringify({passed:true, hardwarePenTested:false, checks, errors},null,2));
    console.log('PRESSURE_ACCEPTANCE_PASSED',JSON.stringify(checks));
})().catch(error=>{fs.writeFileSync(path.join(root,'pressure-report.json'),JSON.stringify({passed:false,checks,errors,error:String(error)},null,2));console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.evaluate(({app})=>app.exit()).catch(()=>{});});
