// Cloud-only (browser): opening another of YOUR orgs by its slug URL just
// works — no switch, no cookie rewrite. The slug in the path is the request
// scope (the `x-executor-organization` header), and the session authenticates
// the user to ALL their orgs at once, so a bookmark or a teammate's link into a
// shared org lands you there regardless of which org the cookie happens to pin.
//
// org-switcher.test.ts covers the account-menu navigation; this covers the URL
// path. (Unknown/unauthorized slugs → 404 is covered by
// scenarios/org-slug-routing.test.ts; two tabs at once by
// org-multitab-cookie.test.ts.)
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";
import { activeOrg, addOrg, cookieOf } from "./support/session";

scenario(
  "Org URLs · opening another of your orgs by slug works without switching the session",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;

    // Identity starts in org A, then joins org B and signs in to it: the
    // session is pinned to B.
    const identity = yield* target.newIdentity();
    const { slug: slugA } = yield* activeOrg(target, identity);
    const { org: orgB, identity: inB } = yield* addOrg(target, identity, "Foreign Slug Org B");
    const sessionB = cookieOf(inB).slice("wos-session=".length);
    expect(slugA, "the two orgs have distinct slugs").not.toBe(orgB.slug);

    // Drive the browser as the session pinned to B.
    yield* browser.session(inB, async ({ page, step }) => {
      await step("Land in org B, then open org A's slug URL directly", async () => {
        await visit(page, `/${orgB.slug}`);
        await page.getByText("Integrations").first().waitFor({ timeout: 30_000 });
        // Open org A by its slug while the cookie is still pinned to B.
        await visit(page, `/${slugA}/policies`);
      });

      await step("Org A's page renders at its slugged URL — the URL is the scope", async () => {
        // Reaching org A's policies at its URL is the proof the request scoped
        // to A off the URL alone: a model that required the cookie to name A
        // would 404 here (the cookie still says B).
        await page.waitForURL((url) => url.pathname === `/${slugA}/policies`, { timeout: 30_000 });
        await page.getByText("Policies").first().waitFor({ timeout: 30_000 });
        // And no switch happened: the session cookie still names org B.
        const sessionCookie = (await page.context().cookies())
          .find((c) => c.name === "wos-session")
          ?.value.split(";")[0];
        expect(sessionCookie, "the session cookie was never rewritten — no switch").toBe(sessionB);
      });
    });
  }),
);
