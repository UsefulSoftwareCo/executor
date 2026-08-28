// Selfhost-only: the admin Users PAGER, which no other scenario reaches.
//
// The page shows 25 users at a time. To know whether a "Next" exists without a
// count endpoint, the atom over-fetches by one (`limit: 25 + 1`) and `splitPage`
// drops the extra row to derive `hasNext`. That +1/-1 pair is an off-by-one
// waiting to happen in the most damaging place: the page BOUNDARY. Drop one row
// too many and user #25 is invisible on every page — present in the workspace,
// absent from the operator's view, with no error anywhere. Drop one too few and
// the same person appears twice.
//
// Both existing admin console scenarios seed two members, so the pager never
// renders at all and none of that logic is exercised. This one seeds past the
// page size and walks the boundary.
//
// Self-host rather than cloud because cloud's free plan caps a workspace at 3
// member seats — 26 members cannot exist there. Self-host has one turnkey org,
// no seat gate, and an admin invite plane that mints codes freely.
//
// A user earns their row in the workspace the first time they touch the
// EXECUTOR plane (`touchSubject` at the request seam) — signing up alone is not
// enough, so each seeded identity makes one product read.
//
// The org is SHARED with every other selfhost scenario in the run, so this
// asserts "contains mine, split correctly across pages" and never a global
// count or a fixed row index. Rows are matched by the emails this scenario
// minted, under a per-run prefix.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { createInvitedIdentity } from "../targets/selfhost";
import type { Identity } from "../src/target";

/** The page size the atom and the page component share
 *  (`ADMIN_USERS_PAGE_SIZE`). Restated rather than imported: this is the
 *  contract the UI promises an operator, and a scenario that imported it would
 *  silently follow the product if it changed. */
const PAGE_SIZE = 25;

/** Enough seeded users that a second page must exist even in a workspace that
 *  starts empty — one more than a full page. */
const SEEDED_USERS = PAGE_SIZE + 1;

/** The `[data-slot='admin-user-name']` values on the page right now. Rows are
 *  named by email on this host, which is what this scenario matches on. */
const rowNames = (page: Page): Promise<Array<string>> =>
  page
    .locator("[data-slot='admin-user-row'] [data-slot='admin-user-name']")
    .evaluateAll((elements) => elements.map((element) => element.textContent ?? ""));

scenario(
  "Admin · the Users pager walks a workspace larger than one page without dropping or repeating anyone",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;

    const owner = yield* target.newIdentity();

    // A per-run prefix so this scenario's rows are identifiable among the users
    // other selfhost scenarios left in the shared org.
    const prefix = `pager-${randomBytes(4).toString("hex")}`;

    // Seed past the page size. Each identity then makes ONE executor-plane read,
    // which is what mints its `subject` row — without it the account exists in
    // the auth store but never appears on this page.
    const seeded = yield* Effect.forEach(
      Array.from({ length: SEEDED_USERS }, (_, index) => index),
      (index) =>
        Effect.promise(async (): Promise<Identity> => {
          const identity = await createInvitedIdentity(target.baseUrl, owner, {
            role: "member",
            emailPrefix: `${prefix}-${String(index).padStart(2, "0")}`,
          });
          const response = await fetch(new URL("/api/integrations", target.baseUrl), {
            headers: { cookie: identity.headers?.cookie ?? "" },
          });
          if (!response.ok) {
            throw new Error(`seeding read failed for ${identity.label} (${response.status})`);
          }
          return identity;
        }),
      // Bounded: one dev server, one database connection, and a password hash
      // per signup. Unbounded here would starve the server rather than go
      // faster.
      { concurrency: 4 },
    );

    const seededEmails = new Set(seeded.map((identity) => identity.credentials?.email ?? ""));
    expect(seededEmails.size, "every seeded member has a distinct email").toBe(SEEDED_USERS);

    yield* browser.session(owner, async ({ page, step }) => {
      let firstPage: ReadonlyArray<string> = [];
      let secondPage: ReadonlyArray<string> = [];

      await step("Open the Users page", async () => {
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await page.getByRole("link", { name: "Users" }).click();
        await page.waitForURL((url) => url.pathname.endsWith("/users"), { timeout: 30_000 });
        await page.locator("[data-slot='admin-users-table']").waitFor({ timeout: 30_000 });
      });

      await step("The first page is full and offers a next page", async () => {
        await page.locator("[data-slot='admin-user-row']").first().waitFor({ timeout: 30_000 });
        firstPage = await rowNames(page);
        // Exactly the page size — this is the `limit + 1` over-fetch being
        // trimmed back. A page of 26 would mean `splitPage` failed to drop the
        // probe row and the operator sees a row that belongs to page 2.
        expect(firstPage.length, "a full page shows exactly the page size").toBe(PAGE_SIZE);
        await page.getByText("Page 1", { exact: false }).waitFor({ timeout: 30_000 });
        // The over-fetch exists precisely to answer this without a count.
        await expectEnabled(page, "Next", true);
        await expectEnabled(page, "Previous", false);
      });

      await step("Next advances to a second page of different people", async () => {
        await page.getByRole("button", { name: "Next" }).click();
        await page.getByText("Page 2", { exact: false }).waitFor({ timeout: 30_000 });
        await page.locator("[data-slot='admin-user-row']").first().waitFor({ timeout: 30_000 });
        secondPage = await rowNames(page);
        expect(secondPage.length, "the second page has rows").toBeGreaterThan(0);

        // THE boundary invariant, and the whole reason this scenario exists:
        // the +1 over-fetch must not leak a row onto both pages, and the -1
        // trim must not swallow one between them.
        const overlap = secondPage.filter((name) => firstPage.includes(name));
        expect(
          overlap,
          "no one appears on both pages — the +1 probe row is not shown twice",
        ).toEqual([]);

        // And nobody fell into the gap: every user this scenario seeded is on
        // one of the two pages. Asserted over MY rows only, since the shared
        // org also holds users from other scenarios.
        const seen = new Set([...firstPage, ...secondPage]);
        const missing = [...seededEmails].filter((email) => !seen.has(email));
        expect(missing, "every seeded member is on one of the two pages").toEqual([]);

        await expectEnabled(page, "Previous", true);
      });

      await step("Previous returns to the identical first page", async () => {
        await page.getByRole("button", { name: "Previous" }).click();
        await page.getByText("Page 1", { exact: false }).waitFor({ timeout: 30_000 });
        await page.locator("[data-slot='admin-user-row']").first().waitFor({ timeout: 30_000 });
        // Same rows, same order: paging back is navigation, not a reshuffle.
        // `listSubjects` orders by (created_at, external_id), a total order, so
        // this is a guarantee rather than a coincidence.
        expect(await rowNames(page), "going back shows the same first page").toEqual(firstPage);
        await expectEnabled(page, "Previous", false);
      });
    });
  }),
);

/** Assert a pager button's enabled state — the affordance an operator reads to
 *  know whether a page exists in that direction. */
const expectEnabled = async (page: Page, name: string, enabled: boolean): Promise<void> => {
  expect(
    await page.getByRole("button", { name }).isEnabled(),
    `${name} is ${enabled ? "offered" : "not offered"}`,
  ).toBe(enabled);
};
