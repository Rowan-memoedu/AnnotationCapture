const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {mkdir, writeFile} = require('node:fs/promises');
const {join} = require('node:path');
const {pathToFileURL} = require('node:url');
const source = require('./calculator-source.json');

async function stage(directory) {
    assert.match(source.commit, /^[a-f0-9]{40}$/);
    const base = `https://raw.githubusercontent.com/memoedu/GraspMemoEdu/${source.commit}/web/`;
    const assets = await Promise.all(Object.entries(source.files).map(async ([file, expected]) => {
        assert.match(file, /^(?:calculator-(?:engine|policy)\.js|vendor\/calculator\/[a-zA-Z0-9.]+)$/);
        const response = await fetch(base + file, {signal: AbortSignal.timeout(30000)});
        if (!response.ok) throw Error(`Shared calculator asset unavailable: ${file}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, file);
        return [file, bytes];
    }));
    await mkdir(join(directory, 'vendor', 'calculator'), {recursive: true});
    for (const [file, bytes] of assets) await writeFile(join(directory, file), bytes);
    await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(directory, 'SOURCE.txt'), `GraspMemoEdu source: https://github.com/memoedu/GraspMemoEdu/tree/${source.commit}/web\n`);
    const engine = await import(pathToFileURL(join(directory, 'calculator-engine.js')).href);
    assert.equal((await engine.calculateSelectedFormula({expression: 'mod(17,5)'})).text, '2');
    assert.equal((await engine.calculateSelectedFormula({expression: 'x+x'})).text, '2*x');
    console.log(`Shared calculator verified: ${source.commit}`);
}

if (require.main === module) stage(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
