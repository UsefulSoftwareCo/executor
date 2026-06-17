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
// Everything runs through the browser (onboarding + the menu create-org), so
// the single-use WorkOS refresh-token chain stays browser-owned and valid.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Org tabs · two tabs on different orgs stay independent (URL-scoped, no cookie steal)",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity({ org: false });

    yield* browser.session(identity, async ({ page: tab1, step }) => {
      const slugOf = (page: typeof tab1) => new URL(page.url()).pathname.replace(/^\/|\/.*$/g, "");

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

      let slugA = "";
      let slugB = "";

      await step("Onboard org A in tab 1", async () => {
        await tab1.goto("/", { waitUntil: "networkidle" });
        await tab1.getByPlaceholder("Northwind Labs").fill("Multitab A");
        await tab1.getByRole("button", { name: "Create organization" }).click();
        await tab1.getByText("Connect your MCP client").waitFor({ timeout: 30_000 });
        await tab1.getByRole("button", { name: "Continue to app" }).click();
        await tab1.waitForURL((url) => /^\/[a-z0-9-]+\/?$/.test(url.pathname), { timeout: 30_000 });
        await tab1.getByText("Integrations").first().waitFor({ timeout: 30_000 });
        slugA = slugOf(tab1);
      });

      await step("Create org B from tab 1's account menu — tab 1 is now in B", async () => {
        await tab1.getByRole("button", { name: /Test User/ }).click();
        await tab1.getByRole("menuitem", { name: "Multitab A" }).click();
        await tab1
          .locator('[data-slot="dropdown-menu-sub-content"]')
          .getByText("Create organization", { exact: true })
          .click();
        await tab1.getByText("Add another organization").waitFor();
        await tab1.getByPlaceholder("Northwind Labs").fill("Multitab B");
        await tab1.getByRole("button", { name: "Create organization" }).click();
        await tab1.waitForURL((url) => url.pathname !== `/${slugA}`, { timeout: 30_000 });
        await tab1.getByText("Integrations").first().waitFor({ timeout: 30_000 });
        slugB = slugOf(tab1);
      });
      expect(slugB, "the two orgs have distinct slugs").not.toBe(slugA);

      // A second tab in the SAME context — shares tab 1's cookie jar.
      const tab2 = await tab1.context().newPage();

      await step("Tab 2 opens org A's URL and stays in A — no switch, no reload loop", async () => {
        await tab2.goto(`/${slugA}/policies`, { waitUntil: "networkidle" });
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
        await page.goto("/integrations/add/openapi", { waitUntil: "networkidle" });
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
