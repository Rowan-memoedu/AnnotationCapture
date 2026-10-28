const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const asar=require(require.resolve('@electron/asar',{paths:[require.resolve('electron-builder')]}));
const manifest=require('./update-manifest.cjs');
const {prepareProfile}=require('./acceptance-window.cjs');
const evidence=process.env.ANNOTATION_EVIDENCE||'D:/Artifacts/AnnotationCapture/update-e2e';fs.mkdirSync(evidence,{recursive:true});
const root='D:/Quarantine/AnnotationCapture/update-e2e-'+Date.now(),appRoot=root+'/App 数学',data=root+'/Data & 学习';
fs.mkdirSync(root,{recursive:true});
const base=process.env.ANNOTATION_UPDATE_BASE||'D:/Artifacts/AnnotationCapture/release-0.4.1/release/win-unpacked';
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const checks=[];let app,server,release,packageFile;
const wait=async test=>{const deadline=Date.now()+90000;while(!test()){if(Date.now()>deadline)throw Error('Update receipt timed out');await new Promise(r=>setTimeout(r,100));}};
function stopFixture(){const exe=path.resolve(appRoot,'AnnotationCapture.exe');assert.ok(exe.startsWith(path.resolve(root)+path.sep));cp.execFileSync('pwsh',['-NoLogo','-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter "name='AnnotationCapture.exe'" | Where-Object {$_.ExecutablePath -eq '${exe.replaceAll("'","''")}'} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],{windowsHide:true});}
async function future(version,failing=false){
 const source=root+'/asar-source-'+version;asar.uncacheAll();asar.extractAll(appRoot+'/resources/app.asar',source);
 const pkg=JSON.parse(fs.readFileSync(source+'/package.json','utf8'));pkg.version=version;
 if(failing){pkg.main='startup-failure.cjs';fs.writeFileSync(source+'/startup-failure.cjs',"require('electron').app.exit(17)");}
 fs.writeFileSync(source+'/package.json',JSON.stringify(pkg));const newAsar=root+'/app-'+version+'.asar';await asar.createPackage(source,newAsar);
 const current=JSON.parse(fs.readFileSync(appRoot+'/program-manifest.json','utf8'));current.version=version;
 for(const item of current.files)if(item.path==='resources/app.asar'){item.size=fs.statSync(newAsar).size;item.sha256=hash(newAsar);}
 const m=root+'/manifest-'+version+'.json';fs.writeFileSync(m,JSON.stringify(current));
 packageFile=root+'/fixture-'+version+'.zip';
 cp.execFileSync('python',['-c',"import zipfile,pathlib,sys; root=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1); [(z.write(p,p.relative_to(root).as_posix())) for p in root.rglob('*') if p.is_file() and p.name!='program-manifest.json' and p.relative_to(root).as_posix()!='resources/app.asar']; z.write(sys.argv[3],'resources/app.asar'); z.write(sys.argv[4],'program-manifest.json'); z.close()",appRoot,packageFile,newAsar,m],{windowsHide:true,timeout:180000});
 const name=`AnnotationCapture-${version}-windows-x64.zip`;release=[{tag_name:'v'+version,draft:false,assets:[{name,browser_download_url:`https://github.com/Rowan-memoedu/AnnotationCapture/releases/download/v${version}/${name}`,digest:'sha256:'+hash(packageFile),size:fs.statSync(packageFile).size}]}];
}
async function launch(feed){
 // Native launch avoids Electron inspector/test-launcher process-tree cleanup
 // interfering with a real installer that must outlive its parent application.
 const child=cp.spawn(appRoot+'/AnnotationCapture.exe',['--remote-debugging-port=0','--userData',data,'--archiveRoot',data+'/Archive','--testMode','--updateTestFeed',feed],{cwd:appRoot,windowsHide:true,stdio:['ignore','ignore','pipe']});
 const endpoint=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Native debug endpoint timed out')),30000);child.stderr.on('data',b=>{text+=b;const m=text.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});child.once('error',reject);});
 app=await chromium.connectOverCDP(endpoint);let panel;await wait(()=>{panel=app.contexts()[0].pages().find(p=>p.url().includes('annotation.html'));return !!panel;});await panel.waitForSelector('#ac-check-updates');await isolate(panel);return panel;
}
async function isolate(page){await page.waitForLoadState('domcontentloaded');}
function pending(){return JSON.parse(fs.readFileSync(data+'/Updates/preferences.json','utf8')).pending;}
async function install(panel){const request=pending(),receipt=path.join(path.dirname(request),'receipt.json');const state=await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:installUpdate')).catch(e=>{if(!/closed|destroyed/i.test(String(e)))throw e;});if(state?.phase==='error')throw Error(state.message);app=null;await wait(()=>fs.existsSync(receipt));return JSON.parse(fs.readFileSync(receipt,'utf8'));}
(async()=>{
 fs.cpSync(base,appRoot,{recursive:true});
 if(process.env.ANNOTATION_UPDATE_OVERLAY_OUT){
  const source=root+'/base-asar-source';asar.extractAll(appRoot+'/resources/app.asar',source);fs.cpSync('out',source+'/out',{recursive:true});await asar.createPackage(source,appRoot+'/resources/app.asar');fs.copyFileSync('src/main/update-worker.ps1',appRoot+'/resources/update-worker.ps1');await manifest({appOutDir:appRoot});
 }
 prepareProfile(data);fs.mkdirSync(data+'/Archive',{recursive:true});fs.writeFileSync(data+'/Archive/existing.txt','existing archive sentinel');fs.writeFileSync(appRoot+'/my-note.txt','unmanaged user file');
 const archiveHash=hash(data+'/Archive/existing.txt'),userHash=hash(appRoot+'/my-note.txt');
 // Only declared program files are packaged, never unmanaged notes or data.
 fs.renameSync(appRoot+'/my-note.txt',root+'/my-note.txt');await future('0.4.2');fs.renameSync(root+'/my-note.txt',appRoot+'/my-note.txt');
 server=http.createServer((req,res)=>{if(req.url==='/package.zip'){res.writeHead(200,{'Content-Length':fs.statSync(packageFile).size});fs.createReadStream(packageFile).pipe(res);}else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(release));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const feed=`http://127.0.0.1:${server.address().port}/releases`;
 let panel=await launch(feed);
 const invite=JSON.parse(fs.readFileSync(process.env.ANNOTATION_INVITE_FILE||'D:/AppData/AnnotationCapture/Admin/owner-invite.json','utf8'));
 const code=invite.inviteCode||invite.code;assert.ok(code,'Owner invitation schema');await panel.evaluate(code=>require('electron').ipcRenderer.invoke('annotation:login',code),code);
 const sessionBefore=JSON.parse(fs.readFileSync(data+'/annotation-settings.json','utf8')).encryptedSession;
 const next=app.contexts()[0].waitForEvent('page');await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:capture','full'));const capture=await next;await capture.waitForSelector('#ac-completion');await isolate(capture);
 let state=await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:checkUpdates'));assert.equal(state.phase,'ready',state.message);
 state=await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:installUpdate'));assert.equal(state.phase,'ready');assert.equal(capture.isClosed(),false);checks.push('download-and-verify-while-drawing-install-deferred');
 const closed=capture.waitForEvent('close');await capture.keyboard.press('Escape');await closed;
 const result=await install(panel);assert.equal(result.status,'installed');assert.equal(result.version,'0.4.2');
 assert.equal(hash(data+'/Archive/existing.txt'),archiveHash);assert.equal(hash(appRoot+'/my-note.txt'),userHash);assert.equal(JSON.parse(fs.readFileSync(data+'/annotation-settings.json','utf8')).encryptedSession,sessionBefore);
 checks.push('actual-overlay-startup-health-and-user-data-preserved');stopFixture();
 panel=await launch(feed);let s=await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:state'));assert.equal(s.config.version,'0.4.2');assert.equal(s.login.loggedIn,true);
 await panel.locator('#ac-auto-update').uncheck();await panel.waitForTimeout(100);assert.equal(JSON.parse(fs.readFileSync(data+'/Updates/preferences.json','utf8')).enabled,false);await panel.reload();await panel.waitForSelector('#ac-auto-update');assert.equal(await panel.locator('#ac-auto-update').isChecked(),false);checks.push('settings-and-login-persist-after-upgrade');
 const oldAsar=hash(appRoot+'/resources/app.asar');
 fs.renameSync(appRoot+'/my-note.txt',root+'/my-note.txt');await future('0.4.3',true);fs.renameSync(root+'/my-note.txt',appRoot+'/my-note.txt');
 state=await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:checkUpdates'));assert.equal(state.phase,'ready',state.message);
 const rollback=await install(panel);assert.equal(rollback.status,'rolled-back');assert.equal(rollback.version,'0.4.2');assert.equal(hash(appRoot+'/resources/app.asar'),oldAsar);assert.equal(hash(data+'/Archive/existing.txt'),archiveHash);checks.push('startup-failure-rolls-back-and-restarts-old-version');stopFixture();
 fs.writeFileSync(evidence+'/report.json',JSON.stringify({passed:true,checks,root,futureVersionsAreIsolatedFixtures:true},null,2));console.log('UPDATE_E2E_PASSED',JSON.stringify(checks));
})().catch(error=>{fs.writeFileSync(evidence+'/report.json',JSON.stringify({passed:false,checks,root,error:String(error)},null,2));console.error(error);process.exitCode=1;}).finally(async()=>{stopFixture();if(app)await app.close().catch(()=>{});if(server)await new Promise(r=>server.close(r));});
