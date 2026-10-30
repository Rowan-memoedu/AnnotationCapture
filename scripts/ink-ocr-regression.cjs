const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {prepareProfile,isolateWindow}=require('./acceptance-window.cjs');
const root=path.join(process.env.ANNOTATION_EVIDENCE||'D:/Artifacts/AnnotationCapture/capture-fix-0.5.1','ink-ocr');
fs.mkdirSync(root,{recursive:true});
const strokes=[[[430,320],[470,370]],[[430,370],[470,320]],[[490,345],[530,345]],[[510,325],[510,365]],[[552,334],[566,320],[566,370]],[[554,370],[578,370]],[[415,397],[595,397]],[[485,432],[494,420],[514,420],[526,433],[523,444],[486,475],[529,475]]];
const checks=[];let app;
async function stroke(page,points){await page.mouse.move(...points[0]);await page.mouse.down();for(const p of points.slice(1))await page.mouse.move(...p,{steps:4});await page.mouse.up();}
(async()=>{
 for(const scenario of [{name:'normal-pen',mode:'full',formula:false},{name:'formula-pen',mode:'full',formula:true},{name:'free-capture',mode:'region',formula:true}].filter(s=>!process.env.ANNOTATION_INK_SCENARIO||s.name===process.env.ANNOTATION_INK_SCENARIO)){
  const data=path.join(root,scenario.name+'-'+Date.now());prepareProfile(data,{penColor:'#ff0000',penWidth:7});
  fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({'图像编辑':{'记忆':{select:'free',draw:'free',shape:'arrow',filter:'pixelate'}}}));
  app=await _electron.launch({executablePath:process.env.ANNOTATION_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(process.env.ANNOTATION_EXE?[]:['.']),'--userData',data,'--testMode'],timeout:30000});
  const panel=await app.firstWindow();await panel.waitForSelector('#ac-save-settings');await isolateWindow(app,panel);
  if(process.env.ANNOTATION_INVITE_FILE){const invite=JSON.parse(fs.readFileSync(process.env.ANNOTATION_INVITE_FILE,'utf8'));await panel.evaluate(code=>require('electron').ipcRenderer.invoke('annotation:login',code),invite.inviteCode);}
  const next=app.waitForEvent('window');await panel.evaluate(mode=>require('electron').ipcRenderer.invoke('annotation:capture',mode),scenario.mode);const page=await next;
  await page.waitForFunction(()=>document.body.style.opacity!=='0'&&document.querySelector('#ac-formula-pen'));await isolateWindow(app,page);
  if(scenario.mode==='region'){await page.locator('#draw_select').hover();await page.locator('#draw_select_free').click();await stroke(page,[[300,240],[700,240],[700,550],[300,550],[300,240]]);}
  if(scenario.formula)await page.locator('#ac-formula-pen').click();
  for(const points of strokes)await stroke(page,points);
  await page.screenshot({path:path.join(root,scenario.name+'-drawing.png')});
  if(!scenario.formula)await page.locator('#ac-formula-pen').click();
  await page.locator('#ac-formula').click();await page.waitForSelector('#ac-selection');
  const preview=await page.locator('#ac-selection').evaluate(c=>{const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let red=0,alpha=0;for(let i=0;i<p.length;i+=4){if(p[i]>150&&p[i+1]<100&&p[i+2]<100&&p[i+3]>8)red++;if(p[i+3]>8)alpha++;}return {width:c.width,height:c.height,red,alpha};});
  fs.writeFileSync(path.join(root,scenario.name+'-preview.json'),JSON.stringify(preview,null,2));
  assert.ok(preview.red>500,'Preview lost the drawn ink');assert.ok(preview.alpha>preview.width*preview.height/2,'Preview is blank/transparent');
  await page.screenshot({path:path.join(root,scenario.name+'-selection.png')});
  await page.locator('#ac-output-format').selectOption('mathAcademy');
  let b=await page.locator('#ac-selection').boundingBox();
  await stroke(page,[[b.x+5,b.y+5],[b.x+20,b.y+20]]);await page.locator('#ac-recognize').click();
  assert.match(await page.locator('#ac-selection-status').textContent(),/没有批注笔迹/);
  b=await page.locator('#ac-selection').boundingBox();
  await stroke(page,[[b.x+2,b.y+2],[b.x+b.width-2,b.y+b.height-2]]);
  const closed=page.waitForEvent('close');await page.locator('#ac-recognize').click();await closed;
  let job;for(let i=0;i<320;i++){const state=await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:state'));job=state.jobs[0];if(job&&['copied','review','error','unconfigured'].includes(job.status)&&job.status!=='unconfigured')break;if(!process.env.ANNOTATION_INVITE_FILE&&job)break;await new Promise(r=>setTimeout(r,250));}
  assert.ok(job);if(process.env.ANNOTATION_INVITE_FILE)assert.equal(job.status,'copied',job.message);
  fs.copyFileSync(job.path,path.join(root,scenario.name+'-ocr-input.png'));
  const ink=await panel.evaluate(async file=>{const img=new Image();img.src='data:image/png;base64,'+require('node:fs').readFileSync(file).toString('base64');await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const x=c.getContext('2d');x.drawImage(img,0,0);const p=x.getImageData(0,0,c.width,c.height).data;let red=0,other=0;for(let i=0;i<p.length;i+=4){if(p[i]>150&&p[i+1]<100&&p[i+2]<100)red++;if(p[i]<250||Math.abs(p[i+1]-p[i+2])>2||p[i+3]!==255)other++;}return {red,other};},job.path);
  assert.ok(ink.red>500);assert.equal(ink.other,0,'OCR image must contain only red ink and white, never desktop content');
  const canonical=s=>s.replace(/\s/g,'').replace(/\\left|\\right/g,'');
  checks.push({scenario:scenario.name,rememberedCaptureTool:'free',preview,ink,actual:job.latex,expected:'\\frac{X+1}{2}',exactMatch:canonical(job.latex)==='\\frac{X+1}{2}',realOcr:!!process.env.ANNOTATION_INVITE_FILE,clipboardMatched:await app.evaluate(({clipboard})=>clipboard.readText())===job.latex});
  await panel.locator('#ac-results').screenshot({path:path.join(root,scenario.name+'-result.png')});
  console.log('INK_OCR_CHECK',JSON.stringify(checks.at(-1)));
  await app.evaluate(({app})=>app.exit());app=null;
 }
 fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:true,checks},null,2));
})().catch(e=>{fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:false,checks,error:String(e)},null,2));console.error(e);process.exitCode=1;}).finally(async()=>{if(app)await app.evaluate(({app})=>app.exit()).catch(()=>{});});
