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
        // Pause the real provider response before its redirect reaches the app.
        // Playwright does not route subsequent hops of a redirect chain.
        await page.route("**/user_management/authorize/submit", async (route) => {
          const response = await route.fetch({ maxRedirects: 0 });
          expect(response.status()).toBe(302);
          callback = response.headers().location;
          await route.fulfill({
            status: 200,
            contentType: "text/plain",
            body: "Authorization ready for callback validation",
          });
        });
        await page.goto(new URL("/api/auth/login", target.baseUrl).toString());
        await page.getByPlaceholder("new-user@example.com").fill(email);
        await page.getByRole("button", { name: /Continue/ }).click();
        await expect.poll(() => callback).toBeDefined();
        await page.unroute("**/user_management/authorize/submit");
        if (!callback) throw new Error("AuthKit did not return a callback");
        return callback;
      };
      await step("Discard a valid code without state and restart login", async () => {
        const callback = new URL(await interceptCallback());
        callback.searchParams.delete("state");
        const response = await page.request.get(callback.toString(), { maxRedirects: 0 });
        expect(response.status()).toBe(302);
        expect(response.headers().location).toBe("/api/auth/login");
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

scenario(
  "Auth · a provider-initiated login restarts with browser-bound state",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const email = `provider-login-${randomUUID()}@e2e.test`;
    // Discover this deployment's provider URL without setting a browser cookie.
    const login = yield* Effect.promise(() =>
      fetch(new URL("/api/auth/login", target.baseUrl), { redirect: "manual" }),
    );
    expect(login.status).toBe(302);
    const location = login.headers.get("location");
    if (!location) throw new Error("Login did not redirect to AuthKit");
    const providerUrl = new URL(location);
    providerUrl.searchParams.delete("state");

    yield* browser.session({ label: "anonymous" }, async ({ page, step }) => {
      await step("Sign in directly at the provider, as a hosted invitation does", async () => {
        await page.goto(providerUrl.toString());
        await page.getByPlaceholder("new-user@example.com").fill(email);
        const callbackResponse = page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/api/auth/callback",
        );
        await page.getByRole("button", { name: /Continue/ }).click();
        const callback = await callbackResponse;
        expect(new URL(callback.url()).searchParams.has("state")).toBe(false);
        expect(callback.status()).toBe(302);
        expect(callback.headers().location).toBe("/api/auth/login");
        await page.waitForURL((url) => url.searchParams.has("state"));
        expect((await page.context().cookies()).map((cookie) => cookie.name)).not.toContain(
          "wos-session",
        );
      });

      await step("Complete the fresh login and reach the signed-in app", async () => {
        // The emulator asks again; hosted AuthKit can reuse its browser session.
        await page.getByPlaceholder("new-user@example.com").fill(email);
        await page.getByRole("button", { name: /Continue/ }).click();
        await page.waitForURL((url) => url.pathname === "/create-org", { timeout: 30_000 });
        const me = await page.request.get(new URL("/api/auth/me", target.baseUrl).toString());
        expect(me.status()).toBe(200);
        expect(await me.json()).toMatchObject({ user: { email } });
        const cookieNames = (await page.context().cookies()).map((cookie) => cookie.name);
        expect(cookieNames).toContain("wos-session");
        expect(cookieNames).not.toContain("wos-login-state");
      });
    });
  }),
);
