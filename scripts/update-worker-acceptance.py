import pathlib,tempfile,zipfile,json,hashlib,subprocess,os,uuid
base=pathlib.Path(os.environ.get('ANNOTATION_EVIDENCE','D:/Artifacts/AnnotationCapture/update-worker'))
base.mkdir(parents=True,exist_ok=True)
root=pathlib.Path('D:/Quarantine/AnnotationCapture')/('update-worker-'+str(uuid.uuid4()));root.mkdir(parents=True)
worker=pathlib.Path(__file__).resolve().parent.parent/'src/main/update-worker.ps1'
ps=pathlib.Path(os.environ['SystemRoot'])/'System32/WindowsPowerShell/v1.0/powershell.exe'
sha=lambda b:hashlib.sha256(b).hexdigest()
checks=[]
def fixture(case,change=None):
 app=root/case/'App';data=app/'AnnotationCapture-data';txn=data/'Updates'/str(uuid.uuid4());txn.mkdir(parents=True)
 files={'AnnotationCapture.exe':b'MZ-test-fixture','resources/app.asar':b'old application','LICENSE':b'license'}
 def manifest(version,values):return {'version':version,'files':[{'path':p,'size':len(b),'sha256':sha(b)} for p,b in values.items()]}
 for p,b in files.items():f=app/p;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(b)
 (app/'program-manifest.json').write_text(json.dumps(manifest('9.0.0',files)))
 values={**files,'resources/app.asar':b'new application'};new=manifest('9.0.1',values)
 entries={**values,'program-manifest.json':json.dumps(new).encode()}
 if change:change(entries)
 z=txn/'update.zip'
 with zipfile.ZipFile(z,'w',compression=zipfile.ZIP_DEFLATED)as out:
  for p,b in entries.items():out.writestr(p,b)
 req={'version':'9.0.1','currentVersion':'9.0.0','appRoot':str(app),'dataRoot':str(data),'archiveRoot':str(data/'Archive'),'zip':str(z),'sha256':sha(z.read_bytes()),'parentPid':999999,'transaction':str(txn)}
 request=txn/'request.json';request.write_text(json.dumps(req))
 return app,txn,request
def run(mode,request):return subprocess.run([str(ps),'-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(worker),'-Mode',mode,'-RequestPath',str(request)],capture_output=True,text=True,timeout=45)
for name,change,success in [
 ('valid',None,True),
 ('traversal',lambda e:e.update({'../outside.txt':b'bad'}),False),
 ('user-data',lambda e:e.update({'AnnotationCapture-data/config.json':b'bad'}),False),
 ('altered-payload',lambda e:e.update({'resources/app.asar':b'changed bytes'}),False),
 ('extra-program-file',lambda e:e.update({'unmanaged.dll':b'bad'}),False),
]:
 app,txn,request=fixture(name,change);old=sha((app/'resources/app.asar').read_bytes());result=run('Prepare',request)
 assert (result.returncode==0)==success,(name,result.stdout,result.stderr)
 assert sha((app/'resources/app.asar').read_bytes())==old
 checks.append({'name':name,'passed':True})
 if name=='valid':
  (app/'resources/app.asar').write_bytes(b'local change must be preserved')
  result=run('Apply',request);assert result.returncode!=0
  assert (app/'resources/app.asar').read_bytes()==b'local change must be preserved'
  assert not(txn/'worker-ready.json').exists()
  checks.append({'name':'modified-installation-refused-before-exit','passed':True})
(base/'report.json').write_text(json.dumps({'passed':True,'checks':checks,'root':str(root)},indent=2))
print('UPDATE_WORKER_ACCEPTANCE_PASSED',json.dumps(checks))
