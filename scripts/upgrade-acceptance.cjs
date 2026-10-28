const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {pipeline}=require('node:stream/promises');
const yauzl=require('yauzl');
const expectedVersion=require('../package.json').version;
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {isolateWindow}=require('./acceptance-window.cjs');
const root=process.env.ANNOTATION_EVIDENCE||'D:/Artifacts/AnnotationCapture/auth-phase/upgrade';
const directory=path.join('D:/Quarantine/AnnotationCapture',`upgrade-${Date.now()}`);
const oldZip=process.env.ANNOTATION_OLD_ZIP||'D:/Artifacts/AnnotationCapture/release/AnnotationCapture-0.1.1-windows-x64.zip';
const newZip=process.env.ANNOTATION_NEW_ZIP||'D:/Artifacts/AnnotationCapture/auth-phase/candidate/release/AnnotationCapture-0.2.0-windows-x64.zip';
const invitation=JSON.parse(fs.readFileSync(process.env.ANNOTATION_INVITE_FILE||'D:/AppData/AnnotationCapture/Admin/owner-invite.json','utf8'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(root,{recursive:true});
const checks=[];let app;
async function extract(zipPath,destination,overlay=false){
 fs.mkdirSync(destination,{recursive:true});
 await new Promise((resolve,reject)=>yauzl.open(zipPath,{lazyEntries:true},(error,zip)=>{
  if(error)return reject(error);zip.on('error',reject);zip.on('end',resolve);
  zip.on('entry',async entry=>{try{
   const target=path.resolve(destination,entry.fileName);
   if(!target.toLowerCase().startsWith(path.resolve(destination).toLowerCase()+path.sep)||/^(AnnotationCapture-data|Archive)(\/|$)/i.test(entry.fileName))throw new Error('Release archive must not overwrite user data');
   if(entry.fileName.endsWith('/'))fs.mkdirSync(target,{recursive:true});
   else {fs.mkdirSync(path.dirname(target),{recursive:true});let fd;for(let attempt=0;attempt<50;attempt++){try{fd=fs.openSync(target,overlay?'w':'wx');break;}catch(e){if(!overlay||!['EBUSY','EPERM'].includes(e.code)||attempt===49)throw e;await new Promise(r=>setTimeout(r,100));}}const input=await new Promise((yes,no)=>zip.openReadStream(entry,(e,s)=>e?no(e):yes(s)));await pipeline(input,fs.createWriteStream(target,{fd,autoClose:true}));}
   zip.readEntry();
  }catch(e){zip.close();reject(e);}});zip.readEntry();
 }));
}
async function launch(executable,data,custom){
 app=await _electron.launch({executablePath:executable,cwd:path.dirname(executable),args:['--testMode',...(custom?['--userData',data]:[])],env:{...process.env,ANNOTATION_DATA_DIR:'',PATH:`${process.env.SystemRoot}/System32;${process.env.SystemRoot}`,NODE_PATH:'',NODE_OPTIONS:'',DEEPSEEK_API_KEY:'',ANNOTATION_DEEPSEEK_API_KEY:''},timeout:30000});
 const panel=await app.firstWindow();await panel.waitForSelector('#ac-start');await isolateWindow(app,panel);return panel;
}
async function stop(){if(app){await app.close();app=null;}}
(async()=>{
 for(const mode of ['portable','external-data']){
  console.log('UPGRADE_CASE',mode);
  const workspace=path.join(directory,mode);const install=path.join(workspace,'App');const data=mode==='portable'?path.join(install,'AnnotationCapture-data'):path.join(workspace,'UserData');const archiveRoot=mode==='portable'?path.join(data,'Archive'):path.join(workspace,'DailyArchive');
  await extract(oldZip,install);fs.mkdirSync(data,{recursive:true});
  fs.writeFileSync(path.join(data,'annotation-settings.json'),JSON.stringify({archiveRoot,shortcut:'Control+Alt+F13',model:'deepseek-flash'}));
  const executable=path.join(install,'AnnotationCapture.exe');let panel=await launch(executable,data,mode==='external-data');
  const oldVersion=await app.evaluate(({app})=>app.getVersion());assert.ok(['0.1.1','0.2.0'].includes(oldVersion));
  await panel.evaluate(async legacy=>{const ipc=require('electron').ipcRenderer;const s=await ipc.invoke('annotation:state');await ipc.invoke('annotation:configure',legacy?{archiveRoot:s.config.archiveRoot,shortcut:s.config.shortcut,model:s.config.model,apiKey:'acceptance-only-not-a-real-key'}:s.config);ipc.sendSync('store',{type:'set',path:'图像编辑.默认属性.画笔粗细',value:5});},oldVersion==='0.1.1');
  if(oldVersion==='0.2.0'){await panel.locator('#ac-invite-code').fill(invitation.inviteCode);await panel.locator('#ac-login').click();await panel.waitForFunction(()=>document.querySelector('#ac-login-status').textContent.includes('识别服务可用'));}
  const png=await app.evaluate(({nativeImage})=>nativeImage.createFromBitmap(Buffer.alloc(32*32*4,255),{width:32,height:32}).toDataURL());
  const archive=await panel.evaluate(input=>require('electron').ipcRenderer.invoke('annotation:archive',input),{id:crypto.randomUUID(),capturedAt:new Date().toISOString(),png,rect:{x:0,y:0,width:32,height:32},screenId:0});
  const preserved=new Map([archive.path,archive.path.replace('.png','.json')].map(file=>[file,hash(file)]));const settings=JSON.parse(fs.readFileSync(path.join(data,'annotation-settings.json'),'utf8'));assert.ok(oldVersion==='0.1.1'?settings.encryptedKey:settings.encryptedSession);
  const personal=path.join(install,'personal-notes.txt');fs.writeFileSync(personal,'User-owned file retained during ZIP overlay');preserved.set(personal,hash(personal));
  await stop();console.log('OVERLAY_NEW_VERSION',mode);await extract(newZip,install,true);panel=await launch(executable,data,mode==='external-data');
  const state=await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:state'));assert.equal(state.config.version,expectedVersion);assert.equal(state.config.archiveRoot,archiveRoot);assert.equal(state.config.shortcut,'Control+Alt+F13');assert.equal(state.config.fullShortcut,'Alt+W');assert.equal(state.config.penColor,'#ff0000');assert.equal(state.config.showMagnifier,false);assert.equal(state.login.loggedIn,oldVersion==='0.2.0');assert.equal(await panel.locator('#ac-api-key').count(),0);
  assert.equal(await app.evaluate(({app})=>app.getPath('userData')),data);
  for(const [file,sha]of preserved)assert.equal(hash(file),sha);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'annotation-settings.json'),'utf8')).encryptedKey,settings.encryptedKey);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'config.json'),'utf8'))['图像编辑']['默认属性']['画笔粗细'],5);
  if(!state.login.loggedIn){await panel.locator('#ac-invite-code').fill(invitation.inviteCode);await panel.locator('#ac-login').click();}await panel.waitForFunction(()=>document.querySelector('#ac-login-status').textContent.includes('识别服务可用'));
  assert.equal((await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:state'))).login.providerReady,true);
  const cipher=JSON.parse(fs.readFileSync(path.join(data,'annotation-settings.json'),'utf8')).encryptedSession;assert.ok(cipher);
  await stop();await extract(newZip,install,true);panel=await launch(executable,data,mode==='external-data');await panel.waitForFunction(()=>document.querySelector('#ac-login-status').textContent.includes('已登录'));
  const restored=await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:state'));assert.equal(restored.login.verified,true);assert.equal(restored.login.providerReady,true);assert.equal(restored.login.label,invitation.label);assert.equal(restored.config.archiveRoot,archiveRoot);
  for(const [file,sha]of preserved)assert.equal(hash(file),sha);assert.equal(JSON.parse(fs.readFileSync(path.join(data,'annotation-settings.json'),'utf8')).encryptedSession,cipher);
  await panel.screenshot({path:path.join(root,`${mode}-upgraded.png`)});
  checks.push({mode,oldVersion,newVersion:expectedVersion,sameExecutablePath:true,archiveHashesUnchanged:true,settingsPreserved:true,newPenAndMagnifierDefaults:true,personalFilePreserved:true,invitationLoginWorks:true,repeatedOverlayPreservesLogin:true,passed:true});await stop();
 }
 const report={passed:true,oldZipSha256:hash(oldZip),newZipSha256:hash(newZip),checks};fs.writeFileSync(path.join(root,'upgrade-report.json'),JSON.stringify(report,null,2));console.log('UPGRADE_ACCEPTANCE_PASSED',JSON.stringify(report));
})().catch(e=>{const message=String(e).replace(/AC-[A-Za-z0-9_-]+/g,'[invitation]');console.error(message);fs.writeFileSync(path.join(root,'upgrade-report.json'),JSON.stringify({passed:false,checks,error:message},null,2));process.exitCode=1;}).finally(stop);
