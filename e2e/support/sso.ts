import { Config, Effect, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import { Target } from "./platform.ts";
import { emulatorRequest } from "./emulators.ts";

/** Control only the disposable external IdP and loopback DNS fixture. */
export const ssoFixture = Effect.gen(function* () {
  const target = yield* Target,
    fs = yield* FileSystem.FileSystem,
    http = yield* HttpClient.HttpClient;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const publicIssuer = yield* fs.readFileString(yield* Config.String("E2E_EMULATORS")).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            services: Schema.Struct({ google: Schema.Struct({ baseUrl: Schema.String }) }),
          }),
        ),
      ),
    ),
    Effect.map((fixture) => fixture.services.google.baseUrl),
  );
  const { origin } = yield* fs
    .readFileString(`${target.directory}/sso-idp.json`)
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ origin: Schema.String }))),
      ),
    );
  return {
    origin,
    publicIssuer,
    configure: (email: string, mode: "valid" | "tamper" | "wrong-audience" = "valid") =>
      emulatorRequest(origin, "/control", { email, mode }),
    metadata: Effect.scoped(
      http.get(`${origin}/saml/metadata`).pipe(Effect.flatMap((response) => response.text)),
    ),
    storage: (provider: string, verify = false) =>
      processes
        .string(
          ChildProcess.make(
            "node",
            [
              "apps/hosted/testing/sso-database-fixture.ts",
              "--configuration",
              `${target.directory}/sso-database.json`,
              "--provider",
              provider,
              ...(verify ? ["--verify"] : []),
            ],
            { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, extendEnv: false },
          ),
        )
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Struct({ verified: Schema.Boolean, encrypted: Schema.Boolean }),
              ),
            ),
          ),
        ),
  };
});
