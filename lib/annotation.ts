export type PixelRect = { x: number; y: number; width: number; height: number };
export type CaptureInput = {
    id: string;
    capturedAt: string;
    png: string;
    rect: PixelRect;
    screenId: number;
};
export type ArchiveRecord = {
    id: string;
    capturedAt: string;
    path: string;
    sha256: string;
    rect: PixelRect;
    screenId: number;
};
export type FormulaState =
    | "unconfigured"
    | "recognizing"
    | "ready"
    | "copied"
    | "review"
    | "error";
export type FormulaResult = {
    id: string;
    archiveId: string;
    path: string;
    rect: PixelRect;
    status: FormulaState;
    latex: string;
    recognizedLatex?: string;
    message: string;
    model?: string;
    durationMs?: number;
};
export type PublicConfig = {
    archiveRoot: string;
    shortcut: string;
    model: string;
    hasKey: boolean;
    keySource: "saved" | "environment" | "none";
    version: string;
};
export type ConfigInput = {
    archiveRoot: string;
    shortcut: string;
    model: string;
    apiKey?: string;
    clearKey?: boolean;
};
export type AppState = {
    config: PublicConfig;
    jobs: FormulaResult[];
    shortcutError: string;
};

export function selectedRect(
    a: { x: number; y: number },
    b: { x: number; y: number },
    width: number,
    height: number,
): PixelRect {
    const x = Math.max(0, Math.floor(Math.min(a.x, b.x)));
    const y = Math.max(0, Math.floor(Math.min(a.y, b.y)));
    const right = Math.min(width, Math.ceil(Math.max(a.x, b.x)));
    const bottom = Math.min(height, Math.ceil(Math.max(a.y, b.y)));
    return {
        x,
        y,
        width: Math.max(0, right - x),
        height: Math.max(0, bottom - y),
    };
}

export type AnnotationMessages = {
    screenshots: () => {
        id: number;
        png: string;
        bounds: PixelRect;
        scaleFactor: number;
    }[];
    archive: (input: CaptureInput) => ArchiveRecord;
    formula: (input: {
        archiveId: string;
        png: string;
        rect: PixelRect;
    }) => FormulaResult;
    state: () => AppState;
    configure: (config: ConfigInput) => PublicConfig;
    copy: (id: string, text: string) => FormulaResult;
    retry: (id: string) => FormulaResult;
    openArchive: () => void;
    capture: () => void;
    openPanel: () => void;
    chooseArchive: () => string | null;
};
