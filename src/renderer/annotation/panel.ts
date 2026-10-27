import { button, ele, input, p, textarea, view } from "dkh-ui";
import type { AppState, FormulaResult } from "../../../lib/annotation";
import { invoke } from "../../../lib/annotationIpc";
import store from "../../../lib/store/renderStore";
import { t } from "../../../lib/translate/translate";
import { initStyle } from "../root/root";
import { annotationStyles } from "./styles";

const { ipcRenderer } = require("electron") as typeof import("electron");
initStyle(store);
annotationStyles();
document.body.style.overflow = "auto";
const root = view("y")
    .style({
        maxWidth: "760px",
        margin: "auto",
        padding: "28px",
        gap: "24px",
        color: "var(--font-color)",
    })
    .addInto();
const notice = p()
    .class("ac-status")
    .attr({ id: "ac-panel-status", role: "status", ariaLive: "polite" });
const resultList = view("y").style({ gap: "16px" }).attr({ id: "ac-results" });
const archivePath = input()
    .class("ac-field")
    .attr({ id: "ac-archive-root", ariaLabel: t("归档位置") });
const shortcut = input()
    .class("ac-field")
    .attr({ id: "ac-shortcut", ariaLabel: t("截图快捷键") });
const fullShortcut = input()
    .class("ac-field")
    .attr({ id: "ac-full-shortcut", ariaLabel: t("全屏批注快捷键") });
const inviteCode = input("password")
    .class("ac-field")
    .attr({
        id: "ac-invite-code",
        placeholder: "AC-…",
        autocomplete: "off",
        ariaLabel: t("邀请码"),
        ariaRequired: "true",
    });
inviteCode.el.setAttribute("aria-describedby", "ac-login-status");
const loginStatus = p().attr({
    id: "ac-login-status",
    role: "status",
    ariaLive: "polite",
});
const accountLabel = p().attr({ id: "ac-account-label" });
const summary = p().class("ac-status");
function action(label: string, id: string, fn: () => Promise<unknown>) {
    const b = button(t(label))
        .class("ac-button")
        .attr({ id })
        .on("click", async () => {
            b.el.disabled = true;
            b.el.setAttribute("aria-busy", "true");
            notice.el.classList.remove("ac-error");
            notice.el.textContent = "";
            try {
                await fn();
            } catch (error) {
                notice.el.textContent = String(error);
                notice.class("ac-error");
            } finally {
                b.el.disabled = false;
                b.el.setAttribute("aria-busy", "false");
            }
        });
    return b;
}
const loginButton = action("登录", "ac-login", async () => {
    loginStatus.el.textContent = t("正在登录…");
    loginStatus.el.classList.remove("ac-error");
    inviteCode.el.setAttribute("aria-invalid", "false");
    inviteCode.el.disabled = true;
    try {
        await invoke("login", inviteCode.el.value);
        inviteCode.el.value = "";
        await refresh();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        loginStatus.el.textContent = message
            .replace(/^Error invoking remote method '[^']+': /, "")
            .replace(/^Error: /, "");
        loginStatus.class("ac-error");
        inviteCode.el.setAttribute("aria-invalid", "true");
    } finally {
        inviteCode.el.disabled = false;
    }
});
inviteCode.on("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        loginButton.el.click();
    }
});
const loginForm = view("y")
    .style({ gap: "12px" })
    .add([p(t("邀请码")), inviteCode, loginButton]);
const accountActions = view("x")
    .style({ gap: "12px" })
    .add([
        action("重新连接", "ac-refresh-login", async () => {
            await invoke("refreshLogin");
            await refresh();
        }),
        action("退出登录", "ac-logout", async () => {
            await invoke("logout");
            await refresh();
        }),
    ]);
root.add([
    view("y")
        .style({ gap: "12px" })
        .add([
            ele("h1")
                .style({ fontSize: "26px", fontWeight: "600" })
                .add("AnnotationCapture"),
            summary,
            view("x")
                .style({ gap: "12px" })
                .add([
                    action("区域截图", "ac-start", () =>
                        invoke("capture", "region"),
                    ).class("ac-primary"),
                    action("全屏批注", "ac-start-full", () =>
                        invoke("capture", "full"),
                    ),
                    action("打开归档目录", "ac-open-archive", () =>
                        invoke("openArchive"),
                    ),
                ]),
        ]),
    notice,
    view()
        .class("ac-card")
        .attr({ id: "ac-login-card" })
        .add([
            ele("h2").add(t("邀请码登录")),
            accountLabel,
            loginStatus,
            loginForm,
            accountActions,
            p(
                t(
                    "本机登录一次后会保留登录状态。登录后使用统一识别服务，无需填写 API。",
                ),
            ),
        ]),
    view("y")
        .style({ gap: "12px" })
        .add([
            ele("h2").add(t("公式识别结果")),
            p(t("请核对字母大小写和上下标；可修改结果后重新复制。")),
            resultList,
        ]),
    view()
        .class("ac-card")
        .add([
            ele("h2").add(t("设置")),
            p(t("归档位置")),
            archivePath,
            action("选择目录", "ac-choose-directory", async () => {
                const path = await invoke("chooseArchive");
                if (path) archivePath.el.value = path;
            }),
            p(t("区域截图快捷键")),
            shortcut,
            p(t("全屏批注快捷键")),
            fullShortcut,
            p(
                t(
                    "仅主动选择识别时发送公式笔迹图。完整截图保存在本机，登录凭据由 Windows 加密保存。",
                ),
            ),
            view("x")
                .style({ gap: "12px" })
                .add([
                    action("保存设置", "ac-save-settings", async () => {
                        await invoke("configure", {
                            archiveRoot: archivePath.el.value,
                            shortcut: shortcut.el.value,
                            fullShortcut: fullShortcut.el.value,
                        });
                        await refresh(true);
                        notice.el.textContent = t("设置已保存");
                    }),
                ]),
        ]),
    p(
        t(
            "基于 eSearch 15.6.1 · GPL-3.0。公式以 LaTeX 文本复制；Math Academy 输入适配尚未加入。",
        ),
    ),
]);
let previousResults = "";
function resultCard(result: FormulaResult) {
    const output = textarea()
        .class("ac-field")
        .attr({
            id: `result-${result.id}`,
            ariaLabel: t("公式 LaTeX"),
            rows: 3,
        });
    output.el.value = result.latex;
    const preview = ele("img")
        .attr({
            src: `file:///${result.path.replaceAll("\\", "/")}`,
            alt: t("提交识别的纯笔迹选区"),
        })
        .style({
            maxWidth: "100%",
            maxHeight: "200px",
            objectFit: "contain",
            background: "white",
            alignSelf: "flex-start",
        });
    return view()
        .class("ac-card")
        .data({ "job-id": result.id, status: result.status })
        .add([
            preview,
            p(result.message).class(
                result.status === "error"
                    ? "ac-error"
                    : result.status === "copied"
                      ? "ac-success"
                      : "ac-status",
            ),
            result.latex ? output : p(t("识别结果将在这里显示")),
            view("x")
                .style({ gap: "12px" })
                .add([
                    action("复制公式", `copy-${result.id}`, () =>
                        invoke("copy", result.id, output.el.value),
                    ).attr({
                        disabled:
                            !result.latex || result.status === "recognizing",
                    }),
                    action("重新识别", `retry-${result.id}`, () =>
                        invoke("retry", result.id),
                    ).attr({ disabled: result.status === "recognizing" }),
                ]),
            result.model
                ? p(
                      `${result.model} · ${((result.durationMs ?? 0) / 1000).toFixed(1)} s`,
                  )
                : "",
        ]);
}
async function refresh(settings = false) {
    const state: AppState = await invoke("state");
    if (settings) {
        archivePath.el.value = state.config.archiveRoot;
        shortcut.el.value = state.config.shortcut;
        fullShortcut.el.value = state.config.fullShortcut;
        summary.el.textContent = `${state.config.fullShortcut || t("点击按钮开始")} ${t("全屏批注")} · ${state.config.shortcut || t("点击按钮开始")} ${t("区域截图")} · ${t("Esc / Ctrl+Enter 归档退出；Ctrl+Shift+Enter 选择公式")}`;
        if (state.shortcutError) notice.el.textContent = state.shortcutError;
    }
    loginStatus.el.textContent = state.login.message;
    accountLabel.el.textContent = state.login.loggedIn
        ? `${t("已登录：")}${state.login.label}`
        : t("未登录；仍可截图、批注和归档");
    loginForm.el.style.display = state.login.loggedIn ? "none" : "flex";
    accountActions.el.style.display = state.login.loggedIn ? "flex" : "none";
    const signature = JSON.stringify(state.jobs);
    if (signature !== previousResults) {
        previousResults = signature;
        resultList
            .clear()
            .add(
                state.jobs.length
                    ? state.jobs.map(resultCard)
                    : p(t("完成批注后选择公式，识别结果会在这里显示。")),
            );
    }
}
ipcRenderer.on("annotation:changed", () => {
    void refresh();
});
void refresh(true);
