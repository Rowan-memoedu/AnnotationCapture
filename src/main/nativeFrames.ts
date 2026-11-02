import { spawn } from "node:child_process";
import type { PixelRect } from "../../lib/annotation";

// A warm helper waits on stdin. No desktop pixels are read before a capture is requested.
export function prepareFrameReader(executable: string) {
    const child = spawn(executable, [], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
    });
    let maxBytes = 0,
        total = 0;
    const chunks: Buffer[] = [];
    const result = new Promise<Buffer | null>((resolve) => {
        child.on("error", () => resolve(null));
        child.stdin.on("error", () => resolve(null));
        child.stdout.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) child.kill();
            else chunks.push(chunk);
        });
        child.on("close", (code) =>
            resolve(
                code === 0 && total > 0 && total <= maxBytes
                    ? Buffer.concat(chunks, total)
                    : null,
            ),
        );
    });
    return {
        stop: () => child.kill(),
        read: async (rect: PixelRect) => {
            // Incompressible frames can be slightly larger than their pixel buffer.
            maxBytes = Math.ceil(rect.width * rect.height * 4 * 1.01) + 1024;
            const timeout = setTimeout(() => child.kill(), 3500);
            try {
                child.stdin.end(
                    `${[rect.x, rect.y, rect.width, rect.height].join(" ")}\n`,
                );
                const bytes = await result;
                if (!bytes)
                    throw new Error("Native screen capture unavailable");
                return bytes;
            } finally {
                clearTimeout(timeout);
            }
        },
    };
}
