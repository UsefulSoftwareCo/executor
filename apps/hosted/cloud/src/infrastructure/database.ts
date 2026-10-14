/** Database infrastructure belongs to cloud; Docker and local keep their own drivers. */
import * as Output from "alchemy/Output";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Planetscale from "alchemy/Planetscale";
import { Random, RuntimeContext } from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import type { InputProps } from "alchemy/Input";
import { adopt } from "alchemy/AdoptPolicy";
import { retain } from "alchemy/RemovalPolicy";
import { PgClient } from "@effect/sql-pg";
import {
  Config,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
  type Scope,
  Tracer,
} from "effect";
import { developmentDatabase } from "./development.ts";
import { cloudOrigin, roleHostsJobEnvironment, testStage, type TestStage } from "./stage.ts";
import { postgresUrl, previewDatabase, previewPoolConnections } from "./preview-database.ts";
import { missingV1PlanetscaleDatabase } from "./v1-membership-settings.ts";

/**
 * Hyperdrive needs an uploaded trust root even for publicly issued certificates.
 * PlanetScale's Let's Encrypt chain terminates at ISRG Root X1.
 */
const certificateAuthority = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const certificatePath = yield* path.fromFileUrl(
    new URL("../../certificates/isrg-root-x1.pem", import.meta.url),
  );
  // Cloudflare deduplicates identical CA certificates across stages. Removing
  // one stage must not try to delete another stage's shared trust root.
  return yield* Cloudflare.MtlsCertificate.MtlsCertificate("DatabaseCertificateAuthority", {
    ca: true,
    certificates: yield* fs.readFileString(certificatePath),
  }).pipe(retain());
});

type HyperdriveProps = Effect.Effect<
  InputProps<Cloudflare.Hyperdrive.Props>,
  never,
  FileSystem.FileSystem | Path.Path | Cloudflare.Providers
>;

/**
 * The runtime role's two routes into Postgres. `url` is PgBouncer (port 6432 on PlanetScale),
 * bound as the `DatabaseUrl` secret. `hyperdrive` holds the props of the Hyperdrive configuration
 * in front of it, evaluated only when the stack declares that configuration; it is absent where
 * Hyperdrive does not front the database (Neon previews). Both wait for the migration job.
 */
const runtimeDatabase = (
  url: Output.Output<Redacted.Redacted<string>, never>,
  hyperdrive: Option.Option<HyperdriveProps>,
) => ({ url, hyperdrive });

/** Both SQL adapters create schema objects as the stable owner, not the rotating login. */
const migrationUrl = (origin: Planetscale.PostgresOrigin) => {
  const url = new URL(Redacted.value(postgresUrl(origin)));
  url.searchParams.set("options", "-c role=postgres");
  return Redacted.make(url.toString());
};

/** Dedicated automated and performance stages may hand fixture authority to a local runner. */
const fixtureStage = /^test-(?:e2e|perf)-/;

/** Provision the preview schema and local fixtures before exposing its runtime URL. */
const preparedPreviewDatabase = (stage: TestStage) =>
  Effect.gen(function* () {
    const preview = yield* previewDatabase(stage);
    const migrations = globalThis.__ALCHEMY_RUNTIME__
      ? yield* Command.Exec.ref("Migrations")
      : yield* Command.Exec("Migrations", {
          command: "node src/migrate.ts",
          env: {
            DATABASE_URL: preview.migrationUrl,
            // The same logical id as `cloudSecrets`, so the job signs with the secret the Worker will verify.
            BETTER_AUTH_SECRET: (yield* Random("AuthSecret")).text,
            BETTER_AUTH_URL: stage.origin,
            // Auth setup provisions the OAuth resources at the role hosts too.
            ...(yield* roleHostsJobEnvironment),
          },
          memo: false,
          timeout: "5 minutes",
        });
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const fixtureOutput = yield* Config.String("TEST_STAGE_ACCOUNTS_OUTPUT").pipe(Config.option);
      const fixtureControl = yield* Config.Redacted("TEST_STAGE_FIXTURE_CONTROL").pipe(
        Config.option,
      );
      if (Option.isSome(fixtureControl)) {
        if (!fixtureStage.test(stage.name))
          return yield* Effect.die(
            new Error("Fixture control requires a dedicated test-e2e- or test-perf- stage"),
          );
        yield* Command.Exec("ScenarioFixtures", {
          command: "node scripts/configure-test-fixtures.ts",
          env: {
            ALCHEMY_STAGE: stage.name,
            BETTER_AUTH_URL: stage.origin,
            BETTER_AUTH_SECRET: (yield* Random("AuthSecret")).text,
            TEST_STAGE_FIXTURE_CONTROL: fixtureControl.value,
            TEST_STAGE_DATABASE_BRANCH: preview.branchName,
            TEST_STAGE_DATABASE_USERNAME: preview.username,
            TEST_STAGE_DATABASE_NAME: preview.databaseName,
            DATABASE_URL: Output.all(preview.migrationUrl, migrations.hash).pipe(
              Output.map(([url]) => url),
            ),
          },
          memo: false,
          timeout: "1 minute",
        });
      }
      if (Option.isSome(fixtureOutput)) {
        const fixtureOrganization = yield* Config.String("TEST_STAGE_APP_ORGANIZATION").pipe(
          Config.option,
        );
        if (!stage.name.startsWith("test-e2e-"))
          return yield* Effect.die(
            new Error("Account fixtures require a dedicated test-e2e- stage"),
          );
        yield* Command.Exec("TestAccounts", {
          command: "node scripts/test-accounts.ts",
          env: {
            ALCHEMY_STAGE: stage.name,
            BETTER_AUTH_URL: stage.origin,
            BETTER_AUTH_SECRET: (yield* Random("AuthSecret")).text,
            TEST_STAGE_ACCOUNTS_OUTPUT: fixtureOutput.value,
            TEST_STAGE_DATABASE_BRANCH: preview.branchName,
            TEST_STAGE_DATABASE_USERNAME: preview.username,
            TEST_STAGE_DATABASE_NAME: preview.databaseName,
            ...(Option.isSome(fixtureOrganization)
              ? { TEST_STAGE_APP_ORGANIZATION: fixtureOrganization.value }
              : {}),
            DATABASE_URL: Output.all(preview.migrationUrl, migrations.hash).pipe(
              Output.map(([url]) => url),
            ),
          },
          memo: false,
          timeout: "2 minutes",
        });
      }
    }
    // Depending on the migration hash keeps the Worker from serving an empty schema.
    const migrated = <A>(value: Output.Output<A, never>) =>
      Output.all(value, migrations.hash).pipe(Output.map(([resolved]) => resolved));
    return runtimeDatabase(
      migrated(preview.runtimeUrl),
      Option.map(preview.hyperdriveOrigin, (origin) =>
        hyperdriveProps(migrated(origin), Option.some(previewPoolConnections)),
      ),
    );
  });

/**
 * Hyperdrive verifies PlanetScale's certificate against the uploaded trust root. Caching stays
 * off: reads must observe writes made through other connections.
 */
const hyperdriveProps = (
  origin: Output.Output<Planetscale.PostgresOrigin, never>,
  originConnectionLimit: Option.Option<number>,
): HyperdriveProps =>
  Effect.gen(function* () {
    const authority = yield* certificateAuthority;
    return {
      origin,
      caching: { disabled: true },
      mtls: { sslmode: "verify-full" as const, caCertificateId: authority.mtlsCertificateId },
      ...Option.match(originConnectionLimit, {
        onNone: () => ({}),
        onSome: (limit) => ({ originConnectionLimit: limit }),
      }),
    };
  }).pipe(Effect.orDie);

/**
 * Production's PlanetScale database, its roles and the migration job. Workers use the runtime
 * role through PlanetScale's PgBouncer (port 6432), directly or through Hyperdrive. Only the
 * migration job receives the schema-owner role.
 */
const productionDatabase = Effect.gen(function* () {
  // Inside the Worker only the bindings' identities are needed, not provisioning config.
  if (globalThis.__ALCHEMY_RUNTIME__) {
    const role = yield* Planetscale.PostgresRole.ref("RuntimeRole");
    return runtimeDatabase(
      role.pooledOrigin.pipe(Output.map(postgresUrl)),
      Option.some(Effect.die(new Error("Hyperdrive props are deploy-time only"))),
    );
  }
  const settings = yield* Config.all({
    name: Config.String("PLANETSCALE_DATABASE_NAME"),
    clusterSize: Config.String("PLANETSCALE_CLUSTER_SIZE"),
    region: Config.String("PLANETSCALE_REGION"),
    adopt: Config.Boolean("PLANETSCALE_ADOPT_DATABASE").pipe(Config.withDefault(false)),
    connectionLimit: Config.Number("CLOUD_DATABASE_CONNECTION_LIMIT").pipe(Config.option),
  });
  const connectionLimit = yield* Schema.decodeUnknownEffect(
    Schema.Option(Schema.Int.check(Schema.isGreaterThanOrEqualTo(5))),
  )(settings.connectionLimit);
  const database = yield* Planetscale.PostgresDatabase("Database", {
    name: settings.name,
    clusterSize: settings.clusterSize,
    region: { slug: settings.region },
  }).pipe(adopt(settings.adopt), retain());
  const role = yield* Planetscale.PostgresRole("RuntimeRole", {
    database,
    inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
  });
  const migrationRole = yield* Planetscale.PostgresRole("MigrationRole", {
    database,
    inheritedRoles: ["postgres"],
  }).pipe(retain());
  const migrations = yield* Command.Exec("Migrations", {
    command: "node src/migrate.ts",
    env: {
      DATABASE_URL: migrationRole.origin.pipe(Output.map(migrationUrl)),
      BETTER_AUTH_URL: yield* cloudOrigin,
      BETTER_AUTH_SECRET: yield* Config.Redacted("BETTER_AUTH_SECRET"),
      // Auth setup provisions the OAuth resources at the role hosts too.
      ...(yield* roleHostsJobEnvironment),
    },
    memo: false,
    timeout: "5 minutes",
  });
  // Every database consumer waits for the migration, including an existing Worker update.
  const migrated = Output.all(role.pooledOrigin, migrations.hash).pipe(
    Output.map(([origin]) => origin),
  );
  return runtimeDatabase(
    migrated.pipe(Output.map(postgresUrl)),
    Option.some(hyperdriveProps(migrated, connectionLimit)),
  );
});

/**
 * The runtime database: local Postgres in development, the preview's own database on test
 * stages, and PlanetScale in production. Props are resolved during infrastructure evaluation,
 * never inside a Worker request.
 */
export const databaseInfrastructure = Effect.gen(function* () {
  const context = yield* Effect.serviceOption(AlchemyContext);
  if (Option.isSome(context) && context.value.dev) {
    const local = yield* developmentDatabase;
    // A local passthrough: Worker events reach the same Postgres through the Hyperdrive binding.
    return runtimeDatabase(
      local.url,
      Option.some(
        Effect.succeed({
          origin: local.origin,
          dev: local.origin.pipe(
            Output.map((origin) => ({ ...origin, sslmode: "disable" as const })),
          ),
          caching: { disabled: true },
        }),
      ),
    );
  }
  const stage = yield* testStage;
  if (Option.isSome(stage)) return yield* preparedPreviewDatabase(stage.value);
  return yield* productionDatabase;
}).pipe(Effect.orDie);

/**
 * The connection for Worker events: Hyperdrive wherever it fronts the database, because every
 * event opens its own connections and Hyperdrive hands one out in about 2 ms instead of a TLS
 * login to PgBouncer (about 70 ms). Alchemy dev declares a local Hyperdrive passthrough. Neon
 * previews bind their pooler URL.
 */
export const cloudDatabaseConnection = Effect.gen(function* () {
  const database = yield* databaseInfrastructure;
  if (Option.isNone(database.hyperdrive)) return yield* cloudDirectDatabaseConnection;
  // Inside the Worker only the binding's identity is needed, not provisioning config.
  const configuration = globalThis.__ALCHEMY_RUNTIME__
    ? yield* Cloudflare.Hyperdrive.Connection.ref("DatabaseConnection")
    : yield* Cloudflare.Hyperdrive.Connection("DatabaseConnection", database.hyperdrive.value);
  const client = yield* Cloudflare.Hyperdrive.Connect(configuration);
  return { connectionString: client.connectionString.pipe(Effect.provide(RuntimeContext.phantom)) };
}).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding));

/**
 * The runtime role's PgBouncer URL, bound as the `DatabaseUrl` secret. Durable Objects use it:
 * they keep their connections across calls, so they pay the login once per window, and statements
 * on a held PgBouncer connection are faster than through Hyperdrive.
 */
export const cloudDirectDatabaseConnection = Effect.gen(function* () {
  const database = yield* databaseInfrastructure;
  return { connectionString: yield* Output.named(database.url, "DatabaseUrl") };
});

/**
 * v1's Postgres for the v1 sign-in check, on production only. The stack declares a role on v1's
 * PlanetScale database (`V1_PLANETSCALE_DATABASE_NAME`, branch `main`) that inherits only
 * `pg_read_all_data`, and binds its pooled URL as the `V1_DATABASE_URL` Worker secret. It never
 * declares v1's database, which v1 owns; removing the resource drops only the role. Temporary,
 * with the v1 import window. Without the name a production deploy stops and says what to set.
 */
export const v1DatabaseConnection = Effect.gen(function* () {
  const role = globalThis.__ALCHEMY_RUNTIME__
    ? yield* Planetscale.PostgresRole.ref("V1ReaderRole")
    : yield* Planetscale.PostgresRole("V1ReaderRole", {
        database: yield* Config.String("V1_PLANETSCALE_DATABASE_NAME").pipe(
          Config.option,
          Effect.map(Option.filter((name) => name !== "")),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.die(new Error(missingV1PlanetscaleDatabase)),
              onSome: Effect.succeed,
            }),
          ),
        ),
        inheritedRoles: ["pg_read_all_data"],
      });
  return yield* Output.named(role.pooledOrigin.pipe(Output.map(postgresUrl)), "V1_DATABASE_URL");
}).pipe(Effect.orDie);

/**
 * How long one attempt to open a runtime connection may take. A connection usually opens in
 * about 100 ms, but a few attempts stall until they time out while connections opened just before
 * and after take the usual time. An attempt that fails has sent no statement, so the pool makes
 * it once more; two attempts take no longer than the one 5-second attempt before.
 */
const connectAttemptTimeout = Duration.millis(2500);

/**
 * A pool on the runtime database, for one Worker event or one Durable Object window. Hyperdrive
 * and PgBouncer pool in transaction mode, so no consumer may rely on session state (`prepare: false`; no
 * session `SET`, advisory locks or `LISTEN`). Building it opens no connection; the pool connects
 * on first use. Opening a connection gets a second attempt when the first fails or times out.
 * Each `sql.connect` span records its `db.connect.attempt`, and the second also records why the
 * first failed as `db.connect.retry_reason`. When both fail, the statement fails with the
 * driver's `SqlError`; statements themselves are never repeated. Beside the client it provides
 * {@link OpenedConnections}, its count of those spans.
 */
export const cloudDatabasePool = (options: {
  readonly url: Redacted.Redacted;
  readonly maxConnections: number;
  readonly idleTimeout?: Duration.Input;
  readonly applicationName?: string;
  /**
   * Statements of one `PgPool.grouped` group that are in flight at the same time share one
   * connection and go out in one write; the connection carries no other statement meanwhile, so a
   * group only ever waits behind its own statements. Ungrouped statements, transactions, streams
   * and reserved connections each take a connection of their own, as without this. A statement
   * whose caller gives up while it runs stops the connection taking new statements (the group's
   * next ones take another); before the connection goes back, what nobody awaits is cancelled and
   * drained, and the connection is kept, as an interrupted statement's is without grouping.
   */
  readonly statementGroups?: boolean;
}) =>
  Layer.effectContext(
    Effect.gen(function* () {
      // The pool opens connections with the tracer it was built with; counting its `sql.connect`
      // spans there tells a caller whether its work opened one, without asking the pool.
      const tracer = yield* Effect.tracer;
      let opened = 0;
      const counting = Tracer.make({
        span: (span) => {
          if (span.name === "sql.connect") opened += 1;
          return tracer.span(span);
        },
        context: tracer.context,
      });
      const sql = yield* Layer.build(
        PgClient.layer({
          url: options.url,
          maxConnections: options.maxConnections,
          idleTimeout: options.idleTimeout,
          applicationName: options.applicationName,
          // One connection per lease: grouping is what puts statements on a connection together.
          ...(options.statementGroups === true ? { multiplex: true, multiplexConcurrency: 1 } : {}),
          prepare: false,
          connectTimeout: connectAttemptTimeout,
          connectRetries: 1,
        }),
      ).pipe(Effect.withTracer(counting));
      return Context.add(sql, OpenedConnections, { count: () => opened });
    }),
  );

/**
 * How many connection attempts a {@link cloudDatabasePool} has started. Reading it before and
 * after some work shows whether a connection opened meanwhile; it costs no I/O.
 */
export class OpenedConnections extends Context.Service<
  OpenedConnections,
  { readonly count: () => number }
>()("executor/cloud/OpenedConnections") {}

/**
 * Provided beside a SQL client, for a consumer that may have to give up a connection it reserved,
 * such as one still inside a transaction it could not roll back. `scope` closes only after the
 * client's pool has shut down, so a reservation still open in it then is closed instead of lent
 * again. `retire` shuts the pool down as soon as no caller still uses it.
 */
export class ConnectionReservations extends Context.Service<
  ConnectionReservations,
  { readonly scope: Scope.Scope; readonly retire: Effect.Effect<void> }
>()("executor/cloud/ConnectionReservations") {}
