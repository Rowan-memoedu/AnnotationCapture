const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {prepareProfile,isolateWindow}=require('./acceptance-window.cjs');
const root=process.env.ANNOTATION_EVIDENCE||'D:/Artifacts/AnnotationCapture/output-acceptance';
const data=path.join(root,`output-profile-${Date.now()}`);prepareProfile(data);
const exe=process.env.ANNOTATION_EXE||path.resolve('node_modules/electron/dist/electron.exe');
const baseArgs=[...(process.env.ANNOTATION_EXE?[]:['.']),'--userData',data,'--testMode'];
const prior=process.env.ANNOTATION_RESUME_OUTPUT==='1'&&fs.existsSync(path.join(root,'ocr-output-report.json'))?JSON.parse(fs.readFileSync(path.join(root,'ocr-output-report.json'),'utf8')):null;
const checks=prior?.checks||[];let app;
async function launch(extra=[]){app=await _electron.launch({executablePath:exe,args:[...baseArgs,...extra],timeout:30000});return app.firstWindow();}
async function stop(){if(app){await app.evaluate(({app})=>app.exit());app=null;}}
async function stroke(page,points){await page.mouse.move(...points[0]);await page.mouse.down();for(const p of points.slice(1))await page.mouse.move(...p,{steps:4});await page.mouse.up();}
async function result(minimumJobs=1){let panel=app.windows().find(p=>p.url().endsWith('annotation.html'));if(!panel)panel=await app.waitForEvent('window');let job;for(let attempt=0;attempt<300;attempt++){const state=await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:state'));job=state.jobs[0];if(state.jobs.length>=minimumJobs&&['copied','error','review'].includes(job.status))break;await new Promise(resolve=>setTimeout(resolve,250));}assert.equal(job?.status,'copied',job?.message);assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),job.latex);return {job,panel};}
async function mermaid(code,name,expected){
 const pending=app.waitForEvent('window');await app.evaluate(({BrowserWindow})=>{const w=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true}});w.loadURL('about:blank');});const validator=await pending;
 await validator.addScriptTag({path:process.env.MERMAID_BROWSER_SCRIPT||'D:/Caches/AnnotationCapture/ocr-validation/node_modules/mermaid/dist/mermaid.min.js'});
 const parsed=await validator.evaluate(async code=>{mermaid.initialize({startOnLoad:false,securityLevel:'strict'});await mermaid.parse(code);const d=await mermaid.mermaidAPI.getDiagramFromText(code);const vertices=[...d.db.getVertices().values()].map(v=>({id:v.id,label:v.text}));const edges=d.db.getEdges().map(e=>({from:e.start,to:e.end}));const {svg}=await mermaid.render('accepted-diagram',code);return {vertices,edges,svg};},code);
 const labels=new Map(parsed.vertices.map(v=>[v.id,v.label]));const edges=parsed.edges.map(e=>`${labels.get(e.from)}->${labels.get(e.to)}`).sort();assert.deepEqual(edges,expected.slice().sort());
 assert.match(parsed.svg,/<svg/);fs.writeFileSync(path.join(root,`${name}-rendered.svg`),parsed.svg);await validator.close();return {syntaxParsed:true,rendered:true,edges};
}
(async()=>{
 let panel=await launch();await panel.waitForSelector('#ac-invite-code');await isolateWindow(app,panel);
 const invite=JSON.parse(fs.readFileSync(process.env.ANNOTATION_INVITE_FILE,'utf8'));await panel.locator('#ac-invite-code').fill(invite.inviteCode);await panel.locator('#ac-login').click();await panel.waitForFunction(()=>document.querySelector('#ac-login-status').textContent.includes('识别服务可用'));
 const fixtures={};
 for(const kind of ['text','markdown','formula','mermaid']){
  const png=await panel.evaluate(kind=>{const c=document.createElement('canvas');c.width=1000;c.height=600;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,c.width,c.height);x.fillStyle='black';x.strokeStyle='black';x.lineWidth=4;x.font='36px Arial';
   if(kind==='text'){x.fillText('Practice makes progress.',80,180);x.fillText('Keep the original wording.',80,240);}
   if(kind==='markdown'){x.font='bold 48px Arial';x.fillText('Study Plan',80,100);x.font='bold 34px Arial';x.fillText('Tasks',80,180);x.font='30px Arial';x.fillText('• Read chapter',90,240);x.fillText('• Review notes',90,295);x.font='bold 34px Arial';x.fillText('Deadline',80,390);x.font='30px Arial';x.fillText('Friday',80,445);}
   if(kind==='formula'){x.font='48px Times New Roman';x.fillText('X + x',210,210);x.fillRect(180,235,200,3);x.fillText('2',268,305);}
   if(kind==='mermaid'){x.strokeRect(100,180,220,120);x.strokeRect(620,180,220,120);x.font='48px Arial';x.fillText('A',190,260);x.fillText('B',710,260);x.beginPath();x.moveTo(320,240);x.lineTo(620,240);x.lineTo(595,225);x.moveTo(620,240);x.lineTo(595,255);x.stroke();}
   return c.toDataURL();},kind);
  fixtures[kind]=path.join(root,`direct-${kind}-source.png`);fs.writeFileSync(fixtures[kind],Buffer.from(png.split(',')[1],'base64'));
 }
 await stop();
 for(const kind of Object.keys(fixtures)){
  if(checks.some(c=>c.case===`direct-auto-${kind}`))continue;
  const page=await launch(['--input',fixtures[kind],'--ocr']);await page.waitForFunction(()=>document.querySelector('#ac-completion')&&document.body.style.opacity!=='0');await isolateWindow(app,page);
  assert.equal(await page.locator('#draw_free_pencil').evaluate(e=>e.classList.contains('select')),false);
  const b=await page.locator('#main_photo').boundingBox();const closed=page.waitForEvent('close');await page.mouse.move(b.x+8,b.y+8);await page.mouse.down();await page.mouse.move(b.x+b.width-8,b.y+b.height-8,{steps:8});await page.mouse.up();await closed;
  const {job}=await result();assert.equal(job.outputFormat,'auto');assert.equal(job.detectedType,kind);
  if(kind==='text')assert.equal(job.latex.replace(/\s+/g,' '),'Practice makes progress. Keep the original wording.');
  if(kind==='markdown'){assert.match(job.latex,/^#{1,3} .*Study Plan/m);assert.match(job.latex,/[-*+] Read chapter/);assert.match(job.latex,/Review notes/);}
  if(kind==='formula')assert.equal(job.latex.replace(/\s/g,'').replace(/\\left|\\right/g,''),'$\\frac{X+x}{2}$');
  const diagram=kind==='mermaid'?await mermaid(job.latex.slice(11,-4),`direct-${kind}`,['A->B']):undefined;
  checks.push({case:`direct-auto-${kind}`,selectionImmediatelyRecognized:true,annotationSkipped:true,type:job.detectedType,clipboardMatched:true,actual:job.latex,...diagram});console.log('DIRECT_OCR_PASSED',kind);await stop();
 }
 panel=await launch();await panel.waitForSelector('#ac-start');await isolateWindow(app,panel);
 for(const branch of [false,true]){
  if(checks.some(c=>c.case===(branch?'ink-mermaid-branch':'ink-mermaid-chain')))continue;
  await panel.waitForFunction(()=>document.querySelector('#ac-login-status').textContent.includes('识别服务可用'));
  const beforeJobs=await panel.evaluate(async()=>{const s=await require('electron').ipcRenderer.invoke('annotation:state');return s.jobs.length;});
  const pending=app.waitForEvent('window');await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:capture','full'));const page=await pending;await page.waitForFunction(()=>document.querySelector('#draw_free_pencil')?.classList.contains('select'));await isolateWindow(app,page);
  const paths=[[[350,250],[450,250],[450,350],[350,350],[350,250]],[[650,250],[750,250],[750,350],[650,350],[650,250]],[[375,325],[400,275],[425,325]],[[385,307],[415,307]],[[680,275],[680,325]],[[680,275],[704,275],[716,284],[710,296],[680,300],[708,301],[718,313],[708,325],[680,325]],[[450,300],[650,300]],[[630,285],[650,300],[630,315]]];
  if(branch)paths.push([[650,450],[750,450],[750,550],[650,550],[650,450]],[[720,477],[709,472],[687,478],[680,497],[685,519],[706,525],[720,518]],[[450,330],[650,500]],[[628,474],[650,500],[620,500]]);
  for(const points of paths)await stroke(page,points);
  const geometry=await page.locator('#main_photo').evaluate(c=>{const b=c.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};});
  await page.keyboard.press('Control+Shift+Enter');await page.waitForSelector('#ac-selection');await page.locator('#ac-output-format').selectOption('mermaid');
  const box=await page.locator('#ac-selection').boundingBox(),map=(x,y)=>[box.x+(x-geometry.x)/geometry.w*box.width,box.y+(y-geometry.y)/geometry.h*box.height];
  await page.mouse.move(...map(320,220));await page.mouse.down();await page.mouse.move(...map(780,branch?580:380),{steps:8});await page.mouse.up();const closed=page.waitForEvent('close');await page.locator('#ac-recognize').click();await closed;
  const r=await result(beforeJobs+1);panel=r.panel;await isolateWindow(app,panel);assert.equal(r.job.outputFormat,'mermaid');const validated=await mermaid(r.job.latex.slice(11,-4),branch?'ink-branch':'ink-chain',branch?['A->B','A->C']:['A->B']);checks.push({case:branch?'ink-mermaid-branch':'ink-mermaid-chain',clipboardMatched:true,actual:r.job.latex,...validated});console.log('INK_MERMAID_PASSED',branch);
 }
 fs.writeFileSync(path.join(root,'ocr-output-report.json'),JSON.stringify({passed:true,checks},null,2));
})().catch(async error=>{const message=String(error.stack||error).replace(/AC-[A-Za-z0-9_-]+/g,'[invitation]');const states=[];for(const p of app?.windows()||[])if(p.url().endsWith('annotation.html')){const s=await p.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:state'));states.push({login:s.login,jobs:s.jobs.map(j=>({id:j.id,status:j.status,outputFormat:j.outputFormat}))});}fs.writeFileSync(path.join(root,'ocr-output-report.json'),JSON.stringify({passed:false,checks,error:message,states},null,2));console.error(message);process.exitCode=1;}).finally(stop);
