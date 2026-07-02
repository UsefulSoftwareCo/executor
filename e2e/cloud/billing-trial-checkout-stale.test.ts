// Cloud-only (billing, browser): completing the Team free-trial checkout should
// leave the billing page showing the new plan WITHOUT a manual reload, and
// without ever flashing the stale upgrade CTA.
//
// Guards a reported bug + its fix: a user starts the free trial, completes
// Stripe checkout, and is redirected back to the plans page. The redirect lands
// before Autumn has processed Stripe's webhook, and autumn-js fetches the
// customer once on load (staleTime 60s, refetchOnWindowFocus off), so the page
// used to show the old plan and the "Start free trial" CTA until a manual
// reload. The fix tags the checkout return URL with the purchased plan, then on
// return shows that plan as "Activating" while it refetches until the webhook
// lands, resolving to "Your plan" with no reload.
//
// The emulator models the race faithfully: completing the hosted checkout
// redirects back immediately but does NOT activate the subscription; activation
// lands only when the webhook settles (autumn.settleCheckout), which this test
// triggers to control the exact moment the backend becomes consistent.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Autumn, Billing, Browser, Target } from "../src/services";

scenario(
  "Billing · completing the trial checkout shows the new plan without a reload",
  { timeout: 120_000 },
  Effect.gen(function* () {
    // Gates: billing enforced here AND the Autumn emulator is observable (so we
    // can land the checkout webhook). Yield before any work so a target missing
    // either capability skips cleanly rather than failing.
    yield* Billing;
    const autumn = yield* Autumn;
    const target = yield* Target;
    const browser = yield* Browser;

    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      const teamCard = page
        .getByText("Team", { exact: true })
        .locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
      const startTrial = teamCard.getByRole("button", { name: "Start free trial" });

      await step("A fresh org is offered the Team free trial", async () => {
        // Billing requests are org-scoped via the URL slug header, so reach the
        // plans page through the org-scoped URL (a bare /billing/plans would fire
        // the first fetch before the slug resolves and 401). Land on "/" to
        // canonicalize, then open the slug-scoped plans page.
        await page.goto("/", { waitUntil: "networkidle" });
        const slug = new URL(page.url()).pathname.split("/").filter(Boolean)[0];
        await page.goto(`/${slug}/billing/plans`, { waitUntil: "networkidle" });
        await page.getByRole("heading", { name: "Choose a plan" }).waitFor();
        await startTrial.waitFor();
      });

      let sessionId = "";
      await step("Start the trial and land on the hosted checkout", async () => {
        await startTrial.click();
        // attach() redirects the whole page to the checkout URL.
        await page.waitForURL(/\/checkout\//, { timeout: 30_000 });
        sessionId = new URL(page.url()).pathname.split("/").filter(Boolean).pop() ?? "";
        expect(sessionId, "captured the checkout session id").toMatch(/^cs_/);
        await page.locator("button.checkout-pay-btn").waitFor();
      });

      await step("Complete checkout and return to the plans page", async () => {
        await page.locator("button.checkout-pay-btn").click();
        await page.waitForURL(/billing\/plans/, { timeout: 30_000 });
        // The webhook has NOT landed yet, but the page knows from the return
        // marker which plan was purchased, so it shows that plan as activating
        // rather than the stale upgrade CTA (which would read as if nothing
        // happened). This is the key user-facing guarantee.
        await teamCard.getByText("Activating", { exact: true }).waitFor({ timeout: 10_000 });
        expect(await startTrial.count(), "the stale trial CTA is not shown on return").toBe(0);
      });

      // The Stripe webhook reaches Autumn: the customer is now on the Team trial.
      await Effect.runPromise(autumn.settleCheckout(sessionId));

      // Without any reload, the activating state resolves to the active plan as
      // the polled refetch picks up the now-consistent backend.
      await step("The plan resolves to active without a reload", async () => {
        await teamCard.getByText("Current plan").waitFor({ timeout: 15_000 });
        await teamCard.getByText("Your plan").waitFor({ timeout: 5_000 });
      });
      expect(await startTrial.count(), "the upgrade CTA never returns").toBe(0);
    });
  }),
);
