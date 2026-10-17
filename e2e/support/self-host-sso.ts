/** The operator SSO fixture for self-host: a disposable OIDC provider the instance reaches over HTTPS. */
import { Effect, FileSystem, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { outputLines } from "./alchemy-dev-output.ts";
import { emulatorRequest } from "./emulators.ts";
import { Target } from "./platform.ts";

/** What the provider says about the user, besides `sub` and `email` in the ID token. */
export type SelfHostSsoMode =
  | "valid"
  | "userinfo-verified"
  | "userinfo-unverified"
  | "userinfo-other-subject";

/**
 * Start the synthetic identity provider for a self-host instance at `application`. Self-host
 * accepts only an HTTPS issuer, so the provider listens over TLS with a certificate issued for
 * this scenario; `certificate` is the file the instance trusts through `NODE_EXTRA_CA_CERTS`.
 */
export const startSelfHostSsoIdp = (application: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner,
      target = yield* Target;
    // Kept with the run's evidence, so the provider's log outlives the scenario.
    const directory = yield* fs.makeTempDirectory({
      directory: target.directory,
      prefix: "sso-idp",
    });
    const certificate = `${directory}/cert.pem`;
    const key = `${directory}/key.pem`;
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
          "subjectAltName=IP:127.0.0.1,DNS:localhost",
        ],
        { stderr: "pipe" },
      ),
    );
    const issuer = yield* processes.spawn(
      ChildProcess.make(
        "node",
        [
          "apps/hosted/testing/sso-idp.ts",
          "--directory",
          directory,
          "--application",
          application,
          "--tls-key",
          key,
          "--tls-cert",
          certificate,
        ],
        {
          env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
          extendEnv: false,
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: "5 seconds",
        },
      ),
    );
    yield* outputLines(issuer).pipe(
      Stream.runForEach((line) =>
        fs.writeFileString(`${directory}/sso-idp.log`, `${line}\n`, { flag: "a", mode: 0o600 }),
      ),
      Effect.forkScoped,
    );
    const { origin, control } = yield* fs
      .readFileString(`${directory}/sso-idp.json`)
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ origin: Schema.String, control: Schema.String })),
          ),
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
      );
    return {
      /** The HTTPS issuer the instance discovers. */
      origin,
      certificate,
      configure: (email: string, mode: SelfHostSsoMode = "valid") =>
        emulatorRequest(control, "/control", { email, mode }),
    };
  });
