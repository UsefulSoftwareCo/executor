/**
 * Zero-configuration local cloud: `bun run hosted:cloud:dev` needs Docker and internet access only.
 *
 * Runs inside `scripts/dev-host.ts`, which gives this checkout its own HTTPS name on the shared
 * Portless proxy (PORTLESS_URL) and a loopback port for the dashboard (PORT). The launcher then
 * builds the same credential-free environment as the CI Cloud E2E run: emulated Google, GitHub,
 * mail, company lookup and billing, generated secrets and a local Postgres container. Nothing is
 * read from 1Password, the shell or an Alchemy profile.
 */
import { randomBytes } from "node:crypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { freePort as freeLoopbackPort } from "../../../../scripts/dev-host.ts";
import {
  LocalSecrets,
  LocalSession,
  localDevelopmentDirectory,
  localDevelopmentFiles,
  localDevelopmentStage,
} from "./local-development.ts";

class LocalDevelopmentFailed extends Schema.TaggedError<LocalDevelopmentFailed>()(
  "LocalDevelopmentFailed",
  { reason: Schema.String },
) {
  get message() {
    return this.reason;
  }
}

/** Ports are never persisted: rifts copy `.local/`. */
const freePort = Effect.tryPromise({
  try: freeLoopbackPort,
  catch: () => new LocalDevelopmentFailed({ reason: "No free loopback port" }),
});

const EmulatorFixture = Schema.Struct({
  origin: Schema.String,
  services: Schema.Unknown,
});

/** Only these inherited variables reach the stack; credentials in the shell are ignored. */
const inherited = [
  "PATH",
  "HOME",
  "TMPDIR",
  "SHELL",
  "USER",
  "LANG",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "NODE_EXTRA_CA_CERTS",
] as const;

const main = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const origin = (yield* Config.String("PORTLESS_URL").pipe(
      Effect.mapError(
        () =>
          new LocalDevelopmentFailed({
            reason: "Start cloud dev with bun run hosted:cloud:dev",
          }),
      ),
    )).replace(/\/$/, "");
    const webPort = yield* Config.Number("PORT");
    const cloud = path.resolve(
      path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))),
      "..",
    );
    const root = path.resolve(cloud, "../../..");

    const docker = yield* processes.exitCode(
      ChildProcess.make("docker", ["info", "--format", "{{.ServerVersion}}"], {
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    if (docker !== 0)
      return yield* new LocalDevelopmentFailed({
        reason: "Start Docker or OrbStack; cloud dev runs Postgres in a container",
      });

    yield* fs.makeDirectory(localDevelopmentFiles.alchemyHome, { recursive: true, mode: 0o700 });
    yield* fs.chmod(localDevelopmentDirectory, 0o700);

    // Generated once and kept: sessions, encrypted records and the database volume depend on them.
    if (!(yield* fs.exists(localDevelopmentFiles.secrets))) {
      const secret = () => randomBytes(32).toString("hex");
      yield* fs.writeFileString(
        localDevelopmentFiles.secrets,
        JSON.stringify(
          LocalSecrets.make({
            version: 1,
            betterAuthSecret: secret(),
            encryptionKey: secret(),
            databasePassword: secret(),
          }),
          null,
          2,
        ),
        { flag: "wx", mode: 0o600 },
      );
    }
    const secrets = yield* fs
      .readFileString(localDevelopmentFiles.secrets)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(LocalSecrets))));

    // One private emulator instance per checkout origin, created through the E2E provisioning CLI.
    const cached = yield* fs
      .readFileString(localDevelopmentFiles.emulators)
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(EmulatorFixture))),
        Effect.option,
      );
    if (cached._tag === "None" || cached.value.origin !== origin) {
      yield* Console.log("Creating private emulators on emulators.dev for this checkout…");
      const pending = `${localDevelopmentFiles.emulators}.${randomBytes(6).toString("hex")}`;
      const created = yield* processes.exitCode(
        ChildProcess.make(
          "node",
          ["e2e/create-emulators.ts", "--origin", origin, "--output", pending],
          {
            cwd: root,
            stdout: "inherit",
            stderr: "inherit",
          },
        ),
      );
      if (created !== 0)
        return yield* new LocalDevelopmentFailed({
          reason: "Could not create emulators on emulators.dev; check the internet connection",
        });
      yield* fs.rename(pending, localDevelopmentFiles.emulators);
    }
    const emulators = yield* fs
      .readFileString(localDevelopmentFiles.emulators)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(EmulatorFixture))));

    const apiPort = yield* freePort;
    const appUiPort = yield* freePort;
    const databasePort = yield* freePort;
    const env: Record<string, string> = {};
    for (const key of inherited) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, {
      PATH: [path.join(cloud, "node_modules/.bin"), env.PATH ?? ""].join(":"),
      // CI keeps Alchemy away from personal Cloudflare profiles; its home holds no credentials.
      CI: "true",
      ALCHEMY_HOME: localDevelopmentFiles.alchemyHome,
      NODE_ENV: "development",
      // Local Worker, R2 and Hyperdrive need an account-shaped ID, never a real account.
      CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: secrets.betterAuthSecret,
      EXECUTOR_ENCRYPTION_KEY: secrets.encryptionKey,
      CLOUD_DEV_WEB_PORT: String(webPort),
      CLOUD_DEV_API_PORT: String(apiPort),
      CLOUD_DEV_DATABASE_PORT: String(databasePort),
      CLOUD_DEV_DATABASE_PASSWORD: secrets.databasePassword,
      // App hosts route on the raw Host header, which the HTTP/2 proxy rewrites; serve them directly.
      CLOUD_DEV_APP_UI_PORT: String(appUiPort),
      EXECUTOR_APP_UI_BASE_URL: `http://localhost:${appUiPort}`,
      EXECUTOR_EMULATORS: JSON.stringify(emulators.services),
    });

    yield* fs.writeFileString(
      localDevelopmentFiles.session,
      JSON.stringify(LocalSession.make({ pid: process.pid, origin, apiPort, databasePort })),
      { mode: 0o600 },
    );
    yield* Effect.addFinalizer(() => fs.remove(localDevelopmentFiles.session).pipe(Effect.ignore));

    yield* Console.log(`Executor cloud dev (${localDevelopmentStage}): ${origin}`);
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["scripts/dev.ts", "--stage", localDevelopmentStage], {
        cwd: cloud,
        env,
        extendEnv: false,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        forceKillAfter: "15 seconds",
      }),
    );
    process.exitCode = Number(yield* child.exitCode);
  }),
).pipe(Effect.provide(NodeServices.layer));

NodeRuntime.runMain(main);
