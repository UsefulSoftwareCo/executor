// Cloud-specific (billing): the free plan allows 3 organizations per user.
// Driven ENTIRELY through the real web UI as a fresh user — the onboarding
// create-org page for the first org, then the in-app account-menu →
// org-switcher → "Create organization" modal for the rest. The run's
// Playwright trace + video + step screenshots are the debugging artifacts.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";

const FREE_LIMIT = 3;

scenario(
  "Billing · the free plan stops organization creation after 3",
  { needs: ["browser", "billing"] },
  (ctx) =>
    Effect.gen(function* () {
      const identity = yield* ctx.target.newIdentity({ org: false });

      yield* ctx.browser.session(identity, async ({ page, step }) => {
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
          await page.getByRole("button", { name: /Test User/ }).click();
          // The org entry is a radix submenu trigger; its content loads the
          // org list from the API, so wait for the sub-content to mount and
          // click "Create organization" scoped INSIDE it — clicking during
          // the loading re-render dismisses the whole menu.
          await page.getByRole("menuitem", { name: currentOrg }).click();
          const subContent = page.locator('[data-slot="dropdown-menu-sub-content"]');
          await subContent.waitFor({ state: "visible" });
          await subContent.getByText("Create organization", { exact: true }).click();
          await page.getByText("Add another organization").waitFor();
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
        const cookie = (await page.context().cookies())
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");
        const response = await fetch(new URL("/api/auth/organizations", ctx.target.baseUrl), {
          headers: { cookie },
        });
        const body = (await response.json()) as { organizations: ReadonlyArray<{ name: string }> };
        expect(body.organizations.length, "exactly the free-plan allowance exists").toBe(
          FREE_LIMIT,
        );
      });
    }),
);
