const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {_electron} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {isolateWindow, prepareProfile} = require('./acceptance-window.cjs');
const root = process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/continuous-writing';
const data = path.join(root, `profile-${Date.now()}`);
prepareProfile(data);
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({'鼠标快捷键':{'右键':'关闭','双击':'复制'},'鼠标跟随栏':{'显示':true},'图像编辑':{'形状属性':{'free':{'sc':'#00ff00'}}}}));
let app;
const checks = [];
function captures() {
    let count = 0;
    const walk = dir => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, {withFileTypes:true})) { const f = path.join(dir,e.name); if (e.isDirectory()) walk(f); else if (e.name === 'capture.json') count++; } };
    walk(path.join(data,'Archive')); return count;
}
async function staysOpen(page, before, name) {
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(page.isClosed(), false, `${name}: writing must not close the capture`);
    assert.equal(captures(), before, `${name}: writing must not archive before Escape`);
}
(async () => {
    app = await _electron.launch({executablePath:process.env.ANNOTATION_EXE || path.resolve('node_modules/electron/dist/electron.exe'), args:[...(process.env.ANNOTATION_EXE ? [] : ['.']), '--userData',data,'--testMode'], timeout:30000});
    const panel = await app.firstWindow(); await panel.waitForSelector('#ac-save-settings'); await isolateWindow(app,panel);
    for (const mode of ['full','region']) {
        const pending = app.waitForEvent('window'); await panel.evaluate(mode => require('electron').ipcRenderer.invoke('annotation:capture',mode),mode);
        const page = await pending; await page.waitForFunction(() => document.querySelector('#ac-completion') && document.body.style.opacity !== '0'); await isolateWindow(app,page);
        const before = captures();
        if (mode === 'region') { await page.mouse.move(200,180); await page.mouse.down(); await page.mouse.move(1100,750,{steps:8}); await page.mouse.up(); }
        await page.waitForFunction(() => document.querySelector('#draw_free_pencil')?.classList.contains('select'));
        for (let i=0;i<40;i++) {
            await page.mouse.move(350+(i%10)*18,300+Math.floor(i/10)*40); await page.mouse.down(); await page.mouse.move(360+(i%10)*18,310+Math.floor(i/10)*40); await page.mouse.up();
        }
        await staysOpen(page,before,`${mode}: 40 strokes`);
        const redPixels = await page.locator('#draw_photo').evaluate(c => {const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<a.length;i+=4)if(a[i]>200&&a[i+1]<60&&a[i+2]<60&&a[i+3]>50)n++;return n;});
        assert.ok(redPixels>100,'New capture must start with the configured red pencil');
        for (const selector of ['#tool_close','#tool_copy','#tool_save','#tool_ocr','#ac-finish','#ac-formula']) {
            const box = await page.locator(selector).boundingBox(); if (!box) continue;
            await page.mouse.move(650,450); await page.mouse.down(); await page.mouse.move(box.x+box.width/2,box.y+box.height/2,{steps:5}); await page.mouse.up();
            await staysOpen(page,before,`${mode}: stroke released on ${selector}`);
        }
        await page.locator('.upper-canvas').dblclick({position:{x:700,y:500}});
        await staysOpen(page,before,`${mode}: rapid pen taps`);
        await page.locator('#draw_select').click();
        await page.locator('#clip_photo').dblclick({position:{x:700,y:500}});
        await staysOpen(page,before,`${mode}: selection double-click`);
        await page.locator('#clip_photo').click({position:{x:700,y:500},button:'right'});
        await staysOpen(page,before,`${mode}: legacy right-click close setting`);
        await page.locator('#draw_free').click();
        assert.equal(await page.locator('#mouse_bar').isVisible(),false,'Magnifier must be hidden while annotating');
        await page.waitForTimeout(5000); await staysOpen(page,before,`${mode}: idle after writing`);
        const ink = await page.locator('#draw_photo').evaluate(c => {const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<a.length;i+=4)if(a[i]>50)n++;return n;}); assert.ok(ink>100);
        await page.screenshot({path:path.join(root,`${mode}-before-Escape.png`)});
        const closed = page.waitForEvent('close'); await page.keyboard.press('Escape'); await closed;
        assert.equal(captures(),before+1,'Escape must create exactly one archive');
        checks.push({mode,strokes:40,releaseOverToolbar:true,doubleClicksStayOpen:true,magnifierHidden:true,idleStaysOpen:true,escapeArchivesOnce:true,inkPixels:ink,redPixels});
    }
    await panel.reload(); await panel.waitForSelector('#ac-save-settings');
    assert.equal(await panel.locator('#ac-pen-color').inputValue(),'#ff0000');
    assert.equal(await panel.locator('#ac-show-magnifier').isChecked(),false);
    await panel.locator('#ac-pen-color').fill('#0000ff');
    await panel.locator('#ac-pen-width-setting').fill('6');
    await panel.locator('#ac-show-magnifier').check();
    await panel.locator('#ac-save-settings').click();
    await panel.waitForFunction(() => document.querySelector('#ac-panel-status').textContent.includes('设置已保存'));
    await panel.reload(); await panel.waitForSelector('#ac-save-settings');
    assert.equal(await panel.locator('#ac-pen-color').inputValue(),'#0000ff');
    assert.equal(await panel.locator('#ac-show-magnifier').isChecked(),true);
    const persisted = JSON.parse(fs.readFileSync(path.join(data,'annotation-settings.json'),'utf8'));
    assert.equal(persisted.penColor,'#0000ff'); assert.equal(persisted.showMagnifier,true);
    assert.equal(persisted.penWidth,6);
    const pending = app.waitForEvent('window'); await panel.evaluate(() => require('electron').ipcRenderer.invoke('annotation:capture','full'));
    const custom = await pending; await custom.waitForFunction(() => document.querySelector('#draw_free_pencil')?.classList.contains('select')); await isolateWindow(app,custom);
    assert.equal(await custom.locator('#mouse_bar').isVisible(),true);
    await custom.mouse.move(600,450); await custom.mouse.wheel(0,-120);
    await custom.waitForFunction(() => document.querySelector('#ac-pen-width').textContent === '7 px');
    await custom.locator('#ac-save-defaults').click();
    await custom.waitForFunction(() => document.querySelector('#ac-capture-status').textContent.includes('默认画笔已保存'));
    assert.equal(custom.isClosed(),false,'Saving pen defaults must keep the capture open');
    assert.equal(JSON.parse(fs.readFileSync(path.join(data,'annotation-settings.json'),'utf8')).penWidth,7);
    await custom.mouse.move(350,300); await custom.mouse.down(); await custom.mouse.move(500,350,{steps:10}); await custom.mouse.up();
    await custom.waitForFunction(() => {const c=document.querySelector('#draw_photo'),a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<a.length;i+=4)if(a[i]<60&&a[i+1]<60&&a[i+2]>200&&a[i+3]>50)n++;return n>100;});
    const closed=custom.waitForEvent('close'); await custom.keyboard.press('Escape'); await closed;
    for (const mode of ['region','full']) {
        const pending=app.waitForEvent('window'); await panel.evaluate(mode=>require('electron').ipcRenderer.invoke('annotation:capture',mode),mode);
        const next=await pending; await next.waitForFunction(()=>document.querySelector('#ac-completion')&&document.body.style.opacity!=='0'); await isolateWindow(app,next);
        if(mode==='region'){await next.mouse.move(200,180);await next.mouse.down();await next.mouse.move(1100,750,{steps:8});await next.mouse.up();}
        await next.mouse.move(600,450);await next.mouse.wheel(0,-120);
        await next.waitForFunction(()=>document.querySelector('#ac-pen-width').textContent==='8 px');
        const closed=next.waitForEvent('close');await next.keyboard.press('Escape');await closed;
        assert.equal(JSON.parse(fs.readFileSync(path.join(data,'annotation-settings.json'),'utf8')).penWidth,7,'Unsaved temporary width must not replace the default');
    }
    await app.evaluate(({app})=>app.exit());app=null;
    app=await _electron.launch({executablePath:process.env.ANNOTATION_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(process.env.ANNOTATION_EXE?[]:['.']),'--userData',data,'--testMode'],timeout:30000});
    const restored=await app.firstWindow();await restored.waitForSelector('#ac-pen-width-setting');
    assert.equal(await restored.locator('#ac-pen-color').inputValue(),'#0000ff');
    assert.equal(await restored.locator('#ac-pen-width-setting').inputValue(),'7');
    assert.equal(await restored.locator('#ac-show-magnifier').isChecked(),true);
    checks.push({settingsSavedFromUI:true,settingsReloaded:true,customBlueInk:true,magnifierCanBeEnabled:true,wheelIncreasesWidth:true,toolbarSavesDefaults:true,bothModesLoadSavedWidth:true,unsavedWidthIsTemporary:true,relaunchRestoresDefaults:true});
    fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:true,checks},null,2)); console.log('CONTINUOUS_WRITING_PASSED',JSON.stringify(checks));
})().catch(error => {fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:false,checks,error:String(error)},null,2));console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.evaluate(({app})=>app.exit());});
