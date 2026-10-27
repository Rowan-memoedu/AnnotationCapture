async function isolateWindow(app, page) {
    return app.evaluate(({ BrowserWindow }, url) => {
        const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url);
        if (!win) throw new Error('Acceptance window was not found');
        win.webContents.setBackgroundThrottling(false);
        win.setAlwaysOnTop(false);
        win.setFocusable(false);
        win.setBounds({ x: -10000, y: 0, width: 1440, height: 900 });
        return win.getBounds();
    }, page.url());
}

module.exports = { isolateWindow };
