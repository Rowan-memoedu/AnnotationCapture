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
    LoginSession,
    PublicConfig,
} from "../../lib/annotation";

type StoredConfig = {
    archiveRoot: string;
    shortcut: string;
    fullShortcut: string;
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
            version: app.getVersion(),
        };
    }
    save(input: ConfigInput): PublicConfig {
        if (!isAbsolute(input.archiveRoot) || !input.archiveRoot.trim())
            throw new Error("归档目录必须是绝对路径");
        if (
            ![input.shortcut, input.fullShortcut].every(
                (key) => typeof key === "string" && key.length <= 80,
            )
        )
            throw new Error("快捷键无效");
        const next: StoredConfig = {
            ...this.config,
            archiveRoot: input.archiveRoot,
            shortcut: input.shortcut,
            fullShortcut: input.fullShortcut,
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
