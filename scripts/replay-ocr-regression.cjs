const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
(async()=>{
 const file=process.env.ANNOTATION_REGRESSION_FILE;assert.ok(file&&path.isAbsolute(file),'An absolute original OCR report is required');
 const original=JSON.parse(fs.readFileSync(file,'utf8'));const bytes=fs.readFileSync(original.result.path);const png='data:image/png;base64,'+bytes.toString('base64');
 const invite=JSON.parse(fs.readFileSync(process.env.ANNOTATION_INVITE_FILE,'utf8'));const base=process.env.ANNOTATION_SERVICE_URL||'https://124.221.144.155/annotationcapture/api';
 const login=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({inviteCode:invite.inviteCode}),signal:AbortSignal.timeout(15000)});assert.equal(login.status,200,'Regression login failed');const session=await login.json();
 const response=await fetch(base+'/recognize',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.token},body:JSON.stringify({png,outputFormat:original.result.outputFormat||'latex'}),signal:AbortSignal.timeout(60000)});assert.equal(response.status,200,'Regression recognition failed');const result=await response.json();
 const canonical=value=>value.replace(/\s/g,'').replace(/\\left|\\right/g,'').replace(/([_^])\{([A-Za-z0-9])\}/g,'$1$2');
 const passed=canonical(result.latex)===canonical(original.expected);
 const record={passed,originalInputSha256:crypto.createHash('sha256').update(bytes).digest('hex'),replayedOriginalPixels:true,expected:original.expected,actual:result.latex,outputFormat:original.result.outputFormat,model:result.model};
 const evidence=process.env.ANNOTATION_EVIDENCE||path.dirname(file);fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'original-pixels-replay.json'),JSON.stringify(record,null,2));console.log(JSON.stringify(record));assert.ok(passed,'Original OCR pixels still fail the regression');
})().catch(error=>{console.error(String(error).replace(/AC-[A-Za-z0-9_-]+/g,'[invitation]'));process.exitCode=1;});
