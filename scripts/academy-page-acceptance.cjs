// Browser regression for the public DOM and the lesson's pending-answer interface.
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
    const { academyQuestion } = await import(
        "../browser/math-academy/question.mjs"
    );
    const browser = await chromium.launch({
        channel: "chromium",
        headless: true,
    });
    try {
        const page = await browser.newPage();
        await page.setContent(
            '<div id="step-old"><input value="old"></div><div id="step-current">Vertical [[label]]: <input> Horizontal: <input value="0"> Units: <input><span hidden>hidden feedback</span><button disabled>Submit</button></div>',
        );
        await page.addScriptTag({
            content: `window.academyQuestion = ${academyQuestion.toString()}`,
        });
        await page.evaluate(() => {
            const inputs = Array.from(
                document.querySelectorAll("#step-current input"),
            );
            const submitButton = document.querySelector("button");
            window.clicks = 0;
            submitButton.onclick = () => {
                window.clicks++;
            };
            for (const input of inputs)
                input.oninput = () => {
                    submitButton.disabled = !inputs.every((i) => i.value);
                };
            window.studentLesson = {
                step: {
                    id: "current",
                    questionWidget: {
                        submitButton,
                        answerSubmitted: false,
                        getStudentAnswer: () => ({
                            freeResponseAnswers: inputs.map((i) => i.value),
                        }),
                    },
                },
            };
        });
        const initial = await page.evaluate(() => window.academyQuestion());
        assert.ok(initial.snapshot, initial.error);
        assert.ok(
            !initial.snapshot.context.question.includes("hidden feedback"),
        );
        const read = () =>
            page
                .locator("input")
                .evaluateAll((els) => els.map((el) => el.value));
        const fill = (answers, snapshot = initial.snapshot) =>
            page.evaluate(
                ([s, a]) => window.academyQuestion(s, a),
                [snapshot, answers],
            );
        for (const ids of [["s1"], ["s1", "s1"], ["s2", "s3"], ["s1", "s4"]]) {
            assert.ok(
                (await fill(ids.map((id) => ({ id, value: "7" })))).error,
            );
            assert.deepEqual(await read(), ["old", "", "0", ""]);
        }
        const answers = [
            { id: "s3", value: "cm" },
            { id: "s1", value: "7" },
        ];
        await page.locator("#step-current input").first().fill("user edit");
        assert.ok((await fill(answers)).error);
        assert.deepEqual(await read(), ["old", "user edit", "0", ""]);
        await page.locator("#step-current input").first().fill("");
        const other = { ...initial.snapshot, step: "other" };
        assert.ok((await fill(answers, other)).error);
        assert.deepEqual(await fill(answers), { filled: 2 });
        assert.deepEqual(await read(), ["old", "7", "0", "cm"]);
        assert.ok((await fill(answers)).error);
        assert.equal(await page.evaluate(() => window.clicks), 0);
        console.log(
            "Verified field identity, occupied slots, stale questions, exact readback and no grading",
        );
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
