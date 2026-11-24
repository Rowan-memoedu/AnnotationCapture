import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
    root: resolve(__dirname, "src/renderer"),
    base: "./",
    build: {
        outDir: resolve(
            process.env.ANNOTATION_WHITEBOARD_OUTPUT ||
                "D:/Artifacts/AnnotationCapture/whiteboard-v3",
        ),
        emptyOutDir: false,
        rollupOptions: {
            input: resolve(__dirname, "src/renderer/whiteboard.html"),
        },
    },
});
