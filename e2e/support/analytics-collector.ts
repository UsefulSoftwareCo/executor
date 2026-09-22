/** A loopback ingestion service; synthetic events never leave the test machine. */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, FileSystem, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

/** Own the receiver for one managed Cloud run and retain JSON batches as evidence. */
export const startAnalyticsCollector = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${directory}/analytics.ndjson`;
    yield* fs.writeFileString(file, "", { mode: 0o600 });
    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const payload = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
      );
      const batch = request.url.startsWith("/batch/") ? payload : { batch: [payload] };
      yield* fs.writeFileString(file, `${JSON.stringify(batch)}\n`, { flag: "a", mode: 0o600 });
      return HttpServerResponse.jsonUnsafe({ status: 1 });
    }).pipe(Effect.orDie);
    const services = yield* Layer.build(
      HttpRouter.serve(
        Layer.mergeAll(
          HttpRouter.add("POST", "/batch/", handler),
          HttpRouter.add("POST", "/e/", handler),
          HttpRouter.add(
            "POST",
            "/flags/",
            Effect.succeed(HttpServerResponse.jsonUnsafe({ flags: {}, featureFlags: {} })),
          ),
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
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Analytics collector needs TCP");
    return server.address.port;
  });
