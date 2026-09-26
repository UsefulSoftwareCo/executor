import { Effect, FileSystem, Path, Redacted, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import { startAnalyticsCollector } from "./analytics-collector.ts";
import { startOtlpCollector } from "./otlp-collector.ts";
import { randomBytes } from "node:crypto";
import { createEmulatorFixture, emulatorRequest } from "./emulators.ts";
import { startFixtureControl, fixtureRequest } from "../sdk/fixtures.ts";

class CloudStartFailed extends Schema.TaggedError<CloudStartFailed>()("CloudStartFailed", {
  operation: Schema.String,
}) {
  get message() {
    return `Cloud test environment failed: ${this.operation}`;
  }
}

/** A complete local Cloud Worker, real Postgres and hosted emulators; no inherited credentials. */
export const startCloudEnvironment = (input: {
  readonly directory: string;
  readonly origin: string;
  readonly appPort: number;
  readonly databasePort: number;
  readonly commit: string;
  readonly observeUI: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner,
      http = yield* HttpClient.HttpClient;
    const cloud = path.resolve("apps/hosted/cloud");
    const directory = path.resolve(input.directory);
    const stage = `e2e-${randomBytes(8).toString("hex")}`;
    const container = `executor-${stage}`;
    // In dev, account sign-in returns to the API server's local address.
    const fixture = yield* createEmulatorFixture(
      input.origin,
      `http://127.0.0.1:${new URL(input.origin).port}/api/oauth/callback`,
    );
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        Object.values(Redacted.value(fixture).services),
        (service) => emulatorRequest(service.baseUrl, "/_emulate/reset", {}),
        { concurrency: 5 },
      ).pipe(Effect.asVoid, Effect.orDie),
    );
    const emulators = `${directory}/emulators.json`;
    yield* fs.writeFileString(emulators, JSON.stringify(Redacted.value(fixture)), { mode: 0o600 });
    yield* Effect.addFinalizer(() => fs.remove(emulators).pipe(Effect.orDie));
    const analyticsPort = yield* startAnalyticsCollector(directory);
    const collector = yield* startOtlpCollector(directory);
    const databasePassword = randomBytes(24).toString("hex");
    const ssoDatabase = `${directory}/sso-database.json`;
    yield* fs.writeFileString(
      ssoDatabase,
      JSON.stringify({
        database: `postgresql://executor:${databasePassword}@127.0.0.1:${input.databasePort}/executor?sslmode=disable`,
      }),
      { mode: 0o600 },
    );
    yield* Effect.addFinalizer(() => fs.remove(ssoDatabase).pipe(Effect.orDie));
    const env = {
      PATH: [path.join(cloud, "node_modules/.bin"), process.env.PATH ?? ""].join(
        process.platform === "win32" ? ";" : ":",
      ),
      ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      // CI prevents Alchemy from inspecting personal profiles; its home is empty for every run.
      CI: "true",
      ALCHEMY_HOME: `${directory}/alchemy-home`,
      NODE_ENV: "development",
      VITE_UI_OBSERVE: input.observeUI ? "1" : "0",
      // Local artifact addresses need an account-shaped ID, never a real cloud credential.
      CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
      BETTER_AUTH_URL: input.origin,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      EXECUTOR_BUILD_VERSION: input.commit,
      POSTHOG_LOCAL_TEST_PORT: String(analyticsPort),
      SENTRY_LOCAL_TEST_PORT: String(analyticsPort),
      VITE_SENTRY_TUNNEL: "/api/fedcba9876543210/submit",
      VITE_SENTRY_DSN: `http://synthetic@127.0.0.1:${analyticsPort}/1`,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector}/v1/traces`,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${collector}/v1/logs`,
      EXECUTOR_ENVIRONMENT: "test-local",
      VITE_POSTHOG_KEY: "synthetic-ingestion-key",
      VITE_POSTHOG_PATH: "/api/0123456789abcdef",
      VITE_POSTHOG_HOST: `http://127.0.0.1:${analyticsPort}`,
      VITE_EXECUTOR_ENVIRONMENT: "test-local",
      VITE_EXECUTOR_RELEASE: input.commit,
      // Serve the same built assets and routing as a deployed stage. Vite's
      // on-demand source transforms must not compete with timed scenarios.
      CLOUD_DEV_DASHBOARD: "built",
      CLOUD_DEV_API_PORT: new URL(input.origin).port,
      CLOUD_DEV_APP_UI_PORT: String(input.appPort),
      EXECUTOR_APP_UI_BASE_URL: `http://localhost:${input.appPort}`,
      CLOUD_DEV_DATABASE_PORT: String(input.databasePort),
      CLOUD_DEV_DATABASE_PASSWORD: databasePassword,
      CLOUD_DEV_EXTERNAL_DATABASE: "true",
      EXECUTOR_EMULATORS: JSON.stringify(Redacted.value(fixture).services),
    };
    yield* fs.makeDirectory(env.ALCHEMY_HOME, { recursive: true, mode: 0o700 });
    const dockerHost = (yield* processes.string(
      ChildProcess.make("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]),
    )).trim();
    if (!dockerHost.startsWith("unix://") && !dockerHost.startsWith("npipe://"))
      return yield* new CloudStartFailed({
        operation: "Use a local Docker daemon for disposable test data",
      });
    const dockerEnv = {
      PATH: env.PATH,
      DOCKER_HOST: dockerHost,
      DOCKER_CONFIG: `${directory}/docker-client`,
    };
    yield* fs.makeDirectory(dockerEnv.DOCKER_CONFIG, { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(
      `${directory}/environment.json`,
      JSON.stringify(
        {
          runtime: "Alchemy local Worker and disposable Postgres",
          origin: input.origin,
          externalServices: "emulators.dev",
          inheritedCredentials: false,
          savedAuthProfile: false,
          savedDockerCredentials: false,
          generatedTestCredentials: true,
          environmentKeys: Object.keys(env).sort(),
        },
        null,
        2,
      ),
    );
    const capture = (child: ChildProcessSpawner.ChildProcessHandle, file: string) =>
      Stream.merge(child.stdout, child.stderr).pipe(
        Stream.decodeText(),
        Stream.runForEach((text) =>
          fs.writeFileString(`${directory}/${file}`, text, { flag: "a", mode: 0o600 }),
        ),
        Effect.forkScoped,
      );
    const ssoIssuer = yield* processes.spawn(
      ChildProcess.make(
        "node",
        ["apps/hosted/testing/sso-idp.ts", "--directory", directory, "--application", input.origin],
        {
          env: { PATH: env.PATH, NODE_ENV: "test" },
          extendEnv: false,
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: "5 seconds",
        },
      ),
    );
    yield* capture(ssoIssuer, "sso-idp.log");
    const sso = yield* fs
      .readFileString(`${directory}/sso-idp.json`)
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ origin: Schema.String })),
          ),
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
      );
    const docker = yield* processes.spawn(
      ChildProcess.make(
        "docker",
        [
          "run",
          "--rm",
          "--name",
          container,
          "--publish",
          `127.0.0.1:${input.databasePort}:5432`,
          "--env",
          "POSTGRES_USER=executor",
          "--env",
          "POSTGRES_DB=executor",
          "--env",
          "POSTGRES_PASSWORD",
          "postgres:17",
          // Local Hyperdrive is a TCP passthrough, without the deployed pooler.
          // Parallel browser requests and their background jobs each own SQL
          // connections; PostgreSQL's default 100 slots rejects startup bursts.
          "-c",
          "max_connections=512",
        ],
        {
          env: {
            ...dockerEnv,
            POSTGRES_PASSWORD: databasePassword,
          },
          extendEnv: false,
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: "10 seconds",
        },
      ),
    );
    yield* capture(docker, "postgres.log");
    yield* Effect.addFinalizer(() =>
      processes
        .exitCode(
          ChildProcess.make("docker", ["rm", "--force", "--volumes", container], {
            stdout: "ignore",
            stderr: "ignore",
            env: dockerEnv,
            extendEnv: false,
          }),
        )
        .pipe(
          Effect.flatMap((code) =>
            code === 0
              ? Effect.void
              : Effect.die(new Error("Cannot remove disposable Cloud test database")),
          ),
          Effect.orDie,
        ),
    );
    // The image starts a temporary Unix-only server during initdb. Wait for its
    // final TCP listener before migrations and fixture setup compete to use it.
    yield* processes
      .exitCode(
        ChildProcess.make(
          "docker",
          ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "executor", "-d", "executor"],
          {
            env: dockerEnv,
            extendEnv: false,
            stdout: "ignore",
            stderr: "ignore",
          },
        ),
      )
      .pipe(
        Effect.flatMap((code) =>
          code === 0
            ? Effect.void
            : Effect.fail(new CloudStartFailed({ operation: "Postgres TCP readiness" })),
        ),
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 90 }),
      );
    const built = yield* processes.exitCode(
      ChildProcess.make("bun", ["run", "framework:build"], {
        cwd: cloud,
        env,
        extendEnv: false,
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    if (built !== 0)
      return yield* new CloudStartFailed({ operation: "Build the actual Cloud Worker" });
    const server = yield* processes.spawn(
      ChildProcess.make("node", ["scripts/dev.ts", "--stage", stage], {
        cwd: cloud,
        env: { ...env, AUTH_TRUSTED_ORIGINS: sso.origin },
        extendEnv: false,
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "15 seconds",
      }),
    );
    yield* capture(server, "cloud.log");
    const ready = Effect.scoped(
      http.get(`${input.origin}/health`).pipe(
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            yield* response.text;
            if (response.status !== 200)
              return yield* new CloudStartFailed({ operation: "Cloud readiness" });
          }),
        ),
      ),
    ).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 360 }));
    yield* Effect.raceFirst(
      ready,
      server.exitCode.pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new CloudStartFailed({ operation: "Cloud stopped before readiness; see cloud.log" }),
          ),
        ),
      ),
    );
    const fixtures = yield* startFixtureControl(input.origin, directory);
    yield* fixtureRequest(fixtures, "/configure", {
      origin: input.origin,
      stage: "local",
      database: `postgres://executor:${databasePassword}@127.0.0.1:${input.databasePort}/executor`,
      secret: env.BETTER_AUTH_SECRET,
      databaseName: "executor",
      databaseUsername: "executor",
    });
    return { emulators, fixtures, origin: input.origin };
  });
