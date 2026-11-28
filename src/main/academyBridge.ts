import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AcademyAnswer, AcademyContext } from "../../lib/annotation";

const hostName = "edu.memo.annotationcapture.mathacademy";
const origin = "chrome-extension://gdejildelbenfhefjohighebigmnmame/";
const limit = 128 * 1024;
export type AcademyTarget = { peer: Socket; token: string; context: AcademyContext };

export class AcademyBridge {
    private server = createServer((socket) => this.attach(socket));
    private peers = new Set<Socket>();
    private requests = new Map<string, { peer: Socket; finish: (result: unknown, error?: string) => void }>();
    private problem = "";
    async start(exe: string, data: string, register: boolean) {
        try {
            if (!existsSync(exe)) throw Error("找不到 Math Academy 浏览器连接程序");
            const identity = ((process.env.USERDOMAIN || "") + "\\" + userInfo().username + "|" + resolve(exe)).toLowerCase();
            const pipe = "\\\\.\\pipe\\AnnotationCapture.MathAcademy." + createHash("sha256").update(identity).digest("hex").slice(0,32);
            await new Promise<void>((ok, fail) => {
                this.server.once("error", fail);
                this.server.listen(pipe, () => { this.server.removeListener("error", fail); ok(); });
            });
            this.server.on("error", (error) => { this.problem = error.message; });
            if (register) {
                const manifest = join(data, "math-academy-host.json");
                writeFileSync(manifest, JSON.stringify({name: hostName, description: "AnnotationCapture Math Academy", path: resolve(exe), type: "stdio", allowed_origins: [origin]}));
                await promisify(execFile)("reg.exe", ["ADD", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + hostName, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"], {windowsHide: true});
            }
        } catch (error) { this.problem = "Math Academy 浏览器连接初始化失败：" + String(error); }
    }
    close() {
        for (const socket of this.peers) socket.destroy();
        if (this.server.listening) this.server.close();
    }
    private attach(socket: Socket) {
        this.peers.add(socket);
        let buffer: Buffer = Buffer.alloc(0);
        socket.on("error", () => socket.destroy());
        socket.on("close", () => {
            this.peers.delete(socket);
            for (const req of this.requests.values())
                if (req.peer === socket) req.finish(null, "Chrome 已断开连接，请重新进入批注");
        });
        socket.on("data", (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 4) {
                const length = buffer.readUInt32LE(0);
                if (!length || length > limit) { socket.destroy(); return; }
                if (buffer.length < length + 4) return;
                try {
                    const reply = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
                    const request = this.requests.get(reply.id);
                    if (request?.peer === socket) request.finish(reply.result, typeof reply.error === "string" ? reply.error : undefined);
                } catch { socket.destroy(); return; }
                buffer = buffer.subarray(length + 4);
            }
        });
    }
    private send<T>(peer: Socket, message: object, ms: number): Promise<T> {
        return new Promise((ok, fail) => {
            const id = randomUUID();
            const finish = (result: unknown, error?: string) => {
                clearTimeout(timer);
                this.requests.delete(id);
                if (error) fail(Error(error)); else ok(result as T);
            };
            const timer = setTimeout(() => finish(null, "Chrome 读取题目超时，请重新进入批注"), ms);
            this.requests.set(id, {peer, finish});
            const body = Buffer.from(JSON.stringify({id, ...message}), "utf8");
            const header = Buffer.alloc(4);
            header.writeUInt32LE(body.length);
            if (peer.destroyed) finish(null, "原题所在的 Chrome 已断开连接");
            else peer.write(Buffer.concat([header, body]), error => { if (error) finish(null, "无法连接原题所在的 Chrome"); });
        });
    }
    async bind(point: {x: number; y: number}): Promise<AcademyTarget> {
        if (!this.peers.size) throw Error(this.problem || "请启用 AnnotationCapture 的 Chrome 扩展，将 Math Academy 题目置于前台，再开始批注");
        const responses = await Promise.allSettled([...this.peers].map(async peer => {
            const r = await this.send<Omit<AcademyTarget, "peer">>(peer, {action: "bind", point}, 1400);
            if (typeof r?.token !== "string" || typeof r.context?.question !== "string" || !Array.isArray(r.context.fields))
                throw Error("网页控件未完成加载");
            return {peer, token: r.token, context: r.context};
        }));
        const ready = responses.flatMap(r => r.status === "fulfilled" ? [r.value] : []);
        if (!ready.length && responses[0].status === "rejected") throw responses[0].reason;
        if (ready.length !== 1) throw Error("无法确定唯一的 Math Academy 活动题目");
        return ready[0];
    }
    async fill(target: AcademyTarget, answers: AcademyAnswer[]) {
        const result = await this.send<{filled: number}>(target.peer, {action: "fill", token: target.token, answers}, 6500);
        if (!result || result.filled !== answers.length) throw Error("网页回读的答题框数量不一致");
        return result.filled;
    }
}
