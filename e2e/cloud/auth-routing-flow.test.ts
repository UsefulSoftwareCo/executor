// Cloud-only (browser): the whole auth-routing arc in ONE session, end to end
// through the real dev server (the e2e cloud target boots `vite dev` with the
// SSR gate active, so this is the same routing that runs in prod):
//
//   signed out  →  /login
//   click Sign in  →  WorkOS (emulator) callback  →  org-less → /create-org
//   create the first org  →  canonical dashboard at /<slug>
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

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Auth routing · signed out → login → onboarding → dashboard, one browser session",
  {},
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* Target;

    // A brand-new user the emulator provisions on first login_hint — no org, so
    // the post-callback document is gated to onboarding.
    const email = `flow-${randomUUID().slice(0, 8)}@e2e.test`;

    // No cookies → a clean, signed-out browser.
    const anonymous = { label: "anonymous" };

    yield* browser.session(anonymous, async ({ page, step }) => {
      await step("Signed out, the root redirects to /login", async () => {
        await page.goto("/", { waitUntil: "commit" });
        await page.getByText("Sign in to manage your tools and sources").waitFor();
      });
      expect(new URL(page.url()).pathname, "the signed-out root lands on /login").toBe("/login");

      await step("Sign in through the UI → org-less session lands on onboarding", async () => {
        await page.getByRole("link", { name: "Sign in" }).click();
        // The emulator's hosted AuthKit form: provision a brand-new user.
        await page.getByPlaceholder("new-user@example.com").fill(email);
        await page.getByRole("button", { name: /Continue/ }).click();
        // callback mints the session → SSR gate sees no org → /create-org.
        await page.waitForURL((url) => url.pathname === "/create-org", { timeout: 30_000 });
        await page.getByPlaceholder("Northwind Labs").waitFor({ timeout: 30_000 });
      });

      await step("Create the first org → canonical dashboard at /<slug>", async () => {
        await page.getByPlaceholder("Northwind Labs").fill("Flow Test Org");
        await page.getByRole("button", { name: "Create organization" }).click();
        await page.getByText("Connect your MCP client").waitFor({ timeout: 30_000 });
        await page.getByRole("button", { name: "Continue to app" }).click();
        // The bare landing canonicalizes onto the new org's slug.
        await page.waitForURL((url) => /^\/[a-z0-9-]+\/?$/.test(url.pathname), { timeout: 30_000 });
        await page.getByText("Integrations").first().waitFor({ timeout: 30_000 });
      });

      expect(
        /^\/[a-z0-9-]+\/?$/.test(new URL(page.url()).pathname),
        "the signed-in user ends on their org-slug dashboard",
      ).toBe(true);
    });
  }),
);
