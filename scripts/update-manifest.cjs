const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
module.exports=async context=>{
 const root=context.appOutDir,files=[];
 function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Linked package entry');if(e.isDirectory())walk(p);else if(e.name!=='program-manifest.json')files.push({path:path.relative(root,p).split(path.sep).join('/'),size:fs.statSync(p).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')});}}
 walk(root);fs.writeFileSync(path.join(root,'program-manifest.json'),JSON.stringify({version:require('../package.json').version,files},null,2));
};
