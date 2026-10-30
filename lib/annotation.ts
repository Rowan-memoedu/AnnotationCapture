export type PixelRect = { x: number; y: number; width: number; height: number };
export type CaptureMode = "region" | "full" | "ocr";
export type FormulaFont = "stix2" | "newcm";
export type LassoRule = "intersect" | "contain";
export const outputFormats = [
    "auto",
    "text",
    "markdownText",
    "inlineMath",
    "latex",
    "mathAcademy",
    "markdown",
    "mermaid",
] as const;
export type OutputFormat = (typeof outputFormats)[number];
export const outputFormatLabels = {
    auto: "自动判断（公式用 $）",
    text: "普通文字",
    markdownText: "Markdown 文字",
    inlineMath: "公式（$…$）",
    latex: "原始 LaTeX",
    mathAcademy: "Math Academy 公式",
    markdown: "Markdown 公式（RemNote / Obsidian）",
    mermaid: "Mermaid 图",
};
export type CaptureInput = {
    id: string;
    capturedAt: string;
    png: string;
    rect: PixelRect;
    screenId: number;
    annotations?: object;
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
    outputIssue?: string;
    outputFormat?: OutputFormat;
    detectedType?: "text" | "markdown" | "mermaid" | "formula";
    message: string;
    model?: string;
    durationMs?: number;
};
export type PublicConfig = {
    archiveRoot: string;
    shortcut: string;
    fullShortcut: string;
    ocrShortcut: string;
    penColor: string;
    penWidth: number;
    showMagnifier: boolean;
    outputFormat: OutputFormat;
    formulaFont: FormulaFont;
    lassoRule: LassoRule;
    version: string;
};
export type LoginSession = { token: string; accountId: string; label: string };
export type LoginState = {
    loggedIn: boolean;
    verified: boolean;
    label: string;
    providerReady: boolean;
    message: string;
};
export type ConfigInput = {
    archiveRoot: string;
    shortcut: string;
    fullShortcut: string;
    ocrShortcut?: string;
    penColor?: string;
    penWidth?: number;
    showMagnifier?: boolean;
    outputFormat?: OutputFormat;
    formulaFont?: FormulaFont;
    lassoRule?: LassoRule;
};
export type AppState = {
    update: UpdateState;
    config: PublicConfig;
    login: LoginState;
    jobs: FormulaResult[];
    shortcutError: string;
};
export type UpdateState = {
    enabled: boolean;
    phase:
        | "idle"
        | "checking"
        | "current"
        | "downloading"
        | "ready"
        | "installing"
        | "error";
    message: string;
    lastCheckedAt?: string;
    version?: string;
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
    checkUpdates: () => UpdateState;
    installUpdate: () => UpdateState;
    setAutoUpdate: (enabled: boolean) => UpdateState;
    inkRecognize: (id: string, png: string) => { latex: string; model: string };
    inkCancel: (id: string) => void;
    typeset: (latex: string, font: FormulaFont, color: string) => string;
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
        outputFormat?: OutputFormat;
    }) => FormulaResult;
    state: () => AppState;
    configure: (config: ConfigInput) => PublicConfig;
    copy: (id: string, text: string) => FormulaResult;
    retry: (id: string) => FormulaResult;
    openArchive: () => void;
    capture: (mode?: CaptureMode) => void;
    login: (inviteCode: string) => LoginState;
    logout: () => LoginState;
    refreshLogin: () => LoginState;
    openPanel: () => void;
    quit: () => void;
    chooseArchive: () => string | null;
};
