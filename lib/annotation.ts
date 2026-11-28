import type { WhiteboardSettings } from "./whiteboard";
export type PixelRect = { x: number; y: number; width: number; height: number };
export type ScreenFrame = {
    id: number;
    bounds: PixelRect;
    scaleFactor: number;
    pointer?: { x: number; y: number };
} & ({ rgba: Uint8Array; width: number; height: number } | { png: string });
export type CaptureMode = "region" | "full" | "ocr";
export type AcademyContext = {
    question: string;
    fields: {
        id: string;
        format: "latex" | "text" | "choice";
        current: string;
        options?: string[];
    }[];
};
export type AcademyAnswer = { id: string; value: string };
export type AcademyFieldBox = PixelRect & { id: string };
export type FormulaFont = "stix2" | "newcm";
export type LassoRule = "intersect" | "contain";
export const outputFormats = [
    "auto",
    "text",
    "markdownText",
    "inlineMath",
    "calculator",
    "calculatorCas",
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
    calculator: "Calculator",
    calculatorCas: "Calculator（含 CAS）",
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
export const ocrProviders = ["openai", "deepseek"] as const;
export type OcrProvider = (typeof ocrProviders)[number];
export type PublicConfig = {
    whiteboard: WhiteboardSettings;
    archiveRoot: string;
    shortcut: string;
    fullShortcut: string;
    ocrShortcut: string;
    penColor: string;
    penWidth: number;
    pressureEnabled: boolean;
    pressureSensitivity: number;
    scribbleEnabled: boolean;
    showMagnifier: boolean;
    outputFormat: OutputFormat;
    ocrProvider?: OcrProvider;
    formulaFont: FormulaFont;
    lassoRule: LassoRule;
    archiveRetentionDays: number;
    version: string;
};
export type LoginSession = { token: string; accountId: string; label: string };
export type LoginState = {
    loggedIn: boolean;
    verified: boolean;
    label: string;
    providerReady: boolean;
    ocrProviders?: OcrProvider[];
    message: string;
};
export type ConfigInput = {
    whiteboard?: Partial<WhiteboardSettings>;
    archiveRoot: string;
    shortcut: string;
    fullShortcut: string;
    ocrShortcut?: string;
    penColor?: string;
    penWidth?: number;
    pressureEnabled?: boolean;
    pressureSensitivity?: number;
    scribbleEnabled?: boolean;
    showMagnifier?: boolean;
    outputFormat?: OutputFormat;
    ocrProvider?: OcrProvider;
    formulaFont?: FormulaFont;
    lassoRule?: LassoRule;
    archiveRetentionDays?: number;
};
export type AppState = {
    startup: StartupState;
    update: UpdateState;
    archiveCleanup: string;
    config: PublicConfig;
    login: LoginState;
    jobs: FormulaResult[];
    shortcutError: string;
};
export type StartupState = {
    supported: boolean;
    enabled: boolean;
    busy: boolean;
    method: "task" | "run" | "unavailable";
    message: string;
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

export function inkBounds(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
): PixelRect | null {
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < height; y++) {
        const row = y * width * 4 + 3;
        let first = 0;
        while (first < width && pixels[row + first * 4] <= 8) first++;
        if (first === width) continue;
        let last = width - 1;
        while (last > first && pixels[row + last * 4] <= 8) last--;
        left = Math.min(left, first);
        right = Math.max(right, last);
        top = Math.min(top, y);
        bottom = y;
    }
    if (right < left) return null;
    return {
        x: left,
        y: top,
        width: right - left + 1,
        height: bottom - top + 1,
    };
}

export type AnnotationMessages = {
    academyTarget: () => string;
    academyLayout: () => AcademyFieldBox[];
    academyFill: (png: string, byPosition?: boolean) => number;
    academyRetryAvailable: () => void;
    openAcademyExtension: () => void;
    setAutoStart: (enabled: boolean) => StartupState;
    detectWhitespace: (
        png: string,
    ) => import("./whiteboard").WhiteboardDetection;
    captureVisibility: (visible: boolean) => void;
    captureConfig: () => PublicConfig;
    checkUpdates: () => UpdateState;
    installUpdate: () => UpdateState;
    setAutoUpdate: (enabled: boolean) => UpdateState;
    inkRecognize: (id: string, png: string) => { latex: string; model: string };
    inkCancel: (id: string) => void;
    typeset: (latex: string, font: FormulaFont, color: string) => string;
    screenshots: () => ScreenFrame[];
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
