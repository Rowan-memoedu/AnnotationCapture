const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {_electron} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {prepareProfile, isolateWindow} = require('./acceptance-window.cjs');
const root = process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/tablet-selection';
const data = path.join(root, `profile-${Date.now()}`);
prepareProfile(data);
let app, panel;
const checks = [];
const archives = () => {
    const found = [];
    function walk(dir) { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir,{withFileTypes:true})) { const p=path.join(dir,e.name); if(e.isDirectory())walk(p);else if(e.name==='capture.json')found.push(p); } }
    walk(path.join(data,'Archive')); return found;
};
async function open(mode='region') {
    const pending=app.waitForEvent('window');
    await panel.evaluate(mode=>require('electron').ipcRenderer.invoke('annotation:capture',mode),mode);
    const page=await pending;
    await page.waitForFunction(()=>document.querySelector('#ac-completion')&&document.body.style.opacity!=='0');
    await isolateWindow(app,page);
    await page.evaluate(()=>{
        window.tabletEvents={pointer:0,mouse:0,id:0};
        // A digitizer must work without relying on compatibility mouse messages.
        document.addEventListener('pointerdown',e=>{if(e.pointerType==='pen'){window.tabletEvents.pointer++;window.tabletEvents.id=e.pointerId;e.preventDefault();}},true);
        document.addEventListener('mousedown',e=>{if(e.target.id==='clip_photo'||e.target.classList.contains('upper-canvas'))window.tabletEvents.mouse++;},true);
    });
    return {page, cdp:await page.context().newCDPSession(page)};
}
async function input(cdp,type,x,y) {
    await cdp.send('Input.dispatchMouseEvent',{type,x,y,pointerType:'pen',button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1,force:type==='mouseReleased'?0:0.6});
}
async function drag(cdp,a,b) {
    await input(cdp,'mouseMoved',...a);await input(cdp,'mousePressed',...a);
    for(let i=1;i<=8;i++)await input(cdp,'mouseMoved',a[0]+(b[0]-a[0])*i/8,a[1]+(b[1]-a[1])*i/8);
    await input(cdp,'mouseReleased',...b);
}
async function visible(page) {
    return app.evaluate(({BrowserWindow},url)=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url);return w?{visible:w.isVisible(),minimized:w.isMinimized()}:null},page.url());
}
async function finish(page,before) {
    const closed=page.waitForEvent('close');await page.keyboard.press('Escape');await closed;
    assert.equal(archives().length,before+1);
}
(async()=>{
    app=await _electron.launch({executablePath:process.env.ANNOTATION_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(process.env.ANNOTATION_EXE?[]:['.']),'--userData',data,'--testMode'],timeout:30000});
    panel=await app.firstWindow();await panel.waitForSelector('#ac-save-settings');await isolateWindow(app,panel);
    const directions=[[[220,180],[1050,700]],[[1050,700],[220,180]],[[220,700],[1050,180]],[[1050,180],[220,700]]];
    for(const [i,[a,b]]of directions.entries()){
        const {page,cdp}=await open(),before=archives().length;
        await drag(cdp,a,b);await page.waitForTimeout(200);
        assert.equal(page.isClosed(),false,'Lifting the pen must not close the selection');
        assert.equal(await page.locator('#draw_free_pencil').evaluate(e=>e.classList.contains('select')),true,'Pen-only selection must enter pencil mode');
        assert.deepEqual(await visible(page),{visible:true,minimized:false});assert.equal(archives().length,before);
        for(let n=0;n<6;n++)await drag(cdp,[350+n*25,300],[360+n*25,440]);
        const events=await page.evaluate(()=>window.tabletEvents);assert.ok(events.pointer>=7);assert.equal(events.mouse,0);
        const ink=await page.locator('#draw_photo').evaluate(c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>8));assert.equal(ink,true,'Pen-only input must leave ink');
        assert.equal(archives().length,before);await finish(page,before);
        checks.push({name:'pen-only-direction-'+i,selection:true,ink:true,noCompatibilityMouse:true,visible:true,escapeArchivesOnce:true});
    }
    {
        const {page,cdp}=await open(),before=archives().length;
        await input(cdp,'mousePressed',220,180);await input(cdp,'mouseMoved',500,400);
        await page.evaluate(()=>document.querySelector('#clip_photo').dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.tabletEvents.id,pointerType:'pen',bubbles:true,isPrimary:true})));
        await input(cdp,'mouseReleased',500,400);
        assert.equal(page.isClosed(),false);assert.equal(archives().length,before);
        await drag(cdp,[230,200],[1050,700]);assert.equal(await page.locator('#draw_free_pencil').evaluate(e=>e.classList.contains('select')),true);
        await finish(page,before);checks.push({name:'cancelled-pen-selection-can-retry',passed:true});
    }
    {
        const {page,cdp}=await open(),before=archives().length;
        await input(cdp,'mousePressed',220,180);await input(cdp,'mouseMoved',1050,700);
        await app.evaluate(({BrowserWindow},url)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url).hide(),page.url());
        await input(cdp,'mouseReleased',1050,700);await page.waitForTimeout(200);
        assert.deepEqual(await visible(page),{visible:true,minimized:false},'A completed selection must restore its live annotation surface');
        await finish(page,before);checks.push({name:'selection-restores-hidden-surface',passed:true});
    }
    {
        const {page}=await open(),before=archives().length;
        await page.mouse.move(220,180);await page.mouse.down();await page.mouse.move(1050,700,{steps:8});await page.mouse.up();
        assert.equal(await page.locator('#draw_free_pencil').evaluate(e=>e.classList.contains('select')),true);
        await finish(page,before);checks.push({name:'mouse-selection-still-works',passed:true});
    }
    await app.evaluate(({ipcMain})=>{globalThis.tabletOcrCalls=0;ipcMain.removeHandler('annotation:formula');ipcMain.handle('annotation:formula',()=>{globalThis.tabletOcrCalls++;return 'fixture-job';});});
    {
        const {page,cdp}=await open('ocr'),before=archives().length;
        const closed=page.waitForEvent('close');await drag(cdp,[220,180],[1050,700]);await closed;
        assert.equal(archives().length,before+1);assert.equal(await app.evaluate(()=>globalThis.tabletOcrCalls),1);
        checks.push({name:'pen-direct-OCR-selection',passed:true});
    }
    fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:true,checks,hardwareTabletTested:false},null,2));console.log('TABLET_SELECTION_PASSED',JSON.stringify(checks));
})().catch(error=>{fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:false,checks,error:String(error)},null,2));console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.evaluate(({app})=>app.exit()).catch(()=>{});});
