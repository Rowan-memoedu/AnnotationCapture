const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { prepareProfile, isolateWindow } = require('./acceptance-window.cjs');
const root = process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/whiteboard-layout';
const data = path.join(root, `profile-${Date.now()}`);
prepareProfile(data, { shortcut: '', fullShortcut: '', ocrShortcut: '' });
const checks = [];
let app;
function touches(a, b) {
    const dx = Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x), dy = Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y);
    return dx>=0 && dy>=0 && (dx>0 || dy>0);
}
(async () => {
    app = await _electron.launch({ executablePath: process.env.ANNOTATION_EXE || path.resolve('node_modules/electron/dist/electron.exe'),
        args: [...(process.env.ANNOTATION_EXE ? [] : ['.']), '--userData', data, '--testMode'], timeout: 30000 });
    const panel = await app.firstWindow(); await panel.waitForSelector('#ac-save-settings'); await isolateWindow(app,panel);
    const invite = JSON.parse(fs.readFileSync(process.env.ANNOTATION_INVITE_FILE));
    await panel.evaluate(code=>require('electron').ipcRenderer.invoke('annotation:login',code),invite.inviteCode);
    await app.evaluate(({ipcMain})=>{const detect=ipcMain._invokeHandlers.get('annotation:detectWhitespace');ipcMain.removeHandler('annotation:detectWhitespace');ipcMain.handle('annotation:detectWhitespace',async(e,png)=>{const result=await detect(e,png);globalThis.layoutDetection=result;return result;});});
    const privateInput = process.env.ANNOTATION_LAYOUT_INPUT ? JSON.parse(fs.readFileSync(process.env.ANNOTATION_LAYOUT_INPUT)) : null;
    const scenarios = [...(privateInput ? [{name:'provided-page',allowed:true},{name:'provided-page',allowed:false}] : []),
        {name:'question',allowed:true},{name:'diagram',allowed:true},{name:'diagram',allowed:false}];
    for(const scenario of scenarios) {
        console.log('LAYOUT_START',scenario.name,scenario.allowed);
        const supplied = scenario.name==='provided-page' ? {...privateInput, image:'data:image/png;base64,'+fs.readFileSync(privateInput.image).toString('base64')} : null;
        const fixture = await panel.evaluate(async ({scenario,supplied})=>{
            const canvas=document.createElement('canvas'); canvas.width=1600;canvas.height=1000;const c=canvas.getContext('2d');
            c.fillStyle='#e8edf7';c.fillRect(0,0,1600,1000);
            const content=[],figures=[];
            function text(value,x,y,size=26){c.font=`${size}px Arial`;c.fillStyle='#18202d';c.fillText(value,x,y);const m=c.measureText(value);content.push({x:x-2,y:y-m.actualBoundingBoxAscent-2,width:m.width+4,height:m.actualBoundingBoxAscent+m.actualBoundingBoxDescent+4});}
            if(supplied){const im=new Image();im.src=supplied.image;await im.decode();const scale=1600/im.width;c.drawImage(im,0,100,1600,im.height*scale);for(const r of supplied.contentRects)content.push({x:r.x*scale,y:100+r.y*scale,width:r.width*scale,height:r.height*scale});}
            else {
                c.fillStyle='#fff';c.fillRect(350,145,900,740);c.strokeStyle='#c4c8d0';c.lineWidth=1;c.strokeRect(350,145,900,740);
                text(scenario.name==='question'?'Question 1':'Function graph',380,200,32);
                text('Let f(x) = x² + 2x. Read the expression carefully.',380,260);
                text('Find the value of f(3) using the information given.',380,310);
                if(scenario.name==='question')for(let i=0;i<5;i++)text(`${String.fromCharCode(97+i)})   ${[6,9,12,15,18][i]}`,390,410+i*72);
                else {c.strokeStyle='#152233';c.lineWidth=3;c.strokeRect(380,370,650,390);c.beginPath();c.moveTo(420,700);c.lineTo(980,700);c.moveTo(600,410);c.lineTo(600,720);c.stroke();c.beginPath();c.moveTo(440,420);c.quadraticCurveTo(650,900,950,420);c.stroke();figures.push({x:376,y:366,width:658,height:398});}
                c.fillStyle='#9ba4b0';c.fillRect(380,820,110,38);c.fillStyle='white';c.font='20px Arial';c.fillText('Submit',395,845);
            }
            c.fillStyle='#d0d8e2';c.fillRect(0,0,1600,72);c.fillRect(0,940,1600,60);c.fillStyle='#27364b';c.font='24px Arial';c.fillText('Browser    Lesson tab                         -    [ ]    X',24,42);c.fillText('Start       Browser       Notes                                       12:30',24,978);
            return {png:canvas.toDataURL(),width:1600,height:1000,content,figures};
        },{scenario,supplied});
        const name=scenario.name+'-'+scenario.allowed;
        fs.writeFileSync(path.join(root,name+'-input.png'),Buffer.from(fixture.png.split(',')[1],'base64'));
        await app.evaluate(({ipcMain,screen},png)=>{ipcMain.removeHandler('annotation:screenshots');ipcMain.handle('annotation:screenshots',()=>screen.getAllDisplays().map(d=>({id:d.id,bounds:d.bounds,scaleFactor:d.scaleFactor,png})));},fixture.png);
        await panel.evaluate(async allowed=>{const ipc=require('electron').ipcRenderer,s=await ipc.invoke('annotation:state');await ipc.invoke('annotation:configure',{...s.config,whiteboard:{enabled:true,maxRects:5,includeTaskbar:allowed,includeWindowChrome:allowed}});},scenario.allowed);
        const next=app.waitForEvent('window'),start=performance.now();await panel.evaluate(()=>require('electron').ipcRenderer.invoke('annotation:capture','full'));
        const page=await next;await page.waitForFunction(()=>document.body.dataset.acReady==='true');const ready=performance.now();await isolateWindow(app,page);
        await page.waitForFunction(()=>!document.querySelector('#ac-whiteboard-status').textContent.startsWith('正在'),undefined,{timeout:15000});
        assert.equal(await page.locator('#ac-whiteboard-status').innerText(),'空白区域已就绪');
        const durationMs=performance.now()-start,detectionAfterReadyMs=performance.now()-ready;
        await page.locator('#ac-whiteboard').click();assert.equal(await page.locator('#ac-whiteboard-adjust').isVisible(),false);
        await page.screenshot({path:path.join(root,name+'-screen.png')});
        const closed=page.waitForEvent('close');await page.keyboard.press('Escape');await closed;
        const files=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name==='annotations.json')files.push(p);}}
        walk(path.join(data,'Archive'));const file=files.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
        const objects=JSON.parse(fs.readFileSync(file)).canvas.objects.filter(o=>o.acWhiteboard);
        const rects=objects.map(o=>({x:o.left,y:o.top,width:o.width,height:o.height}));assert.ok(rects.length>0&&rects.length<=5&&objects.every(o=>o.acFixed));
        const connected=new Set([0]);let changed=true;while(changed){changed=false;for(let i=0;i<rects.length;i++)if(!connected.has(i)&&[...connected].some(j=>touches(rects[i],rects[j]))){connected.add(i);changed=true;}}
        assert.equal(connected.size,rects.length,'boards should form one connected writing surface on these layouts');
        const metrics=await app.evaluate(({nativeImage},{fixture,rects,capture,allowed})=>{
            const before=nativeImage.createFromDataURL(fixture.png).toBitmap(),after=nativeImage.createFromPath(capture).toBitmap();
            const {width,height}=fixture;let covered=0,lostContent=0,seamPixels=0,protectedOverlap=0,chromeMiss=0;
            const inside=(r,x,y)=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height;
            for(let y=0;y<height;y++)for(let x=0;x<width;x++){
                const hit=rects.some(r=>inside(r,x,y));const p=(y*width+x)*4;
                if(hit){covered++;if(after[p]<250||after[p+1]<250||after[p+2]<250)seamPixels++;if(fixture.figures.some(r=>inside(r,x,y)))protectedOverlap++;}
                if(hit&&fixture.content.some(r=>inside(r,x,y))&&Math.max(before[p],before[p+1],before[p+2])<150)lostContent++;
                if(allowed&&(y<60||y>=955)&&!hit)chromeMiss++;
                if(!allowed&&(y<72||y>=940)&&hit)protectedOverlap++;
            }
            return {coverage:covered/(width*height),lostContent,seamPixels,protectedOverlap,chromeMiss};
        },{fixture,rects,capture:path.join(path.dirname(file),'capture.png'),allowed:scenario.allowed});
        fs.copyFileSync(path.join(path.dirname(file),'capture.png'),path.join(root,name+'-result.png'));
        checks.push({...scenario,...metrics,durationMs,detectionAfterReadyMs,rects});
        fs.writeFileSync(path.join(root,name+'-detection.json'),JSON.stringify(await app.evaluate(()=>globalThis.layoutDetection),null,2));
        console.log('LAYOUT_RESULT',JSON.stringify(checks.at(-1)));
        assert.equal(metrics.lostContent,0,'all text and choice pixels must remain visible');
        assert.equal(metrics.seamPixels,0,'whiteboard union must be solid white, including shared boundaries');
        assert.equal(metrics.protectedOverlap,0,'figures and disabled chrome must remain intact');
        if(scenario.allowed)assert.equal(metrics.chromeMiss,0,'allowed chrome/taskbar should be covered edge to edge');
        assert.ok(metrics.coverage>(scenario.name==='diagram'?.45:.60));
        assert.ok(detectionAfterReadyMs<8000);
    }
    fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:true,checks},null,2));
})().catch(error=>{fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({passed:false,checks,error:String(error)},null,2));console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.evaluate(({app})=>app.exit()).catch(()=>{});});
