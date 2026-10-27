import type { LoginSession, LoginState } from "../../lib/annotation";
import type { AnnotationConfig } from "./annotationConfig";
import { type FormulaProvider, normalizeLatex } from "./formulaProvider";

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
    provider(): FormulaProvider | null {
        if (!this.config.session()) return null;
        return {
            recognize: async (png, signal) => {
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
                        body: JSON.stringify({ png }),
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
                                ? "公式图片无效，请重新框选"
                                : response.status === 504
                                  ? "识别服务超时，可重试"
                                  : "识别服务调用失败，可重试",
                    );
                const value = (await response.json()) as {
                    latex: string;
                    model: string;
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
                    latex: normalizeLatex(value.latex),
                    model: value.model,
                };
            },
        };
    }
}
