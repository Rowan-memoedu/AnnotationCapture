const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');
const yauzl = require('yauzl');
const { version } = require('../package.json');

const artifacts = process.env.ANNOTATION_ARTIFACTS || 'D:/Artifacts/AnnotationCapture';
const zipPath = path.join(artifacts, 'release', `AnnotationCapture-${version}-windows-x64.zip`);
const runId = `${version}-${Date.now()}`;
const destination = path.resolve('D:/Quarantine/AnnotationCapture', `accept-${runId}`);
const evidence = path.join(artifacts, 'acceptance', `release-${runId}`);

async function extract() {
    if (fs.existsSync(destination)) throw new Error('Acceptance destination already exists');
    fs.mkdirSync(destination, { recursive: true });
    await new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true }, (error, zip) => {
            if (error) return reject(error);
            zip.on('error', reject);
            zip.on('end', resolve);
            zip.on('entry', async entry => {
                try {
                    const target = path.resolve(destination, entry.fileName);
                    if (!target.toLowerCase().startsWith(`${destination.toLowerCase()}${path.sep}`)) throw new Error('Archive path escapes acceptance directory');
                    if (entry.fileName.endsWith('/')) fs.mkdirSync(target, { recursive: true });
                    else {
                        fs.mkdirSync(path.dirname(target), { recursive: true });
                        const stream = await new Promise((resolveStream, rejectStream) => zip.openReadStream(entry, (err, value) => err ? rejectStream(err) : resolveStream(value)));
                        await pipeline(stream, fs.createWriteStream(target, { flags: 'wx' }));
                    }
                    zip.readEntry();
                } catch (err) { zip.close(); reject(err); }
            });
            zip.readEntry();
        });
    });
}

(async () => {
    fs.mkdirSync(evidence, { recursive: true });
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
    await extract();
    const executable = path.join(destination, 'AnnotationCapture.exe');
    if (!fs.existsSync(executable)) throw new Error('Extracted application executable is missing');
    const env = { ...process.env, ANNOTATION_EXE: executable, ANNOTATION_EVIDENCE: evidence };
    const checks = [];
    const tasks = [
        { script: 'portable-smoke' },
        { script: 'shortcuts-acceptance' },
        { script: 'settings-acceptance' },
        { script: 'capture-modes-acceptance' },
        { script: 'continuous-writing-acceptance' },
        { script: 'quit-acceptance' },
        { script: 'ui-acceptance' },
        { script: 'edge-acceptance' },
        { script: 'tablet-selection-acceptance' },
        { script: 'copy-stays-open-acceptance' },
        { script: 'keyboard-performance-acceptance' },
        ...['1','1.5','2'].map(scale=>({script:'ink-selection-acceptance',scale})),
        ...['1','1.5','2'].map(scale=>({script:'formula-pen-acceptance',scale})),
        ...(process.env.ANNOTATION_INVITE_FILE ? [{script:'formula-pen-live'}] : []),
        ...(process.env.ANNOTATION_INVITE_FILE ? ['polynomial', 'fraction', 'root', 'mixedcase'].map(formulaCase => ({ script: 'live-ocr-acceptance', formulaCase })) : []),
        ...(process.env.ANNOTATION_INVITE_FILE ? ['fraction','root'].map(formulaCase=>({script:'live-ocr-acceptance',formulaCase,outputFormat:'markdown'})) : []),
        ...(process.env.ANNOTATION_INVITE_FILE ? [{script:'ocr-output-acceptance'}] : []),
    ];
    for (const task of tasks) {
        console.log(`RUN ${task.script}${task.formulaCase ? ` ${task.formulaCase}` : ''}`);
        const result = spawnSync(process.execPath, [path.join(__dirname, `${task.script}.cjs`)], {
            cwd: path.resolve(__dirname, '..'),
            env: { ...env, ANNOTATION_EVIDENCE:task.script.startsWith('formula-pen')||task.script==='ink-selection-acceptance'?path.join(evidence,task.script+(task.scale?'-'+task.scale:'')):evidence, ANNOTATION_SCALE:task.scale||'', ANNOTATION_OCR_CASE: task.formulaCase || '', ANNOTATION_OCR_FORMAT:task.outputFormat||'latex', ANNOTATION_TEST_CORRECTION: task.formulaCase === 'polynomial' ? '1' : '' },
            encoding: 'utf8', timeout: task.script==='ocr-output-acceptance'?360000:180000, windowsHide: true,
        });
        process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
        checks.push({ ...task, exitCode: result.status, error: result.error?.message });
    }
    const liveProviderTested=!!process.env.ANNOTATION_INVITE_FILE;
    const ocrAccuracy=tasks.filter(t=>t.script==='live-ocr-acceptance').map(t=>{const file=path.join(evidence,`shared-api-${t.outputFormat||'latex'}-${t.formulaCase}-report.json`);const r=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};return {case:t.formulaCase,format:t.outputFormat||'latex',exactMatch:r.exactMatch,expected:r.expected,actual:r.actual};});
    const report = { passed: checks.every(check => check.exitCode === 0), releaseReady:liveProviderTested&&checks.every(check=>check.exitCode===0), liveProviderTested, pending:liveProviderTested?[]:['NEW unified API end-to-end acceptance'], version, zipPath, sha256, executable, evidence, isolation: 'Drawing windows moved outside the visible desktop after screen capture; native focus disabled', checks };
    report.ocrAccuracy=ocrAccuracy;report.ambiguityPolicy='Automatic copy followed by human review; functional acceptance and exact transcription are reported separately';
    fs.writeFileSync(path.join(evidence, 'release-acceptance.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
