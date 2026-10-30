import { normalizeLatex } from "./formulaProvider";

const symbols = new Set(
    (
        "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega " +
        "Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega " +
        "sin cos tan sec csc cot sinh cosh tanh ln log exp lim " +
        "arcsin arccos arctan sum prod int infty pi cdot times div pm mp le leq ge geq ne neq lt gt approx equiv to rightarrow " +
        "in notin subset supset subseteq supseteq cup cap emptyset land lor neg partial nabla degree"
    ).split(" "),
);
const wrappers = new Set(["mathrm", "mathbf", "text", "operatorname"]);

function unsupported(detail: string): never {
    throw new Error(
        `Math Academy 暂不支持此公式：${detail}。原始 LaTeX 已保留，请修改后重试或使用原始 LaTeX 输出`,
    );
}

/** Only remove presentation commands; never simplify or drop mathematical structure. */
export function mathAcademyOutput(source: string): string {
    const value = normalizeLatex(source)
        .replace(/\\(?:display|text|script|scriptscript)style\b/g, " ")
        .replace(
            /\\(?:quad|qquad|enspace|thinspace|medspace|thickspace)\b|\\[,!;: ]/g,
            " ",
        )
        .replace(/\\[dt]frac\b/g, "\\frac")
        .replace(/−/g, "-")
        .replace(/[×÷±≤≥≠π∞]/g, (symbol) => {
            const names: Record<string, string> = {
                "×": "times",
                "÷": "div",
                "±": "pm",
                "≤": "leq",
                "≥": "geq",
                "≠": "neq",
                π: "pi",
                "∞": "infty",
            };
            return `\\${names[symbol]} `;
        })
        .replace(/\s+/g, " ")
        .replace(/ ([\^_])/g, "$1")
        .trim();
    const tokens = value.match(/\\[A-Za-z]+|\\.|[^\s]/g) ?? [];
    let index = 0;
    let depth = 0;

    function delimiter() {
        const token = tokens[index++];
        if (
            !token ||
            !["(", ")", "[", "]", "|", ".", "\\{", "\\}"].includes(token)
        )
            unsupported("括号格式");
    }
    function atom() {
        const token = tokens[index++];
        if (!token) unsupported("缺少公式内容或参数");
        if (token === "{") {
            sequence("}");
        } else if (token === "\\left") {
            delimiter();
            sequence("\\right");
            delimiter();
        } else if (token === "\\frac" || token === "\\binom") {
            atom();
            atom();
        } else if (token === "\\sqrt") {
            if (tokens[index] === "[") {
                index++;
                sequence("]");
            }
            atom();
        } else if (wrappers.has(token.slice(1)) && token.startsWith("\\")) {
            if (tokens[index++] !== "{") unsupported(`${token} 缺少花括号`);
            sequence("}");
        } else if (token.startsWith("\\")) {
            if (
                !symbols.has(token.slice(1)) &&
                !["\\{", "\\}", "\\%"].includes(token)
            )
                unsupported(token);
        } else if (!/^[A-Za-z0-9.+\-*/=(),[\]|!:<>'%]$/.test(token)) {
            unsupported(token);
        }
        return !/^[+\-*/=,:<>]$/.test(token);
    }
    function sequence(end?: string) {
        if (++depth > 64) unsupported("嵌套层数过多");
        const start = index;
        while (index < tokens.length && tokens[index] !== end) {
            const base = atom();
            const scripts = new Set<string>();
            while (tokens[index] === "^" || tokens[index] === "_") {
                const script = tokens[index++];
                if (!base) unsupported("上下标缺少主体");
                if (scripts.has(script)) unsupported("同一位置的重复上下标");
                scripts.add(script);
                atom();
            }
        }
        if (index === start) unsupported("空参数");
        if (end && tokens[index++] !== end) unsupported("括号或参数未闭合");
        depth--;
    }
    sequence();
    return value;
}
