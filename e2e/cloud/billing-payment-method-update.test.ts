// Cloud-only (billing, browser): an organization can add the card it is billed
// on and later change it from the billing page, and the page shows the current
// card WITHOUT a manual reload.
//
// The card lives at the billing provider, never in the app: the billing page
// reads the customer's default payment method (`payment_method` expand). Two
// journeys, because the provider treats them differently (verified against the
// live sandbox API):
//
//   1. No card yet — "Add card" opens a hosted setup session
//      (`billing.setup_payment`). The browser is redirected back BEFORE the
//      provider's webhook sets the default card, so the page tags its return
//      URL, shows the card as updating, and refetches until it reflects.
//   2. A card on file — a setup session never REPLACES an existing default, so
//      "Update card" opens the billing portal (`billing.open_customer_portal`)
//      where the user adds a card and makes it the default. The provider reads
//      the default live, so one refetch on return shows the new card.
//
// The emulator models both faithfully: completing the hosted setup form
// redirects back immediately but does NOT set the card until the webhook
// settles (autumn.settleSetup); the portal applies the card at once.
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
  "Billing · adding and changing the card shows the current card without a reload",
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
      await step("Open the billing page and add a card", async () => {
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

      await step("Save the card and return to the billing page", async () => {
        await page.locator("input[name='card_number']").fill("4242 4242 4242 4242");
        await page.locator("input[name='exp']").fill("12/30");
        await page.locator("button.checkout-pay-btn").click();
        await page.waitForURL(/\/billing(\?|$)/, { timeout: 30_000 });
        // The webhook has NOT landed yet, but the page knows from the return
        // marker that a card was just saved, so it shows the card as updating
        // rather than "No card on file" (which would read as if nothing
        // happened). This is the key user-facing guarantee.
        await paymentMethodRow.getByText("Updating card").waitFor({ timeout: 10_000 });
      });

      // The provider webhook reaches Autumn: the org's default card is set.
      await Effect.runPromise(autumn.settleSetup(sessionId));

      await step("The new card appears without a reload", async () => {
        await paymentMethodRow.getByText("Visa ending in 4242").waitFor({ timeout: 15_000 });
      });

      await step("Change the card in the billing portal", async () => {
        await paymentMethodRow.getByRole("button", { name: "Update card" }).click();
        // openCustomerPortal() redirects the whole page to the hosted portal.
        await page.waitForURL(/\/checkout\/portal\//, { timeout: 30_000 });
        await page.locator("input[name='card_number']").fill("5555 5555 5555 4444");
        await page.locator("input[name='exp']").fill("11/31");
        await page.locator("button.checkout-pay-btn").click();
        await page.getByText("4444").first().waitFor({ timeout: 10_000 });
        await page.getByRole("link", { name: /^Return to/ }).click();
        await page.waitForURL(/\/billing(\?|$)/, { timeout: 30_000 });
      });

      await step("The billing page shows the card chosen in the portal", async () => {
        await paymentMethodRow.getByText("Mastercard ending in 4444").waitFor({ timeout: 15_000 });
        expect(
          await paymentMethodRow.getByText("Updating card").count(),
          "no webhook wait for a portal change",
        ).toBe(0);
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
