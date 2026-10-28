import { expect, it } from "vitest";
import { screenshotSource } from "../../src/main/screenshotSource";

it("matches a screen by explicit display identity", () => {
    const sources = [{ display_id: "20" }, { display_id: "10" }];
    expect(screenshotSource(10, 2, sources)).toBe(sources[1]);
});
it("accepts an anonymous source only for an unambiguous single display", () => {
    const anonymous = [{ display_id: "" }];
    expect(screenshotSource(10, 1, anonymous)).toBe(anonymous[0]);
    expect(screenshotSource(10, 2, anonymous)).toBeUndefined();
    expect(
        screenshotSource(10, 1, [...anonymous, ...anonymous]),
    ).toBeUndefined();
    expect(screenshotSource(10, 1, [{ display_id: "20" }])).toBeUndefined();
    expect(screenshotSource(10, 1, [])).toBeUndefined();
});
