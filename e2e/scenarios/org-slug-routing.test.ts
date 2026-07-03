// Cross-target (browser): org-slug console URLs. Console routes live under an
// optional `{-$orgSlug}` segment and the authenticated shell canonicalizes
// the URL onto the ACTIVE organization's slug — this scenario pins that
// contract end to end through the real web UI:
//
//   - /account/me advertises the org's URL slug (valid grammar)
//   - a bare deep link (/policies) canonicalizes to /<slug>/policies
//   - an unknown slug (/zz-no-such-org/policies) is a wrong address — a
//     not-found page, never a silent redirect into a workspace the URL
//     didn't name
//   - in-shell navigation keeps the slug prefix on every link
//
// Cloud's switch-into-another-org-by-URL behavior is covered separately by
// cloud/org-switcher.test.ts; this scenario only uses slugs no identity owns.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { AccountHttpApi, isValidOrgSlug } from "@executor-js/api";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

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
        await page.goto("/policies", { waitUntil: "networkidle" });
        await page.waitForURL((url) => url.pathname === `/${slug}/policies`, {
          timeout: 30_000,
        });
        await page.getByText("Policies").first().waitFor();
      });

      // The "unknown slug is a 404" contract is multi-tenant only. Selfhost is
      // single-tenant: /account/me always returns the instance org regardless of
      // the URL segment, so the slug is cosmetic and an unknown one canonicalizes
      // onto the shell rather than 404ing. Cloud enforces the not-found; selfhost
      // legitimately does not.
      if (target.name !== "selfhost") {
        await step("An unknown org slug is a wrong address, not a redirect", async () => {
          await page.goto("/zz-no-such-org/policies", { waitUntil: "networkidle" });
          await page.getByText("Page not found").waitFor({ timeout: 30_000 });
        });
      }

      await step("In-shell navigation keeps the slug prefix", async () => {
        await page.goto(`/${slug}`, { waitUntil: "networkidle" });
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
