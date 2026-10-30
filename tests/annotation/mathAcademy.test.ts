import { describe, expect, it } from "vitest";
import { mathAcademyOutput } from "../../src/main/mathAcademy";

describe("Math Academy paste output", () => {
    it.each([
        ["$$\\displaystyle \\dfrac{X+x}{2}$$", "\\frac{X+x}{2}"],
        ["\\int_0^1 x^2\\,dx", "\\int_0^1 x^2 dx"],
        ["\\sin\\!x+\\pi\\quad r", "\\sin x+\\pi r"],
        ["x ^ {n+1}+a _ {i}", "x^ {n+1}+a_ {i}"],
        ["x−1≤2π", "x-1\\leq 2\\pi"],
    ])("adapts presentation without changing symbols: %s", (source, output) => {
        expect(mathAcademyOutput(source)).toBe(output);
    });
    it.each([
        "\\frac{x^2+1}{\\sqrt{y}}",
        "\\sqrt[3]{x^2}+\\alpha_1",
        "\\sum_{i=1}^{n}i^2",
        "\\prod_{i=1}^n a_i",
        "\\binom{n}{k}",
        "\\operatorname{sin}\\left(x\\right)",
        "\\left|x-1\\right|",
        "\\lim_{x\\to0}\\frac{\\sin x}{x}",
        "\\mathrm{e}^{x}+\\mathbf{x}",
        "\\frac{1}{\\frac{1}{x}+\\sqrt[3]{y}}",
    ])("keeps supported structure: %s", (source) => {
        expect(mathAcademyOutput(source)).toBe(source);
    });
    it.each([
        "\\begin{aligned}x&=1\\\\y&=2\\end{aligned}",
        "\\begin{pmatrix}1&2\\end{pmatrix}",
        "\\mathbb{R}",
        "\\unknown{x}",
        "x\\\\y",
        "x&y",
        "x$y",
        "\\frac{x}",
        "\\frac{}{y}",
        "x^{2",
        "x}",
        "\\sqrt[3{x}",
        "\\left(x+1",
        "\\right)",
        "x^",
        "^2",
        "x^2^3",
        "x+^2",
        "\\displaystyle",
        "UNREADABLE",
        "\\text{a\\unknown b}",
    ])("rejects lossy or incomplete expressions: %s", (source) => {
        expect(() => mathAcademyOutput(source)).toThrow();
    });
    it("is idempotent for a manually copied result", () => {
        const result = mathAcademyOutput("\\displaystyle \\dfrac{X}{2}\\,x");
        expect(mathAcademyOutput(result)).toBe(result);
    });
});
