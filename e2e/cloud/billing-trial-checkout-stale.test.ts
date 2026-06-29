// Cloud-only (billing, browser): completing the Team free-trial checkout should
// leave the billing page showing the new plan WITHOUT a manual reload.
//
// Repro of a reported bug: a user starts the free trial, completes Stripe
// checkout, and is redirected back to the plans page, which STILL shows the
// upgrade/"Start free trial" call to action. A manual reload then shows the
// active trial. The cause is client-side: autumn-js fetches the customer once
// on load (staleTime 60s, refetchOnWindowFocus off) and the redirect back from
// Stripe lands before Autumn has processed Stripe's webhook, so that single
// fetch sees the old plan and the page never refetches on its own.
//
// The emulator models this faithfully: completing the hosted checkout redirects
// back immediately but does NOT activate the subscription; the activation lands
// only when the webhook settles (autumn.settleCheckout). The reload control
// proves the backend is consistent, isolating the failure to the stale client.
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
        // Checkout completes and redirects back to the success_url (the plans
        // page). The webhook has NOT landed yet, so the trial is still offered:
        // exactly the window the bug lives in.
        await page.waitForURL(/billing\/plans/, { timeout: 30_000 });
        await startTrial.waitFor();
      });

      // The Stripe webhook reaches Autumn: the customer is now on the Team trial.
      // From here on the billing backend is authoritative-consistent.
      await Effect.runPromise(autumn.settleCheckout(sessionId));

      // The page the user was returned to never reloads. If the UI refetched
      // after returning from checkout it would drop the trial CTA within a few
      // seconds; today it does not, so this stays visible.
      const reflectedWithoutReload = await startTrial
        .waitFor({ state: "hidden", timeout: 8_000 })
        .then(() => true)
        .catch(() => false);

      // Control: a manual reload surfaces the active trial, proving the backend
      // was consistent all along and the only thing missing was a client refetch.
      await step("A manual reload shows the active trial", async () => {
        await page.reload({ waitUntil: "networkidle" });
        await teamCard.getByText("Current plan").waitFor({ timeout: 15_000 });
      });

      expect(
        reflectedWithoutReload,
        "the plans page reflects the completed checkout without a manual reload",
      ).toBe(true);
    });
  }),
);
