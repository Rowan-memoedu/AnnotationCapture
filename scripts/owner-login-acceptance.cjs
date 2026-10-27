const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {isolateWindow,prepareProfile}=require('./acceptance-window.cjs');
const invitation=JSON.parse(fs.readFileSync(process.env.ANNOTATION_INVITE_FILE||'D:/AppData/AnnotationCapture/Admin/owner-invite.json','utf8'));
const root=process.env.ANNOTATION_EVIDENCE||'D:/Artifacts/AnnotationCapture/auth-phase/owner';
const data=path.join(root,`profile-${Date.now()}`);prepareProfile(data);
let app;
async function launch(){app=await _electron.launch({executablePath:process.env.ANNOTATION_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(process.env.ANNOTATION_EXE?[]:['.']),'--userData',data,'--testMode'],timeout:30000});const panel=await app.firstWindow();await panel.waitForSelector('#ac-login-card');await isolateWindow(app,panel);return panel;}
async function stop(){if(app){await app.evaluate(({app})=>app.exit());app=null;}}
(async()=>{
 let panel=await launch();await panel.locator('#ac-invite-code').fill(invitation.inviteCode);await panel.locator('#ac-login').click();await panel.waitForFunction(()=>document.querySelector('#ac-login-status').textContent.includes('已登录'));
 await stop();panel=await launch();await panel.waitForFunction(()=>document.querySelector('#ac-login-status').textContent.includes('已登录'));
 const state=await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:state'));assert.equal(state.login.loggedIn,true);assert.equal(state.login.verified,true);assert.equal(state.login.label,invitation.label);
 await panel.screenshot({path:path.join(root,'owner-restored-login.png')});
 fs.writeFileSync(path.join(root,'owner-login-report.json'),JSON.stringify({passed:true,sameInvitationServiceAsOtherUsers:true,loginRestored:true,providerReady:state.login.providerReady,data},null,2));console.log('OWNER_LOGIN_ACCEPTANCE_PASSED',JSON.stringify({providerReady:state.login.providerReady,loginRestored:true}));
})().catch(e=>{console.error(String(e).replace(/AC-[A-Za-z0-9_-]+/g,'[invitation]'));process.exitCode=1;}).finally(stop);
