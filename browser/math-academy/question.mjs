// chrome.scripting runs this function in the bound Lesson or Review document.
export async function academyQuestion(expected = null, answers = []) {
    try {
        const lessonPage =
            typeof studentLesson === "undefined"
                ? window.studentLesson
                : studentLesson;
        const reviewPage =
            typeof studentReview === "undefined"
                ? window.studentReview
                : studentReview;
        const multistep = location.pathname.includes("/multisteps/")
            ? window.studentMultistep
            : undefined;
        const activity = multistep ?? (location.pathname.endsWith("/review")
            ? reviewPage
            : lessonPage ?? reviewPage);
        const step = activity?.step;
        const questionId = multistep ? step?.number : step?.id;
        const root = step && document.getElementById('step-' + questionId);
        const part = multistep && step?.question;
        const widget = part?.format === "FR" && Array.isArray(part.freeResponseEditors)
            ? {
                get answerSubmitted() { return Boolean(part.answer); },
                submitButton: root?.querySelector(".submitButton"),
                getStudentAnswer: () => ({freeResponseAnswers: multistep.getFreeResponseAnswers(part)}),
            }
            : step?.questionWidget;
        if (
            !root ||
            !widget?.getStudentAnswer ||
            !widget.submitButton ||
            widget.answerSubmitted
        )
            throw Error("当前没有待作答的 Math Academy 题目");
        const visible = (el) =>
            el.isConnected &&
            el.getClientRects().length > 0 &&
            getComputedStyle(el).visibility !== "hidden";
        if (!visible(root)) throw Error("当前题目未显示");
        const answer = () => widget.getStudentAnswer();
        const pending = answer();
        const MQ = window.MathQuill?.getInterface(2);
        const controls = [];
        const marks = new Map();
        function add(el, format, read, write, options) {
            const id = `s${controls.length + 1}`;
            controls.push({ id, format, read, write, options, el });
            marks.set(el, `[[${id}]]`);
        }
        const choice = root.querySelector(".questionWidget-choicesTable");
        if (Array.isArray(pending.freeResponseAnswers)) {
            const nodes = root.querySelectorAll(
                '.mq-editable-field, input:not([type]), input[type="text"], input[type="number"], textarea',
            );
            for (const el of nodes) {
                if (
                    !visible(el) ||
                    el.closest(".mq-textarea,.mq-editable-field") !==
                        (el.matches(".mq-editable-field") ? el : null)
                )
                    continue;
                if (el.matches(".mq-editable-field")) {
                    const field = MQ?.(el);
                    if (!field?.latex) throw Error("公式框未完成加载");
                    const editor = part?.freeResponseEditors?.[controls.length];
                    if (part && editor?.mathField?.el() !== el)
                        throw Error("多步骤题的输入框与当前步骤不一致");
                    add(
                        el,
                        "latex",
                        () => field.latex(),
                        (v) => {
                            if (editor) {
                                editor.setLatex(v);
                                editor.checkForChange();
                            } else field.latex(v);
                        },
                    );
                } else if (!el.disabled && !el.readOnly) {
                    add(
                        el,
                        "text",
                        () => el.value,
                        (v) => {
                            el.value = v;
                            el.dispatchEvent(
                                new Event("input", { bubbles: true }),
                            );
                            el.dispatchEvent(
                                new Event("change", { bubbles: true }),
                            );
                        },
                    );
                }
            }
            if (
                pending.freeResponseAnswers.length > controls.length ||
                controls.some(
                    (c, i) =>
                        (part ? part.freeResponseEditors[i].getLatex(true) : c.read()) !==
                        String(pending.freeResponseAnswers[i] ?? ""),
                )
            )
                throw Error("网页当前答案与可见控件不一致，请稍后重试");
        } else if (choice && "selectedChoice" in pending) {
            const letters = new Map();
            for (const el of choice.querySelectorAll(
                ".questionWidget-choiceLetterCircle",
            )) {
                const letter = el.id.split("-").pop();
                if (
                    !visible(el) ||
                    !/^[a-z]$/i.test(letter) ||
                    letters.has(letter)
                )
                    throw Error("选项标识不明确");
                letters.set(letter, el);
            }
            if (letters.size < 2) throw Error("选择题未完成加载");
            const responses = new Map();
            for (const letter of letters.keys()) {
                const code = typeof widget.getSelectedChoice === "function"
                    ? widget.getSelectedChoice(letter)
                    : letter;
                const key = String(code ?? "").toLowerCase();
                if (!key || responses.has(key))
                    throw Error("选项与网页答案无法对应");
                responses.set(key, letter);
            }
            add(
                choice,
                "choice",
                () => {
                    const value = answer().selectedChoice;
                    if (value == null || value === "") return "";
                    const letter = responses.get(String(value).toLowerCase());
                    if (!letter) throw Error("网页返回了未知的选项");
                    return letter;
                },
                (v) => letters.get(v).click(),
                [...letters.keys()],
            );
        }
        if (!controls.length || controls.length > 48)
            throw Error("当前控件尚不支持自动填写");
        function render(node) {
            if (node.nodeType === Node.TEXT_NODE)
                return node.nodeValue.replace(/\s+/g, " ");
            if (node.nodeType !== Node.ELEMENT_NODE) return "";
            const el = node;
            if (
                el.hidden ||
                el.matches(
                    "script,style,button,.stepHeader,.submitButtonFrame,.questionWidget-header,.questionWidget-buttonBar,.questionWidget-spinnerFrame,[aria-hidden=true]:not(mjx-container)",
                )
            )
                return "";
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden")
                return "";
            const mark = marks.get(el);
            if (mark && el !== choice) return ` ${mark} `;
            if (el.localName === "mjx-container") {
                const item =
                    window.MathJax?.startup?.document?.getMathItemsWithin?.([
                        el,
                    ])?.[0];
                const tex = item?.math || el.getAttribute("aria-label");
                const mathml = el.querySelector("math");
                if (!tex && !mathml)
                    throw Error("网页公式尚未加载完成，请稍后重试");
                return (
                    " " +
                    (tex
                        ? `$${tex}$`
                        : mathml.outerHTML.replace(/ [\w:-]+="[^"]*"/g, "")) +
                    " "
                );
            }
            if (el.matches("img")) return ` ${el.alt || el.title || "[图像]"} `;
            if (el.matches("br")) return "\n";
            const body = [...el.childNodes].map(render).join("");
            if (el.matches("td,th")) {
                const span =
                    (el.rowSpan > 1 ? ` rowspan=${el.rowSpan}` : "") +
                    (el.colSpan > 1 ? ` colspan=${el.colSpan}` : "");
                return `<cell${span}>${body.trim()}</cell>`;
            }
            if (el.matches("tr")) return `\n<row>${body.trim()}</row>\n`;
            if (el.matches("sup,sub"))
                return `${(el.matches("sup") ? "^{" : "_{") + body}}`;
            if (el.matches("div,p,table,li")) return `\n${mark || ""}${body}\n`;
            return body;
        }
        const intro = part && document.getElementById("step-1");
        const common = intro && intro !== root && !intro.querySelector(".question,.questionWidget") ? render(intro) : "";
        const question = (common + "\n" + render(root))
            .replace(/[ \t]+/g, " ")
            .replace(/ *\n */g, "\n")
            .replace(/\n+/g, "\n")
            .trim();
        const fields = controls.map(({ id, format, read, options }) => ({
            id,
            format,
            current: read(),
            ...(options ? { options } : {}),
        }));
        if (
            !question ||
            question.length > 16000 ||
            !fields.every((f) => question.includes(`[[${f.id}]]`))
        )
            throw Error("题干或控件布局未能完整读取");
        const snapshot = {
            step: part ? String(questionId) + "/" + part.id : String(questionId),
            context: { question, fields },
        };
        if (!expected) {
            if (fields.every((f) => f.current))
                throw Error("这道题的答题框已经填好");
            const empty = controls.filter(c => c.format !== "choice" && !c.read());
            if (empty.length > 1) {
                const boxes = empty.map(c => c.el.getBoundingClientRect());
                const left = Math.min(...boxes.map(b => b.left));
                const top = Math.min(...boxes.map(b => b.top));
                const span = Math.max(...boxes.map(b => b.right - left), ...boxes.map(b => b.bottom - top));
                if (span > 0) {
                    const positions = boxes.map((b,i) => [
                        empty[i].id,
                        Math.round(1000 * (b.left + b.width / 2 - left) / span),
                        Math.round(1000 * (b.top + b.height / 2 - top) / span),
                    ]);
                    const layout = "\nVisible empty control centers [id,x,y], measured right and down at a common scale: " + JSON.stringify(positions) +
                        ". Separate handwritten entries may be written directly at these positions. Match their relative positions to the controls. A complete handwritten expression can also be mapped using the template.";
                    if (question.length + layout.length <= 16000) return {snapshot, fillContext: {question: question + layout, fields}};
                }
            }
            return { snapshot };
        }
        const prior = expected.context;
        if (
            snapshot.step !== expected.step ||
            question !== prior.question ||
            fields.length !== prior.fields.length ||
            fields.some((f, i) => {
                const old = prior.fields[i];
                return (
                    old.id !== f.id ||
                    old.current !== f.current ||
                    old.format !== f.format ||
                    String(old.options) !== String(f.options)
                );
            })
        )
            throw Error("题目、控件或已有答案发生了变化，请重新进入批注");
        const blank = controls.filter((c) => !c.read());
        if (
            !Array.isArray(answers) ||
            !blank.length ||
            blank.length !== answers.length
        )
            throw Error("待填答案不完整");
        const planned = new Map();
        const canonical = (v) =>
            v
                .replace(/\\(?:left|right)\s*(?=[()[\]|.\\])/g, "")
                .replace(/\s+/g, "")
                .replace(/([\^_])\{([0-9A-Za-z])\}/g, "$1$2");
        for (const entry of answers) {
            const c = blank.find((f) => f.id === entry?.id);
            const v = entry?.value;
            if (
                !c ||
                planned.has(c) ||
                typeof v !== "string" ||
                !v.trim() ||
                v.length > 2048 ||
                Array.from(v).some((char) => char.charCodeAt(0) < 32)
            )
                throw Error("识别结果的控件标识或内容无效");
            let value = v;
            if (c.format === "choice" && !c.options.includes(v))
                throw Error("识别结果没有对应选项");
            if (c.format === "latex") {
                const probe = MQ.MathField(document.createElement("span"));
                try {
                    probe.latex(v);
                    value = probe.latex();
                } finally {
                    probe.revert();
                }
                if (!value || canonical(value) !== canonical(v))
                    throw Error(`网页公式框无法完整保留 ${c.id} 的表达式`);
            }
            planned.set(c, value);
        }
        const written = [];
        try {
            for (const [c, value] of planned) {
                c.write(value);
                written.push([c, value]);
                if (c.read() !== value) throw Error("控件写入后回读不一致");
            }
            const verify = () => {
                if (
                    activity.step !== step ||
                    widget.answerSubmitted ||
                    !root.isConnected
                )
                    throw Error("填写期间网页已换题");
                const values = answer().freeResponseAnswers;
                const matches = controls.every((c, i) => {
                    const value = planned.get(c) ?? fields[i].current;
                    return (
                        c.read() === value &&
                        (!Array.isArray(values) ||
                            String(values[i] ?? "") === (part ? part.freeResponseEditors[i].cleanLatex(value) : value))
                    );
                });
                return matches && (part ? multistep.submitButtonEnabled === true && !widget.submitButton.classList.contains("disabledButton") : !widget.submitButton.disabled);
            };
            for (let i = 0; i < 50; i++) {
                if (verify()) return { filled: written.length };
                await new Promise((resolve) => setTimeout(resolve, 60));
            }
            throw Error("网页未确认全部答案，请检查答题框");
        } catch (error) {
            if (
                activity.step === step &&
                root.isConnected &&
                !widget.answerSubmitted
            ) {
                for (const [c, value] of written.reverse())
                    if (c.format !== "choice" && c.read() === value)
                        c.write("");
            }
            throw error;
        }
    } catch (error) {
        return { error: error.message };
    }
}
