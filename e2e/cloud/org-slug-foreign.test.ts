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

const CLOUD_ORIGIN_HEADERS = (baseUrl: string) => ({ origin: new URL(baseUrl).origin });

scenario(
  "Org URLs · opening another of your orgs by slug works without switching the session",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;

    // Identity starts in org A. Create org B through the real endpoint, which
    // returns its refreshed cookie (the session is now pinned to B).
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
    expect(sessionB, "creating org B pinned the session into it").toBeTruthy();

    // Both orgs' slugs (the org list is the same whichever org the cookie pins).
    const orgs = (yield* Effect.promise(() =>
      fetch(new URL("/api/auth/organizations", target.baseUrl), {
        headers: { cookie: `wos-session=${sessionB}` },
      }).then((r) => r.json()),
    )) as {
      organizations: ReadonlyArray<{ name: string; slug: string }>;
    };
    const slugA = orgs.organizations.find((o) => o.name.startsWith("Org user-"))?.slug;
    expect(slugA, "org A has a slug").toBeTruthy();
    expect(orgB.slug, "org B has a slug").toBeTruthy();
    expect(slugA, "the two orgs have distinct slugs").not.toBe(orgB.slug);

    // Drive the browser as the session pinned to B.
    const inB = {
      ...identity,
      headers: { cookie: `wos-session=${sessionB}` },
      cookies: [{ name: "wos-session", value: sessionB! }],
    };

    yield* browser.session(inB, async ({ page, step }) => {
      await step("Land in org B, then open org A's slug URL directly", async () => {
        await page.goto(`/${orgB.slug}`, { waitUntil: "networkidle" });
        await page.getByText("Integrations").first().waitFor({ timeout: 30_000 });
        // Open org A by its slug while the cookie is still pinned to B.
        await page.goto(`/${slugA}/policies`, { waitUntil: "networkidle" });
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
