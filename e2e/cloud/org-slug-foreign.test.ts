// Cloud-only (browser): opening another of YOUR orgs by its slug URL switches
// the session into it. The org-slug gate's foreign-slug branch (ForeignOrgSlug)
// resolves a URL slug that isn't the active org against the caller's
// memberships — a match switches + reloads, so a bookmark or a teammate's link
// into a shared org lands you there even when a different org is active.
//
// org-switcher.test.ts covers switching via the account menu; this covers the
// URL path. (Unknown/unauthorized slugs → 404 is covered by
// scenarios/org-slug-routing.test.ts.)
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

const CLOUD_ORIGIN_HEADERS = (baseUrl: string) => ({ origin: new URL(baseUrl).origin });

scenario(
  "Org URLs · opening another of your orgs by slug switches the session into it",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;

    // Identity starts in org A. Create org B through the real endpoint, which
    // switches the active session to B and returns its refreshed cookie.
    const identity = yield* target.newIdentity();
    const cookie = identity.headers?.cookie ?? "";

    const createB = yield* Effect.promise(() =>
      fetch(new URL("/api/auth/create-organization", target.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          ...CLOUD_ORIGIN_HEADERS(target.baseUrl),
        },
        body: JSON.stringify({ name: "Foreign Slug Org B" }),
      }),
    );
    expect(createB.ok, "org B was created").toBe(true);
    const orgB = (yield* Effect.promise(() => createB.json())) as { slug: string };
    const setCookie = createB.headers.get("set-cookie") ?? "";
    const sessionB = /wos-session=([^;]+)/.exec(setCookie)?.[1];
    expect(sessionB, "creating org B refreshed the session into it").toBeTruthy();

    // Both orgs' slugs from the session that is now active in B.
    const orgs = (yield* Effect.promise(() =>
      fetch(new URL("/api/auth/organizations", target.baseUrl), {
        headers: { cookie: `wos-session=${sessionB}` },
      }).then((r) => r.json()),
    )) as {
      organizations: ReadonlyArray<{ name: string; slug: string }>;
      activeOrganizationId: string;
    };
    const slugA = orgs.organizations.find((o) => o.name.startsWith("Org user-"))?.slug;
    expect(slugA, "org A has a slug").toBeTruthy();
    expect(orgB.slug, "org B has a slug").toBeTruthy();
    expect(slugA, "the two orgs have distinct slugs").not.toBe(orgB.slug);

    // Drive the browser as the session that is ACTIVE IN B.
    const inB = {
      ...identity,
      headers: { cookie: `wos-session=${sessionB}` },
      cookies: [{ name: "wos-session", value: sessionB! }],
    };

    yield* browser.session(inB, async ({ page, step }) => {
      await step("Land in org B, then open org A's slug URL directly", async () => {
        await page.goto(`/${orgB.slug}`, { waitUntil: "networkidle" });
        await page.getByText("Integrations").first().waitFor({ timeout: 30_000 });
        // Navigate to org A — the gate sees a foreign-but-member slug.
        await page.goto(`/${slugA}/policies`, { waitUntil: "networkidle" });
      });

      await step("The session switches into org A and lands on the slugged URL", async () => {
        // Reaching org A's policies at its URL is the proof: a switch that
        // failed would render the gate's 404 here, not the Policies page.
        await page.waitForURL((url) => url.pathname === `/${slugA}/policies`, { timeout: 30_000 });
        await page.getByText("Policies").first().waitFor({ timeout: 30_000 });
      });
    });
  }),
);
