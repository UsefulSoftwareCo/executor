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
import {
  postgresUrl,
  previewBranchSettings,
  previewDatabase,
  previewShape,
} from "./preview-database.ts";

const certificateAuthority = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const certificatePath = yield* path.fromFileUrl(
    new URL("../../certificates/isrg-root-x1.pem", import.meta.url),
  );
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

const runtimeDatabase = (
  url: Output.Output<Redacted.Redacted<string>, never>,
  hyperdrive: Option.Option<HyperdriveProps>,
) => ({ url, hyperdrive });

const migrationUrl = (origin: Planetscale.PostgresOrigin) => {
  const url = new URL(Redacted.value(postgresUrl(origin)));
  url.searchParams.set("options", "-c role=postgres");
  return Redacted.make(url.toString());
};

const fixtureStage = /^test-(?:e2e|perf)-/;

const preparedPreviewDatabase = (stage: TestStage) =>
  Effect.gen(function* () {
    const preview = yield* previewDatabase(stage);
    const settings = yield* previewBranchSettings(stage);
    const migrations = globalThis.__ALCHEMY_RUNTIME__
      ? yield* Command.Exec.ref("Migrations")
      : yield* Command.Exec("Migrations", {
          command: "node src/migrate.ts",
          env: {
            DATABASE_URL: preview.migrationUrl,
            ...Option.match(settings, {
              onNone: () => ({}),
              onSome: (hash) => ({
                PREVIEW_BRANCH_SETTINGS: hash.pipe(Output.map(() => "applied")),
              }),
            }),
            BETTER_AUTH_SECRET: (yield* Random("AuthSecret")).text,
            BETTER_AUTH_URL: stage.origin,
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
    const migrated = <A>(value: Output.Output<A, never>) =>
      Output.all(value, migrations.hash).pipe(Output.map(([resolved]) => resolved));
    return runtimeDatabase(
      migrated(preview.runtimeUrl),
      Option.map(preview.hyperdriveOrigin, (origin) =>
        hyperdriveProps(migrated(origin), Option.some(previewShape(stage).poolConnections)),
      ),
    );
  });

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

const productionDatabase = Effect.gen(function* () {
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
      ...(yield* roleHostsJobEnvironment),
    },
    memo: false,
    timeout: "5 minutes",
  });
  const migrated = Output.all(role.pooledOrigin, migrations.hash).pipe(
    Output.map(([origin]) => origin),
  );
  return runtimeDatabase(
    migrated.pipe(Output.map(postgresUrl)),
    Option.some(hyperdriveProps(migrated, connectionLimit)),
  );
});

export const databaseInfrastructure = Effect.gen(function* () {
  const context = yield* Effect.serviceOption(AlchemyContext);
  if (Option.isSome(context) && context.value.dev) {
    const local = yield* developmentDatabase;
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

export type DatabaseRoute = "hyperdrive" | "direct";

export const cloudDatabaseConnection = Effect.gen(function* () {
  const database = yield* databaseInfrastructure;
  if (Option.isNone(database.hyperdrive)) return yield* cloudDirectDatabaseConnection;
  const configuration = globalThis.__ALCHEMY_RUNTIME__
    ? yield* Cloudflare.Hyperdrive.Connection.ref("DatabaseConnection")
    : yield* Cloudflare.Hyperdrive.Connection("DatabaseConnection", database.hyperdrive.value);
  const client = yield* Cloudflare.Hyperdrive.Connect(configuration);
  return {
    connectionString: client.connectionString.pipe(Effect.provide(RuntimeContext.phantom)),
    route: "hyperdrive" as DatabaseRoute,
  };
}).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding));

export const cloudDirectDatabaseConnection = Effect.gen(function* () {
  const database = yield* databaseInfrastructure;
  return {
    connectionString: yield* Output.named(database.url, "DatabaseUrl"),
    route: "direct" as DatabaseRoute,
  };
});

const connectAttemptTimeout = Duration.millis(2500);

export const cloudDatabasePool = (options: {
  readonly url: Redacted.Redacted;
  readonly route: DatabaseRoute;
  readonly maxConnections: number;
  readonly idleTimeout?: Duration.Input;
  readonly applicationName?: string;
  readonly statementGroups?: boolean;
}) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const tracer = yield* Effect.tracer;
      let opened = 0;
      const counting = Tracer.make({
        span: (spanOptions) => {
          const span = tracer.span(spanOptions);
          if (spanOptions.name === "sql.connect") {
            opened += 1;
            span.attribute("db.connect.route", options.route);
          }
          return span;
        },
        context: tracer.context,
      });
      const sql = yield* Layer.build(
        PgClient.layer({
          url: options.url,
          maxConnections: options.maxConnections,
          idleTimeout: options.idleTimeout,
          applicationName: options.applicationName,
          ...(options.statementGroups === true ? { multiplex: true, multiplexConcurrency: 1 } : {}),
          prepare: false,
          connectTimeout: connectAttemptTimeout,
          connectRetries: 1,
        }),
      ).pipe(Effect.withTracer(counting));
      return Context.add(sql, OpenedConnections, { count: () => opened });
    }),
  );

export class OpenedConnections extends Context.Service<
  OpenedConnections,
  { readonly count: () => number }
>()("executor/cloud/OpenedConnections") {}

export class ConnectionReservations extends Context.Service<
  ConnectionReservations,
  { readonly scope: Scope.Scope; readonly retire: Effect.Effect<void> }
>()("executor/cloud/ConnectionReservations") {}
