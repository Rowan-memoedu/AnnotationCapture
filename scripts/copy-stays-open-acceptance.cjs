const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {_electron} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {prepareProfile, isolateWindow} = require('./acceptance-window.cjs');
const root=process.env.ANNOTATION_EVIDENCE||'D:/Artifacts/AnnotationCapture/copy-stays-open';
const data=path.join(root,'profile-'+Date.now());prepareProfile(data);
const checks=[];let app;
function captures(){const found=[];function walk(dir){if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name==='capture.json')found.push(p);}}walk(path.join(data,'Archive'));return found;}
async function stroke(page,y){await page.mouse.move(350,y);await page.mouse.down();await page.mouse.move(550,y+30,{steps:12});await page.mouse.up();await page.waitForTimeout(70);}
async function clipboardImage(){return app.evaluate(async({clipboard,nativeImage})=>{const items=await clipboard.read();const item=items.find(i=>i.types.includes('image/png'));if(!item)throw new Error('Clipboard must contain a PNG screenshot');const blob=await item.getType('image/png');const i=nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));const pixels=i.toBitmap();let red=0;for(let n=0;n<pixels.length;n+=4)if(pixels[n]<70&&pixels[n+1]<70&&pixels[n+2]>180)red++;return {size:i.getSize(),red};});}
async function stillOpen(page,before,message){await new Promise(r=>setTimeout(r,200));assert.equal(page.isClosed(),false,message);assert.equal(captures().length,before,'Copy must not archive');}
(async()=>{
 app=await _electron.launch({executablePath:process.env.ANNOTATION_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(process.env.ANNOTATION_EXE?[]:['.']),'--userData',data,'--testMode'],timeout:30000});
 const panel=await app.firstWindow();await panel.waitForSelector('#ac-start');await isolateWindow(app,panel);
 for(const mode of ['region','full']){
  const next=app.waitForEvent('window');await panel.evaluate(mode=>require('electron').ipcRenderer.invoke('annotation:capture',mode),mode);const page=await next;
  await page.waitForFunction(()=>document.querySelector('#ac-completion')&&document.body.style.opacity!=='0');await isolateWindow(app,page);
  await page.evaluate(()=>{window.copyKeys=[];for(const type of ['copy','keydown','keyup'])document.addEventListener(type,e=>window.copyKeys.push({type,key:e.key,ctrl:e.ctrlKey,tag:e.target.tagName,id:e.target.id}),true);window.copyWrites=[];const write=navigator.clipboard.write.bind(navigator.clipboard);navigator.clipboard.write=async items=>{const blob=await items[0].getType('image/png');window.copyWrites.push({bytes:blob.size,done:false});const n=window.copyWrites.length-1;await write(items);window.copyWrites[n].done=true;};});
  const before=captures().length;
  if(mode==='region'){await page.mouse.move(220,180);await page.mouse.down();await page.mouse.move(1000,700,{steps:8});await page.mouse.up();}
  await page.waitForFunction(()=>document.querySelector('#draw_free_pencil')?.classList.contains('select'));
  await stroke(page,300);
  for(let i=0;i<8;i++)await page.keyboard.press('Control+c');await stillOpen(page,before,'Selection-capture Ctrl+C must leave the annotation canvas open');
  assert.equal(await page.evaluate(()=>window.copyWrites.length),0,'Canvas Ctrl+C must not encode or copy a screenshot');
  await page.locator('#tool_copy').click();await page.waitForFunction(()=>window.copyWrites.length===1&&window.copyWrites[0].done);
  const first=await clipboardImage();assert.ok(first.size.width>100&&first.size.height>100);assert.ok(first.red>100,'Copied image must contain annotated ink');
  for(let i=0;i<3;i++)await page.keyboard.press('Control+c');await stillOpen(page,before,'Repeated injected copy must not finish the session');
  assert.equal(await page.evaluate(()=>window.copyWrites.length),1,'Ignored Ctrl+C must not perform additional work');
  await stroke(page,400);await page.locator('#tool_copy').click();await page.waitForFunction(()=>window.copyWrites.length===2&&window.copyWrites[1].done,undefined,{timeout:10000});await stillOpen(page,before,'Drawing must remain usable after copying');
  const second=await clipboardImage();assert.deepEqual(second.size,first.size);assert.ok(second.red>first.red+100,`A later copy must include the new stroke: first=${first.red}, second=${second.red}, writes=${JSON.stringify(await page.evaluate(()=>window.copyWrites))}, events=${JSON.stringify(await page.evaluate(()=>window.copyKeys))}`);
  await page.locator('#tool_copy').click();await stillOpen(page,before,'Toolbar copy must also keep the canvas');
  const closed=page.waitForEvent('close');await page.keyboard.press('Escape');await closed;
  const files=captures();assert.equal(files.length,before+1,'Esc must archive exactly once');
  const latest=files.map(p=>({p,time:fs.statSync(p).mtimeMs})).sort((a,b)=>b.time-a.time)[0].p;
  const metadata=JSON.parse(fs.readFileSync(latest,'utf8'));
  assert.deepEqual({width:metadata.rect.width,height:metadata.rect.height},second.size);
  const archived=await app.evaluate(({nativeImage},file)=>{const p=nativeImage.createFromPath(file).toBitmap();let red=0;for(let n=0;n<p.length;n+=4)if(p[n]<70&&p[n+1]<70&&p[n+2]>180)red++;return red;},latest.replace('.json','.png'));
  assert.ok(archived>=second.red,'Esc archive must retain all copied ink');
  checks.push({mode,canvasCtrlCIgnored:true,noScreenshotEncodingOnCtrlC:true,copyKeepsCanvas:true,repeatedCopyKeepsCanvas:true,canContinueDrawing:true,toolbarCopiesImage:true,toolbarCopyKeepsCanvas:true,escapeArchivesOnce:true,firstRedPixels:first.red,secondRedPixels:second.red});
 }
 fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:true,checks},null,2));console.log('COPY_STAYS_OPEN_PASSED',JSON.stringify(checks));
})().catch(error=>{fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:false,checks,error:String(error)},null,2));console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.evaluate(({app})=>app.exit()).catch(()=>{});});
