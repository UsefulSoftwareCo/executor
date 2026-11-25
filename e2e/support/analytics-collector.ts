/** A loopback ingestion service; synthetic events never leave the test machine. */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

/** Own the receiver for one managed product process and retain JSON batches as evidence. */
export const startAnalyticsCollector = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${directory}/analytics.ndjson`;
    yield* fs.writeFileString(file, "", { mode: 0o600 });
    const sentryFile = `${directory}/sentry.ndjson`;
    yield* fs.writeFileString(sentryFile, "", { mode: 0o600 });
    const sentry = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const envelope = yield* request.text;
      yield* fs.writeFileString(sentryFile, `${JSON.stringify({ envelope })}\n`, {
        flag: "a",
        mode: 0o600,
      });
      return HttpServerResponse.jsonUnsafe({}, { headers: { "access-control-allow-origin": "*" } });
    }).pipe(Effect.orDie);
    // A scenario can answer flag evaluations for one person by writing `flags/<distinct id>.json`
    // as `{ status, body }`. Everyone else gets no flags, so experiments serve their control.
    yield* fs.makeDirectory(`${directory}/flags`, { recursive: true, mode: 0o700 });
    const flagsFile = `${directory}/flags.ndjson`;
    yield* fs.writeFileString(flagsFile, "", { mode: 0o600 });
    const FlagRequest = Schema.Struct({
      distinct_id: Schema.String,
      flag_keys_to_evaluate: Schema.optionalKey(Schema.Array(Schema.String)),
    });
    const FlagStub = Schema.Struct({ status: Schema.Number, body: Schema.Json });
    const flags = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // The browser SDK may compress its body; only plain JSON names a person to answer for.
      const text = yield* request.text;
      const person = Schema.decodeUnknownOption(Schema.fromJsonString(FlagRequest))(text);
      if (person._tag === "None")
        return HttpServerResponse.jsonUnsafe({
          flags: {},
          featureFlags: {},
          errorsWhileComputingFlags: false,
        });
      const distinct = person.value.distinct_id;
      // Each evaluation is kept with the flags it asked for, so a scenario can tell which it asked.
      yield* fs.writeFileString(flagsFile, `${JSON.stringify(person.value)}\n`, {
        flag: "a",
        mode: 0o600,
      });
      const stubFile = `${directory}/flags/${encodeURIComponent(distinct)}.json`;
      if (!(yield* fs.exists(stubFile)))
        return HttpServerResponse.jsonUnsafe({
          flags: {},
          featureFlags: {},
          errorsWhileComputingFlags: false,
        });
      const stub = yield* fs
        .readFileString(stubFile)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FlagStub))));
      return HttpServerResponse.jsonUnsafe(stub.body, { status: stub.status });
    }).pipe(Effect.orDie);
    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const payload = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
      );
      const batch = request.url.startsWith("/batch/") ? payload : { batch: [payload] };
      yield* fs.writeFileString(file, `${JSON.stringify(batch)}\n`, { flag: "a", mode: 0o600 });
      return HttpServerResponse.jsonUnsafe({ status: 1 });
    }).pipe(Effect.orDie);
    // A fresh router per collector: one process can own several products, each with its own.
    const services = yield* Layer.build(
      Layer.fresh(
        HttpRouter.serve(
          Layer.mergeAll(
            HttpRouter.add("POST", "/api/1/envelope/", sentry),
            HttpRouter.add(
              "OPTIONS",
              "/api/1/envelope/",
              Effect.succeed(
                HttpServerResponse.empty({
                  headers: {
                    "access-control-allow-origin": "*",
                    "access-control-allow-methods": "POST, OPTIONS",
                    "access-control-allow-headers": "content-type, sentry-trace, baggage",
                  },
                }),
              ),
            ),
            HttpRouter.add("POST", "/batch/", handler),
            HttpRouter.add("POST", "/e/", handler),
            HttpRouter.add("POST", "/flags/", flags),
            HttpRouter.add(
              "GET",
              "/array/:token/config.js",
              Effect.succeed(
                HttpServerResponse.text(
                  'window._POSTHOG_REMOTE_CONFIG = {"synthetic-ingestion-key": {config: {hasFeatureFlags: false, sessionRecording: false}}};',
                  { contentType: "application/javascript" },
                ),
              ),
            ),
            HttpRouter.add(
              "GET",
              "/array/:token/config",
              Effect.succeed(
                HttpServerResponse.jsonUnsafe({ hasFeatureFlags: false, sessionRecording: false }),
              ),
            ),
          ),
          {
            disableLogger: true,
            disableListenLog: true,
          },
        ).pipe(
          Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
        ),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Analytics collector needs TCP");
    return server.address.port;
  });
