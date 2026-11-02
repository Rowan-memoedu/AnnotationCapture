const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

if (process.platform === 'win32') {
    const target = path.resolve('out/native/ScreenFrame.exe');
    mkdirSync(path.dirname(target), {recursive:true});
    const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(compiler, ['/nologo', '/target:exe', '/optimize+', '/unsafe', '/platform:x64',
        '/reference:System.Drawing.dll', '/out:' + target, path.resolve('native/ScreenFrame.cs')], {stdio:'inherit', windowsHide:true});
}
