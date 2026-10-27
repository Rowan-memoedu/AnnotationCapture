const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');const {isolateWindow,prepareProfile}=require('./acceptance-window.cjs');
const root=process.env.ANNOTATION_EVIDENCE||'D:/Artifacts/AnnotationCapture/auth-phase/shortcuts';const data=path.join(root,`profile-${Date.now()}`);prepareProfile(data,{fullShortcut:'Alt+W'});
let app;
(async()=>{
 app=await _electron.launch({executablePath:process.env.ANNOTATION_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(process.env.ANNOTATION_EXE?[]:['.']),'--userData',data,'--testMode']});const panel=await app.firstWindow();await panel.waitForSelector('#ac-login-card');await isolateWindow(app,panel);
 const initial=await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:state'));
 const registered=await app.evaluate(({globalShortcut},keys)=>keys.map(key=>globalShortcut.isRegistered(key)),[initial.config.shortcut,initial.config.fullShortcut]);assert.equal(registered[0],true,'A full-screen shortcut collision must not disable the region shortcut');
 if(!registered[1])assert.match(initial.shortcutError,/全屏批注快捷键 Alt\+W 已被占用/);
 await panel.evaluate(async()=>{const ipc=require('electron').ipcRenderer;const s=await ipc.invoke('annotation:state');await ipc.invoke('annotation:configure',{...s.config,fullShortcut:'Alt+Shift+W'});});
 const current=await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:state'));assert.equal(current.shortcutError,'');
 await assert.rejects(panel.evaluate(async()=>{const ipc=require('electron').ipcRenderer;const s=await ipc.invoke('annotation:state');await ipc.invoke('annotation:configure',{...s.config,fullShortcut:s.config.shortcut});}),/相同快捷键/);
 assert.equal((await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:state'))).config.fullShortcut,'Alt+Shift+W');
 const final=await app.evaluate(({globalShortcut},keys)=>keys.every(key=>globalShortcut.isRegistered(key)),[current.config.shortcut,current.config.fullShortcut]);assert.equal(final,true);
 fs.writeFileSync(path.join(root,'shortcuts-report.json'),JSON.stringify({passed:true,altWAvailable:registered[1],collisionDoesNotDisableOtherShortcut:true,localAlternative:'Alt+Shift+W',duplicateSettingRejected:true},null,2));console.log('SHORTCUTS_ACCEPTANCE_PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(app)await app.evaluate(({app})=>app.exit());});
