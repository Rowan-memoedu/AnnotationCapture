const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { isolateWindow } = require('./acceptance-window.cjs');
const root = process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/acceptance';
fs.mkdirSync(root,{recursive:true});
function whitePng(w,h) {
    const chunk=(type,data)=>{ const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const b of body){crc^=b;for(let k=0;k<8;k++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([head,body,tail]);};
    const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=6;
    const bytes=Buffer.alloc((w*4+1)*h,255);for(let y=0;y<h;y++)bytes[y*(w*4+1)]=0;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(bytes)),chunk('IEND',Buffer.alloc(0))]);
}
const fixture=path.join(root,'white-fixture.png');fs.writeFileSync(fixture,whitePng(1200,800));
let app,page,data;
const report=[];
async function launch(name,scale=1) {
    data=path.join(root,`edge-${name}-${Date.now()}`);
    app=await _electron.launch({executablePath:process.env.ANNOTATION_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(process.env.ANNOTATION_EXE?[]:['.']),'--userData',data,'--archiveRoot',path.join(data,'Archive'),'--input',fixture,'--testMode',`--force-device-scale-factor=${scale}`],env:{...process.env,DEEPSEEK_API_KEY:'',ANNOTATION_DEEPSEEK_API_KEY:''},timeout:30000});
    page=await app.firstWindow();await page.waitForFunction(()=>document.querySelector('#ac-completion')&&document.body.style.opacity!=='0');
    await isolateWindow(app,page);
    await page.locator('#draw_free').click();
}
async function stop(){if(app){await app.evaluate(({app})=>app.exit());app=null;}}
async function stroke(points){await page.mouse.move(...points[0]);await page.mouse.down();for(const p of points.slice(1))await page.mouse.move(...p,{steps:6});await page.mouse.up();}
async function ink(){return page.locator('#draw_photo').evaluate(c=>{const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<a.length;i+=4)if(a[i]>50)n++;return n;});}
async function waitInk(predicate){let n;for(let i=0;i<30;i++){n=await ink();if(predicate(n))return n;await new Promise(r=>setTimeout(r,50));}throw new Error(`Unexpected ink count ${n}`);}
async function finish(key='Escape'){const c=page.waitForEvent('close');await page.keyboard.press(key);await c;}
function files(name='capture.png'){const out=[];const walk=d=>{if(!fs.existsSync(d))return;for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory())walk(p);else if(f.name===name)out.push(p);}};walk(path.join(data,'Archive'));return out;}
async function archivedInk(){const f=files()[0];return app.evaluate(({nativeImage},png)=>{const image=nativeImage.createFromDataURL(png);const b=image.toBitmap();let ink=0;for(let i=0;i<b.length;i+=4)if(b[i]<220&&b[i+1]<220&&b[i+2]<220)ink++;return {size:image.getSize(),ink};},`data:image/png;base64,${fs.readFileSync(f).toString('base64')}`);}
(async()=>{
    await launch('last-stroke');
    await page.mouse.move(330,250);await page.mouse.down();await page.mouse.move(520,310,{steps:15});
    await page.keyboard.press('Control+Enter');assert.match(await page.locator('#ac-capture-status').innerText(),/抬笔/);
    const closed=page.waitForEvent('close');await page.mouse.up();await closed;
    const last=await archivedInk();assert.ok(last.ink>100);assert.deepEqual(last.size,{width:1200,height:800});report.push({case:'last-stroke-deferred-until-mouseup',...last,passed:true});await stop();

    await launch('undo-erase');
    await stroke([[330,250],[520,250]]);const first=await waitInk(n=>n>100);
    await stroke([[600,350],[740,350]]);const second=await waitInk(n=>n>first+100);
    await page.keyboard.press('Control+z');const undone=await waitInk(n=>Math.abs(n-first)<10);assert.ok(Math.abs(undone-first)<10);
    await page.keyboard.press('Control+y');await waitInk(n=>Math.abs(n-second)<10);
    await page.locator('#draw_free').hover();await page.locator('#draw_free_eraser').click();
    await stroke([[330,250],[520,250]]);const erased=await waitInk(n=>n<second-100);
    await page.keyboard.press('Control+z');await waitInk(n=>Math.abs(n-second)<10);
    await page.keyboard.press('Control+y');await finish();const saved=await archivedInk();
    assert.ok(saved.ink<second-100);report.push({case:'undo-redo-eraser-and-immediate-finish',first,second,erased,saved,passed:true});await stop();

    await launch('write-failure');await stroke([[330,250],[520,310]]);const before=await ink();
    const blocked=path.join(data,'not-a-directory');fs.writeFileSync(blocked,'occupied');
    await page.evaluate(async root=>{const ipc=require('electron').ipcRenderer;const s=await ipc.invoke('annotation:state');await ipc.invoke('annotation:configure',{...s.config,archiveRoot:root});},blocked);
    await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelector('#ac-capture-status').textContent.includes('画布已保留'));
    assert.equal(await ink(),before);assert.equal(files().length,0);
    await page.screenshot({path:path.join(root,'save-failure-retains-canvas.png')});
    await page.evaluate(async root=>{const ipc=require('electron').ipcRenderer;const s=await ipc.invoke('annotation:state');await ipc.invoke('annotation:configure',{...s.config,archiveRoot:root});},path.join(data,'Archive'));
    await finish();assert.equal(files().length,1);report.push({case:'write-failure-retains-canvas-and-retries',passed:true});await stop();

    await launch('cancel-formula');await stroke([[330,250],[520,310]]);await page.keyboard.press('Control+Shift+Enter');await page.waitForSelector('#ac-selection');
    const beforeCancel=fs.readFileSync(files()[0]);await finish();assert.deepEqual(fs.readFileSync(files()[0]),beforeCancel);assert.equal(files().length,1);report.push({case:'cancel-formula-keeps-full-archive',passed:true});await stop();

    await launch('text-edit');await page.locator('#draw_shapes').hover();await page.locator('#draw_shapes_text').click();await page.mouse.click(350,300);await page.keyboard.type('x^2 + 1 = 0');await finish('Control+Enter');
    const text=await archivedInk();assert.ok(text.ink>100);report.push({case:'active-text-edit-committed',...text,passed:true});await stop();

    for(const scale of [1,1.5,2]){
        await launch(`scale-${scale}`,scale);await stroke([[280,240],[390,300]]);const count=await waitInk(n=>n>100);await finish();const value=await archivedInk();assert.deepEqual(value.size,{width:1200,height:800});assert.ok(value.ink>100);report.push({case:`display-scale-${scale}`,canvasInk:count,...value,passed:true});await stop();
    }
    fs.writeFileSync(path.join(root,'edge-report.json'),JSON.stringify({passed:true,checks:report},null,2));console.log('EDGE_ACCEPTANCE_PASSED',JSON.stringify(report));
})().catch(e=>{console.error(e);fs.writeFileSync(path.join(root,'edge-report.json'),JSON.stringify({passed:false,checks:report,error:String(e)},null,2));process.exitCode=1;}).finally(stop);
