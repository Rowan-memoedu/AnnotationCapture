const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {prepareProfile,isolateWindow}=require('./acceptance-window.cjs');
const root=process.env.ANNOTATION_EVIDENCE||'D:/Artifacts/AnnotationCapture/formula-phase/ui';
fs.mkdirSync(root,{recursive:true});
const data=path.join(root,`profile-${Date.now()}`);prepareProfile(data);
let app,panel;const checks=[],errors=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(values={}) {return app.evaluate((_electron,values)=>Object.assign(globalThis.inkFixture,values),values);}
async function stroke(page,points) {await page.mouse.move(...points[0]);await page.mouse.down();for(const p of points.slice(1))await page.mouse.move(...p,{steps:4});await page.mouse.up();}
async function write(page,x=350,y=310){await stroke(page,[[x,y],[x+40,y+60]]);await stroke(page,[[x,y+60],[x+40,y]]);await stroke(page,[[x+65,y+30],[x+105,y+30]]);await stroke(page,[[x+85,y+10],[x+85,y+50]]);await stroke(page,[[x+130,y+12],[x+145,y],[x+145,y+60]]);}
async function inkBox(page){return page.locator('#draw_photo').evaluate(c=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let l=c.width,r=0,t=c.height,b=0;for(let i=0;i<d.length;i+=4)if(d[i+3]>50){const x=(i/4)%c.width,y=Math.floor(i/4/c.width);l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}const box=c.getBoundingClientRect();return {left:box.left+l/c.width*box.width,right:box.left+r/c.width*box.width,top:box.top+t/c.height*box.height,bottom:box.top+b/c.height*box.height};});}
async function blankDoubleClick(page){const p=await page.locator('.upper-canvas').evaluate(c=>{const r=c.getBoundingClientRect();return {x:Math.min(r.right-20,innerWidth-40),y:Math.min(r.bottom-20,innerHeight-130)};});await page.mouse.dblclick(p.x,p.y);}
async function open(mode='full') {
 const next=app.waitForEvent('window');await panel.evaluate(mode=>require('electron').ipcRenderer.invoke('annotation:capture',mode),mode);const page=await next;
 page.on('pageerror',e=>errors.push(String(e)));await page.waitForFunction(()=>document.querySelector('#ac-formula-pen')&&document.body.style.opacity!=='0');await isolateWindow(app,page);
 if(mode==='region'){await page.mouse.move(230,200);await page.mouse.down();await page.mouse.move(1100,700,{steps:8});await page.mouse.up();}
 return page;
}
function records(){const out=[];function walk(d){if(!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory())walk(f);else if(e.name==='annotations.json')out.push(f);}}walk(path.join(data,'Archive'));return out;}
async function finish(page){const before=records();const closing=page.waitForEvent('close');await page.keyboard.press('Escape');await closing;const fresh=records().filter(f=>!before.includes(f));assert.equal(fresh.length,1);return JSON.parse(fs.readFileSync(fresh[0],'utf8'));}
async function converted(page){await page.waitForFunction(()=>document.querySelector('#ac-ink-status').textContent.includes('公式已回填'),undefined,{timeout:20000});assert.equal(page.isClosed(),false);}
(async()=>{
 app=await _electron.launch({executablePath:process.env.ANNOTATION_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(process.env.ANNOTATION_EXE?[]:['.']),'--userData',data,'--testMode',...(process.env.ANNOTATION_SCALE?['--force-device-scale-factor='+process.env.ANNOTATION_SCALE]:[])],timeout:30000});
 panel=await app.firstWindow();await panel.waitForSelector('#ac-save-settings');await isolateWindow(app,panel);
 await app.evaluate(({ipcMain,nativeImage,screen,clipboard})=>{
  globalThis.inkFixture={calls:0,cancelled:0,delay:20,latex:'x+1',fail:false,inputs:[]};
  ipcMain.removeHandler('annotation:inkRecognize');ipcMain.removeHandler('annotation:inkCancel');ipcMain.removeHandler('annotation:screenshots');
  ipcMain.handle('annotation:inkRecognize',async(_e,id,png)=>{const s=globalThis.inkFixture;const im=nativeImage.createFromDataURL(png);s.calls++;s.inputs.push({id,size:im.getSize()});const {delay,latex,fail}=s;await new Promise(r=>setTimeout(r,delay));if(fail)throw new Error('Controlled recognition failure');return {latex,model:'fixture'};});
  ipcMain.handle('annotation:inkCancel',()=>{globalThis.inkFixture.cancelled++;});
  ipcMain.handle('annotation:screenshots',()=>screen.getAllDisplays().map(d=>{const width=Math.round(d.size.width*d.scaleFactor),height=Math.round(d.size.height*d.scaleFactor);return {id:d.id,bounds:d.bounds,scaleFactor:d.scaleFactor,png:nativeImage.createFromBitmap(Buffer.alloc(width*height*4,255),{width,height}).toDataURL()};}));
  clipboard.writeText('formula-pen-must-not-copy');
 });
 const samples=[];
 for(const font of ['stix2','newcm']) {
  const svg=await panel.evaluate(({font})=>require('electron').ipcRenderer.invoke('annotation:typeset','\\frac{X+x_1}{2}+\\sqrt{y}=\\sum_{n=1}^{\\infty}\\frac{1}{n^2}',font,'#1256ab'),{font});
  assert.ok(svg.includes('<path')&&!/<use\b|<text\b|(?:href|src)=/.test(svg));assert.ok(svg.includes('#1256ab'));samples.push(svg);fs.writeFileSync(path.join(root,`${font}.svg`),svg);
 }
 assert.notEqual(samples[0],samples[1]);checks.push('both local fonts render self-contained vector paths');
 for(const mode of ['full','region']) {
  const page=await open(mode);const count=records().length;
  await page.locator('#ac-formula-pen').click();await write(page);
  // A real decimal point written away from the double click must survive in source.
  await page.mouse.click(520,370);await delay(700);
  const calls=(await fixture()).calls;
  const sourceBox=await inkBox(page);await blankDoubleClick(page);await converted(page);const resultBox=await inkBox(page);fs.writeFileSync(path.join(root,`${mode}-geometry.json`),JSON.stringify({sourceBox,resultBox},null,2));assert.ok(resultBox.left>=sourceBox.left-3&&resultBox.right<=sourceBox.right+3&&resultBox.top>=sourceBox.top-3&&resultBox.bottom<=sourceBox.bottom+3,'Typeset formula must stay within original visible ink bounds');
  assert.equal((await fixture()).calls,calls+1);assert.equal(records().length,count);
  await page.screenshot({path:path.join(root,`${mode}-typeset.png`)});
  if(mode==='full') {
   const after=await page.locator('#draw_photo').evaluate(c=>c.toDataURL());
   await page.keyboard.press('Control+z');await delay(250);const undo=await page.locator('#draw_photo').evaluate(c=>c.toDataURL());assert.notEqual(undo,after);
   await page.keyboard.press('Control+y');await delay(500);const redo=await page.locator('#draw_photo').evaluate(c=>c.toDataURL());fs.writeFileSync(path.join(root,'before-undo.png'),Buffer.from(after.split(',')[1],'base64'));fs.writeFileSync(path.join(root,'after-redo.png'),Buffer.from(redo.split(',')[1],'base64'));assert.ok(redo===after,'Redo must restore the same rendered formula');
   // Switch to existing object selection, select the replacement and edit locally.
   await page.locator('#draw_select').hover();await delay(180);await page.locator('#draw_select_draw').click();await page.mouse.click((resultBox.left+resultBox.right)/2,(resultBox.top+resultBox.bottom)/2);
   await page.waitForSelector('#ac-formula-editor',{state:'visible'});
   await page.locator('#ac-formula-latex').fill('\\frac{X+x}{2}');await page.locator('#ac-inline-font').selectOption('newcm');await page.locator('#ac-apply-formula').click();
   await page.waitForFunction(()=>document.querySelector('#ac-ink-status').textContent.includes('公式已更新'));assert.equal((await fixture()).calls,calls+1);
  }
  const saved=await finish(page);const formula=saved.canvas.objects.find(o=>o.acFormula);assert.ok(formula);assert.equal(formula.acFormula.source.length,6,'double click taps must not become formula strokes');
  assert.equal(saved.canvas.objects.filter(o=>o.acInk).length,0);checks.push(`${mode}: double click, dot preservation, archive metadata`);
 }
 // Ordinary pencil must not invoke OCR.
 let page=await open();await write(page);let calls=(await fixture()).calls;await page.mouse.dblclick(900,550);await delay(500);assert.equal((await fixture()).calls,calls);await finish(page);checks.push('ordinary pencil double click does not convert or close');
 // Recognition failure preserves source; retry uses those same strokes.
 await fixture({fail:true});page=await open();await page.locator('#ac-formula-pen').click();await write(page);await page.keyboard.press('Control+Shift+t');await page.waitForFunction(()=>document.querySelector('#ac-ink-status').textContent.includes('转换失败'));
 await fixture({fail:false});await page.locator('#ac-typeset').click();await converted(page);assert.ok((await finish(page)).canvas.objects.some(o=>o.acFormula));checks.push('recognition failure and retry preserve ink');
 await fixture({latex:'\\notASupportedCommand{x}'});page=await open();await page.locator('#ac-formula-pen').click();await write(page);await page.locator('#ac-typeset').click();await page.waitForFunction(()=>document.querySelector('#ac-ink-status').textContent.includes('转换失败'));const badRender=await finish(page);assert.equal(badRender.canvas.objects.filter(o=>o.acInk).length,5);assert.ok(!badRender.canvas.objects.some(o=>o.acFormula));checks.push('invalid LaTeX preserves all original strokes');
 await fixture({latex:'x+1',delay:1500});page=await open();await page.locator('#ac-formula-pen').click();await write(page);await page.locator('#ac-typeset').click();await page.locator('#draw_select').hover();await delay(180);await page.locator('#draw_select_draw').click();await page.mouse.click(370,340);await page.keyboard.press('Delete');await delay(1700);const deleted=await finish(page);assert.equal(deleted.canvas.objects.filter(o=>o.acInk).length,4);assert.ok(!deleted.canvas.objects.some(o=>o.acFormula));checks.push('deleted source is not replaced by a late response');
 // Undo while the response is pending invalidates it.
 await fixture({delay:1000});page=await open();await page.locator('#ac-formula-pen').click();await write(page);await page.locator('#ac-typeset').click();await page.keyboard.press('Control+z');await delay(1500);const stale=await finish(page);assert.ok(!stale.canvas.objects.some(o=>o.acFormula));assert.equal(stale.canvas.objects.filter(o=>o.acInk).length,4);checks.push('late response after undo is discarded');
 // Two batches, duplicate trigger, and active writing while processing.
 await fixture({delay:1200});page=await open();await page.locator('#ac-formula-pen').click();await write(page);calls=(await fixture()).calls;await page.locator('#ac-typeset').click();await page.locator('#ac-typeset').click();await write(page,350,150);await page.locator('#ac-typeset').click();await delay(2000);const batches=await finish(page);assert.equal((await fixture()).calls,calls+2);assert.equal(batches.canvas.objects.filter(o=>o.acFormula).length,2);checks.push('separate batches and duplicate suppression');
 // Esc must not wait for the OCR request, nor resurrect a closed canvas.
 await fixture({delay:5000});page=await open();await page.locator('#ac-formula-pen').click();await write(page);await page.locator('#ac-typeset').click();const started=Date.now();const exiting=await finish(page);assert.ok(Date.now()-started<3000);assert.equal(exiting.canvas.objects.filter(o=>o.acInk).length,5);assert.ok((await fixture()).cancelled>=1);checks.push('Esc cancels pending OCR and archives source without waiting');
 await fixture({delay:20});await panel.reload();await panel.waitForSelector('#ac-formula-font');await panel.locator('#ac-formula-font').selectOption('newcm');await panel.locator('#ac-pen-color').fill('#2266cc');await panel.locator('#ac-pen-width-setting').fill('6');await panel.locator('#ac-save-settings').click();await panel.waitForFunction(()=>document.querySelector('#ac-panel-status').textContent.includes('设置已保存'));await panel.reload();await panel.waitForSelector('#ac-formula-font');assert.equal(await panel.locator('#ac-formula-font').inputValue(),'newcm');page=await open('region');await page.locator('#ac-formula-pen').click();await write(page);await page.locator('#ac-typeset').click();await converted(page);const custom=(await finish(page)).canvas.objects.find(o=>o.acFormula).acFormula;assert.equal(custom.font,'newcm');assert.equal(custom.color,'#2266cc');assert.ok(custom.source.every(o=>o.stroke==='#2266cc'&&o.strokeWidth===6));checks.push('saved font, color and width apply to formula pen');
 page=await open();await page.locator('#ac-formula-pen').click();await page.evaluate(()=>{window.penMouseMessages=0;document.addEventListener('pointerdown',e=>{if(e.pointerType==='pen')e.preventDefault();},true);document.addEventListener('mousedown',e=>{if(e.target.classList.contains('upper-canvas'))window.penMouseMessages++;},true);});const cdp=await page.context().newCDPSession(page);
 async function pen(type,x,y,clickCount=1){await cdp.send('Input.dispatchMouseEvent',{type,x,y,pointerType:'pen',button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:clickCount,force:type==='mouseReleased'?0:0.6});}
 for(const points of [[[350,310],[390,370]],[[350,370],[390,310]],[[415,340],[455,340]],[[435,320],[435,360]],[[480,322],[495,310],[495,370]]]){await pen('mouseMoved',...points[0]);await pen('mousePressed',...points[0]);for(const point of points.slice(1))await pen('mouseMoved',...point);await pen('mouseReleased',...points.at(-1));}
 const blank=await page.locator('.upper-canvas').evaluate(c=>{const r=c.getBoundingClientRect();return {x:Math.min(r.right-20,innerWidth-40),y:Math.min(r.bottom-20,innerHeight-130)};});for(const clicks of [1,2]){await pen('mouseMoved',blank.x,blank.y);await pen('mousePressed',blank.x,blank.y,clicks);await pen('mouseReleased',blank.x,blank.y,clicks);}await converted(page);assert.equal(await page.evaluate(()=>window.penMouseMessages),0);const penSaved=await finish(page);assert.equal(penSaved.canvas.objects.find(o=>o.acFormula).acFormula.source.length,5);checks.push('pen-only formula ink and double tap without mouse compatibility events');
 assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),'formula-pen-must-not-copy');checks.push('canvas conversion does not change clipboard');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log('FORMULA_PEN_PASSED',checks);
})().catch(e=>{fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:false,checks,error:String(e),errors},null,2));console.error(e,errors);process.exitCode=1;}).finally(async()=>{if(app)await app.evaluate(({app})=>app.exit());});
