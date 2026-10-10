import {
  Clock,
  Deferred,
  Effect,
  FileSystem,
  Path,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient } from "effect/http";
import { startAnalyticsCollector } from "./analytics-collector.ts";
import { serveOtlpCollector } from "./otlp-collector.ts";
import { randomBytes } from "node:crypto";
import { createEmulatorFixture, EmulatorFixture, emulatorRequest } from "./emulators.ts";
import { createV1Database, startCloudPostgres, v1DatabaseReader } from "./cloud-postgres.ts";
import { isAlchemyDevFailure, outputLines } from "./alchemy-dev-output.ts";
import { startFixtureControl, fixtureRequest } from "../sdk/fixtures.ts";
import { roleHost } from "./role-hosts.ts";
import { freePort } from "./ports.ts";
import { OperatorOAuthFixture, operatorOAuthFile } from "./operator-oauth.ts";

/** The operator settings for `fixture`: one client whose tokens go only to its own host. */
const operatorOAuthClients = (fixture: typeof OperatorOAuthFixture.Type) => {
  const origin = `http://127.0.0.1:${fixture.port}`;
  return JSON.stringify([
    {
      id: "synthetic-cloud-mail",
      label: "Executor for Synthetic Cloud Mail",
      server: {
        issuer: origin,
        authorizationUrl: `${origin}/authorize`,
        tokenUrl: `${origin}/token`,
      },
      clientId: fixture.clientId,
      clientSecret: fixture.clientSecret,
      tokenEndpointAuthMethod: "client_secret_basic",
      defaultScopes: ["mail.read"],
      placement: { hosts: [`127.0.0.1:${fixture.port}`] },
    },
  ]);
};

class CloudStartFailed extends Schema.TaggedError<CloudStartFailed>()("CloudStartFailed", {
  operation: Schema.String,
}) {
  get message() {
    return `Cloud test environment failed: ${this.operation}`;
  }
}

/**
 * Starts on this host took up to 324 s from `alchemy dev` to a ready API Worker, under load 60
 * with other local Clouds starting beside them.
 */
const readinessDeadline = "10 minutes";

/** A complete local Cloud Worker, real Postgres and hosted emulators; no inherited credentials. */
export const startCloudEnvironment = (input: {
  readonly directory: string;
  readonly origin: string;
  readonly appPort: number;
  readonly databasePort: number;
  readonly commit: string;
  readonly observeUI: boolean;
  /**
   * Every scenario's request comes from this machine's one address, so they would share Better
   * Auth's per-address allowance. As on deployed test stages, the limit is on only for the
   * scenarios that prove it.
   */
  readonly authRateLimit: boolean;
  /**
   * Which host serves the dashboard and sign-in: `app.` of the origin, or, with the rollback
   * switch (`CLOUD_BROWSER_ORIGIN=deployment`), the origin itself.
   */
  readonly browserOrigin: "app" | "deployment";
  /** Registry the local Cloud compiler resolves app packages from. */
  readonly npmRegistry?: string;
  /**
   * Better Auth's OAuth proxy is on, as in production. Without this, this Cloud is the proxy's
   * production: its edge exchanges the codes of stages that sign in through it. With it, this
   * Cloud is such a test stage: it names that production's edge and secret, and uses its emulated
   * providers, whose clients return to that edge.
   */
  readonly signInThrough?: {
    readonly productionUrl: string;
    readonly secret: Redacted.Redacted<string>;
    readonly services: typeof EmulatorFixture.Type.services;
  };
  /** Another local Cloud of this run built the Worker; a second build would rewrite its files. */
  readonly prebuilt?: true;
  /** Origins beside the SSO issuer that this Cloud trusts, such as a stage proxying through it. */
  readonly trustedOrigins?: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner,
      http = yield* HttpClient.HttpClient;
    const cloud = path.resolve("apps/hosted/cloud");
    const browser = input.browserOrigin === "app" ? roleHost(input.origin, "app") : input.origin;
    const directory = path.resolve(input.directory);
    const stage = `e2e-${randomBytes(8).toString("hex")}`;
    const container = `executor-${stage}`;
    const fixture =
      input.signInThrough === undefined
        ? yield* createEmulatorFixture(input.origin)
        : Redacted.make(
            EmulatorFixture.make({
              version: 4,
              origin: input.origin,
              services: input.signInThrough.services,
            }),
          );
    const oauthProxy = {
      productionUrl: input.signInThrough?.productionUrl ?? roleHost(input.origin, "edge"),
      secret: input.signInThrough?.secret ?? Redacted.make(randomBytes(32).toString("hex")),
    };
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
    const collector = yield* serveOtlpCollector(directory);
    const databasePassword = randomBytes(24).toString("hex");
    const operatorOAuth = OperatorOAuthFixture.make({
      port: yield* freePort,
      clientId: "first-party-client",
      clientSecret: randomBytes(16).toString("hex"),
    });
    const operatorOAuthPath = `${directory}/${operatorOAuthFile}`;
    yield* fs.writeFileString(operatorOAuthPath, JSON.stringify(operatorOAuth), { mode: 0o600 });
    yield* Effect.addFinalizer(() => fs.remove(operatorOAuthPath).pipe(Effect.orDie));
    const ssoDatabase = `${directory}/sso-database.json`;
    yield* fs.writeFileString(
      ssoDatabase,
      JSON.stringify({
        database: `postgresql://executor:${databasePassword}@127.0.0.1:${input.databasePort}/executor?sslmode=disable`,
      }),
      { mode: 0o600 },
    );
    yield* Effect.addFinalizer(() => fs.remove(ssoDatabase).pipe(Effect.orDie));
    // The emulated v1 database: the Worker reads it as v1's read-only login, scenarios write it.
    const v1ReaderPassword = randomBytes(24).toString("hex");
    const v1Database = `${directory}/v1-database.json`;
    yield* fs.writeFileString(
      v1Database,
      JSON.stringify({
        database: `postgresql://executor:${databasePassword}@127.0.0.1:${input.databasePort}/executor_v1?sslmode=disable`,
      }),
      { mode: 0o600 },
    );
    yield* Effect.addFinalizer(() => fs.remove(v1Database).pipe(Effect.orDie));
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
      TEST_STAGE_AUTH_RATE_LIMIT: String(input.authRateLimit),
      VITE_POSTHOG_KEY: "synthetic-ingestion-key",
      VITE_POSTHOG_PATH: "/api/0123456789abcdef",
      VITE_POSTHOG_HOST: `http://127.0.0.1:${analyticsPort}`,
      // The site's own build reads the same synthetic project, so its pages run PostHog too.
      PUBLIC_POSTHOG_KEY: "synthetic-ingestion-key",
      PUBLIC_POSTHOG_PATH: "/api/0123456789abcdef",
      PUBLIC_POSTHOG_HOST: `http://127.0.0.1:${analyticsPort}`,
      VITE_EXECUTOR_ENVIRONMENT: "test-local",
      // Serve the same built assets and routing as a deployed stage. Vite's
      // on-demand source transforms must not compete with timed scenarios.
      CLOUD_DEV_DASHBOARD: "built",
      CLOUD_DEV_API_PORT: new URL(input.origin).port,
      CLOUD_DEV_APP_UI_PORT: String(input.appPort),
      EXECUTOR_APP_UI_BASE_URL: `http://localhost:${input.appPort}`,
      ...(input.npmRegistry === undefined ? {} : { EXECUTOR_NPM_REGISTRY: input.npmRegistry }),
      CLOUD_DEV_DATABASE_PORT: String(input.databasePort),
      CLOUD_DEV_DATABASE_PASSWORD: databasePassword,
      CLOUD_DEV_EXTERNAL_DATABASE: "true",
      EXECUTOR_EMULATORS: JSON.stringify(Redacted.value(fixture).services),
      // Every account this run creates is new to the v1 check; scenarios backdate one to skip it.
      V1_MEMBERSHIP_CHECK_SINCE: new Date(yield* Clock.currentTimeMillis).toISOString(),
      V1_DATABASE_URL: `postgresql://${v1DatabaseReader}:${v1ReaderPassword}@127.0.0.1:${input.databasePort}/executor_v1?sslmode=disable`,
      // Serve the role hosts as production does, at `app.`, `mcp.` and `api.` of the origin's host.
      EXECUTOR_ROLE_HOSTS_DOMAIN: new URL(input.origin).hostname,
      CLOUD_BROWSER_ORIGIN: input.browserOrigin,
      EXECUTOR_EMULATED_OAUTH_PROXY_PRODUCTION_URL: oauthProxy.productionUrl,
      EXECUTOR_EMULATED_OAUTH_PROXY_SECRET: Redacted.value(oauthProxy.secret),
      EXECUTOR_FIRST_PARTY_OAUTH_CLIENTS: operatorOAuthClients(operatorOAuth),
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
    // Lets the lock fixture stop and resume one of the database's backends.
    const postgresContainer = `${directory}/postgres-container.json`;
    yield* fs.writeFileString(
      postgresContainer,
      JSON.stringify({
        container,
        dockerHost: dockerEnv.DOCKER_HOST,
        dockerConfig: dockerEnv.DOCKER_CONFIG,
      }),
      { mode: 0o600 },
    );
    yield* Effect.addFinalizer(() => fs.remove(postgresContainer).pipe(Effect.orDie));
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
    const capture = (
      child: ChildProcessSpawner.ChildProcessHandle,
      file: string,
      onLine: (line: string) => Effect.Effect<void> = () => Effect.void,
    ) =>
      outputLines(child).pipe(
        Stream.runForEach((line) =>
          fs
            .writeFileString(`${directory}/${file}`, `${line}\n`, { flag: "a", mode: 0o600 })
            .pipe(Effect.andThen(onLine(line))),
        ),
        Effect.forkScoped,
      );
    const ssoIssuer = yield* processes.spawn(
      ChildProcess.make(
        "node",
        [
          "apps/hosted/testing/sso-idp.ts",
          "--directory",
          directory,
          // SSO returns to the browser origin, where sign-in runs.
          "--application",
          browser,
        ],
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
    yield* startCloudPostgres({
      container,
      databasePort: input.databasePort,
      databasePassword,
      dockerEnv,
      log: `${directory}/postgres.log`,
    });
    yield* createV1Database({ container, dockerEnv, readerPassword: v1ReaderPassword });
    const built =
      input.prebuilt === true
        ? 0
        : yield* processes.exitCode(
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
        env: {
          ...env,
          AUTH_TRUSTED_ORIGINS: [sso.origin, ...(input.trustedOrigins ?? [])].join(","),
        },
        extendEnv: false,
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "15 seconds",
      }),
    );
    // A failed apply or run leaves `alchemy dev` running so healthy resources keep serving, but in a
    // run nothing will edit the sources it waits on, so the Worker that failed never starts.
    const applyFailed = yield* Deferred.make<void>();
    yield* capture(server, "cloud.log", (line) =>
      isAlchemyDevFailure(line) ? Deferred.succeed(applyFailed, undefined) : Effect.void,
    );
    // A Worker that is still starting holds the request until it can answer, so each probe has its
    // own deadline and the whole wait has one too.
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
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.retry({ schedule: Schedule.spaced("500 millis") }),
      Effect.timeoutOrElse({
        duration: readinessDeadline,
        orElse: () =>
          Effect.fail(
            new CloudStartFailed({
              operation: `Cloud did not answer /health within ${readinessDeadline}; see cloud.log`,
            }),
          ),
      }),
    );
    yield* Effect.raceFirst(
      ready,
      Effect.raceFirst(
        server.exitCode.pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new CloudStartFailed({ operation: "Cloud stopped before readiness; see cloud.log" }),
            ),
          ),
        ),
        Deferred.await(applyFailed).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new CloudStartFailed({
                operation: "Alchemy could not start every Cloud resource; see cloud.log",
              }),
            ),
          ),
        ),
      ),
    );
    const fixtures = yield* startFixtureControl(input.origin, directory, browser);
    yield* fixtureRequest(fixtures, "/configure", {
      origin: input.origin,
      stage: "local",
      database: `postgres://executor:${databasePassword}@127.0.0.1:${input.databasePort}/executor`,
      secret: env.BETTER_AUTH_SECRET,
      databaseName: "executor",
      databaseUsername: "executor",
    });
    return {
      emulators,
      fixtures,
      origin: input.origin,
      oauthProxy: { ...oauthProxy, services: Redacted.value(fixture).services },
    };
  });
