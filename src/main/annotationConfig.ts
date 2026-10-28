import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { app, safeStorage } from "electron";
import type {
    ConfigInput,
    FormulaFont,
    LassoRule,
    LoginSession,
    PublicConfig,
} from "../../lib/annotation";
import { type OutputFormat, outputFormats } from "../../lib/annotation";

type StoredConfig = {
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
    encryptedSession?: string;
};

export class AnnotationConfig {
    private config: StoredConfig;
    private file: string;
    constructor(dataRoot: string, archiveRoot: string) {
        this.file = join(dataRoot, "annotation-settings.json");
        this.config = {
            archiveRoot,
            shortcut: "Control+Alt+S",
            fullShortcut: "Alt+W",
            ocrShortcut: "Control+Alt+O",
            penColor: "#ff0000",
            penWidth: 2,
            showMagnifier: false,
            outputFormat: "latex",
            formulaFont: "stix2",
            lassoRule: "intersect",
        };
        if (existsSync(this.file)) {
            this.config = {
                ...this.config,
                ...JSON.parse(readFileSync(this.file, "utf8")),
            };
        }
    }
    session(): LoginSession | null {
        if (!this.config.encryptedSession) return null;
        try {
            const value = JSON.parse(
                safeStorage.decryptString(
                    Buffer.from(this.config.encryptedSession, "base64"),
                ),
            );
            if (
                typeof value.token !== "string" ||
                typeof value.accountId !== "string" ||
                typeof value.label !== "string"
            )
                return null;
            return value;
        } catch {
            return null;
        }
    }
    public(): PublicConfig {
        return {
            archiveRoot: this.config.archiveRoot,
            shortcut: this.config.shortcut,
            fullShortcut: this.config.fullShortcut,
            ocrShortcut: this.config.ocrShortcut,
            penColor: this.config.penColor,
            penWidth: this.config.penWidth,
            showMagnifier: this.config.showMagnifier,
            outputFormat: this.config.outputFormat,
            formulaFont: this.config.formulaFont,
            lassoRule: this.config.lassoRule,
            version: app.getVersion(),
        };
    }
    save(input: ConfigInput): PublicConfig {
        if (
            input.lassoRule !== undefined &&
            !["intersect", "contain"].includes(input.lassoRule)
        )
            throw new Error("自由圈选规则无效");
        if (
            input.formulaFont !== undefined &&
            !["stix2", "newcm"].includes(input.formulaFont)
        )
            throw new Error("公式字体无效");
        if (!isAbsolute(input.archiveRoot) || !input.archiveRoot.trim())
            throw new Error("归档目录必须是绝对路径");
        if (
            ![
                input.shortcut,
                input.fullShortcut,
                input.ocrShortcut ?? this.config.ocrShortcut,
            ].every((key) => typeof key === "string" && key.length <= 80)
        )
            throw new Error("快捷键无效");
        if (
            input.penColor !== undefined &&
            !/^#[0-9a-f]{6}$/i.test(input.penColor)
        )
            throw new Error("画笔颜色无效");
        if (
            input.showMagnifier !== undefined &&
            typeof input.showMagnifier !== "boolean"
        )
            throw new Error("放大框设置无效");
        if (
            input.outputFormat !== undefined &&
            !outputFormats.includes(input.outputFormat)
        )
            throw new Error("识别输出格式无效");
        if (
            input.penWidth !== undefined &&
            (!Number.isInteger(input.penWidth) ||
                input.penWidth < 1 ||
                input.penWidth > 50)
        )
            throw new Error("画笔粗细须为 1 到 50");
        const next: StoredConfig = {
            ...this.config,
            archiveRoot: input.archiveRoot,
            shortcut: input.shortcut,
            fullShortcut: input.fullShortcut,
            ocrShortcut: input.ocrShortcut ?? this.config.ocrShortcut,
            penColor: input.penColor ?? this.config.penColor,
            penWidth: input.penWidth ?? this.config.penWidth,
            showMagnifier: input.showMagnifier ?? this.config.showMagnifier,
            outputFormat: input.outputFormat ?? this.config.outputFormat,
            formulaFont: input.formulaFont ?? this.config.formulaFont,
            lassoRule: input.lassoRule ?? this.config.lassoRule,
        };
        this.persist(next);
        return this.public();
    }
    saveSession(session: LoginSession) {
        if (!safeStorage.isEncryptionAvailable())
            throw new Error("系统凭据加密不可用，无法保存登录状态");
        this.persist({
            ...this.config,
            encryptedSession: safeStorage
                .encryptString(JSON.stringify(session))
                .toString("base64"),
        });
    }
    clearSession() {
        const next = { ...this.config };
        delete next.encryptedSession;
        this.persist(next);
    }
    private persist(next: StoredConfig) {
        mkdirSync(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.tmp`;
        writeFileSync(temporary, JSON.stringify(next, null, 2));
        renameSync(temporary, this.file);
        this.config = next;
    }
}
