import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { prepareFrameReader } from "../../src/main/nativeFrames";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => vi.useRealTimers());

it("allows the first frame to start slowly and discards a stalled warm reader", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
        stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
        stdout: new EventEmitter(),
        kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    const reader = prepareFrameReader("ScreenFrame.exe");
    const rect = { x: 0, y: 0, width: 1, height: 1 };
    const firstFrame = reader.read(rect);
    const pixel = Buffer.from([1, 2, 3, 255]);
    await vi.advanceTimersByTimeAsync(500);
    child.stdout.emit("data", pixel);
    await expect(firstFrame).resolves.toEqual(pixel);

    const stalledFrame = expect(reader.read(rect)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(350);
    await stalledFrame;
    expect(reader.available).toBe(false);
    expect(child.kill).toHaveBeenCalledOnce();
});
