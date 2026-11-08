const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { prepareProfile } = require('./acceptance-window.cjs');
const exe = path.resolve(process.env.ANNOTATION_EXE);
const evidence = process.env.ANNOTATION_EVIDENCE || 'D:/Artifacts/AnnotationCapture/release-0.8.4/acceptance/runtime';
const root = 'D:/Quarantine/AnnotationCapture/startup-runtime-' + crypto.randomUUID();
const data = path.join(root, "User's 数据 & 学习");
const name = 'AnnotationCapture-Test-' + crypto.randomUUID();
const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
fs.mkdirSync(evidence, { recursive: true });
prepareProfile(data);
function ps(script, extra = {}) {
  const command = "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';" + script;
  return cp.execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    windowsHide: true, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ANNOTATION_TEST_DATA: data, ANNOTATION_TEST_EXE: exe, ANNOTATION_TEST_NAME: name, ...extra },
  }).trim();
}
const sid = ps('[Console]::Write([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)');
const taskName = name + '-Logon-' + sid;
const taskEnv = { ANNOTATION_TEST_TASK: taskName };
let application;
let page;
let report;
const checks = [];
async function wait(check) {
  const deadline = Date.now() + 120000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('Runtime startup verification timed out');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
async function launch(extra = ['--startupTestName', name]) {
  application = await _electron.launch({ executablePath: exe, cwd: 'C:/Windows/System32', args: ['--background', '--testMode', '--userData', data, '--archiveRoot', path.join(data, '归档 & 公式'), ...extra], timeout: 30000 });
  await application.evaluate(({ app }) => app.whenReady());
  const initial = await application.evaluate(({ BrowserWindow, globalShortcut }) => ({ visible: BrowserWindow.getAllWindows().filter(win => win.isVisible()).length, shortcuts: ['Control+Alt+F13', 'Alt+F14', 'Control+Alt+F16'].every(key => globalShortcut.isRegistered(key)) }));
  assert.equal(initial.visible, 0);
  assert.ok(initial.shortcuts);
  await application.evaluate(async ({ BrowserWindow }, file) => {
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
    await win.loadFile(file);
  }, path.join(path.dirname(exe), 'resources/app.asar/out/renderer/annotation.html'));
  page = await application.firstWindow();
  await page.waitForSelector('#ac-save-settings');
  await wait(async () => !(await page.evaluate(() => require('electron').ipcRenderer.invoke('annotation:state'))).startup.busy);
  return page.evaluate(() => require('electron').ipcRenderer.invoke('annotation:state'));
}
(async () => {
  let state = await launch([]);
  assert.equal(state.startup.supported, false);
  assert.equal(fs.existsSync(path.join(data, 'Startup')), false);
  checks.push('ordinary-test-mode-does-not-touch-startup');
  await application.close(); application = null;
  state = await launch();
  assert.equal(state.config.version, '0.8.4');
  assert.equal(state.startup.method, 'task', state.startup.message);
  assert.equal(state.startup.enabled, true);
  checks.push('packaged-background-startup-and-three-shortcuts');
  let result = await page.evaluate(() => require('electron').ipcRenderer.invoke('annotation:setAutoStart', false));
  assert.equal(result.enabled, false);
  assert.equal(result.method, 'task', result.message);
  await application.close(); application = null;
  state = await launch();
  assert.equal(state.startup.enabled, false);
  checks.push('tray-controller-opt-out-persists-after-relaunch');
  result = await page.evaluate(() => require('electron').ipcRenderer.invoke('annotation:setAutoStart', true));
  assert.equal(result.enabled, true);
  assert.equal(result.method, 'task', result.message);
  await application.close(); application = null;
  ps('Start-ScheduledTask -TaskName $env:ANNOTATION_TEST_TASK', taskEnv);
  let native;
  await wait(() => {
    const output = ps('Get-CimInstance Win32_Process -Filter "Name = \'AnnotationCapture.exe\'" | Where-Object {$_.ExecutablePath -eq $env:ANNOTATION_TEST_EXE -and $_.CommandLine.Contains($env:ANNOTATION_TEST_DATA) -and $_.CommandLine -notlike \'* --type=*\'} | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress');
    if (!output) return false;
    native = JSON.parse(output); return true;
  });
  assert.ok(native.CommandLine.includes('--background'));
  assert.ok(native.CommandLine.includes('--startupTestName ' + name));
  await wait(() => {
    const state = JSON.parse(fs.readFileSync(path.join(data, 'Startup/state.json'), 'utf8'));
    return state.method === 'task' && state.enabled;
  });
  const windows = JSON.parse(ps('Get-Process -Id $env:ANNOTATION_TEST_PID | Select-Object Id,@{n="visible";e={$_.MainWindowHandle -ne 0}} | ConvertTo-Json -Compress', { ANNOTATION_TEST_PID: String(native.ProcessId) }));
  assert.equal(windows.visible, false);
  checks.push('native-scheduled-task-cold-launches-without-visible-window');
  report = { passed: true, checks, version: state.config.version, executable: exe, root, taskName, actualWindowsSignIn: false };
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (application) await application.close().catch(() => {});
  assert.ok(path.resolve(data).startsWith(path.resolve(root) + path.sep));
  ps("Get-ScheduledTask -TaskName $env:ANNOTATION_TEST_TASK -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter \"Name = 'AnnotationCapture.exe'\" | Where-Object {$_.ExecutablePath -eq $env:ANNOTATION_TEST_EXE -and $_.CommandLine.Contains($env:ANNOTATION_TEST_DATA)} | ForEach-Object {Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue}; Get-ScheduledTask -TaskName $env:ANNOTATION_TEST_TASK -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false; foreach($key in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run')) {if((Get-Item -LiteralPath $key).GetValue($env:ANNOTATION_TEST_NAME,$null)) {Remove-ItemProperty -LiteralPath $key -Name $env:ANNOTATION_TEST_NAME}}; if(Get-ScheduledTask -TaskName $env:ANNOTATION_TEST_TASK -ErrorAction SilentlyContinue){throw 'Fixture task remains'}; exit 0", taskEnv);
  if (report) {
    ps("$testRoot='HKCU:\\Software\\AnnotationCapture-Tests\\'+$env:ANNOTATION_TEST_NAME;if(Test-Path -LiteralPath $testRoot){Remove-Item -LiteralPath $testRoot -Recurse};exit 0");
    report.cleanedUp = true;
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    console.log('STARTUP_RUNTIME_PASSED', JSON.stringify(checks));
  }
}).catch(error => { console.error(error); process.exitCode = 1; });
