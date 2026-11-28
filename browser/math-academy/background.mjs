import { academyQuestion } from "./question.mjs";

const sites = ["https://mathacademy.com/*", "https://www.mathacademy.com/*"];
let port;
let binding;

async function activeTab() {
    const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true, url: sites});
    return tab;
}

async function execute(message) {
    const tab = await activeTab();
    if (!tab) throw Error("当前 Chrome 标签页没有 Math Academy 题目");
    if (message.action === "bind") {
        binding = undefined;
        const win = await chrome.windows.get(tab.windowId);
        const p = message.point;
        if (!win.focused || (p && (p.x < win.left || p.y < win.top || p.x >= win.left + win.width || p.y >= win.top + win.height)))
            throw Error("请将 Math Academy 题目置于当前屏幕，再开始批注");
        const [frame] = await chrome.scripting.executeScript({target: {tabId: tab.id}, world: "MAIN", func: academyQuestion, args: []});
        if (!frame?.result?.snapshot) throw Error(frame?.result?.error || "当前题目未提供可填写的控件");
        binding = {token: crypto.randomUUID(), tabId: tab.id, windowId: tab.windowId, documentId: frame.documentId, snapshot: frame.result.snapshot};
        return {token: binding.token, context: binding.snapshot.context};
    }
    if (message.action !== "fill" || !binding || message.token !== binding.token || tab.id !== binding.tabId || tab.windowId !== binding.windowId)
        throw Error("题目或标签页已切换，请重新进入批注");
    const target = {tabId: tab.id, documentIds: [binding.documentId]};
    const [frame] = await chrome.scripting.executeScript({target, world: "MAIN", func: academyQuestion, args: [binding.snapshot, message.answers]});
    if (!frame?.result?.filled) throw Error(frame?.result?.error || "未能回读网页中的答案");
    return frame.result;
}

async function connect() {
    if (port || !(await activeTab()) || port) return;
    const channel = chrome.runtime.connectNative("edu.memo.annotationcapture.mathacademy");
    port = channel;
    channel.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (port === channel) {port = undefined; binding = undefined;}
    });
    channel.onMessage.addListener(async message => {
        if (!message || typeof message.id !== "string") return;
        let response;
        try { response = {id: message.id, result: await execute(message)}; }
        catch (error) { response = {id: message.id, error: String(error.message).slice(0, 300)}; }
        if (port === channel) channel.postMessage(response);
    });
}

const wake = () => { void connect().catch(() => {}); };
chrome.tabs.onActivated.addListener(wake);
chrome.tabs.onUpdated.addListener((_id, change) => { if (change.status === "complete") wake(); });
chrome.windows.onFocusChanged.addListener(id => { if (id !== chrome.windows.WINDOW_ID_NONE) wake(); });
chrome.alarms.onAlarm.addListener(wake);
chrome.runtime.onInstalled.addListener(() => {chrome.alarms.create("reconnect", {periodInMinutes: 1}); wake();});
chrome.runtime.onStartup.addListener(() => {chrome.alarms.create("reconnect", {periodInMinutes: 1}); wake();});
wake();
