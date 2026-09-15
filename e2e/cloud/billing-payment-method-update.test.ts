// Cloud-only (billing, browser): an organization can change the card it is
// billed on from the billing page, and the page shows the new card WITHOUT a
// manual reload.
//
// The card lives at the billing provider, never in the app: the billing page
// reads the customer's default payment method (`payment_method` expand) and
// "Update card" opens a hosted setup session (`billing.setup_payment`). As
// with checkout, the browser is redirected back BEFORE the provider's webhook
// swaps the default payment method, so the first fetch on return still shows
// the previous card. The page tags its return URL, shows the card as updating,
// and refetches until the new card reflects.
//
// The emulator models the race faithfully: completing the hosted setup form
// redirects back immediately but does NOT change the card; the swap lands only
// when the webhook settles (autumn.settleSetup), which this test triggers to
// control the exact moment the backend becomes consistent.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Autumn, Billing, Browser, Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";
import { visit } from "../src/surfaces/browser";

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

/** The org the bearer is scoped to — the Autumn customer id every billing call
 *  is made against — read from the JWT's public claims. */
const orgIdOf = (bearer: string): string => {
  const claims = JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString()) as {
    readonly org_id?: string;
  };
  if (!claims.org_id) throw new Error("orgIdOf: bearer carries no org_id claim");
  return claims.org_id;
};

scenario(
  "Billing · updating the card shows the new card without a reload",
  { timeout: 120_000 },
  Effect.gen(function* () {
    yield* Billing;
    const autumn = yield* Autumn;
    const target = yield* Target;
    const browser = yield* Browser;
    const mcp = yield* Mcp;

    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const customerId = orgIdOf(bearer);

    const before = yield* autumn.paymentMethod(customerId);
    expect(before, "a fresh org has no card on file").toBeNull();

    yield* browser.session(identity, async ({ page, step }) => {
      const paymentMethodRow = page
        .getByText("Payment method", { exact: true })
        .locator("xpath=ancestor::div[contains(@class,'justify-between')][1]");

      let sessionId = "";
      await step("Open the billing page and start updating the card", async () => {
        // Billing requests are org-scoped via the URL slug header (see
        // billing-trial-checkout-stale.test.ts for why we wait for the slug).
        await visit(page, "/");
        await page.waitForURL((url) => /^\/[a-z0-9-]+\/?$/.test(url.pathname), {
          timeout: 30_000,
        });
        const slug = new URL(page.url()).pathname.split("/").filter(Boolean)[0];
        await visit(page, `/${slug}/billing`);
        await paymentMethodRow.getByText("No card on file").waitFor();
        await paymentMethodRow.getByRole("button", { name: "Add card" }).click();
        // setupPayment() redirects the whole page to the hosted setup URL.
        await page.waitForURL(/\/checkout\/setup\//, { timeout: 30_000 });
        sessionId = new URL(page.url()).pathname.split("/").filter(Boolean).pop() ?? "";
        expect(sessionId, "captured the setup session id").toMatch(/^seti_/);
      });

      await step("Enter a new card and return to the billing page", async () => {
        await page.locator("input[name='card_number']").fill("5555 5555 5555 4444");
        await page.locator("input[name='exp']").fill("11/31");
        await page.locator("button.checkout-pay-btn").click();
        await page.waitForURL(/\/billing(\?|$)/, { timeout: 30_000 });
        // The webhook has NOT landed yet, but the page knows from the return
        // marker that a card was just saved, so it shows the card as updating
        // rather than "No card on file" (which would read as if nothing
        // happened). This is the key user-facing guarantee.
        await paymentMethodRow.getByText("Updating card").waitFor({ timeout: 10_000 });
      });

      // The provider webhook reaches Autumn: the org's default card is swapped.
      await Effect.runPromise(autumn.settleSetup(sessionId));

      await step("The new card appears without a reload", async () => {
        await paymentMethodRow.getByText("Mastercard ending in 4444").waitFor({ timeout: 15_000 });
        await paymentMethodRow.getByRole("button", { name: "Update card" }).waitFor();
      });
    });

    const after = yield* autumn.paymentMethod(customerId);
    expect(after, "the billing provider holds the new card").toEqual({
      brand: "mastercard",
      last4: "4444",
      expMonth: 11,
      expYear: 2031,
    });
  }),
);
