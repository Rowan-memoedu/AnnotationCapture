const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {connection,remotePython}=require('./gateway-connection.cjs');

(async()=>{
 const id=Date.now();
 const artifacts=`D:/Artifacts/AnnotationCapture/gateway-deploy-${id}`;
 const staging=path.join(artifacts,'package');fs.mkdirSync(staging,{recursive:true});
 const names=['gateway/server.py','gateway/test_server.py','gateway/install.py','gateway/annotationcapture.service','gateway/nginx-location.conf'];
 const hashes={};
 for(const name of names){const target=path.join(staging,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(name,target);hashes[name]=crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex');}
 fs.writeFileSync(path.join(staging,'manifest.json'),JSON.stringify(hashes));
 const archive=path.join(artifacts,'gateway.tar.gz');execFileSync('tar',['-czf',archive,'-C',staging,...names,'manifest.json'],{windowsHide:true});
 const stage=`/tmp/annotationcapture-${id}`;
 remotePython(`import json,os,pathlib,pwd,sys
a=json.load(sys.stdin);p=pathlib.Path(a['stage'])
if p.parent!=pathlib.Path('/tmp') or not p.name.startswith('annotationcapture-') or p.exists():raise ValueError('Invalid staging path')
p.mkdir(mode=0o700);u=pwd.getpwnam('ubuntu');os.chown(p,u.pw_uid,u.pw_gid)
print(json.dumps({'stageCreated':True}))`,{stage});
 const target=connection();
 try{execFileSync('scp',[...target.args,archive,`${target.host}:${stage}/gateway.tar.gz`],{windowsHide:true,stdio:'pipe',timeout:120000});}
 catch{throw new Error('Gateway upload failed');}
 remotePython(`import hashlib,json,pathlib,sys,tarfile
a=json.load(sys.stdin);p=pathlib.Path(a['stage'])
with tarfile.open(p/'gateway.tar.gz') as package:
 members=package.getmembers()
 if set(m.name for m in members)!=set(a['names'])|{'manifest.json'} or any(not m.isfile() for m in members):raise ValueError('Unexpected archive entry')
 package.extractall(p,filter='data')
for name,sha in a['hashes'].items():
 if hashlib.sha256((p/name).read_bytes()).hexdigest()!=sha:raise ValueError('Uploaded source hash mismatch')
print(json.dumps({'sourceVerified':True}))`,{stage,names,hashes});
 let output;
 try{output=execFileSync('ssh',[...target.args,target.host,`sudo -n /usr/bin/python3 /usr/local/lib/tencent-cloud-maintenance/host.py run-stage --path ${stage} -- /usr/bin/python3 ${stage}/gateway/install.py`],{encoding:'utf8',windowsHide:true,timeout:180000});}
 catch(error){fs.writeFileSync(path.join(artifacts,'private-deployment-error.log'),String(error.stderr || error.message));throw new Error('Gateway deployment failed; see private deployment log in '+artifacts);}
 const receipt=JSON.parse(output);fs.writeFileSync(path.join(artifacts,'receipt.json'),JSON.stringify(receipt,null,2));
 for(const route of ['/annotationcapture/api/health','/api/health']){const response=await fetch('https://124.221.144.155'+route,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('External health check failed');}
 console.log(JSON.stringify({...receipt,receipt:path.join(artifacts,'receipt.json')}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
