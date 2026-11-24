import { spawn } from "node:child_process";
import type { PixelRect } from "../../lib/annotation";

// Only one fixed-size reply can be in flight. Discard a failed pipe so its
// remaining bytes cannot be mistaken for a later reply.
function prepareNativeReader(executable: string, args: string[]) {
    const child = spawn(executable, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
    });
    let available = true;
    let pending:
        | {
              frame: Buffer;
              received: number;
              resolve: (frame: Buffer) => void;
              reject: (error: Error) => void;
              timeout: NodeJS.Timeout;
          }
        | undefined;

    function stop() {
        if (!available) return;
        available = false;
        child.kill();
        if (pending) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("Native helper unavailable"));
            pending = undefined;
        }
    }
    child.on("error", stop);
    child.on("exit", stop);
    child.stdin.on("error", stop);
    child.stdout.on("error", stop);
    child.stdout.on("data", (chunk: Buffer) => {
        if (
            !pending ||
            chunk.length > pending.frame.length - pending.received
        ) {
            stop();
            return;
        }
        chunk.copy(pending.frame, pending.received);
        pending.received += chunk.length;
        if (pending.received === pending.frame.length) {
            clearTimeout(pending.timeout);
            const { frame, resolve } = pending;
            pending = undefined;
            resolve(frame);
        }
    });
    return {
        get available() {
            return available;
        },
        stop,
        read(command: string, bytes: number, timeout: number) {
            if (!available || pending)
                return Promise.reject(new Error("Native helper is not ready"));
            const frame = Buffer.allocUnsafe(bytes);
            return new Promise<Buffer>((resolve, reject) => {
                pending = {
                    frame,
                    received: 0,
                    resolve,
                    reject,
                    timeout: setTimeout(stop, timeout),
                };
                child.stdin.write(`${command}\n`);
            });
        },
    };
}

export function prepareFrameReader(executable: string) {
    const reader = prepareNativeReader(executable, []);
    return {
        get available() {
            return reader.available;
        },
        stop: reader.stop,
        read({ x, y, width, height }: PixelRect) {
            return reader.read(
                [x, y, width, height].join(" "),
                width * height * 4,
                350,
            );
        },
    };
}

export function prepareClipboardReader(executable: string) {
    const reader = prepareNativeReader(executable, ["--clipboard-sequences"]);
    return {
        get available() {
            return reader.available;
        },
        stop: reader.stop,
        async read() {
            const sequence = (
                await reader.read("sequence", 4, 450)
            ).readUInt32LE();
            if (!sequence) throw new Error("无法读取剪贴板状态");
            return String(sequence);
        },
    };
}
