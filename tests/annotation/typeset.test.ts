import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {}, session: {} }));

import { validateTypeset } from "../../src/main/formulaTypeset";

describe("local formula renderer boundary", () => {
    it("allows ordinary mathematics and both bundled fonts", () => {
        for (const font of ["stix2", "newcm"] as const)
            expect(() =>
                validateTypeset("\\frac{X+x}{2}+\\sqrt{a_1}", font, "#a0B100"),
            ).not.toThrow();
    });
    it("rejects external resources, macro expansion and invalid settings", () => {
        for (const source of [
            "\\require{html}",
            "\\href{https://example.com}{x}",
            "\\def\\x{\\x}\\x",
            "\\includegraphics{file}",
            "\\newcommand{\\a}{x}",
            "x".repeat(4001),
            "",
        ])
            expect(() => validateTypeset(source, "stix2", "#ff0000")).toThrow();
        expect(() =>
            validateTypeset("x", "other" as "stix2", "#ff0000"),
        ).toThrow();
        expect(() => validateTypeset("x", "stix2", "url(file)")).toThrow();
    });
});
