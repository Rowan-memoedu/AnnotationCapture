const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {spawnSync}=require('node:child_process');
const file=process.argv[2];if(!file||!path.isAbsolute(file))throw new Error('An absolute release-acceptance.json path is required');
const report=JSON.parse(fs.readFileSync(file,'utf8'));const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
if(hash(report.zipPath)!==report.sha256)throw new Error('Release ZIP changed after acceptance');
const built=path.join(path.dirname(report.zipPath),'win-unpacked/resources/app.asar');const extracted=path.join(path.dirname(report.executable),'resources/app.asar');
if(hash(built)!==hash(extracted))throw new Error('Extracted application differs from the frozen build');
for(const check of report.checks.filter(c=>c.exitCode!==0)){
 if(!['portable-smoke','shortcuts-acceptance','capture-modes-acceptance','ui-acceptance','edge-acceptance','live-ocr-acceptance'].includes(check.script))throw new Error('Unknown acceptance stage');
 const result=spawnSync(process.execPath,[path.join(__dirname,check.script+'.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,ANNOTATION_EXE:report.executable,ANNOTATION_EVIDENCE:report.evidence,ANNOTATION_OCR_CASE:check.formulaCase||''},encoding:'utf8',windowsHide:true,timeout:180000});
 process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
 check.previousAttempts=[...(check.previousAttempts||[]),{exitCode:check.exitCode,error:check.error}];check.exitCode=result.status;check.error=result.error?.message;
}
report.passed=report.checks.every(c=>c.exitCode===0);report.releaseReady=report.passed&&report.liveProviderTested;
fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,releaseReady:report.releaseReady,frozenZipSha256:report.sha256}));if(!report.passed)process.exitCode=1;
