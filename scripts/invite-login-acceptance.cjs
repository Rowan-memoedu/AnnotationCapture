const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {isolateWindow,prepareProfile}=require('./acceptance-window.cjs');
const {account}=require('./gateway-admin.cjs');
const endpoint=process.env.ANNOTATION_SERVICE_URL||'https://124.221.144.155/annotationcapture/api';
const root=process.env.ANNOTATION_EVIDENCE||'D:/Artifacts/AnnotationCapture/auth-phase/invite-login';
const data=path.join(root,`profile-${Date.now()}`);prepareProfile(data);
let app,panel;const created=[];const checks=[];
async function state(){return panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:state'));}
async function launch(){
 app=await _electron.launch({executablePath:process.env.ANNOTATION_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(process.env.ANNOTATION_EXE?[]:['.']),'--userData',data,'--archiveRoot',path.join(data,'Archive'),'--testMode'],env:{...process.env,DEEPSEEK_API_KEY:'legacy-key-must-not-be-used'},timeout:30000});
 panel=await app.firstWindow();await panel.waitForSelector('#ac-login-card');await isolateWindow(app,panel);
}
async function stop(){if(app){await app.evaluate(({app})=>app.exit());app=null;}}
async function login(code){await panel.locator('#ac-invite-code').fill(code);await panel.locator('#ac-login').click();await panel.waitForFunction(()=>document.querySelector('#ac-login-status').textContent.includes('已登录'));assert.equal((await state()).login.verified,true);}
async function request(route,token,body){const r=await fetch(endpoint+route,{method:body?'POST':'GET',headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});return {status:r.status,value:await r.json()};}
(async()=>{
 const a=account('create',{label:`Acceptance A ${Date.now()}`});created.push(a.accountId);
 const b=account('create',{label:`Acceptance B ${Date.now()}`});created.push(b.accountId);
 assert.equal((await request('/session')).status,401);
 await launch();assert.equal((await state()).login.loggedIn,false);
 assert.equal(await panel.locator('#ac-api-key').count(),0);
 await panel.locator('#ac-invite-code').fill('invalid-invitation');await panel.locator('#ac-login').click();await panel.waitForFunction(()=>document.querySelector('#ac-login-status').textContent.includes('无效'));
 assert.equal((await state()).login.loggedIn,false);checks.push('invalid-invitation-rejected');
 await login(a.inviteCode);
 const stored=fs.readFileSync(path.join(data,'annotation-settings.json'),'utf8');const config=JSON.parse(stored);assert.ok(config.encryptedSession);assert.ok(!stored.includes(a.inviteCode));
 const first=await app.evaluate(({safeStorage},encrypted)=>JSON.parse(safeStorage.decryptString(Buffer.from(encrypted,'base64'))),config.encryptedSession);
 assert.ok(!stored.includes(first.token));assert.ok(!JSON.stringify(await state()).includes(first.token));checks.push('login-through-ui-and-Windows-encrypted-session');
 await panel.screenshot({path:path.join(root,'logged-in.png')});
 await stop();await launch();await panel.waitForFunction(()=>document.querySelector('#ac-login-status').textContent.includes('已登录'));
 assert.equal((await state()).login.verified,true);assert.equal((await state()).login.label,a.label);checks.push('relaunch-restores-login-without-invitation');
 const second=await request('/login',null,{inviteCode:a.inviteCode});assert.equal(second.status,200);assert.notEqual(second.value.token,first.token);assert.equal((await request('/session',first.token)).status,200);assert.equal((await request('/session',second.value.token)).status,200);checks.push('same-invitation-supports-independent-device-sessions');
 const other=await request('/login',null,{inviteCode:b.inviteCode});assert.equal(other.status,200);
 account('revoke',{accountId:a.accountId});assert.equal((await request('/session',second.value.token)).status,401);
 await panel.locator('#ac-refresh-login').click();await panel.waitForFunction(()=>document.querySelector('#ac-login-status').textContent.includes('失效'));assert.equal((await state()).login.loggedIn,false);assert.equal((await request('/session',other.value.token)).status,200);checks.push('individual-revocation-removes-all-devices-without-affecting-other-users');
 await login(b.inviteCode);
 assert.equal((await state()).login.providerReady,false,'This acceptance expects the NEW provider to be unconfigured');
 const clipboardBefore=await app.evaluate(({clipboard})=>clipboard.readText());
 const pending=app.waitForEvent('window');await panel.evaluate(() => require('electron').ipcRenderer.invoke('annotation:capture', 'full'));const page=await pending;await page.waitForFunction(()=>document.querySelector('#ac-completion')&&document.body.style.opacity!=='0');await isolateWindow(app,page);
 await page.mouse.move(430,350);await page.mouse.down();await page.mouse.move(475,405,{steps:8});await page.mouse.up();
 await page.keyboard.press('Control+Shift+Enter');await page.waitForSelector('#ac-selection');
 const bounds=await page.locator('#ac-selection').boundingBox();
 await page.mouse.move(bounds.x+bounds.width*.2,bounds.y+bounds.height*.2);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.7,bounds.y+bounds.height*.7,{steps:5});await page.mouse.up();
 const closed=page.waitForEvent('close');await page.locator('#ac-recognize').click();await closed;
 await panel.waitForSelector('[data-status="error"]',{timeout:30000});const result=(await state()).jobs[0];assert.match(result.message,/统一 API/);assert.ok(fs.existsSync(result.path));assert.ok(fs.existsSync(path.join(path.dirname(result.path),'capture.png')));
 assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),clipboardBefore);checks.push('logged-in-formula-workflow-saves-images-and-reports-new-API-pending-without-fallback');
 await panel.screenshot({path:path.join(root,'provider-pending.png')});
 fs.writeFileSync(path.join(root,'invite-login-report.json'),JSON.stringify({passed:true,endpoint,checks,liveNewProviderTested:false},null,2));console.log('INVITE_LOGIN_ACCEPTANCE_PASSED',JSON.stringify(checks));
})().catch(error=>{const message=String(error).replace(/AC-[A-Za-z0-9_-]+/g,'[invitation]');console.error(message);fs.writeFileSync(path.join(root,'invite-login-report.json'),JSON.stringify({passed:false,checks,error:message},null,2));process.exitCode=1;}).finally(async()=>{await stop();for(const accountId of created)try{account('revoke',{accountId});}catch{console.error('Acceptance account cleanup failed');process.exitCode=1;}});
