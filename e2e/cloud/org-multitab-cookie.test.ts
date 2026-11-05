// Cloud-only (browser): two tabs, two orgs, at the same time — independent.
//
// WorkOS still pins ONE org into the sealed `wos-session` cookie, and the whole
// browser shares one cookie jar. Under the OLD cookie-based "active org" model
// that made "active organization" a browser-global: two tabs could not be in
// two orgs at once, and a switch (or the slug gate's switch-to-honor-the-URL)
// silently re-scoped the other tab out from under it.
//
// The stateless URL model removes that hazard. The slug in the path is the
// request scope: every API call carries it (the `x-executor-organization`
// header), the server re-checks live membership and resolves data for THAT
// org, and the session merely authenticates the user to all their orgs at
// once. Nothing writes the cookie on a switch. So this scenario — once the
// reproduction of the corruption — now asserts the opposite: each tab's
// requests stay scoped to its own URL org, no matter what the other tab does.
//
// The account's two orgs exist in WorkOS (v1 creates none; see `addOrg`) and
// the session is signed in before the browser opens; from then on only the
// browser uses it, so the single-use WorkOS refresh-token chain stays
// browser-owned and valid.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";
import { addOrg } from "./support/session";

scenario(
  "Org tabs · two tabs on different orgs stay independent (URL-scoped, no cookie steal)",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const account = yield* target.newIdentity({ org: false });
    const { org: orgA } = yield* addOrg(target, account, "Multitab A");
    const { org: orgB, identity } = yield* addOrg(target, account, "Multitab B");
    const slugA = orgA.slug;
    const slugB = orgB.slug;
    expect(slugB, "the two orgs have distinct slugs").not.toBe(slugA);

    yield* browser.session(identity, async ({ page: tab1, step }) => {
      // The org slug a page's REAL app requests carry — read straight off the
      // outgoing `x-executor-organization` header, the actual request scope.
      // This is what makes the two tabs independent; the shared session cookie
      // is irrelevant to it.
      const requestOrgSlugOf = async (page: typeof tab1): Promise<string> => {
        const matching = page.waitForRequest(
          (request) =>
            request.url().includes("/api/") &&
            request.headers()["x-executor-organization"] !== undefined,
          { timeout: 15_000 },
        );
        // Nudge the app to refetch so a fresh scoped request goes out.
        void page.reload({ waitUntil: "commit" });
        return (await matching).headers()["x-executor-organization"]!;
      };

      await step("Tab 1 opens org B", async () => {
        await visit(tab1, `/${slugB}`);
        await tab1.getByText("Integrations").first().waitFor({ timeout: 30_000 });
      });

      // A second tab in the SAME context — shares tab 1's cookie jar.
      const tab2 = await tab1.context().newPage();

      await step("Tab 2 opens org A's URL and stays in A — no switch, no reload loop", async () => {
        await visit(tab2, `/${slugA}/policies`);
        await tab2.getByText("Policies").first().waitFor({ timeout: 30_000 });
        expect(new URL(tab2.url()).pathname, "tab 2 stays on org A's URL").toBe(
          `/${slugA}/policies`,
        );
        expect(await requestOrgSlugOf(tab2), "tab 2's API requests are scoped to org A").toBe(
          slugA,
        );
      });

      await step("Tab 1 is untouched: still org B, and its requests still scope to B", async () => {
        expect(new URL(tab1.url()).pathname, "tab 1's URL still says org B").toBe(`/${slugB}`);
        expect(
          await tab1.getByRole("button", { name: /Multitab B/ }).isVisible(),
          "tab 1's sidebar still shows org B",
        ).toBe(true);
        // The crux: tab 2 opening org A did NOT re-scope tab 1. Tab 1's own
        // requests still carry org B's slug — the URL is the scope, not a
        // shared cookie a sibling tab can steal.
        expect(await requestOrgSlugOf(tab1), "tab 1's API requests stay scoped to org B").toBe(
          slugB,
        );
      });
    });
  }),
);

scenario(
  "Org scope · plugin API requests carry the URL organization selector",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    const spec = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Header Probe", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/ping": {
          get: {
            operationId: "ping",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the OpenAPI add form", async () => {
        await visit(page, "/integrations/add/openapi");
        await page.getByPlaceholder("https://api.example.com/openapi.json").waitFor();
      });

      const orgSlug = new URL(page.url()).pathname.split("/")[1];
      expect(orgSlug, "the add form landed on an org-scoped URL").toBeTruthy();

      await step("Paste an inline spec", async () => {
        const previewRequest = page.waitForRequest(
          (request) => request.url().includes("/api/openapi/preview"),
          { timeout: 15_000 },
        );

        await page.getByPlaceholder("https://api.example.com/openapi.json").fill(spec);

        expect(
          (await previewRequest).headers()["x-executor-organization"],
          "plugin-owned preview requests use the URL's org selector",
        ).toBe(orgSlug);
      });
    });
  }),
);
