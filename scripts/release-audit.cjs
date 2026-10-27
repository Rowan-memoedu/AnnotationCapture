const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const asar=require(require.resolve('@electron/asar',{paths:[require.resolve('electron-builder')]}));
const {version}=require('../package.json');
const base=process.env.ANNOTATION_ARTIFACTS||'D:/Artifacts/AnnotationCapture';
const archive=path.join(base,'release/win-unpacked/resources/app.asar');
const files=asar.listPackage(archive);
const unneeded=files.filter(f=>f.includes('node_modules'));
assert.equal(unneeded.length,0,'Bundled code must run without external node_modules');
const leaked=files.filter(f=>/annotation-settings|capture\.png|\.env|\.key|ui-report|config\.json$|\.map$/.test(f));
assert.deepEqual(leaked,[]);
const keys=Object.entries(process.env).filter(([n,v])=>/(?:DEEPSEEK.*KEY|ANNOTATION_LLM_API_KEY)/.test(n)&&v?.length>15).map(([,v])=>Buffer.from(v));
if(process.platform==='win32'){
 const saved=JSON.parse(execFileSync('pwsh',['-NoLogo','-NoProfile','-NonInteractive','-Command',"ConvertTo-Json -Compress -InputObject ([Environment]::GetEnvironmentVariable('ANNOTATION_LLM_API_KEY','User'))"],{encoding:'utf8',windowsHide:true}));
 if(typeof saved==='string'&&saved.length>15)keys.push(Buffer.from(saved));
}
const raw=fs.readFileSync(archive);
assert.ok(keys.every(key=>!raw.includes(key)),'Credential found in distribution');
let codeMatchesAcceptedCandidate;
if(process.env.ANNOTATION_ACCEPTED_ASAR){
 const reference=process.env.ANNOTATION_ACCEPTED_ASAR;
 const manifest=file=>asar.listPackage(file).filter(name=>name.startsWith('/out/')&&!asar.statFile(file,name.slice(1)).files).map(name=>[name,crypto.createHash('sha256').update(asar.extractFile(file,name.slice(1))).digest('hex')]).sort((a,b)=>a[0].localeCompare(b[0]));
 assert.deepEqual(manifest(archive),manifest(reference),'Application code changed after candidate acceptance');codeMatchesAcceptedCandidate=true;
}
const zip=path.join(base,`release/AnnotationCapture-${version}-windows-x64.zip`);
const bytes=fs.readFileSync(zip);
const hash=crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(path.join(base,'release/SHA256SUMS.txt'),`${hash}  ${path.basename(zip)}\n`);
const report={passed:true,archiveBytes:raw.length,fileCount:files.length,nodeModules:unneeded.length,unexpectedUserData:leaked.length,credentialScanPassed:true,codeMatchesAcceptedCandidate,zipBytes:bytes.length,zipSha256:hash};
fs.mkdirSync(path.join(base,'acceptance'),{recursive:true});fs.writeFileSync(path.join(base,'acceptance/release-audit.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
