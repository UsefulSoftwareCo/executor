import { randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Login CSRF · state is required, bound to the browser, and consumed after login",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const email = `csrf-${randomUUID()}@e2e.test`;
    yield* browser.session({ label: "anonymous" }, async ({ page, step }) => {
      const interceptCallback = async (): Promise<string> => {
        let callback: string | undefined;
        await page.route("**/api/auth/callback?**", async (route) => {
          callback = route.request().url();
          await route.abort();
        });
        await page.goto(new URL("/api/auth/login", target.baseUrl).toString());
        await page.getByPlaceholder("new-user@example.com").fill(email);
        await page.getByRole("button", { name: /Continue/ }).click();
        await expect.poll(() => callback).toBeDefined();
        await page.unroute("**/api/auth/callback?**");
        if (!callback) throw new Error("AuthKit did not return a callback");
        return callback;
      };
      await step("Refuse a valid authorization code with no state", async () => {
        const callback = new URL(await interceptCallback());
        callback.searchParams.delete("state");
        const response = await page.request.get(callback.toString(), { maxRedirects: 0 });
        expect(response.status()).toBe(400);
        expect(await response.text()).toBe("Invalid login state");
        expect(
          (await page.context().cookies()).some((cookie) => cookie.name === "wos-session"),
        ).toBe(false);
      });
      await step("Refuse a state from another login", async () => {
        const callback = new URL(await interceptCallback());
        callback.searchParams.set("state", "another-browser-state");
        const response = await page.request.get(callback.toString(), { maxRedirects: 0 });
        expect(response.status()).toBe(400);
        expect(await response.text()).toBe("Invalid login state");
        expect(
          (await page.context().cookies()).some((cookie) => cookie.name === "wos-session"),
        ).toBe(false);
      });
      await step("Complete a fresh login, then reject the same callback again", async () => {
        const callback = await interceptCallback();
        await page.goto(callback);
        await page.waitForURL((url) => url.pathname === "/create-org", { timeout: 30_000 });
        const cookies = await page.context().cookies();
        expect(cookies.some((cookie) => cookie.name === "wos-session")).toBe(true);
        expect(cookies.some((cookie) => cookie.name === "wos-login-state")).toBe(false);
        const me = await page.request.get(new URL("/api/auth/me", target.baseUrl).toString());
        expect(me.status()).toBe(200);
        expect(await me.json()).toMatchObject({ user: { email } });
        const replay = await page.request.get(callback, { maxRedirects: 0 });
        expect(replay.status()).toBe(400);
        expect(await replay.text()).toBe("Invalid login state");
      });
    });
  }),
);
