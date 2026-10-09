import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

/** The server-rendered dashboard marks its document; nothing else the Worker serves carries it. */
const dashboardDocument = "data-dashboard";

layer(TestLive, { excludeTestServices: true })("Cloud dashboard routing", (it) => {
  it.effect(scenarios.cloudDashboardRoutes.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        // Pages are on the browser origin; MCP is on `mcp.` and the documentation is a site page
        // on the edge, which every other host redirects site pages to.
        const hosts = targetHosts(yield* Target);
        const read = (path: string, accept = "text/html") =>
          browser.use(`Request ${path}`, (page) =>
            page
              .context()
              .request.get(path, { maxRedirects: 0, headers: { accept } })
              .then((response) =>
                response.text().then((body) => ({
                  status: response.status(),
                  location: response.headers()["location"],
                  body,
                })),
              ),
          );
        const signIn = yield* read("/login");
        expect(signIn.status).toBe(200);
        expect(signIn.body).toContain(dashboardDocument);
        expect(signIn.body).not.toContain("/@vite/client");
        expect(signIn.body).not.toContain('src="/src/');
        // The dashboard renderer owns every deep link. Signed out, each one goes to sign-in and
        // keeps its exact address to return to.
        for (const path of [
          "/org/routing-fixture/apps",
          "/org/routing-fixture/apps/app_fixture/source/src/nested/example.ts",
          "/org/routing-fixture/apps/app_fixture/history",
          "/org/routing-fixture/apps/app_fixture/deployments/deploy_fixture",
          "/org/routing-fixture/unknown-page",
          "/mcp/approve/approval_fixture",
        ]) {
          const response = yield* read(path);
          expect(response.status, path).toBe(307);
          expect(response.location, path).toBe(`/login?redirect=${encodeURIComponent(path)}`);
        }
        // An organization root and a trailing slash open the canonical Apps address.
        for (const path of ["/org/routing-fixture", "/org/routing-fixture/apps/"]) {
          const response = yield* read(path);
          expect(response.status, path).toBe(307);
          expect(response.location, path).toBe("/org/routing-fixture/apps");
        }
        for (const path of ["/api/not-a-route", "/assets/missing.js", "/missing.js"]) {
          const response = yield* read(path);
          expect(response.status, path).toBe(404);
          expect(response.body, path).not.toContain(dashboardDocument);
        }
        const health = yield* browser.use("Request /health", (page) =>
          page
            .context()
            .request.get("/health")
            .then((response) =>
              response.json().then((body: unknown) => ({ status: response.status(), body })),
            ),
        );
        expect(health.status).toBe(200);
        expect(health.body).toMatchObject({ status: "ok" });
        const mcp = yield* read(`${hosts.mcp}/mcp`);
        expect(mcp.status).toBe(401);
        const docsRedirect = yield* read("/docs");
        expect(docsRedirect.status).toBe(308);
        expect(docsRedirect.location).toBe(`${hosts.edge}/docs`);
        const docs = yield* read(`${hosts.edge}/docs`);
        expect(docs.status).toBe(200);
        expect(docs.body).not.toContain(dashboardDocument);
        const docsPage = yield* read(`${hosts.edge}/docs/author-an-app`);
        expect(docsPage.status).toBe(200);
        // The page's earlier address keeps working for links already published.
        const movedDocsPage = yield* read(`${hosts.edge}/docs/build/author-an-app`);
        expect(movedDocsPage.status).toBe(308);
        expect(movedDocsPage.location).toBe("/docs/author-an-app");
        // A browser that opens a missing page gets the site's 404 document, with a 404
        // status; the documentation keeps its own. Other clients keep an empty 404.
        const missingPage = yield* read("/no-such-page");
        expect(missingPage.status).toBe(404);
        expect(missingPage.body).toContain("Page not found");
        expect(missingPage.body).toContain("data-missing-path");
        const missingDocsPage = yield* read(`${hosts.edge}/docs/no-such-page`);
        expect(missingDocsPage.status).toBe(404);
        expect(missingDocsPage.body).toContain("Page not found");
        expect(missingDocsPage.body).toContain("/docs/llms.txt");
        const missingResource = yield* read("/no-such-page", "application/json");
        expect(missingResource.status).toBe(404);
        expect(missingResource.body).toBe("");
      }),
    ),
  );
});
