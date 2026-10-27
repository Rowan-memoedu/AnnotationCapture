import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

export default defineConfig({
    main: {
        build: {
            minify: false,
            rollupOptions: {
                input: {
                    main: resolve(__dirname, "src/main/annotationMain.ts"),
                },
            },
        },
    },
    renderer: {
        build: {
            minify: false,
            sourcemap: false,
            rollupOptions: {
                input: {
                    capture: resolve(__dirname, "src/renderer/capture.html"),
                    annotation: resolve(
                        __dirname,
                        "src/renderer/annotation.html",
                    ),
                },
            },
        },
        define: { "process.platform": "process.platform" },
    },
});
