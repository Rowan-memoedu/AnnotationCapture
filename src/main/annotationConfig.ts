import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { app, safeStorage } from "electron";
import type { ConfigInput, PublicConfig } from "../../lib/annotation";

type StoredConfig = {
    archiveRoot: string;
    shortcut: string;
    model: string;
    encryptedKey?: string;
};

export class AnnotationConfig {
    private config: StoredConfig;
    private file: string;
    constructor(dataRoot: string, archiveRoot: string) {
        this.file = join(dataRoot, "annotation-settings.json");
        this.config = {
            archiveRoot,
            shortcut: "Control+Alt+S",
            model: "deepseek-flash",
        };
        if (existsSync(this.file)) {
            this.config = {
                ...this.config,
                ...JSON.parse(readFileSync(this.file, "utf8")),
            };
        }
    }
    key(): string {
        if (this.config.encryptedKey)
            return safeStorage.decryptString(
                Buffer.from(this.config.encryptedKey, "base64"),
            );
        return (
            process.env.ANNOTATION_DEEPSEEK_API_KEY ||
            process.env.DEEPSEEK_API_KEY ||
            ""
        );
    }
    public(): PublicConfig {
        const keySource = this.config.encryptedKey
            ? "saved"
            : this.key()
              ? "environment"
              : "none";
        return {
            archiveRoot: this.config.archiveRoot,
            shortcut: this.config.shortcut,
            model: this.config.model,
            hasKey: keySource !== "none",
            keySource,
            version: app.getVersion(),
        };
    }
    save(input: ConfigInput): PublicConfig {
        if (!isAbsolute(input.archiveRoot) || !input.archiveRoot.trim())
            throw new Error("归档目录必须是绝对路径");
        if (!input.model.trim() || input.model.length > 100)
            throw new Error("模型名称无效");
        const next: StoredConfig = {
            ...this.config,
            archiveRoot: input.archiveRoot,
            shortcut: input.shortcut,
            model: input.model.trim(),
        };
        if (input.clearKey) delete next.encryptedKey;
        if (input.apiKey?.trim()) {
            if (!safeStorage.isEncryptionAvailable())
                throw new Error("系统凭据加密不可用，无法保存密钥");
            next.encryptedKey = safeStorage
                .encryptString(input.apiKey.trim())
                .toString("base64");
        }
        mkdirSync(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.tmp`;
        writeFileSync(temporary, JSON.stringify(next, null, 2));
        renameSync(temporary, this.file);
        this.config = next;
        return this.public();
    }
}
