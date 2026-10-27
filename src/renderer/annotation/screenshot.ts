import type { Display } from "electron";
import { invoke } from "../../../lib/annotationIpc";

const { nativeImage } = require("electron") as typeof import("electron");

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
        const shots = buffer
            ? [
                  {
                      id: -1,
                      png: nativeImage
                          .createFromBuffer(Buffer.from(buffer))
                          .toDataURL(),
                      bounds: { x: 0, y: 0, width: 0, height: 0 },
                      scaleFactor: 1,
                  },
              ]
            : await invoke("screenshots");
        return {
            type: buffer ? "img" : "normal",
            window: [] as {
                rect: { x: number; y: number; w: number; h: number };
            }[],
            screen: shots.map((shot) => {
                const image = nativeImage.createFromDataURL(shot.png);
                const size = image.getSize();
                return {
                    id: shot.id,
                    bounds: buffer ? { x: 0, y: 0, ...size } : shot.bounds,
                    size: buffer
                        ? size
                        : {
                              width: shot.bounds.width,
                              height: shot.bounds.height,
                          },
                    scaleFactor: shot.scaleFactor,
                    capture: async () => ({
                        toImageData: () => pixels(image),
                        toNativeImage: () => image,
                    }),
                };
            }),
        };
    };
}
