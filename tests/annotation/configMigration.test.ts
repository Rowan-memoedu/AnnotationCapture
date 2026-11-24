import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AnnotationConfig } from "../../src/main/annotationConfig";

vi.mock("electron", () => ({ app: { getVersion: () => "test" } }));

it("resets automatic whiteboard opening once and preserves subsequent changes", () => {
    const data = mkdtempSync(join(tmpdir(), "annotation-config-"));
    const file = join(data, "annotation-settings.json");
    const archive = join(data, "Archive");
    expect(
        new AnnotationConfig(data, archive).public().whiteboard.autoOpen,
    ).toBe(false);
    writeFileSync(
        file,
        JSON.stringify({
            whiteboard: { autoOpen: true, maxRects: 8 },
            penWidth: 7,
            encryptedSession: "fixture",
        }),
    );

    const upgraded = new AnnotationConfig(data, archive);
    expect(upgraded.public()).toMatchObject({
        whiteboard: { autoOpen: false, maxRects: 8 },
        penWidth: 7,
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
        whiteboard: { autoOpen: false },
        encryptedSession: "fixture",
    });
    upgraded.save({ ...upgraded.public(), whiteboard: { autoOpen: true } });
    expect(
        new AnnotationConfig(data, archive).public().whiteboard.autoOpen,
    ).toBe(true);
});
