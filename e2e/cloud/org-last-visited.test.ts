// Cloud-only (browser): a bare entry (`/`) lands in the org this browser LAST
// worked in, not the org pinned into the session cookie at login time.
//
// Org switching is stateless (the URL slug scopes every request; nothing
// rewrites the session cookie), so without extra memory a bare entry would
// always canonicalize onto the session's login-time org — for a multi-org user
// that reads as "executor.sh forgot which org I was on". The last-org cookie
// (`executor-last-org`) is that memory: the client records the slug of the org
// it is verifiably viewing, and the SSR gate redirects bare document requests
// onto it after re-checking live membership.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";
import { activeOrg, addOrg } from "./support/session";

scenario(
  "Org URLs · a bare entry lands in the last-visited org, not the session's login org",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;

    // Identity starts in org A, then joins org B and signs in to it — the
    // SESSION is pinned to org B, so without the last-org cookie every bare
    // entry would land in B.
    const identity = yield* target.newIdentity();
    const { slug: slugA } = yield* activeOrg(target, identity);
    const { org: orgB, identity: inB } = yield* addOrg(target, identity, "Last Visited Org B");
    expect(slugA, "the two orgs have distinct slugs").not.toBe(orgB.slug);

    // Drive the browser as the session pinned to B.
    yield* browser.session(inB, async ({ page, step }) => {
      await step("Work in org A by its slug URL (the session still pins org B)", async () => {
        await visit(page, `/${slugA}`);
        await page.getByText("Integrations").first().waitFor({ timeout: 30_000 });
        // The client records the viewed org once /account/me confirms it.
        await page.waitForFunction(
          (slug) => document.cookie.includes(`executor-last-org=${slug}`),
          slugA,
          { timeout: 30_000 },
        );
      });

      await step("A bare entry (`/`) returns to org A, not the session's org B", async () => {
        await visit(page, "/");
        await page.waitForURL(
          (url) => url.pathname === `/${slugA}` || url.pathname === `/${slugA}/`,
          {
            timeout: 30_000,
          },
        );
        await page.getByText("Integrations").first().waitFor({ timeout: 30_000 });
      });

      await step("A bare deep link keeps its path while landing in org A", async () => {
        await visit(page, "/policies");
        await page.waitForURL((url) => url.pathname === `/${slugA}/policies`, { timeout: 30_000 });
        await page.getByText("Policies").first().waitFor({ timeout: 30_000 });
      });
    });
  }),
);
