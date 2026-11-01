import { createHash } from "node:crypto";
import type { LoginSession, LoginState } from "../../lib/annotation";
import {
    type WhiteboardDetection,
    type WhiteboardSettings,
    whiteboardRects,
} from "../../lib/whiteboard";
import type { AnnotationConfig } from "./annotationConfig";
import { type FormulaProvider, normalizeOutput } from "./formulaProvider";

export const serviceUrl =
    process.env.ANNOTATION_SERVICE_URL ||
    "https://124.221.144.155/annotationcapture/api";

type SessionStore = Pick<
    AnnotationConfig,
    "session" | "saveSession" | "clearSession"
>;

export class AnnotationAuth {
    private state: LoginState;
    private loginRevision = 0;
    private whitespaceCache = new Map<
        string,
        { expires: number; result: Promise<WhiteboardDetection> }
    >();
    constructor(
        private config: SessionStore,
        private changed: () => void,
        private baseUrl = serviceUrl,
        private request: typeof fetch = fetch,
    ) {
        const session = config.session();
        this.state = {
            loggedIn: !!session,
            verified: false,
            label: session?.label || "",
            providerReady: false,
            message: session
                ? "正在验证登录状态…"
                : "填写邀请码登录后即可识别公式",
        };
        const url = new URL(baseUrl);
        if (
            url.protocol !== "https:" &&
            !(
                url.protocol === "http:" &&
                ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
            )
        )
            throw new Error("登录服务必须使用 HTTPS");
    }
    public(): LoginState {
        return { ...this.state };
    }
    async login(inviteCode: string) {
        const revision = ++this.loginRevision;
        if (
            typeof inviteCode !== "string" ||
            !inviteCode.trim() ||
            inviteCode.length > 256
        )
            throw new Error("请填写有效邀请码");
        const response = await this.request(`${this.baseUrl}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ inviteCode: inviteCode.trim() }),
            signal: AbortSignal.timeout(15000),
            redirect: "error",
        });
        if (!response.ok)
            throw new Error(
                response.status === 401
                    ? "邀请码无效或已停用"
                    : response.status === 429
                      ? "登录尝试过于频繁，请稍后重试"
                      : "登录服务暂时不可用",
            );
        const value = (await response.json()) as LoginSession & {
            providerReady?: boolean;
        };
        if (
            !value ||
            !/^[A-Za-z0-9_-]{32,256}$/.test(value.token) ||
            typeof value.accountId !== "string" ||
            typeof value.label !== "string" ||
            value.label.length > 100
        )
            throw new Error("登录服务返回无效数据");
        if (revision !== this.loginRevision)
            throw new Error("登录状态已变化，请重新登录");
        this.config.saveSession({
            token: value.token,
            accountId: value.accountId,
            label: value.label,
        });
        this.state = {
            loggedIn: true,
            verified: true,
            label: value.label,
            providerReady: value.providerReady === true,
            message: value.providerReady
                ? "已登录，识别服务可用"
                : "已登录，统一 API 待配置",
        };
        this.changed();
        return this.public();
    }
    logout() {
        this.loginRevision++;
        this.config.clearSession();
        this.state = {
            loggedIn: false,
            verified: false,
            label: "",
            providerReady: false,
            message: "已退出登录；截图和归档仍可使用",
        };
        this.changed();
        return this.public();
    }
    async refresh() {
        const session = this.config.session();
        if (!session) return this.public();
        try {
            const response = await this.request(`${this.baseUrl}/session`, {
                headers: { Authorization: `Bearer ${session.token}` },
                signal: AbortSignal.timeout(15000),
                redirect: "error",
            });
            if (this.config.session()?.token !== session.token)
                return this.public();
            if (response.status === 401 || response.status === 403) {
                this.logout();
                this.state.message = "登录已失效，请重新填写邀请码";
            } else if (response.ok) {
                const value = (await response.json()) as {
                    label: string;
                    providerReady: boolean;
                };
                if (this.config.session()?.token !== session.token)
                    return this.public();
                this.state = {
                    loggedIn: true,
                    verified: true,
                    label: session.label,
                    providerReady: value.providerReady === true,
                    message: value.providerReady
                        ? "已登录，识别服务可用"
                        : "已登录，统一 API 待配置",
                };
            } else
                this.state = {
                    ...this.state,
                    verified: false,
                    message: "暂时连接不到服务，已保留本机登录状态",
                };
        } catch {
            if (this.config.session()?.token === session.token)
                this.state = {
                    ...this.state,
                    verified: false,
                    message: "暂时连接不到服务，已保留本机登录状态",
                };
        }
        this.changed();
        return this.public();
    }
    async detectWhitespace(
        png: string,
        options: WhiteboardSettings,
        signal: AbortSignal,
    ) {
        const session = this.config.session();
        if (!session) throw new Error("请先使用邀请码登录");
        signal.throwIfAborted();
        const key = createHash("sha256")
            .update(session.token)
            .update(JSON.stringify(options))
            .update(png)
            .digest("hex");
        for (const [id, entry] of this.whitespaceCache) {
            if (entry.expires <= Date.now()) this.whitespaceCache.delete(id);
        }
        let entry = this.whitespaceCache.get(key);
        if (!entry) {
            while (this.whitespaceCache.size >= 8)
                this.whitespaceCache.delete(
                    this.whitespaceCache.keys().next().value!,
                );
            const result = this.request(`${this.baseUrl}/whitespace`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${session.token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ png, options }),
                signal: AbortSignal.timeout(12_000),
                redirect: "error",
            }).then(async (response) => {
                if (!response.ok)
                    throw new Error(
                        `空白区域识别暂时不可用（HTTP ${response.status}），将使用中央白板`,
                    );
                const value = (await response.json()) as WhiteboardDetection;
                if (this.config.session()?.token !== session.token)
                    throw new Error("登录状态已变化");
                whiteboardRects(value.rects, options.maxRects, 10000, 10000);
                if (value.unprotected)
                    whiteboardRects(value.unprotected, 20, 10000, 10000);
                if (value.protected !== undefined)
                    whiteboardRects(value.protected, 32, 10000, 10000, 0);
                if (value.contentRegions !== undefined)
                    whiteboardRects(value.contentRegions, 64, 10000, 10000, 0);
                if (value.solid !== undefined)
                    whiteboardRects(value.solid, 32, 10000, 10000, 0);
                return value;
            });
            entry = { expires: Date.now() + 60_000, result };
            this.whitespaceCache.set(key, entry);
            void result.catch(() => {
                this.whitespaceCache.delete(key);
            });
        }
        // Leaving a capture cancels its listener, while the bounded request can
        // finish once and serve an immediate return to the same page.
        return new Promise<WhiteboardDetection>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            entry.result.then(
                (value) => {
                    signal.removeEventListener("abort", abort);
                    if (this.config.session()?.token !== session.token)
                        reject(new Error("登录状态已变化"));
                    else resolve(value);
                },
                (error) => {
                    signal.removeEventListener("abort", abort);
                    reject(error);
                },
            );
        });
    }
    provider(): FormulaProvider | null {
        if (!this.config.session()) return null;
        return {
            recognize: async (png, signal, outputFormat = "latex") => {
                const session = this.config.session();
                if (!session) throw new Error("请先使用邀请码登录");
                const response = await this.request(
                    `${this.baseUrl}/recognize`,
                    {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${session.token}`,
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify(
                            outputFormat === "latex"
                                ? { png }
                                : { png, outputFormat },
                        ),
                        signal,
                        redirect: "error",
                    },
                );
                if (this.config.session()?.token !== session.token)
                    throw new Error("登录状态已变化，请重新识别");
                if (response.status === 401 || response.status === 403) {
                    this.logout();
                    throw new Error("登录已失效，请重新填写邀请码");
                }
                if (!response.ok)
                    throw new Error(
                        response.status === 503
                            ? "统一 API 尚未配置或暂时不可用，公式图已保存"
                            : response.status === 429
                              ? "识别请求过于频繁，请稍后重试"
                              : response.status === 400
                                ? "未能读取选区或输出格式，请重新框选后重试"
                                : response.status === 504
                                  ? "识别服务超时，可重试"
                                  : "识别服务调用失败，可重试",
                    );
                const value = (await response.json()) as {
                    latex: string;
                    model: string;
                    detectedType?: import("./formulaProvider").Recognition["detectedType"];
                };
                if (this.config.session()?.token !== session.token)
                    throw new Error("登录状态已变化，请重新识别");
                if (
                    !value ||
                    typeof value.latex !== "string" ||
                    typeof value.model !== "string"
                )
                    throw new Error("识别服务返回无效数据");
                this.state = {
                    ...this.state,
                    verified: true,
                    providerReady: true,
                    message: "已登录，识别服务可用",
                };
                this.changed();
                return {
                    latex: normalizeOutput(
                        value.latex,
                        outputFormat,
                        value.detectedType,
                    ),
                    model: value.model,
                    ...(value.detectedType
                        ? { detectedType: value.detectedType }
                        : {}),
                };
            },
        };
    }
}
