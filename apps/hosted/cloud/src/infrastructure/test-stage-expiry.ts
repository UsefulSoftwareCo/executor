/** Enforce the preview deadline even if a scheduled cleanup run or provider is delayed. */
import { Clock, Config, Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { testStage } from "./stage.ts";

/** Test stages must supply the registry deadline; configured production stages have no expiry. */
export const testStageExpiry = Effect.gen(function* () {
  if (Option.isNone(yield* testStage)) return Option.none<number>();
  const retention = yield* Config.Literals(["temporary", "retained"], "TEST_STAGE_RETENTION").pipe(
    Config.withDefault("temporary"),
  );
  if (retention === "retained") return Option.none<number>();
  return Option.some(
    yield* Config.Number("TEST_STAGE_EXPIRES_AT").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Int.check(Schema.isGreaterThan(0)))),
    ),
  );
});

/** Capture the configured deadline once; evaluate the clock for each request or background event. */
export const previewLifetime = Effect.gen(function* () {
  const expiry = yield* testStageExpiry.pipe(Effect.orDie);
  const expired = Clock.currentTimeMillis.pipe(
    Effect.map((now) => Option.isSome(expiry) && now >= expiry.value),
  );
  const paused =
    Option.isSome(yield* testStage.pipe(Effect.orDie)) &&
    (yield* Config.Literals(["active", "paused"], "TEST_STAGE_BACKGROUND").pipe(
      Config.withDefault("active"),
      Effect.orDie,
    )) === "paused";
  const stopped = expired.pipe(Effect.map((done) => done || paused));
  const http = <E, R>(handle: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      if (!(yield* expired)) return yield* handle;
      const request = yield* HttpServerRequest.HttpServerRequest;
      // The existing authenticated drain endpoint must remain available to the cleanup worker.
      if (request.method === "POST" && request.url === "/api/internal/app-domains/drain")
        return yield* handle;
      return HttpServerResponse.text(
        "This staging preview has expired. Deploy a new preview to continue.",
        {
          status: 410,
          headers: { "cache-control": "no-store" },
        },
      );
    });
  const background = <E, R>(work: Effect.Effect<void, E, R>) =>
    stopped.pipe(Effect.flatMap((done) => (done ? Effect.void : work)));
  return { http, background, isExpired: expired, isBackgroundStopped: stopped };
});
