const fs = require('node:fs');
const path = require('node:path');
const metadata = require('../package.json');
const artifacts = process.env.ANNOTATION_ARTIFACTS || 'D:/Artifacts/AnnotationCapture';
const staging = path.join(artifacts, 'package');
fs.mkdirSync(staging, { recursive: true });
const compiled=path.resolve(staging,'out');
if(fs.existsSync(compiled)){
    if(fs.lstatSync(compiled).isSymbolicLink()||fs.realpathSync(compiled).toLowerCase()!==compiled.toLowerCase())throw new Error('Refusing to clean linked package output');
    // This directory contains only reproducible compiled application files.
    fs.rmSync(compiled,{recursive:true,force:true});
}
for (const entry of ['out', 'assets/logo']) fs.cpSync(path.resolve(entry), path.join(staging, entry), { recursive: true });
fs.mkdirSync(path.join(staging, 'lib/translate'), { recursive: true });
for (const file of fs.readdirSync('lib/translate').filter(f=>f.endsWith('.json'))) fs.copyFileSync(path.join('lib/translate', file), path.join(staging,'lib/translate',file));
for (const file of ['LICENSE','README.md','README.eSearch.md','THIRD_PARTY_NOTICES.md']) fs.copyFileSync(file,path.join(staging,file));
fs.writeFileSync(path.join(staging,'package.json'),JSON.stringify({name:'annotation-capture',productName:'AnnotationCapture',version:metadata.version,description:metadata.description,main:'out/main/main.js',license:'GPL-3.0',author:metadata.author,dependencies:{},optionalDependencies:{}},null,2));
const licenses=[];
for(const name of ['mathjax','@mathjax/mathjax-stix2-font','@mathjax/mathjax-newcm-font','@erase2d/fabric','bmp-js','chroma-js','dkh-ui','edge_det','fabric','hex-to-css-filter','hotkeys-js','minimist','picture_match','xtranslator']) {
    const directory=path.join('node_modules',name);
    const license=fs.readdirSync(directory).find(f=>/^(license|licence|copying)(\.|$)/i.test(f));
    if(license) licenses.push(`\n========== ${name} ==========\n${fs.readFileSync(path.join(directory,license),'utf8')}`);
    else { const p=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8')); licenses.push(`\n========== ${name} ==========\nLicense: ${p.license || 'See upstream repository'}\nRepository: ${typeof p.repository==='string'?p.repository:JSON.stringify(p.repository)}\n`); }
}
fs.writeFileSync(path.join(staging,'THIRD_PARTY_LICENSES.txt'),licenses.join('\n'));
console.log(`Prepared standalone application: ${staging}`);
