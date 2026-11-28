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
                        getStudentAnswer: () => {
                            const values = inputs.map((i) => i.value);
                            while (values.at(-1) === "") values.pop();
                            return {
                                freeResponseAnswers:
                                    window.reportOverride ?? values,
                            };
                        },
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
        await page.evaluate(() => {
            window.reportOverride = [];
        });
        assert.ok((await page.evaluate(() => window.academyQuestion())).error);
        for (const input of await page.locator("#step-current input").all())
            await input.fill("");
        const empty = await page.evaluate(() => window.academyQuestion());
        assert.deepEqual(
            empty.snapshot?.context.fields.map((field) => field.current),
            ["", "", ""],
        );
        await page.evaluate(() => {
            window.reportOverride = ["", "", "", ""];
        });
        assert.ok((await page.evaluate(() => window.academyQuestion())).error);
        await page.evaluate(() => {
            delete window.reportOverride;
        });
        assert.deepEqual(
            await fill(
                [
                    { id: "s1", value: "2" },
                    { id: "s2", value: "4" },
                    { id: "s3", value: "m" },
                ],
                empty.snapshot,
            ),
            { filled: 3 },
        );
        assert.equal(await page.evaluate(() => window.clicks), 0);
        await page.setContent(
            `<div id="step-review">Choose a value
                <table class="questionWidget-choicesTable">
                    <tr><td><div class="questionWidget-choiceLetterCircle" id="choice-a">a</div></td><td>7</td></tr>
                    <tr><td><div class="questionWidget-choiceLetterCircle" id="choice-b">b</div></td><td>12</td></tr>
                </table><button id="submit" disabled>Submit</button>
            </div>`,
        );
        await page.addScriptTag({
            content: `window.academyQuestion = ${academyQuestion.toString()}`,
        });
        await page.evaluate(() => {
            window.studentLesson = undefined;
            const submitButton = document.querySelector("#submit");
            let selectedChoice;
            const codes = { a: 11, b: 27 };
            const widget = {
                submitButton,
                getSelectedChoice: (letter) => codes[letter],
                getStudentAnswer: () => ({ selectedChoice }),
            };
            window.studentReview = {
                step: { id: "review", questionWidget: widget },
            };
            for (const el of document.querySelectorAll(".questionWidget-choiceLetterCircle")) {
                el.onclick = () => {
                    selectedChoice = codes[el.textContent];
                    submitButton.disabled = false;
                };
            }
            window.reviewGraded = 0;
            submitButton.onclick = () => { window.reviewGraded++; };
        });
        const review = await page.evaluate(() => window.academyQuestion());
        assert.deepEqual(review.snapshot?.context.fields[0].options, ["a", "b"]);
        assert.ok(review.snapshot.context.question.includes("<cell>b</cell><cell>12</cell>"));
        assert.deepEqual(
            await fill([{ id: "s1", value: "b" }], review.snapshot),
            { filled: 1 },
        );
        assert.deepEqual(await page.evaluate(() => ({
            selected: window.studentReview.step.questionWidget.getStudentAnswer().selectedChoice,
            graded: window.reviewGraded,
        })), { selected: 27, graded: 0 });
        console.log(
            "Verified empty and occupied fields, stale questions, Review choices, readback and no grading",
        );
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
