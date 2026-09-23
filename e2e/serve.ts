/** Loopback report server with Effect-owned routing, files and socket lifetime. */
import { createServer } from "node:http";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Console, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import {
  HttpRouter,
  HttpServerRespondable,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/unstable/http";

const command = Command.make("e2e-report", {
  directory: Flag.String("directory"),
  port: Flag.Int("port").pipe(Flag.withDefault(59365)),
}).pipe(
  Command.withHandler(({ directory, port }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path,
        fs = yield* FileSystem.FileSystem;
      yield* Schema.decodeUnknownEffect(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
      )(port);
      const root = path.resolve(directory);
      yield* fs.access(path.join(root, "index.html"));
      // The platform handler implements byte ranges so seeking does not download the whole film.
      const files = yield* HttpStaticServer.make({
        root,
        cacheControl: "no-store",
        mimeTypes: { vtt: "text/vtt; charset=utf-8" },
      }).pipe(Effect.provide(NodeHttpServer.layerHttpServices));
      const handler = files.pipe(
        Effect.catch(HttpServerRespondable.toResponse),
        Effect.map((response) =>
          HttpServerResponse.setHeader(response, "x-content-type-options", "nosniff"),
        ),
      );
      yield* Console.log(`Test evidence: http://127.0.0.1:${port}`);
      yield* Layer.launch(
        HttpRouter.serve(HttpRouter.add("GET", "*", handler)).pipe(
          Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port })),
          Layer.provide(NodeHttpServer.layerHttpServices),
        ),
      );
    }),
  ),
);
NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)),
);
