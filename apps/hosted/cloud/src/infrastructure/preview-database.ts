/** Provider-specific preview allocation; callers consume the same Postgres connection contract. */
import * as Neon from "alchemy/Neon";
import * as Planetscale from "alchemy/Planetscale";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import { Random } from "alchemy";
import { Config, Effect, Option, Redacted } from "effect";
import { testStage, type TestStage } from "./stage.ts";

/** Build a credential-redacted Postgres URL with hostname and certificate verification. */
export const postgresUrl = (origin: Neon.PostgresOrigin) => {
  const url = new URL(
    `postgresql://${origin.host}:${origin.port}/${encodeURIComponent(origin.database)}`,
  );
  url.username = origin.user;
  url.password = Redacted.value(origin.password);
  url.searchParams.set("sslmode", "verify-full");
  return Redacted.make(url.toString());
};

type PreviewConnection = {
  readonly runtimeUrl: Output.Output<Redacted.Redacted<string>, never>;
  /** What Hyperdrive connects to; Neon previews are not behind Hyperdrive. */
  readonly hyperdriveOrigin: Option.Option<Output.Output<Planetscale.PostgresOrigin, never>>;
  readonly migrationUrl: Output.Output<Redacted.Redacted<string>, never>;
  readonly branchName: Output.Output<string, never>;
  readonly username: Output.Output<string, never>;
  readonly databaseName: Output.Output<string, never>;
};

/**
 * PgBouncer server connections for a PlanetScale preview's runtime role. The branch allows 25
 * connections, three reserved for superusers; PgBouncer's default of 20 left none for the
 * migration login on the next deploy. Hyperdrive connects through the same PgBouncer, so this
 * caps the runtime role's backends whatever Hyperdrive and the Durable Objects open.
 */
export const previewPoolConnections = 10;

/** Preview provider selection is shared by database allocation and Worker transport. */
export const previewDatabaseProvider = Config.Literals(
  ["neon", "planetscale"],
  "TEST_STAGE_DATABASE_PROVIDER",
);

/** Allocate one isolated database per preview without changing the application's driver. */
export const previewDatabase = (stage: TestStage) =>
  Effect.gen(function* () {
    const provider = yield* previewDatabaseProvider;
    if (provider === "planetscale") {
      // Inside the Worker only the bindings' identities are needed, not provisioning config.
      const database = globalThis.__ALCHEMY_RUNTIME__
        ? undefined
        : yield* Config.NonEmptyString("TEST_STAGE_DATABASE");
      const branch =
        database === undefined
          ? yield* Planetscale.PostgresBranch.ref("PreviewDatabase")
          : yield* Planetscale.PostgresBranch("PreviewDatabase", {
              database,
              name: stage.name,
              parentBranch: "main",
            });
      const runtime =
        database === undefined
          ? yield* Planetscale.PostgresRole.ref("RuntimeRole")
          : yield* Planetscale.PostgresRole("RuntimeRole", {
              database,
              branch,
              inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
            });
      const migration =
        database === undefined
          ? yield* Planetscale.PostgresRole.ref("MigrationRole")
          : yield* Planetscale.PostgresRole("MigrationRole", {
              database,
              branch,
              inheritedRoles: ["postgres"],
            });
      const connection: PreviewConnection = {
        // Workers use the branch's PgBouncer; migrations keep the direct schema-owner connection.
        runtimeUrl: runtime.pooledOrigin.pipe(Output.map(postgresUrl)),
        hyperdriveOrigin: Option.some(runtime.pooledOrigin),
        migrationUrl: migration.origin.pipe(
          Output.map((origin) => {
            const url = new URL(Redacted.value(postgresUrl(origin)));
            url.searchParams.set("options", "-c role=postgres");
            return Redacted.make(url.toString());
          }),
        ),
        branchName: branch.name,
        username: migration.username,
        databaseName: migration.origin.pipe(Output.map((origin) => origin.database)),
      };
      return connection;
    }
    const branch = globalThis.__ALCHEMY_RUNTIME__
      ? yield* Neon.Branch.ref("PreviewDatabase")
      : yield* Neon.Branch("PreviewDatabase", {
          project: { projectId: yield* Config.NonEmptyString("TEST_STAGE_NEON_PROJECT_ID") },
          name: stage.name,
          parentBranch: { name: "main" },
          // The dedicated parent is empty. Snapshot branching is instant and keeps
          // Neon's canonical parent-data value stable across later reconciliations.
          initSource: "parent-data",
          endpoints: [
            {
              type: "read_write",
              autoscalingLimitMinCu: 0.25,
              autoscalingLimitMaxCu: 1,
              // Neon defaults to five-minute suspension. Free accounts reject even
              // an explicit request for that same timeout.
            },
          ],
          // The registry owns full-environment deletion. Expiring only the branch would orphan Workers.
        });
    const password = (
      globalThis.__ALCHEMY_RUNTIME__
        ? yield* Random.ref("RuntimePassword")
        : yield* Random("RuntimePassword")
    ).text;
    const role = globalThis.__ALCHEMY_RUNTIME__
      ? yield* Command.Exec.ref("RuntimeRole")
      : yield* Command.Exec("RuntimeRole", {
          command: "node scripts/preview-runtime-role.ts",
          env: {
            DATABASE_URL: branch.origin.pipe(Output.map(postgresUrl)),
            RUNTIME_PASSWORD: password,
          },
          memo: false,
          timeout: "1 minute",
        });
    const connection: PreviewConnection = {
      // Workers use Neon's transaction pooler; migrations retain the direct owner connection.
      runtimeUrl: Output.all(branch.pooledOrigin, password, role.hash).pipe(
        Output.map(([origin, password]) =>
          postgresUrl({ ...origin, user: "executor_runtime", password }),
        ),
      ),
      hyperdriveOrigin: Option.none(),
      migrationUrl: branch.origin.pipe(Output.map(postgresUrl)),
      branchName: branch.branchName,
      username: branch.roleName,
      databaseName: branch.databaseName,
    };
    return connection;
  });

/**
 * Cap a PlanetScale preview branch's PgBouncer pool. Only the stack declares this job; Worker
 * initialization evaluates the database connection but not branch administration.
 */
export const previewPoolSize = Effect.gen(function* () {
  const stage = yield* testStage;
  if (Option.isNone(stage) || (yield* previewDatabaseProvider) !== "planetscale") return;
  const preview = yield* previewDatabase(stage.value);
  yield* Command.Exec("PreviewPoolSize", {
    command: "node scripts/preview-pool-size.ts",
    env: {
      TEST_STAGE_DATABASE: yield* Config.NonEmptyString("TEST_STAGE_DATABASE"),
      TEST_STAGE_DATABASE_BRANCH: preview.branchName,
      POOL_SIZE: String(previewPoolConnections),
    },
    timeout: "7 minutes",
  });
}).pipe(Effect.orDie);
