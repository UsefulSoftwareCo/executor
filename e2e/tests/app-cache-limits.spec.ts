/** App cache lifetimes past the retention are shortened, and a size failure names its limit. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const privateMarker = "SYNTHETIC_PRIVATE_CACHE_VALUE";
const source = `import { defineApp, query, object, boolean, string, router } from "apps";
export default defineApp({ accounts: {} }, {
  tools: router({
    // Eight days in all, a day past the retention.
    longLived: query({ input: object({}) }, async ({ cache }) =>
      cache.get({ key: "long", schema: string(), freshFor: "7 days", staleFor: "1 day", load: async () => crypto.randomUUID() })),
    longWrite: query({ input: object({}) }, async ({ cache }) => {
      await cache.write([{ key: "written", value: true }], "30 days");
      return (await cache.read("written", boolean())) ?? false;
    }),
    oversized: query({ input: object({}) }, async ({ cache }) => {
      await cache.write([{ key: "big", value: ${JSON.stringify(privateMarker)} + "x".repeat(2_000_000) }], "1 minute");
      return true;
    }),
  }),
});`;

const CallFailed = Schema.Struct({ _tag: Schema.Literal("ToolCallFailed"), reason: Schema.String });

layer(HostedLive, { excludeTestServices: true })("App caching", (it) => {
  it.effect(scenarios.appCacheLimits.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Cache limits ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const call = (tool: string) =>
          api.request(actors.owner, "POST", `${prefix}/${app.id}/tools/call`, {
            tool,
            kind: "query",
            input: {},
          });
        const value = (tool: string) =>
          Effect.gen(function* () {
            const response = yield* call(tool);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* body(Schema.Json, response);
          });

        // A lifetime past the retention is shortened and stored: the second read is the first
        // load's value.
        const first = yield* value("longLived");
        expect(yield* value("longLived")).toBe(first);
        expect(yield* value("longWrite")).toBe(true);

        // A value past the entry size fails with the limit named, and without the value.
        const failed = yield* call("oversized");
        expect(failed.status, JSON.stringify(failed.body).slice(0, 500)).toBe(502);
        expect(JSON.stringify(failed.body)).not.toContain(privateMarker);
        expect((yield* body(CallFailed, failed)).reason).toContain(
          "App cache failed (capacity): A cache value exceeded the app cache's limit of 2,000,000 bytes per entry.",
        );
      }),
    ),
  );
});
