/**
 * A stale cache read serves the kept value and refreshes it in the background, after the call has
 * returned. The refreshed value must be stored in an app with a database, whose calls run in its
 * data facet, as in one without.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { body } from "../support/api.ts";
import { appsManifest, firstMigration } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { callLocalQuery, localAgent } from "../support/local-links.ts";
import { scenarios } from "../test-plan.ts";

/** Every read is stale at once and kept for ten minutes; `read`'s loader finishes after the call. */
const source = (
  database: boolean,
) => `import { defineApp, query, object, string, router } from "apps";
const options = { key: "k", schema: string(), freshFor: 0, staleFor: "10 minutes" };
export default defineApp({}, {
  tools: router({
    seed: query({ input: object({}) }, async (ctx) => {
      ${database ? `ctx.sql.exec("SELECT 1");` : ""}
      return ctx.cache.get({ ...options, load: async () => "v0" });
    }),
    read: query({ input: object({}) }, async (ctx) => {
      ${database ? `ctx.sql.exec("SELECT 1");` : ""}
      return ctx.cache.get({ ...options, load: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return "v1";
      } });
    }),
  }),
});`;

const Published = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });

layer(TestLive, { excludeTestServices: true })("Local app cache refresh", (it) => {
  it.effect(scenarios.localAppCacheRefresh.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { agent } = yield* localAgent;
        const suffix = randomUUID().slice(0, 8);
        const apps: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(apps, (app) => agent.send("DELETE", `/v1/apps/${app}`)).pipe(Effect.orDie),
        );

        const refreshed = (database: boolean) =>
          Effect.gen(function* () {
            const deployed = yield* agent.send("POST", "/v1/apps/deploy", {
              owner: "local",
              name: `Cache refresh ${database ? "database" : "plain"} ${suffix}`,
              files: [
                { path: "index.ts", content: source(database) },
                ...(database ? [firstMigration] : []),
                appsManifest,
              ],
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = (yield* body(Published, deployed)).app.id;
            apps.push(app);

            expect(yield* callLocalQuery(agent, app, "seed")).toBe("v0");
            // Stale: the kept value, while the loader runs on after the call has returned.
            expect(yield* callLocalQuery(agent, app, "read")).toBe("v0");
            // The refresh stored its value: a later read serves it. Each read refreshes again.
            let value = "v0";
            for (let attempt = 0; attempt < 20 && value !== "v1"; attempt++) {
              yield* Effect.sleep("500 millis");
              value = String(yield* callLocalQuery(agent, app, "read"));
            }
            return value;
          });

        expect(yield* refreshed(false), "the app without a database").toBe("v1");
        expect(yield* refreshed(true), "the app with a database").toBe("v1");
      }),
    ),
  );
});
