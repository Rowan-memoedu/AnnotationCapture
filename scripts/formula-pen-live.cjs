const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {prepareProfile,isolateWindow}=require('./acceptance-window.cjs');
const root=process.env.ANNOTATION_EVIDENCE||'D:/Artifacts/AnnotationCapture/formula-phase/live';fs.mkdirSync(root,{recursive:true});
const data=path.join(root,`profile-${Date.now()}`);prepareProfile(data);
const cases=[
 {name:'polynomial',font:'stix2',expected:'x^2+1=0',strokes:[[[430,350],[475,405]],[[430,405],[475,350]],[[489,328],[494,320],[509,320],[517,328],[516,335],[489,351],[518,351]],[[550,378],[590,378]],[[570,358],[570,398]],[[620,365],[632,352],[632,404]],[[620,405],[646,405]],[[680,367],[724,367]],[[680,388],[724,388]],[[769,351],[751,356],[744,375],[747,395],[762,405],[778,400],[786,380],[782,360],[769,351]]]},
 {name:'root',font:'newcm',expected:'\\sqrt{x+1}',strokes:[[[430,371],[444,357],[458,405],[484,325],[680,325]],[[505,347],[545,397]],[[505,397],[545,347]],[[565,372],[605,372]],[[585,352],[585,392]],[[630,360],[643,347],[643,397]],[[630,398],[657,398]]]},
 {name:'mixedcase',font:'stix2',expected:'X+x=2',strokes:[[[430,325],[475,405]],[[430,405],[475,325]],[[495,382],[525,382]],[[510,367],[510,397]],[[550,365],[555,363],[563,365],[570,378],[580,396],[587,399]],[[585,364],[580,368],[570,383],[558,398],[551,400]],[[610,372],[650,372]],[[610,390],[650,390]],[[680,363],[686,353],[701,352],[710,358],[711,366],[704,375],[680,400],[714,400]]]}
];
let app;const checks=[],errors=[];const canonical=s=>s.replace(/\s/g,'').replace(/\\left|\\right/g,'').replace(/([_^])\{([A-Za-z0-9])\}/g,'$1$2');
(async()=>{
 app=await _electron.launch({executablePath:process.env.ANNOTATION_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(process.env.ANNOTATION_EXE?[]:['.']),'--userData',data,'--testMode'],timeout:30000});
 const panel=await app.firstWindow();await panel.waitForSelector('#ac-start');await isolateWindow(app,panel);
 const invite=JSON.parse(fs.readFileSync(process.env.ANNOTATION_INVITE_FILE||'D:/AppData/AnnotationCapture/Admin/owner-invite.json','utf8'));await panel.locator('#ac-invite-code').fill(invite.inviteCode);await panel.locator('#ac-login').click();await panel.waitForFunction(()=>document.querySelector('#ac-login-status').textContent.includes('识别服务可用'));
 // Only the background is synthetic. The actual production recognition handler,
 // authentication and gateway remain untouched; expected answers are assertions.
 await app.evaluate(({ipcMain,nativeImage,screen,clipboard})=>{ipcMain.removeHandler('annotation:screenshots');ipcMain.handle('annotation:screenshots',()=>screen.getAllDisplays().map(d=>{const width=Math.round(d.size.width*d.scaleFactor),height=Math.round(d.size.height*d.scaleFactor);return {id:d.id,bounds:d.bounds,scaleFactor:d.scaleFactor,png:nativeImage.createFromBitmap(Buffer.alloc(width*height*4,255),{width,height}).toDataURL()};}));clipboard.writeText('live-formula-clipboard-unchanged');});
 for(const item of cases){
  await panel.evaluate(async font=>{const ipc=require('electron').ipcRenderer,s=await ipc.invoke('annotation:state');await ipc.invoke('annotation:configure',{...s.config,formulaFont:font});},item.font);
  const next=app.waitForEvent('window');await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:capture','full'));const page=await next;page.on('pageerror',e=>errors.push(String(e)));await page.waitForFunction(()=>document.querySelector('#ac-formula-pen')&&document.body.style.opacity!=='0');await isolateWindow(app,page);await page.locator('#ac-formula-pen').click();
  for(const stroke of item.strokes){await page.mouse.move(...stroke[0]);await page.mouse.down();for(const p of stroke.slice(1))await page.mouse.move(...p,{steps:3});await page.mouse.up();}
  await page.screenshot({path:path.join(root,`${item.name}-source.png`)});const start=Date.now();await page.mouse.dblclick(1000,580);
  await page.waitForFunction(()=>{const s=document.querySelector('#ac-ink-status').textContent;return s.includes('公式已回填')||s.includes('转换失败');},undefined,{timeout:100000});
  const status=await page.locator('#ac-ink-status').textContent();assert.ok(status.includes('公式已回填'),status);assert.equal(page.isClosed(),false);await page.screenshot({path:path.join(root,`${item.name}-result.png`)});
  const close=page.waitForEvent('close');await page.keyboard.press('Escape');await close;
  const archives=[];function walk(d){if(!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory())walk(f);else if(e.name==='annotations.json')archives.push(f);}}walk(path.join(data,'Archive'));
  const file=archives.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];const saved=JSON.parse(fs.readFileSync(file,'utf8'));const formula=saved.canvas.objects.find(o=>o.acFormula)?.acFormula;assert.ok(formula);assert.equal(formula.font,item.font);assert.equal(formula.source.length,item.strokes.length);assert.equal(saved.canvas.objects.filter(o=>o.acInk).length,0);
  const exactMatch=canonical(formula.latex)===canonical(item.expected);checks.push({case:item.name,font:item.font,latex:formula.latex,expected:item.expected,exactMatch,returnedToCanvas:true,sourceStrokesPreserved:formula.source.length,durationMs:Date.now()-start});console.log('LIVE_INK_CASE',JSON.stringify(checks.at(-1)));
 }
 assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),'live-formula-clipboard-unchanged');assert.deepEqual(errors,[]);const exact=checks.filter(c=>c.exactMatch).length;fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:true,exactMatches:exact,total:checks.length,checks,errors},null,2));console.log('LIVE_INK_PASSED',exact,checks.length);
})().catch(e=>{fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:false,checks,error:String(e),errors},null,2));console.error(e,errors);process.exitCode=1;}).finally(async()=>{if(app)await app.evaluate(({app})=>app.exit());});
