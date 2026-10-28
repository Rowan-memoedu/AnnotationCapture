const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {prepareProfile,isolateWindow}=require('./acceptance-window.cjs');
const root=process.env.ANNOTATION_EVIDENCE||'D:/Artifacts/AnnotationCapture/quit-acceptance';
let app;const checks=[];
(async()=>{
 for(const blocked of [false,true]){
  const data=path.join(root,`quit-${blocked}-${Date.now()}`);prepareProfile(data);
  app=await _electron.launch({executablePath:process.env.ANNOTATION_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(process.env.ANNOTATION_EXE?[]:['.']),'--userData',data,'--testMode'],timeout:30000});
  const panel=await app.firstWindow();await panel.waitForSelector('#ac-save-settings');await isolateWindow(app,panel);let page=panel;
  if(blocked){
   const file=path.join(data,'blocked-archive');fs.writeFileSync(file,'Not a writable directory');await panel.evaluate(async archiveRoot=>{const ipc=require('electron').ipcRenderer;const s=await ipc.invoke('annotation:state');await ipc.invoke('annotation:configure',{...s.config,archiveRoot});},file);
   const pending=app.waitForEvent('window');await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:capture','full'));page=await pending;await page.waitForFunction(()=>document.querySelector('#draw_free_pencil')?.classList.contains('select'));await isolateWindow(app,page);await page.mouse.move(350,300);await page.mouse.down();await page.mouse.move(500,350,{steps:8});await page.mouse.up();await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelector('#ac-capture-status').textContent.includes('画布已保留'));assert.equal(page.isClosed(),false);
  }
  const child=app.process(),started=Date.now();const exited=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Immediate quit did not exit within 3 seconds')),3000);child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
  await page.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:quit')).catch(error=>{if(!/closed|Target|destroyed|quit/i.test(String(error)))throw error;});
  const exit=await exited;assert.equal(exit.code,0);checks.push({saveFailure:blocked,exitedWithoutWaitingForArchive:true,durationMs:Date.now()-started,exitCode:exit.code});console.log('IMMEDIATE_QUIT_PASSED',JSON.stringify(checks.at(-1)));app=null;
 }
 fs.writeFileSync(path.join(root,'quit-report.json'),JSON.stringify({passed:true,sharedTrayExitHandler:true,checks},null,2));
})().catch(error=>{fs.writeFileSync(path.join(root,'quit-report.json'),JSON.stringify({passed:false,checks,error:String(error)},null,2));console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.evaluate(({app})=>app.exit()).catch(()=>{});});
