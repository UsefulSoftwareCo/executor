import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { WelcomeEmailTarget } from "../support/welcome-email.ts";

layer(WelcomeEmailTarget.layer, { excludeTestServices: true })("Cloud welcome email", (it) => {
  it.effect(
    "welcomes once, accepts signed unsubscribes without login, and preserves sign-in email",
    () =>
      Effect.gen(function* () {
        const target = yield* WelcomeEmailTarget;
        const email = `welcome-${crypto.randomUUID()}@example.test`;
        expect(
          yield* target.request("/api/auth/email-otp/send-verification-otp", {
            email,
            type: "sign-in",
          }),
        ).toBe(200);
        expect(yield* target.tick()).toBe(200);
        expect(yield* target.messages(email, "Welcome to Executor")).toHaveLength(0);

        const otp = yield* target.code(email, "sign-up");
        expect(
          yield* target.request("/api/auth/sign-in/email-otp", {
            email,
            otp,
            name: "Taylor Example",
          }),
        ).toBe(200);
        const statuses = yield* Effect.all([target.tick(), target.tick()], {
          concurrency: 2,
        });
        expect(statuses).toEqual([200, 200]);
        const welcomes = yield* target.welcome(email);
        expect(welcomes).toHaveLength(1);
        const welcome = welcomes[0];
        expect(welcome?.from).toBe('"Rhys at Executor" <rhys@executor.sh>');
        expect(welcome?.text).toBe(`Hey Taylor,

I'm Rhys, founder of Executor. Thanks for signing up!

Here's a prompt you can hand to your agent to get started:

"Add the Executor MCP server at ${target.origin}/mcp, then read the Executor docs at ${target.origin}/docs and work out how you can best use Executor to help me."

This is an email directly from me. If you reply, it comes straight to my inbox. I'd love to hear from you if you need any help or have feedback.

I hope you enjoy Executor.

Best,
Rhys`);
        expect(welcome?.html).toContain("<p>Hey Taylor,</p>");
        expect(welcome?.html).toContain(`read the Executor docs at ${target.origin}/docs`);
        expect(welcome?.html).toContain("<p>Best,<br>Rhys</p>");
        expect(welcome?.text).not.toContain("unsubscribe");
        expect(welcome?.html).not.toContain("unsubscribe");
        const { browser: link, token } = yield* target.links(email);
        const visit = yield* target.preference("GET", token);
        expect(visit.status).toBe(303);
        expect(visit.location).toBe(link);
        expect((yield* target.preference("POST", token.slice(0, -10) + "AAAAAAAAAA")).status).toBe(
          400,
        );
        expect((yield* target.preference("POST", "not-a-token")).status).toBe(400);
        expect((yield* target.preference("POST", token)).status).toBe(200);
        expect((yield* target.preference("POST", token, "multipart")).status).toBe(200);
        const confirmed = yield* target.preference("POST", token, "browser");
        expect(confirmed.status).toBe(303);
        expect(confirmed.location).toBe(`${target.origin}/email/unsubscribe?result=unsubscribed`);

        expect(yield* target.request("/api/auth/sign-out", {})).toBe(200);
        expect(
          yield* target.request("/api/auth/email-otp/send-verification-otp", {
            email,
            type: "sign-in",
          }),
        ).toBe(200);
        const nextCode = yield* target.code(email, "sign-in");
        expect(
          yield* target.request("/api/auth/sign-in/email-otp", {
            email,
            otp: nextCode,
          }),
        ).toBe(200);
        expect(yield* target.tick()).toBe(200);
        expect(yield* target.messages(email, "Welcome to Executor")).toHaveLength(1);
        expect(yield* target.request("/api/auth/sign-out", {})).toBe(200);
      }),
  );
});
