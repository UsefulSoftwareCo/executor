import { engineCallFaults } from "../test-plan.ts";
import {
  Clock,
  Console,
  Effect,
  FileSystem,
  Path,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient } from "effect/http";
import { startAnalyticsCollector } from "./analytics-collector.ts";
import { serveShardedOtlpCollector } from "./otlp-collector.ts";
import { randomBytes } from "node:crypto";
import {
  createEmulatorFixture,
  EmulatorFixture,
  emulatorRequest,
  EmulatorRetryRecords,
} from "./emulators.ts";
import { startCloudPostgres } from "./cloud-postgres.ts";
import { runtimeCrashesFile, trackRuntimeCrash, type RuntimeCrash } from "./runtime-crashes.ts";
import { v1McpForwardFile } from "./v1-mcp-forward.ts";
import { v1SessionHandoffFile } from "./v1-session-handoff.ts";
import {
  alchemyResourceFailure,
  followAlchemyDev,
  outputLines,
  unboundPort,
} from "./alchemy-dev-output.ts";
import { startFixtureControl, fixtureRequest } from "../sdk/fixtures.ts";
import { roleHost } from "./role-hosts.ts";
import { freePort } from "./ports.ts";
import { OperatorOAuthFixture, operatorOAuthFile, syntheticCloudGoogle } from "./operator-oauth.ts";
import { reveal, secret } from "./failure-text.ts";
import { cloudNotesFile, type CloudNotesSource } from "./cloud-release-notes.ts";

const operatorOAuthClients = (fixture: typeof OperatorOAuthFixture.Type) => {
  const origin = `http://127.0.0.1:${fixture.port}`;
  return {
    EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify([
      {
        id: "synthetic-cloud-mail",
        label: "Executor for Synthetic Cloud Mail",
        server: {
          issuer: origin,
          authorizationUrl: `${origin}/authorize`,
          tokenUrl: `${origin}/token`,
        },
        tokenEndpointAuthMethod: "client_secret_basic",
        defaultScopes: ["mail.read"],
        placement: { hosts: [`127.0.0.1:${fixture.port}`] },
      },
    ]),
    EXECUTOR_OAUTH_SYNTHETIC_CLOUD_MAIL_CLIENT_ID: fixture.clientId,
    EXECUTOR_OAUTH_SYNTHETIC_CLOUD_MAIL_CLIENT_SECRET: fixture.clientSecret,
    EXECUTOR_OAUTH_GOOGLE_CLIENT_ID: syntheticCloudGoogle.clientId,
    EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET: syntheticCloudGoogle.clientSecret,
  };
};

class CloudStartFailed extends Schema.TaggedError<CloudStartFailed>()("CloudStartFailed", {
  operation: Schema.String,
}) {
  get message() {
    return `Cloud test environment failed: ${this.operation}`;
  }
}

const readinessDeadline = "10 minutes";

const collectorShards = 4;

export const startCloudEnvironment = (input: {
  readonly directory: string;
  readonly origin: string;
  readonly appPort: number;
  readonly databasePort: number;
  readonly commit: string;
  readonly observeUI: boolean;
  readonly authRateLimit: boolean;
  /** Enable the synthetic local relay for the focused telemetry relay scenario. */
  readonly telemetryRelay?: boolean;
  readonly removalRevocationBudgetMs?: number;
  readonly releaseNotes?: CloudNotesSource;
  /**
   * Which host serves the dashboard and sign-in: `app.` of the origin, or, with the rollback
   * switch (`CLOUD_BROWSER_ORIGIN=deployment`), the origin itself.
   */
  readonly browserOrigin: "app" | "deployment";
  readonly npmRegistry?: string;
  readonly catalogs?: string;
  readonly signInThrough?: {
    readonly productionUrl: string;
    readonly secret: Redacted.Redacted<string>;
    readonly services: typeof EmulatorFixture.Type.services;
  };
  readonly prebuilt?: true;
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
        ? yield* createEmulatorFixture(input.origin).pipe(
            Effect.provideService(EmulatorRetryRecords, { directory }),
          )
        : secret(
            EmulatorFixture.make({
              version: 4,
              origin: input.origin,
              services: input.signInThrough.services,
            }),
          );
    const oauthProxy = {
      productionUrl: input.signInThrough?.productionUrl ?? roleHost(input.origin, "edge"),
      secret: input.signInThrough?.secret ?? secret(randomBytes(32).toString("hex")),
    };
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        Object.values(reveal(fixture).services),
        (service) =>
          emulatorRequest(service.baseUrl, "/_emulate/reset", {}).pipe(
            Effect.catch(() => Console.error("Could not reset one external test emulator.")),
            Effect.provideService(EmulatorRetryRecords, { directory }),
          ),
        { concurrency: 5, discard: true },
      ),
    );
    const emulators = `${directory}/emulators.json`;
    yield* fs.writeFileString(emulators, JSON.stringify(reveal(fixture)), { mode: 0o600 });
    yield* Effect.addFinalizer(() => fs.remove(emulators).pipe(Effect.orDie));
    const analyticsPort = yield* startAnalyticsCollector(directory);
    const collector = yield* serveShardedOtlpCollector(directory, collectorShards);
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
    const v1ForwardSecret = randomBytes(32).toString("hex");
    const v1Forward = `${directory}/${v1McpForwardFile}`;
    yield* fs.writeFileString(v1Forward, JSON.stringify({ secret: v1ForwardSecret }), {
      mode: 0o600,
    });
    yield* Effect.addFinalizer(() => fs.remove(v1Forward).pipe(Effect.orDie));
    const v1HandoffSecret = randomBytes(32).toString("hex");
    const v1Handoff = `${directory}/${v1SessionHandoffFile}`;
    yield* fs.writeFileString(v1Handoff, JSON.stringify({ secret: v1HandoffSecret }), {
      mode: 0o600,
    });
    yield* Effect.addFinalizer(() => fs.remove(v1Handoff).pipe(Effect.orDie));
    const notes = yield* cloudNotesFile(input.releaseNotes, directory);
    const env = {
      PATH: [path.join(cloud, "node_modules/.bin"), process.env.PATH ?? ""].join(
        process.platform === "win32" ? ";" : ":",
      ),
      ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      CI: "true",
      ...(process.env.NODE_EXTRA_CA_CERTS === undefined
        ? {}
        : { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }),
      ALCHEMY_HOME: `${directory}/alchemy-home`,
      NODE_ENV: "development",
      VITE_UI_OBSERVE: input.observeUI ? "1" : "0",
      CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
      BETTER_AUTH_URL: input.origin,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      EXECUTOR_BUILD_VERSION: input.commit,
      POSTHOG_LOCAL_TEST_PORT: String(analyticsPort),
      SENTRY_LOCAL_TEST_PORT: String(analyticsPort),
      ...(input.telemetryRelay
        ? {
            EXECUTOR_TELEMETRY_RELAY_URL: `http://127.0.0.1:${analyticsPort}/__telemetry/v1`,
            EXECUTOR_TELEMETRY_RELAY_TOKEN: "synthetic-telemetry-relay-token",
          }
        : {}),
      VITE_SENTRY_TUNNEL: "/api/fedcba9876543210/submit",
      VITE_SENTRY_DSN: `http://synthetic@127.0.0.1:${analyticsPort}/1`,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector}/v1/traces`,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${collector}/v1/logs`,
      EXECUTOR_ENVIRONMENT: "test-local",
      TEST_STAGE_AUTH_RATE_LIMIT: String(input.authRateLimit),
      ...(input.removalRevocationBudgetMs === undefined
        ? {}
        : { TEST_STAGE_REMOVAL_REVOCATION_BUDGET_MS: String(input.removalRevocationBudgetMs) }),
      VITE_POSTHOG_KEY: "synthetic-ingestion-key",
      VITE_POSTHOG_PATH: "/api/0123456789abcdef",
      VITE_POSTHOG_HOST: `http://127.0.0.1:${analyticsPort}`,
      PUBLIC_POSTHOG_KEY: "synthetic-ingestion-key",
      PUBLIC_POSTHOG_PATH: "/api/0123456789abcdef",
      PUBLIC_POSTHOG_HOST: `http://127.0.0.1:${analyticsPort}`,
      VITE_EXECUTOR_ENVIRONMENT: "test-local",
      CLOUD_DEV_DASHBOARD: "built",
      CLOUD_DEV_API_PORT: new URL(input.origin).port,
      CLOUD_DEV_APP_UI_PORT: String(input.appPort),
      EXECUTOR_APP_UI_BASE_URL: `http://localhost:${input.appPort}`,
      ...(input.npmRegistry === undefined ? {} : { EXECUTOR_NPM_REGISTRY: input.npmRegistry }),
      ...(input.catalogs === undefined
        ? {}
        : { EXECUTOR_CATALOG_URL: `${input.catalogs}/catalog/index.json` }),
      CLOUD_DEV_DATABASE_PORT: String(input.databasePort),
      CLOUD_DEV_DATABASE_PASSWORD: databasePassword,
      CLOUD_DEV_EXTERNAL_DATABASE: "true",
      EXECUTOR_EMULATORS: JSON.stringify(reveal(fixture).services),
      EXECUTOR_CLOUD_RELEASE_NOTES: notes,
      EXECUTOR_TEST_WORKFLOW_ENGINE_FAULTS: JSON.stringify(engineCallFaults),
      V1_MCP_FORWARD_SECRET: v1ForwardSecret,
      V1_SESSION_HANDOFF_SECRET: v1HandoffSecret,
      EXECUTOR_ROLE_HOSTS_DOMAIN: new URL(input.origin).hostname,
      CLOUD_BROWSER_ORIGIN: input.browserOrigin,
      EXECUTOR_EMULATED_OAUTH_PROXY_PRODUCTION_URL: oauthProxy.productionUrl,
      EXECUTOR_EMULATED_OAUTH_PROXY_SECRET: reveal(oauthProxy.secret),
      ...operatorOAuthClients(operatorOAuth),
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
      `${directory}/alchemy-state.json`,
      JSON.stringify({
        directory: path.join(cloud, ".alchemy", "state", "executor-next-hosted", stage),
      }),
      { mode: 0o600 },
    );
    yield* Effect.addFinalizer(() =>
      fs.remove(`${directory}/alchemy-state.json`).pipe(Effect.orDie),
    );
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
    const portHolders = (port: number) =>
      Effect.gen(function* () {
        const sockets = yield* processes
          .string(
            process.platform === "linux"
              ? ChildProcess.make("ss", ["-Htanp", `( sport = :${port} )`])
              : ChildProcess.make("lsof", ["-nP", `-iTCP:${port}`]),
          )
          .pipe(
            Effect.timeout("5 seconds"),
            Effect.catch(() => Effect.succeed("(could not list sockets)")),
          );
        const ephemeral =
          process.platform === "linux"
            ? yield* fs.readFileString("/proc/sys/net/ipv4/ip_local_port_range").pipe(
                Effect.map((range) => `; ephemeral ports ${range.trim().replace(/\s+/g, "-")}`),
                Effect.catch(() => Effect.succeed("")),
              )
            : "";
        const listed = sockets.trim().replace(/\s*\n\s*/g, " | ");
        return `sockets on port ${port}: ${listed === "" ? "none now" : listed}${ephemeral}`;
      });
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
        ["apps/hosted/testing/sso-idp.ts", "--directory", directory, "--application", browser],
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
    const resourceFailures = yield* Ref.make<ReadonlyArray<{ resource: string; reason: string }>>(
      [],
    );
    const crashes = yield* Ref.make<ReadonlyArray<RuntimeCrash>>([]);
    const noteCrash = (line: string) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const changed = trackRuntimeCrash(yield* Ref.get(crashes), line, at);
        if (changed === undefined) return;
        yield* Ref.set(crashes, changed);
        yield* fs
          .writeFileString(`${directory}/${runtimeCrashesFile}`, JSON.stringify(changed, null, 2), {
            mode: 0o600,
          })
          .pipe(Effect.orDie);
      });
    const dev = yield* followAlchemyDev(server, (line) =>
      fs.writeFileString(`${directory}/cloud.log`, `${line}\n`, { flag: "a", mode: 0o600 }).pipe(
        Effect.orDie,
        Effect.andThen(() => {
          const failure = alchemyResourceFailure(line);
          return failure === undefined
            ? Effect.void
            : Ref.update(resourceFailures, (all) => [...all, failure]);
        }),
        Effect.andThen(noteCrash(line)),
      ),
    );
    const describeResourceFailures = Effect.gen(function* () {
      const failures = yield* Ref.get(resourceFailures);
      const holders = yield* Effect.forEach(failures, ({ reason }) => {
        const port = unboundPort(reason);
        return port === undefined
          ? Effect.succeed([])
          : portHolders(port).pipe(Effect.map((text) => [text]));
      });
      return [
        ...failures.map(({ resource, reason }) => `${resource}: ${reason}`),
        ...holders.flat(),
      ].join("; ");
    });
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
        dev.failed.pipe(
          Effect.andThen(describeResourceFailures),
          Effect.flatMap((failures) =>
            dev.report.pipe(
              Effect.flatMap((report) =>
                Effect.fail(
                  new CloudStartFailed({
                    operation: `Alchemy could not start every Cloud resource${failures === "" ? "" : ` (${failures})`}; see cloud.log. Alchemy reported:\n${report}`,
                  }),
                ),
              ),
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
      oauthProxy: { ...oauthProxy, services: reveal(fixture).services },
    };
  });
