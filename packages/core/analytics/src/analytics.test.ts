import { describe, expect, it } from "@effect/vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, Layer, Predicate, Ref, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { NodeFileSystem } from "@effect/platform-node";

import { Analytics, isAnalyticsDisabled, layer } from "./analytics";

const PostHogBatchBody = Schema.fromJsonString(
  Schema.Struct({
    api_key: Schema.String,
    batch: Schema.Array(
      Schema.Struct({
        event: Schema.String,
        distinct_id: Schema.String,
        timestamp: Schema.String,
        properties: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
);
type PostHogBatchBody = typeof PostHogBatchBody.Type;
const decodePostHogBatchBody = Schema.decodeUnknownEffect(PostHogBatchBody);

interface CapturedBatch {
  readonly url: string;
  readonly body: PostHogBatchBody;
}

const makeRecordingHttpClient = (
  status: () => number = () => 200,
): Effect.Effect<{
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly batches: Ref.Ref<ReadonlyArray<CapturedBatch>>;
}> =>
  Effect.gen(function* () {
    const batches = yield* Ref.make<ReadonlyArray<CapturedBatch>>([]);
    const httpLayer = Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function* () {
          if (!Predicate.isTagged(request.body, "Uint8Array")) {
            return yield* Effect.die("expected a Uint8Array request body");
          }
          const body = yield* decodePostHogBatchBody(
            new TextDecoder().decode(request.body.body),
          ).pipe(Effect.orDie);
          yield* Ref.update(batches, (existing) => [...existing, { url: request.url, body }]);
          return HttpClientResponse.fromWeb(request, new Response("{}", { status: status() }));
        }),
      ),
    );
    return { layer: httpLayer, batches };
  });

const withTempDir = <A, E>(use: (dir: string) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "executor-analytics-"))),
    use,
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

const testConfig = (dataDir: string) => ({
  surface: "cli" as const,
  version: "0.0.0",
  channel: "dev" as const,
  dataDir,
  disabled: false,
  posthogHost: "https://posthog.test",
  posthogKey: "phc_test",
  flushInterval: Duration.hours(1),
});

describe("isAnalyticsDisabled", () => {
  it("honors DO_NOT_TRACK and EXECUTOR_DISABLE_ANALYTICS", () => {
    expect(isAnalyticsDisabled({})).toBe(false);
    expect(isAnalyticsDisabled({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(isAnalyticsDisabled({ DO_NOT_TRACK: "true" })).toBe(true);
    expect(isAnalyticsDisabled({ EXECUTOR_DISABLE_ANALYTICS: "yes" })).toBe(true);
    expect(isAnalyticsDisabled({ DO_NOT_TRACK: "0" })).toBe(false);
  });
});

describe("Analytics", () => {
  it.effect("buffers events and flushes a PostHog batch with shared properties", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const http = yield* makeRecordingHttpClient();
        yield* Effect.gen(function* () {
          const analytics = yield* Analytics;
          yield* analytics.record("execution_completed", {
            ok: true,
            plane: "mcp",
            toolkit: false,
          });
          yield* analytics.record("integration_added", { plugin_key: "openapi" });
          yield* analytics.flush;

          const batches = yield* Ref.get(http.batches);
          expect(batches).toHaveLength(1);
          expect(batches[0]?.url).toBe("https://posthog.test/batch/");
          // SAFETY: length asserted to be 1 above.
          const body = batches[0]!.body;
          expect(body.api_key).toBe("phc_test");
          expect(body.batch.map((event) => event.event)).toEqual([
            "execution_completed",
            "integration_added",
          ]);
          for (const event of body.batch) {
            expect(event.properties["$process_person_profile"]).toBe(false);
            expect(event.properties["surface"]).toBe("cli");
            expect(event.properties["channel"]).toBe("dev");
            expect(event.properties["app_version"]).toBe("0.0.0");
            expect(event.distinct_id).toBe(body.batch[0]?.distinct_id);
          }
        }).pipe(
          Effect.provide(
            layer(testConfig(dir)).pipe(
              Layer.provide(http.layer),
              Layer.provide(NodeFileSystem.layer),
            ),
          ),
        );
      }),
    ),
  );

  it.effect("mints the anonymous id once and reuses it across runtimes", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const http = yield* makeRecordingHttpClient();
        const runOnce = Effect.gen(function* () {
          const analytics = yield* Analytics;
          yield* analytics.record("execution_completed", {
            ok: true,
            plane: "api",
            toolkit: false,
          });
          yield* analytics.flush;
        }).pipe(
          Effect.provide(
            layer(testConfig(dir)).pipe(
              Layer.provide(http.layer),
              Layer.provide(NodeFileSystem.layer),
            ),
          ),
        );
        yield* runOnce;
        yield* runOnce;

        const persisted = (yield* Effect.promise(() =>
          readFile(join(dir, "analytics-id"), "utf8"),
        )).trim();
        expect(persisted.length).toBeGreaterThan(0);

        const batches = yield* Ref.get(http.batches);
        expect(batches).toHaveLength(2);
        const ids = batches.map((batch) => batch.body.batch[0]?.distinct_id);
        expect(ids[0]).toBe(persisted);
        expect(ids[1]).toBe(persisted);
      }),
    ),
  );

  it.effect("re-queues the batch when delivery fails and never surfaces the error", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        let failing = true;
        const http = yield* makeRecordingHttpClient(() => (failing ? 500 : 200));
        yield* Effect.gen(function* () {
          const analytics = yield* Analytics;
          yield* analytics.record("execution_completed", {
            ok: false,
            plane: "mcp",
            toolkit: true,
          });
          yield* analytics.flush;
          expect(yield* Ref.get(http.batches)).toHaveLength(1);

          failing = false;
          yield* analytics.flush;
          const batches = yield* Ref.get(http.batches);
          expect(batches).toHaveLength(2);
          // SAFETY: length asserted to be 2 above.
          const retried = batches[1]!.body;
          expect(retried.batch[0]?.event).toBe("execution_completed");
          expect(retried.batch[0]?.properties["toolkit"]).toBe(true);
        }).pipe(
          Effect.provide(
            layer(testConfig(dir)).pipe(
              Layer.provide(http.layer),
              Layer.provide(NodeFileSystem.layer),
            ),
          ),
        );
      }),
    ),
  );

  it.effect("disabled config produces a no-op service that never dials out", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const http = yield* makeRecordingHttpClient();
        yield* Effect.gen(function* () {
          const analytics = yield* Analytics;
          yield* analytics.record("execution_completed", {
            ok: true,
            plane: "api",
            toolkit: false,
          });
          yield* analytics.flush;
          expect(yield* Ref.get(http.batches)).toHaveLength(0);
        }).pipe(
          Effect.provide(
            layer({ ...testConfig(dir), disabled: true }).pipe(
              Layer.provide(http.layer),
              Layer.provide(NodeFileSystem.layer),
            ),
          ),
        );
        // No id file either: a disabled install leaves no analytics trace.
        const persisted = yield* Effect.promise(() =>
          readFile(join(dir, "analytics-id"), "utf8").then(
            () => true,
            () => false,
          ),
        );
        expect(persisted).toBe(false);
      }),
    ),
  );
});
