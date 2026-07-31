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

const CLOUD_ORIGIN_HEADERS = (baseUrl: string) => ({ origin: new URL(baseUrl).origin });

scenario(
  "Org URLs · a bare entry lands in the last-visited org, not the session's login org",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;

    // Identity starts in org A. Create org B through the real endpoint, which
    // returns the refreshed cookie — the SESSION is now pinned to org B, so
    // without the last-org cookie every bare entry would land in B.
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
        body: JSON.stringify({ name: "Last Visited Org B" }),
      }),
    );
    expect(createB.ok, "org B was created").toBe(true);
    const orgB = (yield* Effect.promise(() => createB.json())) as { slug: string };
    const setCookie = createB.headers.get("set-cookie") ?? "";
    const sessionB = /wos-session=([^;]+)/.exec(setCookie)?.[1];
    expect(sessionB, "creating org B pinned the session into it").toBeTruthy();

    const orgs = (yield* Effect.promise(() =>
      fetch(new URL("/api/auth/organizations", target.baseUrl), {
        headers: { cookie: `wos-session=${sessionB}` },
      }).then((r) => r.json()),
    )) as { organizations: ReadonlyArray<{ name: string; slug: string }> };
    const slugA = orgs.organizations.find((o) => o.name.startsWith("Org user-"))?.slug;
    expect(slugA, "org A has a slug").toBeTruthy();
    expect(slugA, "the two orgs have distinct slugs").not.toBe(orgB.slug);

    // Drive the browser as the session pinned to B.
    const inB = {
      ...identity,
      headers: { cookie: `wos-session=${sessionB}` },
      cookies: [{ name: "wos-session", value: sessionB! }],
    };

    yield* browser.session(inB, async ({ page, step }) => {
      await step("Work in org A by its slug URL (the session still pins org B)", async () => {
        await page.goto(`/${slugA}`, { waitUntil: "networkidle" });
        await page.getByText("Integrations").first().waitFor({ timeout: 30_000 });
        // The client records the viewed org once /account/me confirms it.
        await page.waitForFunction(
          (slug) => document.cookie.includes(`executor-last-org=${slug}`),
          slugA,
          { timeout: 30_000 },
        );
      });

      await step("A bare entry (`/`) returns to org A, not the session's org B", async () => {
        await page.goto("/", { waitUntil: "networkidle" });
        await page.waitForURL(
          (url) => url.pathname === `/${slugA}` || url.pathname === `/${slugA}/`,
          {
            timeout: 30_000,
          },
        );
        await page.getByText("Integrations").first().waitFor({ timeout: 30_000 });
      });

      await step("A bare deep link keeps its path while landing in org A", async () => {
        await page.goto("/policies", { waitUntil: "networkidle" });
        await page.waitForURL((url) => url.pathname === `/${slugA}/policies`, { timeout: 30_000 });
        await page.getByText("Policies").first().waitFor({ timeout: 30_000 });
      });
    });
  }),
);
