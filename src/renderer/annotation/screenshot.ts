import type { Display } from "electron";
import type { ScreenFrame } from "../../../lib/annotation";
import { invoke } from "../../../lib/annotationIpc";

const { nativeImage } = require("electron") as typeof import("electron");
const { inflateRawSync } = require("node:zlib") as typeof import("node:zlib");

function framePixels(shot: Extract<ScreenFrame, { deflatedRgba: Uint8Array }>) {
    const expected = shot.width * shot.height * 4;
    const raw = inflateRawSync(shot.deflatedRgba, {
        maxOutputLength: expected,
    });
    if (raw.length !== expected) throw new Error("Incomplete screen frame");
    return new ImageData(
        new Uint8ClampedArray(
            raw.buffer as ArrayBuffer,
            raw.byteOffset,
            expected,
        ),
        shot.width,
        shot.height,
    );
}

function pixels(image: Electron.NativeImage) {
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    const rgba = new Uint8ClampedArray(bitmap.length);
    for (let i = 0; i < bitmap.length; i += 4) {
        rgba[i] = bitmap[i + 2];
        rgba[i + 1] = bitmap[i + 1];
        rgba[i + 2] = bitmap[i];
        rgba[i + 3] = bitmap[i + 3];
    }
    return new ImageData(rgba, width, height);
}

export default function init() {
    return async (_displays?: Display[], buffer?: Buffer) => {
        const file =
            buffer && nativeImage.createFromBuffer(Buffer.from(buffer));
        const shots: ScreenFrame[] = file
            ? [
                  {
                      id: -1,
                      bounds: { x: 0, y: 0, ...file.getSize() },
                      scaleFactor: 1,
                      png: "",
                  },
              ]
            : await invoke("screenshots");
        return {
            type: buffer ? "img" : "normal",
            window: [] as {
                rect: { x: number; y: number; w: number; h: number };
            }[],
            screen: shots.map((shot) => {
                return {
                    id: shot.id,
                    pointer: shot.pointer,
                    bounds: shot.bounds,
                    size: {
                        width: shot.bounds.width,
                        height: shot.bounds.height,
                    },
                    scaleFactor: shot.scaleFactor,
                    capture: async () => ({
                        toImageData: () =>
                            "deflatedRgba" in shot
                                ? framePixels(shot)
                                : pixels(
                                      file ||
                                          nativeImage.createFromDataURL(
                                              shot.png,
                                          ),
                                  ),
                    }),
                };
            }),
        };
    };
}
