// Cloud-specific (browser): switching organizations changes the active workspace.
// An account in two organizations (they exist in WorkOS; v1 creates none, see
// `addOrg`) opens the second, finds the switcher's link to create an
// organization in Executor v2 where v1's create dialog used to be, then uses
// the switcher to return to the first org and confirms the workspace label in
// the bottom-left account button updates.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { visit, settle } from "../src/surfaces/browser";
import { addOrg } from "./support/session";

const NEW_ORG_LINK = "New organization in Executor v2";

scenario(
  "Organizations · switching organizations switches the workspace",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;

    const ORG_1 = "Switcher Org One";
    const ORG_2 = "Switcher Org Two";
    const account = yield* target.newIdentity({ org: false });
    yield* addOrg(target, account, ORG_1);
    const { org: org2, identity } = yield* addOrg(target, account, ORG_2);

    yield* browser.session(identity, async ({ page, step }) => {
      await step(`Open "${ORG_2}"`, async () => {
        await visit(page, `/${org2.slug}`);
        await page.getByText("Integrations").first().waitFor();
        await page.getByRole("button", { name: new RegExp(ORG_2) }).waitFor();
        // Let the router navigation fully settle before opening menus — a late
        // remount closes them mid-interaction.
        await settle(page);
      });

      // Capture the label while we are in ORG_2 as a baseline.
      const labelInOrg2 = await page.getByRole("button", { name: new RegExp(ORG_2) }).innerText();
      expect(labelInOrg2, "account button shows the second org").toContain(ORG_2);

      const subContent = page.locator('[data-slot="dropdown-menu-sub-content"]');

      // ── The switcher offers v2 for new organizations, not v1 ─────────
      await step("Open the org switcher: new organizations open Executor v2", async () => {
        // Bounded retry: under parallel-suite load the radix menu re-renders
        // while the org list loads and a click can land on a closing menu.
        for (let attempt = 1; ; attempt++) {
          try {
            await page.keyboard.press("Escape");
            await page.getByRole("button", { name: /Test User/ }).click();
            await page.getByRole("menuitem", { name: ORG_2 }).click({ timeout: 5_000 });
            await subContent.waitFor({ state: "visible", timeout: 5_000 });
            await subContent.getByRole("menuitem", { name: ORG_1 }).waitFor({ timeout: 5_000 });
            break;
          } catch (error) {
            if (attempt >= 3) throw error;
          }
        }
        const newOrgLink = subContent.getByRole("menuitem", { name: NEW_ORG_LINK });
        expect(
          await newOrgLink.getAttribute("href"),
          "the link is v1's create-org address, which the auth gate answers with v2's sign-up page",
        ).toBe("/create-org");
        expect(await newOrgLink.getAttribute("target"), "it opens in a new tab").toBe("_blank");
        expect(
          await subContent.getByText("Create organization", { exact: true }).count(),
          "v1's create-organization dialog is gone",
        ).toBe(0);
      });

      // ── Switch to the first org ──────────────────────────────────────
      await step(`Switch to "${ORG_1}" from the org switcher`, async () => {
        await subContent.getByRole("menuitem", { name: ORG_1 }).click();
        // The page navigates to ORG_1's URL and the workspace re-scopes.
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
