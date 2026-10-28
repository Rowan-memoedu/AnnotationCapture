const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve('out/renderer/mathjax');
fs.mkdirSync(target, {recursive:true});
fs.copyFileSync('src/renderer/annotation/mathjax.html', path.join(target,'index.html'));
for (const file of ['startup.js','core.js','input/tex-base.js','input/tex/extensions/ams.js','input/tex/extensions/newcommand.js','output/svg.js']) {
    fs.mkdirSync(path.dirname(path.join(target,file)),{recursive:true});
    fs.copyFileSync(path.join('node_modules/mathjax',file),path.join(target,file));
}
fs.copyFileSync('node_modules/mathjax/LICENSE', path.join(target,'LICENSE-MathJax'));
for (const font of ['stix2','newcm']) {
    const source=`node_modules/@mathjax/mathjax-${font}-font`;
    fs.mkdirSync(path.join(target,font),{recursive:true});
    fs.copyFileSync(path.join(source,'svg.js'),path.join(target,font,'svg.js'));
    fs.cpSync(path.join(source,'svg'),path.join(target,font,'svg'),{recursive:true});
}
console.log('Local MathJax and two fonts prepared');
