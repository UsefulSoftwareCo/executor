import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { checkAppLoading } from "../support/app-loading.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

layer(TestLive, { excludeTestServices: true })("Local app navigation", (it) => {
  for (const [scenario, viewport] of [
    [scenarios.localAppDetailLoading, { width: 1440, height: 900 }],
  ] as const)
    it.effect(scenario.title, (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api;
          const browser = yield* Browser;
          const target = yield* Target;
          const session = yield* api.session();
          const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
          const name = `Example ${randomUUID().slice(0, 4)}`;
          const deployed = yield* session.send(
            "POST",
            "/v1/apps/deploy",
            {
              owner: "local",
              name,
              files: [
                {
                  path: "index.ts",
                  content: `
import { defineApp, query, object, router } from "apps";
export default defineApp({}, async () => ({
  tools: router({
    hello: query({ description: "A simple greeting", input: object({}) }, async () => "Hello"),
  })
}));`,
                },
                appsManifest,
              ],
            },
            headers,
          );
          expect(deployed.status).toBe(200);
          const { app, deployment } = yield* body(
            Schema.Struct({ app: Resource, deployment: Resource }),
            deployed,
          );
          yield* Effect.addFinalizer(() =>
            session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(
              Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
              Effect.orDie,
            ),
          );
          const pairing = yield* session.send("POST", "/auth/pair", undefined, headers);
          expect(pairing.status).toBe(200);
          const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
          yield* browser.use("Pair the local browser", (page) => page.goto(url));
          yield* browser.use("Pairing completes before checking app navigation", (page) =>
            page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
          );
          yield* browser.use("Set the viewport", (page) => page.setViewportSize(viewport));
          yield* browser.use("Record loading panels shown after server content", (page) =>
            page.addInitScript(() => {
              const view = new URLSearchParams(location.search).get("view");
              const content =
                view === "settings"
                  ? 'section[aria-label="App name"]'
                  : view === "tools"
                    ? 'button[title="hello"]'
                    : undefined;
              if (content === undefined) return;
              const record = { shown: false, reverted: false };
              Object.assign(window, { serverContent: record });
              new MutationObserver(() => {
                if (!record.shown) record.shown = document.querySelector(content) !== null;
                else if (
                  document.querySelector(`[role="status"][aria-label="Loading ${view}"]`) !== null
                )
                  record.reverted = true;
              }).observe(document, { childList: true, subtree: true });
            }),
          );
          // A document load shows live app data read by the server. The browser's own live
          // subscriptions are held, so hydration must keep that content rather than falling back
          // to the loading panel until the browser's first snapshot.
          for (const [view, reads] of [
            ["settings", [`/dashboard/api/live/apps/${app.id}`]],
            [
              "tools",
              [`/dashboard/api/live/apps/${app.id}`, `/dashboard/api/live/apps/${app.id}/tools`],
            ],
          ] as const)
            yield* Effect.scoped(
              Effect.gen(function* () {
                const live = yield* holdQuery(reads, "continue", { allRequests: true });
                yield* browser.use(`Load the ${view} document`, (page) =>
                  page.goto(`/apps/${app.id}?view=${view}`),
                );
                yield* live.requested;
                yield* browser.checkpoint(`${viewport.width} ${view} document hydrated`);
                yield* live.release;
                yield* browser.use(`The ${view} loading panel is gone`, (page) =>
                  page
                    .getByRole("status", { name: `Loading ${view}`, exact: true })
                    .waitFor({ state: "hidden" }),
                );
                expect(
                  yield* browser.use(`The server's ${view} content survives hydration`, (page) =>
                    page.evaluate(() => Reflect.get(window, "serverContent")),
                  ),
                ).toEqual({ shown: true, reverted: false });
              }),
            );
          yield* checkAppLoading({
            viewports: [viewport],
            url: `/apps/${app.id}`,
            name,
            metadata: [`/dashboard/api/live/apps/${app.id}`],
            coldInventory: ["/dashboard/api/live/overview"],
            tools: [`/dashboard/api/live/apps/${app.id}/tools`],
            workspace: [`/api/apps/${app.id}/workspace/display`],
            history: [`/api/apps/${app.id}/history`],
            source: [`/dashboard/api/apps/${app.id}/deployments/${deployment.id}/display`],
          });
        }),
      ),
    );
});
