const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {remotePython}=require('./gateway-connection.cjs');

const accountProgram=`import json,subprocess,sys
a=json.load(sys.stdin)
command=['runuser','-u','annotationcapture','--','/usr/bin/python3','/opt/annotationcapture/app/gateway/server.py','--data-dir','/var/lib/annotationcapture']
if a['operation']=='create':command+=['account-create','--label',a['label']]
elif a['operation']=='revoke':command+=['account-revoke','--account-id',a['accountId']]
elif a['operation']=='list':command+=['account-list']
else:raise ValueError('Unsupported account operation')
result=subprocess.run(command,check=True,capture_output=True,text=True)
print(result.stdout)`;

function account(operation,parameters={}) {return remotePython(accountProgram,{operation,...parameters});}
function configureProvider() {
    const names=['ANNOTATION_LLM_BASE_URL','ANNOTATION_LLM_API_KEY','ANNOTATION_LLM_MODEL','ANNOTATION_LLM_EXTRA_JSON'];
    const script=`$result=@{};foreach($name in @(${names.map(n=>`'${n}'`).join(',')})){$result[$name]=[Environment]::GetEnvironmentVariable($name,'User')};$result|ConvertTo-Json -Compress`;
    const user=JSON.parse(execFileSync('pwsh',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true}));
    const defaults={ANNOTATION_LLM_BASE_URL:'https://api.deepseek.com',ANNOTATION_LLM_MODEL:'deepseek-flash',ANNOTATION_LLM_EXTRA_JSON:'{"thinking":{"type":"enabled"},"reasoning_effort":"low"}'};
    const values=Object.fromEntries(names.map(name=>[name,(user[name] || process.env[name] || defaults[name] || '').trim()]));
    for(const name of names.slice(0,3))if(!values[name])throw new Error('请先在用户环境变量中填写 '+name);
    return remotePython(`import importlib.util,json,os,pathlib,subprocess,sys,time,urllib.request
a=json.load(sys.stdin);spec=importlib.util.spec_from_file_location('gateway','/opt/annotationcapture/app/gateway/server.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
values=a['values'];provider=module.Provider(values)
if not provider.ready:raise ValueError('Provider configuration incomplete')
if any(any(ord(c)<32 for c in v) for v in values.values()):raise ValueError('Control characters are not allowed')
config=pathlib.Path('/etc/annotationcapture/provider.env');previous=config.read_bytes() if config.exists() else b''
temporary=config.with_suffix('.new');temporary.write_text(''.join(k+'='+json.dumps(v,ensure_ascii=False)+'\\n' for k,v in values.items() if v),encoding='utf8');temporary.chmod(0o600);os.replace(temporary,config)
try:
 subprocess.run(['systemctl','restart','annotationcapture'],check=True)
 for _ in range(15):
  try:
   with urllib.request.urlopen('http://127.0.0.1:18879/health',timeout=3) as response:
    if response.status==200:break
  except OSError:time.sleep(1)
 else:raise RuntimeError('Gateway health failed')
except Exception:
 temporary.write_bytes(previous);temporary.chmod(0o600);os.replace(temporary,config);subprocess.run(['systemctl','restart','annotationcapture'],check=True);raise
print(json.dumps({'configured':True,'serviceHealthy':True}))`,{values});
}

if(require.main===module){
    try {
        const [operation,value,output]=process.argv.slice(2);
        if(operation==='create'){
            if(!value||!output||!path.isAbsolute(output)||fs.existsSync(output))throw new Error('Usage: gateway-admin.cjs create LABEL ABSOLUTE_NEW_PRIVATE_FILE');
            const result=account('create',{label:value});fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
            console.log(JSON.stringify({accountId:result.accountId,label:result.label,invitationFile:output}));
        } else if(operation==='revoke')console.log(JSON.stringify(account('revoke',{accountId:value})));
        else if(operation==='list')console.log(JSON.stringify(account('list')));
        else if(operation==='configure-provider')console.log(JSON.stringify(configureProvider()));
        else throw new Error('Usage: gateway-admin.cjs create|list|revoke|configure-provider');
    }catch(error){console.error(error.message);process.exitCode=1;}
}
module.exports={account,configureProvider};
