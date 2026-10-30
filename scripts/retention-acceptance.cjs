const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {prepareProfile,isolateWindow}=require('./acceptance-window.cjs');
const root=path.join(process.env.ANNOTATION_EVIDENCE||'D:/Artifacts/AnnotationCapture/capture-fix-0.5.1','retention');
const data=path.join(root,'profile-'+Date.now()),archive=path.join(data,'Archive');prepareProfile(data);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==','base64');
function fixture(days,extra){const id=crypto.randomUUID(),folder=path.join(archive,'2026-10-01',id);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'capture.png'),png);fs.writeFileSync(path.join(folder,'capture.json'),JSON.stringify({id,capturedAt:new Date(Date.now()-days*86400000).toISOString(),sha256:crypto.createHash('sha256').update(png).digest('hex')}));if(extra)fs.writeFileSync(path.join(folder,'personal.txt'),'must remain');return {id,folder};}
const old=fixture(8),recent=fixture(2),unknown=fixture(10,true);let app;const checks=[];
async function launch(){app=await _electron.launch({executablePath:process.env.ANNOTATION_EXE||path.resolve('node_modules/electron/dist/electron.exe'),args:[...(process.env.ANNOTATION_EXE?[]:['.']),'--userData',data,'--testMode']});const p=await app.firstWindow();await p.waitForSelector('#ac-save-settings');await isolateWindow(app,p);return p;}
async function wait(test){for(let i=0;i<150;i++){if(await test())return;await new Promise(r=>setTimeout(r,100));}throw Error('Retention action timed out');}
(async()=>{
 let panel=await launch();await wait(()=>!fs.existsSync(old.folder));assert.ok(fs.existsSync(recent.folder));assert.ok(fs.existsSync(unknown.folder));
 checks.push('default startup sweep trashes an 8-day archive, retains recent and unmanaged contents');
 await panel.locator('#ac-retention-days').fill('0');await panel.locator('#ac-save-settings').click();await wait(async()=>await panel.locator('#ac-retention-status').textContent().then(t=>t.includes('永久保留')));
 const disabled=fixture(30);await app.evaluate(({app})=>app.exit());app=null;panel=await launch();assert.equal(await panel.locator('#ac-retention-days').inputValue(),'0');assert.ok(fs.existsSync(disabled.folder));checks.push('disabled cleanup persists across restart');
 await panel.locator('#ac-retention-days').fill('1');await panel.locator('#ac-save-settings').click();await wait(()=>!fs.existsSync(recent.folder)&&!fs.existsSync(disabled.folder));assert.ok(fs.existsSync(unknown.folder));checks.push('changed retention applies to the correct archive root, preserving unmanaged contents');
 await panel.locator('#ac-retention-days').scrollIntoViewIfNeeded();await panel.screenshot({path:path.join(root,'settings.png')});
 const report={passed:true,checks,removedFixtureIds:[old.id,recent.id,disabled.id],archiveRoot:archive,recycleApi:'Electron shell.trashItem (unmodified)'};fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log('RETENTION_ACCEPTANCE',JSON.stringify(report));
})().catch(e=>{fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:false,checks,error:String(e)},null,2));console.error(e);process.exitCode=1;}).finally(async()=>{if(app)await app.evaluate(({app})=>app.exit()).catch(()=>{});});
