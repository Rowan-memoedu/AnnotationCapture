import { join } from "node:path";
import { BrowserWindow, session } from "electron";
import type { FormulaFont } from "../../lib/annotation";

export function validateTypeset(
    latex: string,
    font: FormulaFont,
    color: string,
) {
    if (typeof latex !== "string" || !latex.trim() || latex.length > 4000)
        throw new Error("公式须为 1 到 4000 字符");
    if (!["stix2", "newcm"].includes(font) || !/^#[a-f0-9]{6}$/i.test(color))
        throw new Error("公式字体或颜色无效");
    // No user-defined expansion, package loading, URLs, HTML or embedded resources.
    if (
        /\\(?:def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|require|href|url|html\w*|style|class|cssId|includegraphics|unicode)\b/i.test(
            latex,
        )
    )
        throw new Error("公式包含不支持的命令");
}

/** Local renderer with bounded lifetime; it cannot access the network or Node. */
export class FormulaTypesetter {
    private queue: Promise<unknown> = Promise.resolve();
    private windows = new Map<FormulaFont, BrowserWindow>();
    render(latex: string, font: FormulaFont, color: string): Promise<string> {
        validateTypeset(latex, font, color);
        const task = this.queue
            .catch(() => {})
            .then(() => this.convert(latex, font, color));
        this.queue = task;
        return task;
    }
    private async convert(
        latex: string,
        font: FormulaFont,
        color: string,
    ): Promise<string> {
        let win = this.windows.get(font);
        if (win?.isDestroyed()) win = undefined;
        if (!win) {
            const isolated = session.fromPartition(`typeset-${font}`);
            isolated.webRequest.onBeforeRequest((details, done) =>
                done({ cancel: !details.url.startsWith("file://") }),
            );
            isolated.setPermissionRequestHandler((_wc, _permission, done) =>
                done(false),
            );
            win = new BrowserWindow({
                show: false,
                webPreferences: {
                    sandbox: true,
                    contextIsolation: true,
                    nodeIntegration: false,
                    backgroundThrottling: false,
                    session: isolated,
                },
            });
            win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
            this.windows.set(font, win);
        }
        const worker = win;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                (async () => {
                    if (!worker.webContents.getURL())
                        await worker.loadFile(
                            join(__dirname, "../renderer/mathjax/index.html"),
                            { query: { font } },
                        );
                    return (await worker.webContents.executeJavaScript(
                        `window.renderFormula(${JSON.stringify(latex)},${JSON.stringify(color)})`,
                    )) as string;
                })(),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => {
                        worker.destroy();
                        this.windows.delete(font);
                        reject(new Error("公式排版超时，原笔迹已保留"));
                    }, 12_000);
                }),
            ]);
        } catch (error) {
            if (!worker.isDestroyed()) worker.destroy();
            this.windows.delete(font);
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}
