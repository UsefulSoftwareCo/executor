// Cloud-only (browser): the whole auth-routing arc in ONE session, end to end
// through the real dev server (the e2e cloud target boots `vite dev` with the
// SSR gate active, so this is the same routing that runs in prod):
//
//   member:  signed out → /login → click Sign in → WorkOS (emulator) callback
//            → canonical dashboard at /<slug>
//   no org:  the same sign-in → Executor v2's sign-up page (v1 creates no
//            organizations; they are created in v2)
//
// The individual hops are also covered piecewise (cloud/unauthenticated-skeleton,
// cloud/session-gate, scenarios/org-slug-routing) — those pin edge cases this
// narrative doesn't (invalid-cookie clearing, token refresh, returnTo
// open-redirect, unknown-slug 404). This one is the regression guard for the
// happy path as a single continuous flow, and is the only test that pins the
// bare-`/` → `/<slug>/` dashboard canonicalization a fresh login lands on.
//
// The headless helpers sign in via a `login_hint` query param, but the
// emulator's hosted AuthKit also serves a real form ("continue as a new user"),
// so the browser flow just fills it — genuinely end-to-end through the UI.
import { randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { settle, type BrowserSession } from "../src/surfaces/browser";
import { seedOrganization } from "../targets/cloud";

/** Signed out at the root, then through the hosted sign-in form as `email`. */
const signInThroughTheUi = async (page: Page, step: BrowserSession["step"], email: string) => {
  await step("Signed out, the root redirects to /login", async () => {
    await page.goto("/", { waitUntil: "commit" });
    await page.getByText("Sign in to manage your tools and integrations").waitFor();
  });
  expect(new URL(page.url()).pathname, "the signed-out root lands on /login").toBe("/login");

  await step("Sign in through the UI", async () => {
    await page.getByRole("link", { name: "Sign in" }).click();
    // The emulator's hosted AuthKit form.
    await page.getByPlaceholder("new-user@example.com").fill(email);
    await page.getByRole("button", { name: /Continue/ }).click();
  });
};

scenario(
  "Auth routing · signed out → login → dashboard, one browser session",
  {},
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* Target;

    // A member of an existing organization (it lives in WorkOS, as every v1
    // organization does), signing in for the first time in this browser.
    const email = `flow-${randomUUID().slice(0, 8)}@e2e.test`;
    yield* Effect.promise(() => seedOrganization(email, "Flow Test Org"));

    // No cookies → a clean, signed-out browser.
    const anonymous = { label: "anonymous" };

    yield* browser.session(anonymous, async ({ page, step }) => {
      await signInThroughTheUi(page, step, email);

      await step("The callback lands on the canonical dashboard at /<slug>", async () => {
        // The bare landing canonicalizes onto the org's slug.
        await page.waitForURL((url) => /^\/[a-z0-9-]+\/?$/.test(url.pathname), { timeout: 30_000 });
        await page.getByText("Integrations").first().waitFor({ timeout: 30_000 });
        await settle(page);
        await page.getByRole("button", { name: /Flow Test Org/ }).waitFor({ timeout: 30_000 });
      });

      expect(
        /^\/[a-z0-9-]+\/?$/.test(new URL(page.url()).pathname),
        "the signed-in user ends on their org-slug dashboard",
      ).toBe(true);
    });
  }),
);

scenario(
  "Auth routing · a sign-in with no organization is sent to Executor v2's sign-up page",
  {},
  Effect.gen(function* () {
    const browser = yield* Browser;
    const target = yield* Target;

    const email = `flow-orgless-${randomUUID().slice(0, 8)}@e2e.test`;
    const anonymous = { label: "anonymous" };

    yield* browser.session(anonymous, async ({ page, step }) => {
      // The callback's redirect chain ends on v2's real host, and Playwright
      // cannot hold a document at a redirect hop. So the hosted form's answer
      // is held here (as login-csrf does), and the browser's own request
      // context — its cookie jar — follows the chain one hop at a time.
      let callback: string | undefined;
      await page.route("**/user_management/authorize/submit", async (route) => {
        const response = await route.fetch({ maxRedirects: 0 });
        callback = response.headers().location;
        await route.fulfill({ status: 200, contentType: "text/plain", body: "Signed in" });
      });

      await signInThroughTheUi(page, step, email);

      await step("The callback signs the browser in and returns it to the app", async () => {
        await expect.poll(() => callback).toBeDefined();
        const response = await page.request.get(callback!, { maxRedirects: 0 });
        expect(response.status(), "the callback completes the sign-in").toBe(302);
        expect(response.headers().location, "…back to the app's root").toBe("/");
      });

      await step("The app sends the org-less session on to v2's sign-up page", async () => {
        const response = await page.request.get(new URL("/", target.baseUrl).toString(), {
          maxRedirects: 0,
          headers: { accept: "text/html" },
        });
        expect(response.status(), "no app shell for a session with no organization").toBe(302);
        const location = new URL(response.headers().location ?? "", target.baseUrl);
        expect(location.origin, "the session leaves v1 for v2's host").not.toBe(
          new URL(target.baseUrl).origin,
        );
        expect(location.pathname, "v2's sign-in page…").toBe("/login");
        expect(location.searchParams.get("mode"), "…opened to sign up").toBe("signup");
      });
    });
  }),
);
