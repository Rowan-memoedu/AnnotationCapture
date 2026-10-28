const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { isolateWindow, prepareProfile } = require('./acceptance-window.cjs');
const root = process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/acceptance';
fs.mkdirSync(root, { recursive: true });
const data = path.join(root, `live-${Date.now()}`);
let strokes = [
    [[430,350],[475,405]], [[430,405],[475,350]],
    [[489,328],[494,320],[509,320],[517,328],[516,335],[489,351],[518,351]],
    [[550,378],[590,378]], [[570,358],[570,398]],
    [[620,365],[632,352],[632,404]], [[620,405],[646,405]],
    [[680,367],[724,367]], [[680,388],[724,388]],
    [[769,351],[751,356],[744,375],[747,395],[762,405],[778,400],[786,380],[782,360],[769,351]],
];
const caseName=process.env.ANNOTATION_OCR_CASE||'polynomial';
const outputFormat=process.env.ANNOTATION_OCR_FORMAT||'latex';
assert.ok(['polynomial','fraction','root','mixedcase'].includes(caseName),'Unknown OCR acceptance case');
let expected='x^2+1=0';
if(caseName==='fraction'){
    expected='\\frac{x+1}{2}';
    strokes=[[[440,320],[480,370]],[[440,370],[480,320]],[[500,345],[540,345]],[[520,325],[520,365]],[[562,334],[576,320],[576,370]],[[564,370],[588,370]],[[425,397],[605,397]],[[495,432],[504,420],[524,420],[536,433],[533,444],[496,475],[539,475]]];
}
if(caseName==='root'){
    expected='\\sqrt{x+1}';
    strokes=[[[430,371],[444,357],[458,405],[484,325],[680,325]],[[505,347],[545,397]],[[505,397],[545,347]],[[565,372],[605,372]],[[585,352],[585,392]],[[630,360],[643,347],[643,397]],[[630,398],[657,398]]];
}
if(caseName==='mixedcase'){
    expected='X+x=2';
    strokes=[[[430,325],[475,405]],[[430,405],[475,325]],[[495,382],[525,382]],[[510,367],[510,397]],[[550,365],[555,363],[563,365],[570,378],[580,396],[587,399]],[[585,364],[580,368],[570,383],[558,398],[551,400]],[[610,372],[650,372]],[[610,390],[650,390]],[[680,363],[686,353],[701,352],[710,358],[711,366],[704,375],[680,400],[714,400]]];
}
let app;const errors=[];
(async () => {
    assert.ok(process.env.ANNOTATION_INVITE_FILE, 'Private invitation file is required');
    const invitation=JSON.parse(fs.readFileSync(process.env.ANNOTATION_INVITE_FILE,'utf8'));
    prepareProfile(data);
    app = await _electron.launch({ executablePath: process.env.ANNOTATION_EXE || path.resolve('node_modules/electron/dist/electron.exe'), cwd: process.env.ANNOTATION_EXE ? path.dirname(process.env.ANNOTATION_EXE) : process.cwd(), args: [...(process.env.ANNOTATION_EXE ? [] : ['.']), '--userData', data, '--archiveRoot', path.join(data, 'Archive'), '--testMode'], env: { ...process.env, ...(process.env.ANNOTATION_EXE ? { PATH: `${process.env.SystemRoot}/System32;${process.env.SystemRoot}`, NODE_PATH:'',NODE_OPTIONS:'' } : {}) }, timeout: 30000 });
    app.on('window',page=>page.on('pageerror',e=>errors.push(String(e))));
    const panel = await app.firstWindow(); await panel.waitForSelector('#ac-start');
    await isolateWindow(app, panel);
    await panel.locator('#ac-invite-code').fill(invitation.inviteCode);await panel.locator('#ac-login').click();await panel.waitForFunction(()=>document.querySelector('#ac-login-status').textContent.includes('已登录'));
    const login=await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:state'));assert.equal(login.login.providerReady,true,'The NEW shared API has not been configured');
    const pending = app.waitForEvent('window'); await panel.locator('#ac-start-full').click(); const page = await pending;
    await page.waitForFunction(() => document.body.style.opacity !== '0' && document.querySelector('#ac-completion'));
    await isolateWindow(app, page);
    await page.locator('#draw_free').click();
    for (const stroke of strokes) {
        await page.mouse.move(...stroke[0]); await page.mouse.down();
        for (const p of stroke.slice(1)) await page.mouse.move(...p, { steps: 3 });
        await page.mouse.up();
    }
    const canvasGeometry = await page.locator('#main_photo').evaluate(c => { const b=c.getBoundingClientRect();return { left:b.left,top:b.top,cssWidth:b.width,cssHeight:b.height,width:c.width,height:c.height }; });
    await page.keyboard.press('Control+Shift+Enter'); await page.waitForSelector('#ac-selection');
    await page.locator('#ac-output-format').selectOption(outputFormat);
    if(outputFormat==='markdown')expected=`$$\n${expected}\n$$`;
    const box = await page.locator('#ac-selection').boundingBox();
    function mapped(x,y) { return [box.x + (x-canvasGeometry.left)/canvasGeometry.cssWidth*box.width, box.y+(y-canvasGeometry.top)/canvasGeometry.cssHeight*box.height]; }
    await page.mouse.move(...mapped(412,304)); await page.mouse.down(); await page.mouse.move(...mapped(805,500),{steps:6}); await page.mouse.up();
    const closed=page.waitForEvent('close'); await page.locator('#ac-recognize').click(); await closed;
    await panel.waitForSelector('[data-status="copied"], [data-status="error"], [data-status="review"]', { timeout: 75000 });
    const state=await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:state'));
    const result=state.jobs[0];
    const clipboard=await app.evaluate(async ({clipboard})=>await clipboard.readText());
    await panel.screenshot({path:path.join(root,`shared-api-${caseName}-result.png`)});
    const canonical=s=>s.replace(/\s/g,'').replace(/\\left|\\right/g,'').replace(/([_^])\{([A-Za-z0-9])\}/g,'$1$2');
    const exactMatch=canonical(result.latex)===canonical(expected);
    const formatValid=outputFormat==='markdown'?/^\$\$\n[\s\S]+\n\$\$$/.test(result.latex)&&!result.latex.includes('```'):!!result.latex.trim()&&!result.latex.includes('```');
    const functionalPassed=result.status==='copied'&&clipboard===result.latex&&formatValid;
    if(process.env.ANNOTATION_PUBLIC_RESULT_SCREENSHOT&&caseName==='polynomial'&&result.status==='copied'&&exactMatch&&clipboard===result.latex){
        // Only the synthetic formula result is captured; settings and desktop stay outside the image.
        await panel.locator('#ac-results').screenshot({path:process.env.ANNOTATION_PUBLIC_RESULT_SCREENSHOT});
    }
    let manualCorrectionVerified=false;
    if(process.env.ANNOTATION_TEST_CORRECTION==='1'&&result.latex){
        const corrected='x^{2}-1=0';
        await panel.locator(`#result-${result.id}`).fill(corrected);
        await panel.locator(`#copy-${result.id}`).click();
        const current=await app.evaluate(async({clipboard})=>await clipboard.readText());assert.equal(current,corrected);
        const after=await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:state'));
        assert.equal(after.jobs[0].recognizedLatex,result.latex);assert.equal(after.jobs[0].latex,corrected);
        manualCorrectionVerified=true;
    }
    fs.copyFileSync(result.path,path.join(root,`shared-api-${caseName}-input.png`));
    fs.writeFileSync(path.join(root,`shared-api-${outputFormat}-${caseName}-report.json`),JSON.stringify({passed:functionalPassed,functionalPassed,formatValid,inputKind:'Actual mouse strokes in upstream Fabric editor',expected,actual:result.latex,exactMatch,clipboardMatched:clipboard===result.latex,manualCorrectionVerified,ambiguityPolicy:'Automatic copy with original image and editable result for human review',result},null,2));
    assert.equal(result.status,'copied',result.message);assert.equal(clipboard,result.latex);assert.equal(formatValid,true,'Output must use the selected format');
    if(process.env.ANNOTATION_REQUIRE_EXACT==='1')assert.equal(canonical(result.latex),canonical(expected));
    console.log(exactMatch?'LIVE_OCR_EXACT_MATCH':'LIVE_OCR_FUNCTIONAL_PASS_WITH_TRANSCRIPTION_MISMATCH',JSON.stringify({model:result.model,latex:result.latex,exactMatch,durationMs:result.durationMs}));
})().catch(async error=>{
    const message=String(error).replace(/AC-[A-Za-z0-9_-]+/g,'[invitation]');const states=[];
    for(const page of app?.windows()||[])try{states.push(await page.evaluate(()=>({url:location.href,status:document.querySelector('#ac-capture-status')?.textContent,selection:document.querySelector('#ac-selection-status')?.textContent,buttons:[...document.querySelectorAll('#ac-selection button')].map(b=>({text:b.textContent,disabled:b.disabled}))})));await page.screenshot({path:path.join(root,`${caseName}-failure-${Date.now()}.png`),timeout:5000});}catch{}
    fs.writeFileSync(path.join(root,`${caseName}-failure-${Date.now()}.json`),JSON.stringify({error:message,errors,states},null,2));console.error(message,JSON.stringify({errors,states}));process.exitCode=1;
}).finally(async()=>{if(app)await app.evaluate(({app})=>app.exit()).catch(()=>{});});
