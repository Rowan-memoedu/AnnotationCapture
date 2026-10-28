const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {prepareProfile,isolateWindow}=require('./acceptance-window.cjs');
const root=process.env.ANNOTATION_EVIDENCE||'D:/Artifacts/AnnotationCapture/keyboard-performance';
const data=path.join(root,'profile-'+Date.now());prepareProfile(data);
const baseline=process.env.ANNOTATION_PERF_BASELINE==='1';
let app;const checks=[];
async function burst(page){return page.evaluate(async()=>{
 const proto=CanvasRenderingContext2D.prototype,original=proto.getImageData;let reads=0;
 proto.getImageData=function(...args){if(this.canvas.id==='main_photo')reads++;return original.apply(this,args);};
 await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 const start=performance.now();
 for(let i=0;i<1000;i++)document.onpointermove(new PointerEvent('pointermove',{clientX:400+i%250,clientY:350,pointerId:1}));
 await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 proto.getImageData=original;return {events:1000,screenPixelReads:reads,milliseconds:performance.now()-start};
});}
(async()=>{
 app=await _electron.launch({executablePath:process.env.ANNOTATION_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(process.env.ANNOTATION_EXE?[]:['.']),'--userData',data,'--testMode'],timeout:30000});
 const panel=await app.firstWindow();await panel.waitForSelector('#ac-start');await isolateWindow(app,panel);
 for(const mode of ['full','region']){
  const next=app.waitForEvent('window');await panel.evaluate(mode=>require('electron').ipcRenderer.invoke('annotation:capture',mode),mode);const page=await next;
  await page.waitForFunction(()=>document.querySelector('#ac-completion')&&document.body.style.opacity!=='0');await isolateWindow(app,page);
  if(mode==='region'){await page.mouse.move(220,180);await page.mouse.down();await page.mouse.move(1150,760,{steps:10});await page.mouse.up();}
  await page.waitForFunction(()=>document.querySelector('#draw_free_pencil')?.classList.contains('select'));
  await page.evaluate(()=>{window.copyWrites=0;const original=navigator.clipboard.write.bind(navigator.clipboard);navigator.clipboard.write=(...args)=>{window.copyWrites++;return original(...args);};window.frameGaps=[];let last=performance.now();window.perfRunning=true;function frame(now){window.frameGaps.push(now-last);last=now;if(window.perfRunning)requestAnimationFrame(frame);}requestAnimationFrame(frame);});
  const hidden=await burst(page);
  await page.evaluate(()=>document.querySelector('#mouse_bar').style.display='');const visible=await burst(page);
  await page.evaluate(()=>document.querySelector('#mouse_bar').style.display='none');
  if(!baseline){assert.equal(hidden.screenPixelReads,0,'Hidden magnifier must not read screen pixels');assert.equal(visible.screenPixelReads,1,'Pointer work must coalesce to one callback per animation frame');}
  const count=baseline?12:120;
  for(let i=0;i<count;i++){
   await page.mouse.move(350+i%15*25,300+Math.floor(i/15)*35);await page.mouse.down();await page.mouse.move(365+i%15*25,315+Math.floor(i/15)*35,{steps:5});await page.mouse.up();
   await page.keyboard.press('Control+c');
  }
  await page.waitForTimeout(300);
  assert.equal(page.isClosed(),false,'Mouse strokes with selection-capture key sequences must stay open');
  const metrics=await page.evaluate(()=>{window.perfRunning=false;const gaps=window.frameGaps.slice(2).sort((a,b)=>a-b);return {clipboardWrites:window.copyWrites,frameGapP95Ms:gaps[Math.floor(gaps.length*.95)],frameGapMaxMs:Math.max(...gaps),frameCount:gaps.length};});
  if(!baseline){assert.equal(metrics.clipboardWrites,0);assert.ok(metrics.frameGapP95Ms<80,'Steady drawing must not stall the renderer');}
  if(!baseline){
   await page.evaluate(()=>{const field=document.createElement('textarea');field.id='copy-editor-canary';field.value='normal text copy';document.body.append(field);field.focus();field.select();window.nativeCopyEvent=false;field.addEventListener('copy',()=>window.nativeCopyEvent=true);});
   await page.keyboard.press('Control+c');assert.equal(await page.evaluate(()=>window.nativeCopyEvent),true,'Text editor Ctrl+C stays native');await page.locator('#copy-editor-canary').evaluate(e=>e.remove());
  }
  const closing=page.waitForEvent('close');await page.keyboard.press('Escape');await closing;
  let objects=0;const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name==='annotations.json')objects=Math.max(objects,JSON.parse(fs.readFileSync(p,'utf8')).canvas.objects.length);}};walk(path.join(data,'Archive'));
  if(!baseline)assert.equal(objects,count,'Every mouse stroke must survive to the archive');
  checks.push({mode,strokes:count,hidden,visible,...metrics,archivedStrokeObjects:objects});console.log(JSON.stringify(checks.at(-1)));
 }
 fs.writeFileSync(path.join(root,'performance.json'),JSON.stringify({passed:true,baseline,checks},null,2));
})().catch(error=>{fs.writeFileSync(path.join(root,'performance.json'),JSON.stringify({passed:false,baseline,checks,error:String(error)},null,2));console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.evaluate(({app})=>app.exit()).catch(()=>{});});
