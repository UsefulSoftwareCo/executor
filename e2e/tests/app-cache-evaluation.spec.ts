/** A cache failure while an app evaluates keeps its safe reason for callers and traces. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const privateMarker = "SYNTHETIC_PRIVATE_CACHE_KEY";
const EvaluationFailure = Schema.Struct({
  _tag: Schema.Literal("AppEvaluationFailed"),
  failure: Schema.Struct({
    source: Schema.String,
    errorName: Schema.String,
    code: Schema.optional(Schema.String),
    message: Schema.String,
  }),
});

layer(HostedLive, { excludeTestServices: true })("App caching", (it) => {
  it.effect(scenarios.appCacheEvaluation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Cache evaluation ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              // The key alone exceeds the cache's key limit, as a large credential once did.
              content: `import { defineApp, query, object, router } from "apps";
export default defineApp({ accounts: {} }, async (ctx) => {
  await ctx.cache.write([{ key: ${JSON.stringify(privateMarker)} + "x".repeat(9000), value: true }], "1 minute");
  return { tools: router({ never: query({ input: object({}) }, async () => true) }) };
});`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const failed = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/apps/${app.id}/tools/index`,
        );
        expect(failed.status).toBe(502);
        expect(JSON.stringify(failed.body)).not.toContain(privateMarker);
        // The cache's reason is named; the app's code did not throw, so it is not blamed.
        expect((yield* body(EvaluationFailure, failed)).failure).toEqual({
          source: "storage",
          errorName: "CacheError",
          code: "capacity",
          message: "A cache key exceeded the app cache's limit of 8,192 bytes per key.",
        });
        const traceId = (yield* evidence.requests).at(-1)?.traceId;
        if (traceId === undefined) return yield* Effect.die("The request trace was not recorded");
        const inspect = yield* telemetry.query(traceId).pipe(
          Effect.flatMap((trace) => {
            const span = trace.data.find(({ span }) => span.operationName === "app.inspect");
            return span === undefined
              ? Effect.fail(new Error("Missing delivered app.inspect span"))
              : Effect.succeed({ trace, span: span.span });
          }),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
        );
        yield* evidence.json("inspect-trace.json", inspect.trace);
        expect(inspect.span.status).toBe("error");
        expect(JSON.stringify(inspect.trace)).not.toContain(privateMarker);
        expect(inspect.span.tags["error.type"]).toBe("CacheError");
        expect(inspect.span.tags["executor.failure.source"]).toBe("storage");
        expect(inspect.span.tags["executor.failure.code"]).toBe("capacity");
      }),
    ),
  );
});
