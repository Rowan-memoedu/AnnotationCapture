const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { prepareProfile, isolateWindow } = require('./acceptance-window.cjs');
const root = process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/whiteboard-cursor';
const data = path.join(root, 'profile-' + Date.now());
prepareProfile(data, { whiteboard: { enabled:false, maxRects:5, includeTaskbar:true, includeWindowChrome:true } });
let app;

(async () => {
    const input = JSON.parse(fs.readFileSync(process.env.ANNOTATION_CURSOR_FIXTURE, 'utf8'));
    const png = 'data:image/png;base64,' + fs.readFileSync(input.image).toString('base64');
    app = await _electron.launch({executablePath:process.env.ANNOTATION_EXE || path.resolve('node_modules/electron/dist/electron.exe'),
        args:[...(process.env.ANNOTATION_EXE?[]:['.']), '--userData',data,'--testMode','--force-device-scale-factor=1']});
    const panel=await app.firstWindow(); await panel.waitForSelector('#ac-save-settings'); await isolateWindow(app,panel);
    await app.evaluate(({ipcMain,screen,nativeImage},{png,point})=>{
        const size=nativeImage.createFromDataURL(png).getSize();
        ipcMain.removeHandler('annotation:screenshots');
        ipcMain.handle('annotation:screenshots',()=>[{id:screen.getPrimaryDisplay().id, bounds:{x:0,y:0,...size},scaleFactor:1,
            pointer:{x:point.x/size.width,y:point.y/size.height},png}]);
        ipcMain.removeHandler('annotation:archive'); ipcMain.handle('annotation:archive',(_e,input)=>({id:input.id}));
    },{png,point:input.point});
    const opened=app.waitForEvent('window'); await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:capture','full'));
    const page=await opened; await page.waitForFunction(()=>document.body.dataset.acReady==='true'); await isolateWindow(app,page);
    async function read(rect) { return page.locator('#main_photo').evaluate((c,r)=>{
        const bytes=c.getContext('2d').getImageData(r.x,r.y,r.width,r.height).data;
        return Array.from(bytes).filter((_v,i)=>i%4===0);
    },rect); }
    const arrow=await read(input.core), text=await read(input.text);
    await page.locator('#ac-whiteboard').hover();
    await page.waitForFunction(()=>!document.querySelector('#draw_side').classList.contains('draw_side_hide'));
    const ui=await page.locator('#draw_whiteboard_i > button').evaluateAll(items=>items.map(el=>({
        label:el.getAttribute('aria-label'),x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y,
        w:el.getBoundingClientRect().width,h:el.getBoundingClientRect().height})));
    assert.deepEqual(ui.map(v=>v.label),['智能白板','中央白板','反选白板矩形','反选白板自由']);
    assert.ok(ui.every((v,i)=>v.x===ui[0].x && (!i || v.y >= ui[i-1].y + ui[i-1].h - 1)));
    assert.ok(ui[0].x>=(await page.locator('#ac-whiteboard').boundingBox()).x+ui[0].w-1);
    await page.locator('#draw_whiteboard_center').click();
    assert.equal(await page.locator('.upper-canvas').evaluate(el=>getComputedStyle(el).cursor),'none');
    const after=await read(input.core), other=await read(input.text);
    const darkBefore=arrow.filter(v=>v<100).length, darkAfter=after.filter(v=>v<100).length;
    const changedText=text.filter((v,i)=>v<135 && other[i]!==v).length;
    assert.ok(darkBefore>=20); assert.equal(darkAfter,0); assert.equal(changedText,0);
    await page.mouse.move(214,199); await page.mouse.move(229,201);
    await page.waitForFunction(()=>!document.body.classList.contains('ac-stationary-cursor'));
    await page.locator('#ac-whiteboard-remove').click();
    assert.deepEqual(await read(input.core),arrow);
    const result={passed:true,darkBefore,darkAfter,changedText,restored:true,verticalActions:ui.map(v=>v.label)};
    fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(result,null,2)); console.log('CURSOR_REPLAY',JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{ if(app) await app.evaluate(({app})=>app.exit()).catch(()=>{}); });
