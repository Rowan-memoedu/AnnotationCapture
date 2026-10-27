import type { AnnotationMessages } from "./annotation";

const { ipcRenderer, ipcMain } =
    require("electron") as typeof import("electron");

export function invoke<K extends keyof AnnotationMessages>(
    key: K,
    ...args: Parameters<AnnotationMessages[K]>
): Promise<ReturnType<AnnotationMessages[K]>> {
    return ipcRenderer.invoke(`annotation:${key}`, ...args);
}

export function handle<K extends keyof AnnotationMessages>(
    key: K,
    callback: (
        ...args: Parameters<AnnotationMessages[K]>
    ) =>
        | ReturnType<AnnotationMessages[K]>
        | Promise<ReturnType<AnnotationMessages[K]>>,
) {
    ipcMain.handle(`annotation:${key}`, (event, ...args) => {
        const url = event.sender.getURL();
        if (!url.startsWith("file://") && !url.startsWith("http://localhost:"))
            throw new Error("Unsupported sender");
        return callback(...(args as Parameters<AnnotationMessages[K]>));
    });
}
