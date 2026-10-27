const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {isolateWindow,prepareProfile}=require('./acceptance-window.cjs');
const root=process.env.ANNOTATION_EVIDENCE||'D:/Artifacts/AnnotationCapture/auth-phase/capture-modes';
const data=path.join(root,`profile-${Date.now()}`);prepareProfile(data);
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({'框选后默认操作':'save','图像编辑':{'记忆':{draw:'eraser'}}}));
let app,currentPage;const errors=[];
const report=[];
function captures(){const found=[];function walk(d){if(!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory())walk(f);else if(e.name==='capture.json')found.push(f);}}walk(path.join(data,'Archive'));return found;}
(async()=>{
 app=await _electron.launch({executablePath:process.env.ANNOTATION_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(process.env.ANNOTATION_EXE?[]:['.']),'--userData',data,'--archiveRoot',path.join(data,'Archive'),'--testMode'],env:{...process.env,DEEPSEEK_API_KEY:'legacy-key-must-not-be-used'},timeout:30000});
 app.process().stderr.on('data',chunk=>{errors.push(chunk.toString().slice(0,1500));});
 app.on('window',page=>page.on('pageerror',e=>errors.push(String(e))));
 const panel=await app.firstWindow();await panel.waitForSelector('#ac-start');await isolateWindow(app,panel);
 for(const mode of ['region','full']){
  const pending=app.waitForEvent('window');await panel.locator(mode==='full'?'#ac-start-full':'#ac-start').click();const page=await pending;currentPage=page;page.on('pageerror',e=>errors.push(String(e)));
  await page.waitForFunction(()=>document.querySelector('#ac-completion')&&document.body.style.opacity!=='0');
  await isolateWindow(app,page);
  const geometry=await page.locator('#main_photo').evaluate(c=>{const b=c.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height,width:c.width,height:c.height};});
  const before=captures().length;
  if(mode==='region'){
   await page.mouse.move(260,220);await page.mouse.down();await page.mouse.move(800,600,{steps:10});await page.mouse.up();
   await page.waitForTimeout(350);assert.equal(page.isClosed(),false,'Region selection must stay open');assert.equal(captures().length,before,'Region selection must not save yet');
  }
  await page.waitForFunction(()=>document.querySelector('#draw_free_pencil')?.classList.contains('select'));
  // eSearch includes both endpoint pixels in a rectangular selection.
  const rect=mode==='full'?{x:0,y:0,width:geometry.width,height:geometry.height}:{x:Math.round((260-geometry.x)/geometry.w*geometry.width),y:Math.round((220-geometry.y)/geometry.h*geometry.height),width:Math.round(540/geometry.w*geometry.width)+1,height:Math.round(380/geometry.h*geometry.height)+1};
  const background=await page.locator('#main_photo').evaluate((c,r)=>{const v=document.createElement('canvas');v.width=r.width;v.height=r.height;v.getContext('2d').drawImage(c,r.x,r.y,r.width,r.height,0,0,r.width,r.height);return v.toDataURL();},rect);
  await page.mouse.move(330,300);await page.mouse.down();await page.mouse.move(540,410,{steps:20});await page.mouse.up();
  await page.screenshot({path:path.join(root,`${mode}-annotating.png`)});
  const closed=page.waitForEvent('close');await page.keyboard.press('Escape');await closed;
  assert.equal(captures().length,before+1);
  const metadata=captures().map(f=>({file:f,value:JSON.parse(fs.readFileSync(f,'utf8'))})).sort((a,b)=>fs.statSync(b.file).mtimeMs-fs.statSync(a.file).mtimeMs)[0];
  assert.deepEqual(metadata.value.rect,rect);
  const compared=await app.evaluate(({nativeImage},{background,file})=>{const a=nativeImage.createFromDataURL(background),b=nativeImage.createFromPath(file);const x=a.toBitmap(),y=b.toBitmap();let changed=0;for(let i=0;i<x.length;i+=4)if(Math.abs(x[i]-y[i])+Math.abs(x[i+1]-y[i+1])+Math.abs(x[i+2]-y[i+2])>30)changed++;return {changed,size:b.getSize()};},{background,file:metadata.file.replace('.json','.png')});
  assert.deepEqual(compared.size,{width:rect.width,height:rect.height});assert.ok(compared.changed>100,'Default pencil stroke must be archived');
  report.push({mode,selectedRegionStayedOpen:mode==='region',defaultPencil:true,rect,...compared,passed:true});
 }
 fs.writeFileSync(path.join(root,'capture-modes-report.json'),JSON.stringify({passed:true,checks:report},null,2));console.log('CAPTURE_MODES_PASSED',JSON.stringify(report));
})().catch(async e=>{console.error(e);console.error(JSON.stringify(errors));fs.writeFileSync(path.join(root,'capture-modes-report.json'),JSON.stringify({passed:false,checks:report,error:String(e),errors},null,2));process.exitCode=1;}).finally(async()=>{if(app)await app.evaluate(({app})=>app.exit());});
