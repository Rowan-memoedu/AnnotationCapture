import { defineConfig } from "vitest/config";
export default defineConfig({
    test: { include: ["tests/annotation/**/*.test.ts"], environment: "node" },
});
