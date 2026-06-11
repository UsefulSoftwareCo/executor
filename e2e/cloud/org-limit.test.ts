// Cloud-specific (billing): the free plan allows 3 organizations per user.
// Driven ENTIRELY through the real web UI as a fresh user — the onboarding
// create-org page for the first org, then the in-app account-menu →
// org-switcher → "Create organization" modal for the rest. The run's
// Playwright trace + video + step screenshots are the debugging artifacts.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Billing, Browser, Target } from "../src/services";

const FREE_LIMIT = 3;

scenario(
  "Billing · the free plan stops organization creation after 3",
  {},
  Effect.gen(function* () {
    // Gate: billing limits are enforced on this target.
    yield* Billing;
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity({ org: false });

    yield* browser.session(identity, async ({ page, step }) => {
      await step("A fresh user lands on onboarding (no organization yet)", async () => {
        await page.goto("/", { waitUntil: "networkidle" });
        await page.getByPlaceholder("Northwind Labs").waitFor();
      });

      await step(`Create "Acme 1" (1 of ${FREE_LIMIT} allowed on the free plan)`, async () => {
        await page.getByPlaceholder("Northwind Labs").fill("Acme 1");
        await page.getByRole("button", { name: "Create organization" }).click();
        // Onboarding step 2 — proves the first org was created.
        await page.getByText("Connect your MCP client").waitFor();
      });

      await step("Continue into the app", async () => {
        await page.getByRole("button", { name: "Continue to app" }).click();
        await page.getByText("Integrations").first().waitFor();
        // Let the router navigation fully settle (slow on a cold dev server)
        // before opening menus — a late remount closes them mid-interaction.
        await page.waitForURL(/\/$/, { timeout: 30_000 });
        await page.waitForLoadState("networkidle");
      });

      const openCreateOrgModal = async (currentOrg: string) => {
        // Under parallel-suite load the radix menu re-renders while the org
        // list loads; a click can land on a closing menu. Bounded retry with
        // a clean reopen keeps the journey honest without 30s hangs.
        for (let attempt = 1; ; attempt++) {
          try {
            await page.keyboard.press("Escape");
            await page.getByRole("button", { name: /Test User/ }).click();
            await page.getByRole("menuitem", { name: currentOrg }).click({ timeout: 5_000 });
            const subContent = page.locator('[data-slot="dropdown-menu-sub-content"]');
            await subContent.waitFor({ state: "visible", timeout: 5_000 });
            await subContent
              .getByText("Create organization", { exact: true })
              .click({ timeout: 5_000 });
            await page.getByText("Add another organization").waitFor({ timeout: 5_000 });
            return;
          } catch (error) {
            if (attempt >= 3) throw error;
          }
        }
      };

      for (let i = 2; i <= FREE_LIMIT; i++) {
        await step(`Open the org switcher and choose "Create organization"`, async () => {
          await openCreateOrgModal(`Acme ${i - 1}`);
        });
        await step(`Create "Acme ${i}" (${i} of ${FREE_LIMIT})`, async () => {
          await page.getByPlaceholder("Northwind Labs").fill(`Acme ${i}`);
          await page.getByRole("button", { name: "Create organization" }).click();
          // The modal closes and the session switches into the new org.
          await page.getByText("Add another organization").waitFor({ state: "hidden" });
          await page.getByRole("button", { name: new RegExp(`Acme ${i}`) }).waitFor();
        });
      }

      await step("Attempt a 4th organization (over the free limit)", async () => {
        await openCreateOrgModal(`Acme ${FREE_LIMIT}`);
        await page.getByPlaceholder("Northwind Labs").fill("Acme 4");
        await page.getByRole("button", { name: "Create organization" }).click();
        await page.locator("p.text-destructive").first().waitFor();
      });

      const errorText = await page.locator("p.text-destructive").first().innerText();
      expect(errorText.length, "the UI shows a visible refusal").toBeGreaterThan(0);

      // Cross-check through the session API, with the browser's own session
      // cookie (fetched explicitly — the Secure cookie isn't replayed by
      // page.request over plain http).
      const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
      const response = await fetch(new URL("/api/auth/organizations", target.baseUrl), {
        headers: { cookie },
      });
      const body = (await response.json()) as { organizations: ReadonlyArray<{ name: string }> };
      expect(body.organizations.length, "exactly the free-plan allowance exists").toBe(FREE_LIMIT);
    });
  }),
);
