import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Cloud dashboard routing", (it) => {
  it.effect(scenarios.cloudDashboardRoutes.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const read = (path: string) =>
          browser.use(`Request ${path}`, (page) => page.context().request.get(path));
        const shell = yield* read("/org/routing-fixture/apps");
        expect(shell.status()).toBe(200);
        const html = yield* browser.use("Read the dashboard document", () => shell.text());
        expect(html).toContain('id="root"');
        expect(html).not.toContain("/@vite/client");
        expect(html).not.toContain('src="/src/');
        for (const path of [
          "/org/routing-fixture",
          "/org/routing-fixture/apps",
          "/org/routing-fixture/apps/",
          "/org/routing-fixture/apps/app_fixture/source/src/nested/example.ts",
          "/org/routing-fixture/apps/app_fixture/history",
          "/org/routing-fixture/apps/app_fixture/deployments/deploy_fixture",
          "/org/routing-fixture/unknown-page",
          "/mcp/approve/approval_fixture",
        ]) {
          const response = yield* read(path);
          expect(response.status(), path).toBe(200);
          expect(yield* browser.use(`Read ${path}`, () => response.text()), path).toBe(html);
        }
        for (const path of ["/api/not-a-route", "/assets/missing.js", "/missing.js"]) {
          const response = yield* read(path);
          expect(response.status(), path).toBe(404);
          expect(yield* browser.use(`Read ${path}`, () => response.text()), path).not.toContain(
            'id="root"',
          );
        }
        const health = yield* read("/health");
        expect(health.status()).toBe(200);
        expect(yield* browser.use("Read health", () => health.json())).toMatchObject({
          status: "ok",
        });
        const mcp = yield* read("/mcp");
        expect(mcp.status()).toBe(401);
        const docs = yield* read("/docs");
        expect(docs.status()).toBe(200);
        expect(yield* browser.use("Read documentation", () => docs.text())).not.toBe(html);
      }),
    ),
  );
});
