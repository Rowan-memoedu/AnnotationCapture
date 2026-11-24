import { join } from "node:path";
import { pathToFileURL } from "node:url";

type SharedCalculator = {
    warmCalculator: (module: string) => Promise<unknown>;
    calculateSelectedFormula: (input: {
        expression: string;
        cas: boolean;
    }) => Promise<{ text: string }>;
};

async function calculatorEngine() {
    const directory =
        process.env.ANNOTATION_CALCULATOR_ROOT ||
        join(process.resourcesPath, "calculator");
    const entry = pathToFileURL(join(directory, "calculator-engine.js")).href;
    return (await import(/* @vite-ignore */ entry)) as SharedCalculator;
}

export async function warmWhiteboardCalculator(cas: boolean) {
    await (await calculatorEngine()).warmCalculator(
        cas ? "symbolic" : "expression",
    );
}

export async function calculateWhiteboardFormula(
    expression: string,
    cas: boolean,
) {
    try {
        const engine = await calculatorEngine();
        return (await engine.calculateSelectedFormula({ expression, cas }))
            .text;
    } catch {
        throw new Error(
            cas
                ? "未能计算或化简，请检查选区和识别公式"
                : "未能数值计算，可调整选区或选择含 CAS 的格式",
        );
    }
}
