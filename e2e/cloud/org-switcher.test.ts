// Cloud-specific (browser): switching organizations changes the active workspace.
// A fresh user creates two organizations through the real web UI — the first
// via onboarding and the second via the account-menu → org switcher → "Create
// organization" modal — then uses the same switcher to return to the first org
// and confirms the workspace label in the bottom-left account button updates.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Organizations · switching organizations switches the workspace",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity({ org: false });

    yield* browser.session(identity, async ({ page, step }) => {
      // ── Step 1: onboarding, create the first org ─────────────────────
      await step("Fresh user lands on onboarding (no organization yet)", async () => {
        await page.goto("/", { waitUntil: "networkidle" });
        await page.getByPlaceholder("Northwind Labs").waitFor();
      });

      const ORG_1 = "Switcher Org One";
      const ORG_2 = "Switcher Org Two";

      await step(`Create "${ORG_1}" via onboarding`, async () => {
        await page.getByPlaceholder("Northwind Labs").fill(ORG_1);
        await page.getByRole("button", { name: "Create organization" }).click();
        // Onboarding step 2 — proves the first org was created.
        await page.getByText("Connect your MCP client").waitFor();
      });

      await step("Continue into the app", async () => {
        await page.getByRole("button", { name: "Continue to app" }).click();
        await page.getByText("Integrations").first().waitFor();
        // Let the router navigation fully settle before opening menus — a late
        // remount closes them mid-interaction.
        await page.waitForURL(/\/$/, { timeout: 30_000 });
        await page.waitForLoadState("networkidle");
      });

      // ── Step 2: create the second org via the account-menu switcher ──
      await step('Open the org switcher and choose "Create organization"', async () => {
        // Bounded retry: under parallel-suite load the radix menu re-renders
        // while the org list loads and a click can land on a closing menu.
        for (let attempt = 1; ; attempt++) {
          try {
            await page.keyboard.press("Escape");
            await page.getByRole("button", { name: /Test User/ }).click();
            await page.getByRole("menuitem", { name: ORG_1 }).click({ timeout: 5_000 });
            const subContent = page.locator('[data-slot="dropdown-menu-sub-content"]');
            await subContent.waitFor({ state: "visible", timeout: 5_000 });
            await subContent
              .getByText("Create organization", { exact: true })
              .click({ timeout: 5_000 });
            await page.getByText("Add another organization").waitFor({ timeout: 5_000 });
            break;
          } catch (error) {
            if (attempt >= 3) throw error;
          }
        }
      });

      await step(`Create "${ORG_2}" via the org switcher modal`, async () => {
        await page.getByPlaceholder("Northwind Labs").fill(ORG_2);
        await page.getByRole("button", { name: "Create organization" }).click();
        // The modal closes and the session switches into the new org.
        await page.getByText("Add another organization").waitFor({ state: "hidden" });
        // Confirm the account button now shows ORG_2.
        await page.getByRole("button", { name: new RegExp(ORG_2) }).waitFor();
      });

      // Capture the label while we are in ORG_2 as a baseline.
      const labelAfterOrg2 = await page
        .getByRole("button", { name: new RegExp(ORG_2) })
        .innerText();
      expect(labelAfterOrg2, "account button shows the second org after creation").toContain(ORG_2);

      // ── Step 3: switch back to the first org ─────────────────────────
      // The org-switcher sub-menu shows org IDs (not names) because the stub's
      // getOrganization returns the ID as the name. The currently-active org is
      // rendered with data-disabled="" (Radix convention). The only item without
      // data-disabled that isn't "Create organization" is ORG_1.
      await step(`Open the org switcher and switch back to "${ORG_1}"`, async () => {
        await page.waitForLoadState("networkidle");
        await page.getByRole("button", { name: /Test User/ }).click();
        // Click the SubTrigger (shows current org name = ORG_2) to expand the list.
        await page.getByRole("menuitem", { name: ORG_2 }).click();
        // Wait for the sub-content to open.
        await page.locator('[data-slot="dropdown-menu-sub-content"]').waitFor({ state: "visible" });
        // The organizationsAtom loads asynchronously — wait until the loading state
        // clears and the org items appear. The org items have data-disabled="" when
        // active and no data-disabled when not. "Create organization" is always shown
        // and always enabled; wait until there are at least 2 non-disabled items
        // (the non-active org + "Create organization") before clicking.
        await page
          .locator('[data-slot="dropdown-menu-sub-content"]')
          .locator('[role="menuitem"]:not([data-disabled])')
          .nth(1)
          .waitFor();
        // Now the sub-content has loaded. The org items appear BEFORE the separator and
        // "Create organization". ORG_1 (non-active, not disabled) appears before ORG_2
        // (active, disabled) and before "Create organization". Click the first
        // non-disabled item that is NOT "Create organization" — that is ORG_1.
        await page
          .locator('[data-slot="dropdown-menu-sub-content"]')
          .locator('[role="menuitem"]:not([data-disabled])')
          .filter({ hasNot: page.getByText("Create organization") })
          .first()
          .click();
        // The menu closes, the page reloads, and the session switches into ORG_1.
        await page.getByRole("button", { name: new RegExp(ORG_1) }).waitFor();
      });

      // ── Assert: workspace label reflects the first org ───────────────
      const labelAfterSwitch = await page
        .getByRole("button", { name: new RegExp(ORG_1) })
        .innerText();
      expect(labelAfterSwitch, "account button shows the first org after switching back").toContain(
        ORG_1,
      );

      // Cross-check the active org through the session API.
      const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
      const response = await fetch(new URL("/api/auth/organizations", target.baseUrl), {
        headers: { cookie },
      });
      const body = (await response.json()) as {
        organizations: ReadonlyArray<{ name: string }>;
        activeOrganizationId?: string;
      };
      expect(response.ok).toBe(true);
      expect(body.organizations.length, "exactly two organizations exist for this user").toBe(2);
    });
  }),
);
