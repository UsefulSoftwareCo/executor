import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";
import { createInvitedIdentity } from "../targets/selfhost";

scenario(
  "Admin · the self-hosted admin area is visible and accessible only to admins",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const owner = yield* target.newIdentity();
    const member = yield* Effect.promise(() =>
      createInvitedIdentity(target.baseUrl, owner, {
        role: "member",
        emailPrefix: "admin-area-member",
      }),
    );

    yield* browser.session(owner, async ({ page, step }) => {
      await step("The instance owner can open Admin from the sidebar", async () => {
        await visit(page, "/");
        const adminLink = page.locator("nav").getByRole("link", { name: "Admin", exact: true });
        await adminLink.waitFor({ state: "visible", timeout: 30_000 });
        await adminLink.click();
        await page.getByRole("heading", { name: "Admin", exact: true }).waitFor({
          state: "visible",
          timeout: 30_000,
        });
        await page
          .getByText(owner.credentials?.email ?? "", { exact: true })
          .first()
          .waitFor({
            state: "visible",
            timeout: 30_000,
          });
      });
    });

    yield* browser.session(member, async ({ page, step }) => {
      await step("A plain member is not offered the Admin section", async () => {
        // Wait for the member list that drives role-aware navigation to settle.
        // Otherwise asserting immediately after the shell appears could pass
        // merely because every admin link starts hidden during hydration.
        await visit(page, "/organization");
        await page
          .getByText(member.credentials?.email ?? "", { exact: true })
          .first()
          .waitFor({ state: "visible", timeout: 30_000 });
        expect(
          await page.locator("nav").getByRole("link", { name: "Admin", exact: true }).count(),
          "a plain member must not see the Admin link",
        ).toBe(0);
      });

      await step("A plain member who opens the Admin URL is refused", async () => {
        await visit(page, "/admin");
        await page.getByText("You don't have access to this instance's admin area").waitFor({
          state: "visible",
          timeout: 30_000,
        });
        expect(
          await page.getByText(owner.credentials?.email ?? "", { exact: true }).count(),
          "the refusal must not expose the owner's email",
        ).toBe(0);
        expect(
          await page.getByRole("heading", { name: "Members", exact: true }).count(),
          "the refusal must replace the member directory",
        ).toBe(0);
        expect(
          await page.getByRole("button", { name: "Create invite" }).count(),
          "the refusal must replace the admin controls",
        ).toBe(0);
      });
    });
  }),
);
