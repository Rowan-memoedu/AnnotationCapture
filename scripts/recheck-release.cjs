const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {spawnSync}=require('node:child_process');
const file=process.argv[2];if(!file||!path.isAbsolute(file))throw new Error('An absolute release-acceptance.json path is required');
const report=JSON.parse(fs.readFileSync(file,'utf8'));const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
if(hash(report.zipPath)!==report.sha256)throw new Error('Release ZIP changed after acceptance');
const built=path.join(path.dirname(report.zipPath),'win-unpacked/resources/app.asar');const extracted=path.join(path.dirname(report.executable),'resources/app.asar');
if(hash(built)!==hash(extracted))throw new Error('Extracted application differs from the frozen build');
for(const check of report.checks.filter(c=>c.exitCode!==0)){
 if(!['portable-smoke','shortcuts-acceptance','settings-acceptance','retention-acceptance','ink-ocr-regression','math-academy-acceptance','capture-modes-acceptance','continuous-writing-acceptance','quit-acceptance','ui-acceptance','edge-acceptance','tablet-selection-acceptance','copy-stays-open-acceptance','keyboard-performance-acceptance','ink-selection-acceptance','live-ocr-acceptance','ocr-output-acceptance','formula-pen-acceptance','formula-pen-live'].includes(check.script))throw new Error('Unknown acceptance stage');
 const result=spawnSync(process.execPath,[path.join(__dirname,check.script+'.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,ANNOTATION_EXE:report.executable,ANNOTATION_EVIDENCE:check.script.startsWith('formula-pen')||check.script==='ink-selection-acceptance'?path.join(report.evidence,check.script+(check.scale?'-'+check.scale:'')):report.evidence,ANNOTATION_SCALE:check.scale||'',ANNOTATION_OCR_CASE:check.formulaCase||'',ANNOTATION_OCR_FORMAT:check.outputFormat||'latex',ANNOTATION_RESUME_OUTPUT:'1'},encoding:'utf8',windowsHide:true,timeout:['ocr-output-acceptance','ink-ocr-regression'].includes(check.script)?360000:180000});
 process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
 check.previousAttempts=[...(check.previousAttempts||[]),{exitCode:check.exitCode,error:check.error}];check.exitCode=result.status;check.error=result.error?.message;
}
report.passed=report.checks.every(c=>c.exitCode===0);report.releaseReady=report.passed&&report.liveProviderTested;
report.ocrAccuracy=report.checks.filter(c=>c.script==='live-ocr-acceptance').map(c=>{const f=path.join(report.evidence,`shared-api-${c.outputFormat||'latex'}-${c.formulaCase}-report.json`);const r=JSON.parse(fs.readFileSync(f,'utf8'));return {case:c.formulaCase,format:c.outputFormat||'latex',exactMatch:r.exactMatch,expected:r.expected,actual:r.actual};});
report.ambiguityPolicy='Automatic copy followed by human review; functional acceptance and exact transcription are reported separately';
fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,releaseReady:report.releaseReady,frozenZipSha256:report.sha256}));if(!report.passed)process.exitCode=1;
