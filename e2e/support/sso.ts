import { Config, Effect, FileSystem, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient } from "effect/http";
import { Target } from "./platform.ts";
import { emulatorRequest } from "./emulators.ts";

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
    configure: (email: string, mode: IdentityMode = "valid") =>
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

export type IdentityMode =
  | "valid"
  | "tamper"
  | "wrong-audience"
  | "userinfo-verified"
  | "userinfo-other-subject"
  | "discovery-redirect"
  | "cleartext-authorization"
  | "cleartext-token"
  | "cleartext-jwks"
  | "token-redirect"
  | "jwks-redirect"
  | "unverified"
  | "unverified-thin"
  | "unverified-absent";

export const selfHostSsoIdp = (application: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-sso-idp-" });
    const certificate = `${directory}/cert.pem`,
      key = `${directory}/key.pem`;
    yield* processes.string(
      ChildProcess.make(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          certificate,
          "-days",
          "1",
          "-subj",
          "/CN=127.0.0.1",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
        ],
        { stderr: "pipe" },
      ),
    );
    yield* processes.spawn(
      ChildProcess.make(
        "node",
        [
          "apps/hosted/testing/sso-idp.ts",
          "--directory",
          directory,
          "--application",
          application,
          "--tls-certificate",
          certificate,
          "--tls-key",
          key,
        ],
        {
          env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
          extendEnv: false,
          stdout: "ignore",
          stderr: "ignore",
          forceKillAfter: "5 seconds",
        },
      ),
    );
    const { origin, issuer } = yield* fs
      .readFileString(`${directory}/sso-idp.json`)
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ origin: Schema.String, issuer: Schema.String })),
          ),
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
      );
    return {
      origin,
      issuer,
      certificate,
      discoveryUrl: `${issuer}/.well-known/openid-configuration`,
      configure: (email: string, mode: IdentityMode) =>
        emulatorRequest(origin, "/control", { email, mode }),
    };
  });
