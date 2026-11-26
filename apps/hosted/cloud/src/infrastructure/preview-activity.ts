import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Clock, Config, Effect, Option } from "effect";
import { HttpServerRequest, type HttpServerResponse } from "effect/http";
import { AppDomainController } from "./app-domain-controller-worker.ts";
import { inJurisdiction } from "./jurisdiction.ts";
import { testStage } from "./stage.ts";

export const previewIdleMilliseconds = 30 * 60_000;

const visitEveryMilliseconds = 60_000;

const activityName = "preview";

const seenKey = "seen";

interface Activity {
  readonly visit: () => Effect.Effect<void, never, RuntimeContext>;
  readonly idle: () => Effect.Effect<boolean, never, RuntimeContext>;
}

export class PreviewActivity extends Cloudflare.DurableObject<PreviewActivity, Activity>()(
  "PreviewActivity",
) {}

export const PreviewActivityLive = PreviewActivity.make(
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      let seen: number | undefined;
      let stored: number | undefined;
      const last = Effect.gen(function* () {
        if (seen === undefined) {
          stored = yield* state.storage.get<number>(seenKey);
          seen = stored;
        }
        return seen;
      });
      const record = (now: number) =>
        Effect.gen(function* () {
          seen = now;
          if (stored !== undefined && now - stored < visitEveryMilliseconds) return;
          yield* state.storage.put(seenKey, now);
          stored = now;
        });
      return {
        visit: () => Effect.flatMap(Clock.currentTimeMillis, record),
        idle: () =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const previous = yield* last;
            if (previous === undefined) {
              yield* record(now);
              return false;
            }
            return now - previous >= previewIdleMilliseconds;
          }),
      } satisfies Activity;
    }),
  ),
);

const pausesWhenIdle = Effect.gen(function* () {
  if (Option.isNone(yield* testStage)) return false;
  const retention = yield* Config.Literals(["temporary", "retained"], "TEST_STAGE_RETENTION").pipe(
    Config.withDefault("temporary"),
  );
  const background = yield* Config.Literals(["active", "paused"], "TEST_STAGE_BACKGROUND").pipe(
    Config.withDefault("active"),
  );
  return retention === "retained" && background === "active";
}).pipe(Effect.orDie);

export const previewActivity = Effect.gen(function* () {
  if (!(yield* pausesWhenIdle))
    return {
      http:
        (_isVisitor: (request: HttpServerRequest.HttpServerRequest) => boolean) =>
        <E, R>(handle: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
          handle,
      isIdle: Effect.succeed(false),
    };
  const objects = yield* inJurisdiction(PreviewActivity.from(AppDomainController));
  // external: a Worker request cannot wait on another request's I/O, so overlapping requests each report.
  let reported = Number.NEGATIVE_INFINITY;
  const visit = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now - reported < visitEveryMilliseconds) return;
    yield* Effect.suspend(() => objects.getByName(activityName).visit()).pipe(
      Effect.provide(RuntimeContext.phantom),
      Effect.timeout("2 seconds"),
      Effect.tap(() =>
        Effect.sync(() => {
          reported = Math.max(reported, now);
        }),
      ),
      Effect.withSpan("preview.activity.visit"),
      Effect.catchCause(() => Effect.logWarning("Preview activity report failed")),
    );
  });
  return {
    http:
      (isVisitor: (request: HttpServerRequest.HttpServerRequest) => boolean) =>
      <E, R>(handle: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!request.url.startsWith("/api/internal/") && isVisitor(request)) yield* visit;
          return yield* handle;
        }),
    isIdle: Effect.suspend(() => objects.getByName(activityName).idle()).pipe(
      Effect.provide(RuntimeContext.phantom),
      Effect.timeout("2 seconds"),
      Effect.tap((idle) => Effect.annotateCurrentSpan("executor.preview.idle", idle)),
      Effect.catchCause(() =>
        Effect.logWarning("Preview activity check failed").pipe(Effect.as(false)),
      ),
    ),
  };
});
