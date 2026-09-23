/** Trust the existing local HTTPS CA before Alchemy starts workerd and its sidecars. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { cloudDevelopment } from "../src/contracts/development.ts";

class LocalCertificateUnavailable extends Schema.TaggedError<LocalCertificateUnavailable>()(
  "LocalCertificateUnavailable",
  {},
) {}

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userDirectory = yield* Config.String("HOME");
      const certificate = yield* Config.String("NODE_EXTRA_CA_CERTS").pipe(
        Config.withDefault(path.join(userDirectory, ".portless", "ca.pem")),
      );
      // OAuth clients use the existing HTTP loopback listener for their callback;
      // that endpoint returns to the HTTPS dashboard with its browser session intact.
      const configuration = yield* cloudDevelopment;
      const callback = yield* Config.String("EXECUTOR_OAUTH_CALLBACK_URL").pipe(
        Config.withDefault(`http://127.0.0.1:${configuration.apiPort}/api/oauth/callback`),
      );
      const https = configuration.origin.startsWith("https:");
      if (https && !(yield* fs.exists(certificate)))
        return yield* new LocalCertificateUnavailable();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("alchemy", ["dev", ...process.argv.slice(2)], {
          env: {
            ...(https ? { NODE_EXTRA_CA_CERTS: certificate } : {}),
            EXECUTOR_OAUTH_CALLBACK_URL: callback,
          },
          extendEnv: true,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }),
      );
      process.exitCode = Number(yield* child.exitCode);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
