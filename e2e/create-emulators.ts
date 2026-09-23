import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Command, Flag } from "effect/unstable/cli";
import { createEmulatorFixture } from "./support/emulators.ts";

const command = Command.make("e2e-emulators", {
  origin: Flag.String("origin"),
  output: Flag.String("output"),
}).pipe(
  Command.withHandler(({ origin, output }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(
          Schema.String.check(
            Schema.makeFilter((text) => {
              const url = URL.parse(text);
              return (
                url !== null &&
                url.origin === text &&
                (url.protocol === "https:" ||
                  (url.protocol === "http:" && url.hostname === "localhost"))
              );
            }),
          ),
        )(origin);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        if (!path.isAbsolute(output))
          return yield* Effect.die(new Error("Use an absolute private output path"));
        yield* fs.makeDirectory(path.dirname(output), { recursive: true, mode: 0o700 });
        const file = yield* fs.open(output, { flag: "wx", mode: 0o600 });
        let complete = false;
        yield* Effect.addFinalizer(() =>
          complete ? Effect.void : fs.remove(output).pipe(Effect.orDie),
        );
        const fixture = yield* createEmulatorFixture(origin);
        yield* file.writeAll(
          new TextEncoder().encode(JSON.stringify(Redacted.value(fixture), null, 2)),
        );
        complete = true;
        yield* Console.log(
          `Created isolated identity, mail, company and billing emulators. Private configuration: ${output}`,
        );
      }),
    ),
  ),
);
NodeRuntime.runMain(
  Command.run(command, { version: "1" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
