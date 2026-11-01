const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function prepareProfile(directory, shortcuts = {}) {
    fs.mkdirSync(directory, {recursive: true});
    const file = path.join(directory, 'annotation-settings.json');
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({shortcut: 'Control+Alt+F13', fullShortcut: 'Alt+F14', ocrShortcut: 'Control+Alt+F16', ...shortcuts}));
}
async function isolateWindow(app, page, preserveSize = false) {
    return app.evaluate(({ BrowserWindow }, { url, preserveSize }) => {
        const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url);
        if (!win) throw new Error('Acceptance window was not found');
        win.webContents.setBackgroundThrottling(false);
        win.setAlwaysOnTop(false);
        win.setFocusable(false);
        const bounds = win.getBounds();
        win.setBounds({ x: -10000, y: 0, width: preserveSize ? Math.max(bounds.width, 1440) : 1440, height: preserveSize ? Math.max(bounds.height, 900) : 900 });
        return win.getBounds();
    }, { url: page.url(), preserveSize });
}

function stopPackagedTest(executable) {
    const target = path.resolve(executable), root = path.resolve('D:/Quarantine/AnnotationCapture') + path.sep;
    if (!target.toLowerCase().startsWith(root.toLowerCase()) || path.basename(target) !== 'AnnotationCapture.exe') throw new Error('Refusing to stop an application outside test quarantine');
    execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "Name = \'AnnotationCapture.exe\'" | Where-Object { $_.ExecutablePath -eq $env:ANNOTATION_TEST_EXE } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }'], { env: { ...process.env, ANNOTATION_TEST_EXE: target }, windowsHide: true, timeout: 30000 });
}

module.exports = { isolateWindow, prepareProfile, stopPackagedTest };
