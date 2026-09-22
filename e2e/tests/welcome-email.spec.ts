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
        expect(yield* target.messages(email, "welcome to executor")).toHaveLength(0);

        const otp = yield* target.code(email);
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
        expect(welcome?.text.split("\n\nand if you'd rather not get these at all")[0])
          .toBe(`hey Taylor,

i'm rhys, founder of executor - thanks for signing up!

quick heads up: i hate getting emails as much as you do, so you won't get many from me. when i do send one, i'll make sure it's worth opening.

on to the useful part. if you're still working out where to start, here's a prompt you can hand to your agent:

"add the executor mcp server at ${target.origin}/mcp, then read the executor docs at ${target.origin}/docs and work out how you can best use executor to help me."

if you get stuck or have questions, just reply. this was an automated email but replies go straight to me, and i'd love to hear what you're using executor for.`);
        expect(welcome?.html).toContain("<p>hey Taylor,</p>");
        expect(welcome?.html).toContain(`read the executor docs at ${target.origin}/docs`);
        const link = welcome?.text.match(
          /and if you'd rather not get these at all, the unsubscribe link is right here: (\S+)$/,
        )?.[1];
        expect(link).toBeDefined();
        if (!link) return yield* Effect.die("Missing unsubscribe link");
        const url = new URL(link);
        expect(url.origin).toBe(target.origin);
        expect(url.pathname).toBe("/email/unsubscribe");
        expect(welcome?.html).toContain(`href="${link}"`);
        const token = url.hash.slice(1);
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
        const nextCode = yield* target.code(email, 2);
        expect(
          yield* target.request("/api/auth/sign-in/email-otp", {
            email,
            otp: nextCode,
          }),
        ).toBe(200);
        expect(yield* target.tick()).toBe(200);
        expect(yield* target.messages(email, "welcome to executor")).toHaveLength(1);
        expect(yield* target.request("/api/auth/sign-out", {})).toBe(200);
      }),
  );
});
