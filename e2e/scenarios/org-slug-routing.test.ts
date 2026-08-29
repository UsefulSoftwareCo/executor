// Cross-target (browser): org-slug console URLs. Console routes live under an
// optional `{-$orgSlug}` segment and the authenticated shell canonicalizes
// the URL onto the ACTIVE organization's slug — this scenario pins that
// contract end to end through the real web UI:
//
//   - /account/me advertises the org's URL slug (valid grammar)
//   - a bare deep link (/policies) canonicalizes to /<slug>/policies
//   - an unknown slug (/zz-no-such-org/policies) is a wrong address on a
//     multi-tenant host — a not-found page with the console shell never built
//     at any point, never a silent redirect into a workspace the URL didn't
//     name (a single-tenant host canonicalizes it instead; both are pinned)
//   - in-shell navigation keeps the slug prefix on every link
//
// Cloud's switch-into-another-org-by-URL behavior is covered separately by
// cloud/org-switcher.test.ts; this scenario only uses slugs no identity owns.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { AccountHttpApi, isValidOrgSlug } from "@executor-js/api";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

declare global {
  interface Window {
    /** Set by this scenario's init script the first time a console shell
     *  sidebar is attached to the document. Test-only. */
    __executorShellEverMounted?: boolean;
  }
}

scenario(
  "Org URLs · console paths carry the organization slug",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();

    // The slug the URL must canonicalize onto, from the same account surface
    // the shell reads.
    const client = yield* apiClient(AccountHttpApi, identity);
    const me = yield* client.account.me();
    const slug = me.organization?.slug;
    expect(slug, "the active organization advertises a URL slug").toBeTruthy();
    expect(isValidOrgSlug(slug!) || slug === "default", "the slug fits the URL grammar").toBe(true);

    yield* browser.session(identity, async ({ page, step }) => {
      await step("A bare deep link canonicalizes onto the org slug", async () => {
        await visit(page, "/policies");
        await page.waitForURL((url) => url.pathname === `/${slug}/policies`, {
          timeout: 30_000,
        });
        await page.getByText("Policies").first().waitFor();
      });

      // What an unknown slug MEANS depends on tenancy, so both answers are
      // pinned rather than one being skipped:
      //
      //   multi-tenant (cloud) — the slug is a real request scope. /account/me
      //     returns no organization for one this session cannot see, so the
      //     address is simply wrong: a not-found page, the URL left exactly as
      //     typed, and no console shell built at any point along the way.
      //   single-tenant (selfhost) — /account/me always returns the instance
      //     org regardless of the URL segment, so the slug is cosmetic and
      //     OrgSlugGate canonicalizes it onto the shell instead.
      const singleTenant = target.name.startsWith("selfhost");

      // Waiting for the not-found text on its own is not enough. The shell used
      // to render first from the auth-hint cookie — which names the session's
      // OWN org, never the URL's — and correct itself only once /account/me
      // answered, so a run that flashed an entire workspace under a foreign
      // address still ended on "Page not found" and passed. Record the shell
      // from before the page's own scripts run, so a sidebar that exists for a
      // single frame is still caught long after it is gone.
      await page.addInitScript(() => {
        window.__executorShellEverMounted = false;
        const look = () => {
          if (document.querySelector('aside, button[aria-label="Open navigation"]')) {
            window.__executorShellEverMounted = true;
          }
        };
        new MutationObserver(look).observe(document, { childList: true, subtree: true });
        look();
      });

      await step("An unknown org slug resolves by tenancy, never by redirect", async () => {
        await visit(page, "/zz-no-such-org/policies");
        if (singleTenant) {
          await page.waitForURL((url) => url.pathname === `/${slug}/policies`, { timeout: 30_000 });
        } else {
          await page.getByText("Page not found").waitFor({ timeout: 30_000 });
        }

        const landed = {
          pathname: new URL(page.url()).pathname,
          shellEverMounted: await page.evaluate(() => window.__executorShellEverMounted === true),
        };
        expect(landed, "an unknown slug never lands in a workspace the URL did not name").toEqual(
          singleTenant
            ? { pathname: `/${slug}/policies`, shellEverMounted: true }
            : { pathname: "/zz-no-such-org/policies", shellEverMounted: false },
        );
      });

      await step("In-shell navigation keeps the slug prefix", async () => {
        await visit(page, `/${slug}`);
        await page.getByRole("link", { name: "Policies" }).first().click();
        await page.waitForURL((url) => url.pathname === `/${slug}/policies`, {
          timeout: 30_000,
        });
        await page.getByRole("link", { name: "Integrations" }).first().click();
        await page.waitForURL((url) => url.pathname === `/${slug}`, { timeout: 30_000 });
      });
    });
  }),
);
