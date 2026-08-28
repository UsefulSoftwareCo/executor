// Cloud-only: the Organization keys SECTION of the API keys page — the console
// surface over `/api/account/org-api-keys`, minting the machine credential for
// the tenant-wide admin plane.
//
// Two members are built through the real flows. The guarantees pinned here:
//
//   1. an ADMIN sees the section, mints an org key through the dialog, gets the
//      one-time reveal, and the minted value ACTUALLY authenticates the admin
//      API (the whole point of the credential);
//   2. the listing shows the key afterward and revoke asks for confirmation
//      before killing it — after which the value stops authenticating;
//   3. a PLAIN MEMBER never sees the section at all.
//
// Runs against emulate >= 0.13.9, whose WorkOS emulator serves the org-key
// routes (list/mint via /organizations/:id/api_keys, org-owner validation) —
// the gap that previously kept this scenario impossible.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { forBrowser, joinOrg } from "./support/session";
import { visit } from "../src/surfaces/browser";

declare global {
  interface Window {
    __e2eCopied?: Array<string>;
  }
}

scenario(
  "Admin · organization keys are minted in the console and authenticate the admin API",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;

    const admin = yield* target.newIdentity();
    const invitee = yield* target.newIdentity({ org: false });
    const member = yield* joinOrg(target, admin, invitee);

    let mintedValue = "";

    // ── The admin's view: mint, verify, revoke ──────────────────────────────
    yield* browser.session(forBrowser(admin), async ({ page, step }) => {
      let slug = "";

      await step("Land in the workspace and open the API keys page", async () => {
        await visit(page, "/");
        await page.waitForURL((url) => /^\/[a-z0-9-]+\/?$/.test(url.pathname), {
          timeout: 30_000,
        });
        slug = new URL(page.url()).pathname.split("/").filter(Boolean)[0] ?? "";
        await page.getByRole("link", { name: "API keys" }).click();
        await page.waitForURL((url) => url.pathname === `/${slug}/api-keys`, { timeout: 30_000 });
      });

      await step("The admin is offered the Organization keys section", async () => {
        await page
          .getByRole("heading", { name: "Organization keys", exact: true })
          .waitFor({ state: "visible", timeout: 30_000 });
      });

      await step("Mint an org key through the dialog and capture the reveal", async () => {
        await page.getByRole("button", { name: "New org key" }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByLabel("Name").fill("e2e backend reader");
        await dialog.getByRole("button", { name: "Create key" }).click();

        // The one-time secret panel renders once the key exists; its first
        // input holds the plaintext value (same shape the personal-key
        // feedback scenario reads).
        await dialog.getByText("It is only shown once").waitFor({ timeout: 30_000 });
        mintedValue = await dialog.locator("input").first().inputValue();
        expect(mintedValue, "a real key value is revealed once").toMatch(/^sk_/);
        await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
      });

      await step("The minted key appears in the org listing", async () => {
        await page
          .getByText("e2e backend reader")
          .first()
          .waitFor({ state: "visible", timeout: 30_000 });
      });

      await step("The minted value authenticates the tenant-wide admin API", async () => {
        // The credential's purpose, proven from outside the browser: a backend
        // holding ONLY this value can read the admin plane.
        const response = await fetch(new URL("/api/admin/users", target.baseUrl), {
          headers: { authorization: `Bearer ${mintedValue}` },
        });
        expect(response.status, "the org key reads the admin plane").toBe(200);
        const body = (await response.json()) as {
          users: ReadonlyArray<{ email: string | null }>;
        };
        expect(
          body.users.map((user) => user.email),
          "and sees the workspace's members",
        ).toContain(admin.credentials?.email);
      });

      await step("Revoke asks for confirmation, then the key stops working", async () => {
        await page.getByRole("button", { name: "Revoke e2e backend reader" }).click();
        // The confirm dialog names the key and warns; nothing is revoked yet.
        await page
          .getByRole("heading", { name: "Revoke organization key" })
          .waitFor({ state: "visible", timeout: 30_000 });
        await page.getByRole("button", { name: "Revoke key" }).click();
        await page
          .getByRole("heading", { name: "Revoke organization key" })
          .waitFor({ state: "hidden", timeout: 30_000 });

        // The revoked value no longer authenticates.
        const after = await fetch(new URL("/api/admin/users", target.baseUrl), {
          headers: { authorization: `Bearer ${mintedValue}` },
        });
        expect(after.status, "the revoked key is refused").toBe(401);
      });
    });

    // ── The plain member's view ───────────────────────────────────────────
    yield* browser.session(forBrowser(member), async ({ page, step }) => {
      await step("A plain member is not shown the Organization keys section", async () => {
        await visit(page, "/");
        await page.waitForURL((url) => /^\/[a-z0-9-]+\/?$/.test(url.pathname), {
          timeout: 30_000,
        });
        const slug = new URL(page.url()).pathname.split("/").filter(Boolean)[0] ?? "";
        await visit(page, `/${slug}/api-keys`);
        // The personal half renders for everyone…
        await page
          .getByRole("heading", { name: "Personal keys" })
          .waitFor({ state: "visible", timeout: 30_000 });
        // …the org section does not exist for a non-admin.
        expect(
          await page.getByRole("heading", { name: "Organization keys", exact: true }).count(),
          "a plain member is not shown a section that would only refuse them",
        ).toBe(0);
      });
    });
  }),
);
