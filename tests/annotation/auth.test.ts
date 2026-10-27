import { describe, expect, it, vi } from "vitest";
import type { LoginSession } from "../../lib/annotation";
import { AnnotationAuth } from "../../src/main/annotationAuth";

const session: LoginSession = {
    token: "A".repeat(43),
    accountId: "fixture-account",
    label: "测试用户",
};
function fixture(initial: LoginSession | null, request: typeof fetch) {
    let current = initial;
    const config = {
        session: () => current,
        saveSession: vi.fn((value: LoginSession) => {
            current = value;
        }),
        clearSession: vi.fn(() => {
            current = null;
        }),
    };
    const auth = new AnnotationAuth(
        config,
        () => {},
        "https://example.invalid/annotation/api",
        request,
    );
    return { auth, config };
}

describe("invitation sessions", () => {
    it("persists a login but never exposes its bearer token in UI state", async () => {
        const request = vi.fn(async () =>
            Response.json({ ...session, providerReady: false }),
        );
        const { auth, config } = fixture(null, request as typeof fetch);
        expect((await auth.login("AC-fixture-invite")).loggedIn).toBe(true);
        expect(config.saveSession).toHaveBeenCalledWith(session);
        expect(JSON.stringify(auth.public())).not.toContain(session.token);
        expect(auth.public().providerReady).toBe(false);
        expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({
            inviteCode: "AC-fixture-invite",
        });
    });
    it("restores a saved session without requesting an invitation again", async () => {
        const request = vi.fn(async () =>
            Response.json({ label: session.label, providerReady: true }),
        );
        const { auth } = fixture(session, request as typeof fetch);
        const result = await auth.refresh();
        expect(result.verified).toBe(true);
        expect(result.providerReady).toBe(true);
        expect(request.mock.calls[0][0]).toContain("/session");
    });
    it("retains the saved login during network outages", async () => {
        const { auth, config } = fixture(
            session,
            vi.fn(async () => {
                throw new Error("offline");
            }) as typeof fetch,
        );
        expect((await auth.refresh()).loggedIn).toBe(true);
        expect(auth.public().verified).toBe(false);
        expect(config.session()).toEqual(session);
        expect(config.clearSession).not.toHaveBeenCalled();
    });
    it("invalidates a revoked session and refuses subsequent recognition", async () => {
        const { auth, config } = fixture(
            session,
            vi.fn(
                async () => new Response("", { status: 401 }),
            ) as typeof fetch,
        );
        await auth.refresh();
        expect(config.session()).toBeNull();
        expect(auth.provider()).toBeNull();
        expect(auth.public().loggedIn).toBe(false);
    });
    it("sends only the selected PNG and the user session to the gateway", async () => {
        const request = vi.fn(async () =>
            Response.json({
                latex: "\\frac{X+x}{2}",
                model: "configured-model",
            }),
        );
        const { auth } = fixture(session, request as typeof fetch);
        const result = await auth
            .provider()!
            .recognize(
                "data:image/png;base64,fixture",
                new AbortController().signal,
            );
        expect(result.latex).toBe("\\frac{X+x}{2}");
        const [url, input] = request.mock.calls[0];
        expect(url).toBe("https://example.invalid/annotation/api/recognize");
        expect(JSON.parse(input!.body as string)).toEqual({
            png: "data:image/png;base64,fixture",
        });
        expect(input!.headers).toEqual({
            Authorization: `Bearer ${session.token}`,
            "Content-Type": "application/json",
        });
    });
    it("rejects a late recognition response after logout", async () => {
        let complete!: (response: Response) => void;
        const request = vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    complete = resolve;
                }),
        );
        const { auth } = fixture(session, request as typeof fetch);
        const pending = auth
            .provider()!
            .recognize(
                "data:image/png;base64,fixture",
                new AbortController().signal,
            );
        auth.logout();
        complete(Response.json({ latex: "x", model: "fixture" }));
        await expect(pending).rejects.toThrow("登录状态已变化");
        expect(auth.provider()).toBeNull();
    });
    it("cannot restore a session when logout occurs during JSON decoding", async () => {
        let decode!: (value: unknown) => void;
        const response = {
            ok: true,
            status: 200,
            json: () =>
                new Promise((resolve) => {
                    decode = resolve;
                }),
        } as Response;
        for (const operation of ["refresh", "recognize", "login"] as const) {
            const { auth } = fixture(
                session,
                vi.fn(async () => response) as typeof fetch,
            );
            const pending =
                operation === "refresh"
                    ? auth.refresh()
                    : operation === "login"
                      ? auth.login("fixture")
                      : auth
                            .provider()!
                            .recognize("png", new AbortController().signal);
            await vi.waitFor(() => expect(decode).toBeTypeOf("function"));
            auth.logout();
            decode({
                ...session,
                latex: "x",
                model: "fixture",
                providerReady: true,
            });
            if (operation === "refresh") await pending;
            else await expect(pending).rejects.toThrow("登录状态已变化");
            expect(auth.public().loggedIn).toBe(false);
            expect(auth.provider()).toBeNull();
            decode = undefined as never;
        }
    });
    it("rejects invalid invitations, malformed server credentials and insecure remote URLs", async () => {
        const { auth, config } = fixture(
            null,
            vi.fn(
                async () => new Response("", { status: 401 }),
            ) as typeof fetch,
        );
        await expect(auth.login("invalid-code")).rejects.toThrow("邀请码无效");
        expect(config.saveSession).not.toHaveBeenCalled();
        const malformed = fixture(
            null,
            vi.fn(async () =>
                Response.json({ ...session, token: "short" }),
            ) as typeof fetch,
        );
        await expect(malformed.auth.login("valid-format-code")).rejects.toThrow(
            "无效数据",
        );
        expect(
            () =>
                new AnnotationAuth(
                    config,
                    () => {},
                    "http://external.example/api",
                ),
        ).toThrow("HTTPS");
    });
});
