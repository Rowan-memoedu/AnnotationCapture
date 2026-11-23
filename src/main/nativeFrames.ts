import { spawn } from "node:child_process";
import type { PixelRect } from "../../lib/annotation";

// Each request returns exactly width × height × 4 bytes. Only one frame can be
// in flight per reader. A failed reader is discarded so framing cannot drift.
export function prepareFrameReader(executable: string) {
    const child = spawn(executable, [], {
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
            pending.reject(new Error("Native screen capture unavailable"));
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
        read(rect: PixelRect) {
            if (!available || pending)
                return Promise.reject(
                    new Error("Native screen reader is not ready"),
                );
            const { x, y, width, height } = rect;
            const frame = Buffer.allocUnsafe(width * height * 4);
            return new Promise<Buffer>((resolve, reject) => {
                pending = {
                    frame,
                    received: 0,
                    resolve,
                    reject,
                    timeout: setTimeout(stop, 350),
                };
                child.stdin.write(`${x} ${y} ${width} ${height}\n`);
            });
        },
    };
}
