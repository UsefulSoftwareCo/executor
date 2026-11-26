import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, FileSystem, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
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
      const configuration = yield* cloudDevelopment;
      const roleHosts = yield* Config.String("EXECUTOR_ROLE_HOSTS_DOMAIN").pipe(Config.option);
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
            ...(Option.isSome(roleHosts) ? {} : { EXECUTOR_OAUTH_CALLBACK_URL: callback }),
          },
          extendEnv: true,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          forceKillAfter: "10 seconds",
        }),
      );
      process.exitCode = Number(yield* child.exitCode);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
