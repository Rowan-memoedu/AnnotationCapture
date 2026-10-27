const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

function connection() {
    const file=process.env.ANNOTATION_ADMIN_CONFIG || 'D:/AppData/AnnotationCapture/Admin/server.json';
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(value.host)||!path.isAbsolute(value.identityFile))throw new Error('Invalid administrator connection');
    return {host:value.host,args:['-i',value.identityFile,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','ConnectTimeout=15']};
}
function remotePython(program,input={}) {
    const target=connection();
    const encoded=Buffer.from(program).toString('base64');
    try {
        const output=execFileSync('ssh',[...target.args,target.host,`sudo -n /usr/bin/python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`],{input:JSON.stringify(input),encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:2*1024*1024});
        return JSON.parse(output);
    } catch (error) {
        const directory='D:/AppData/AnnotationCapture/Admin';fs.mkdirSync(directory,{recursive:true});
        fs.writeFileSync(path.join(directory,'last-operation-error.log'),String(error.stderr || error.message));
        throw new Error('服务器操作失败，详细信息已保存到本机私密管理目录');
    }
}
module.exports={connection,remotePython};
