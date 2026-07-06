// Cloud-specific (browser): an admin permanently deletes their organization.
// A fresh user creates an org through onboarding, opens Organization settings,
// and uses the danger-zone "Delete organization" flow — which requires
// re-typing the org name to confirm. Deleting tears the org down in WorkOS +
// billing + the tenant database and clears the session, so the app drops the
// user out of the (now gone) workspace.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Organizations · an admin deletes the organization from settings",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity({ org: false });

    yield* browser.session(identity, async ({ page, step }) => {
      const ORG = "Doomed Org";

      await step("Fresh user creates an org via onboarding", async () => {
        await page.goto("/", { waitUntil: "networkidle" });
        await page.getByPlaceholder("Northwind Labs").fill(ORG);
        await page.getByRole("button", { name: "Create organization" }).click();
        await page.getByText("Connect your MCP client").waitFor();
        await page.getByRole("button", { name: "Continue to app" }).click();
        await page.getByText("Integrations").first().waitFor();
        // The console canonicalizes onto the org's URL slug (/doomed-org).
        await page.waitForURL((url) => /^\/[a-z0-9-]+\/?$/.test(url.pathname), {
          timeout: 30_000,
        });
        await page.waitForLoadState("networkidle");
      });

      const slug = new URL(page.url()).pathname.split("/").filter(Boolean)[0]!;

      await step("Open Organization settings and find the danger zone", async () => {
        await page.goto(`/${slug}/org`, { waitUntil: "networkidle" });
        // The admin-only danger zone renders (a member would not see it).
        await page.getByText("Permanently delete this organization").waitFor();
      });

      await step("The confirm button stays disabled until the name matches", async () => {
        // Open the confirmation dialog from the danger-zone Delete button.
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        const confirm = dialog.getByRole("button", { name: "Delete organization" });
        expect(await confirm.isDisabled(), "cannot delete before typing the name").toBe(true);

        // A wrong value keeps it disabled; the exact org name enables it.
        await page.getByLabel(/to confirm/i).fill("not the name");
        expect(await confirm.isDisabled()).toBe(true);
        await page.getByLabel(/to confirm/i).fill(ORG);
        expect(await confirm.isEnabled(), "the exact org name unlocks deletion").toBe(true);
      });

      await step("Confirming deletes the org and drops the user out of it", async () => {
        await page.getByRole("dialog").getByRole("button", { name: "Delete organization" }).click();

        // Deletion clears the session and navigates to "/". The org console is
        // gone: the deleted slug no longer resolves for this browser, so it
        // never lands back on the org settings page.
        await page.waitForURL((url) => !url.pathname.startsWith(`/${slug}/org`), {
          timeout: 30_000,
        });
        expect(await page.getByText("Permanently delete this organization").count()).toBe(0);
      });
    });
  }),
);
