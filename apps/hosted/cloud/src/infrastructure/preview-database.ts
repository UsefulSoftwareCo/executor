import * as Neon from "alchemy/Neon";
import * as Planetscale from "alchemy/Planetscale";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import { Random } from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Config, Effect, Option, Redacted } from "effect";
import { type TestStage } from "./stage.ts";

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
  readonly hyperdriveOrigin: Option.Option<Output.Output<Planetscale.PostgresOrigin, never>>;
  readonly migrationUrl: Output.Output<Redacted.Redacted<string>, never>;
  readonly branchName: Output.Output<string, never>;
  readonly username: Output.Output<string, never>;
  readonly databaseName: Output.Output<string, never>;
};

export const previewShape = (stage: TestStage) =>
  stage.name.startsWith("test-e2e-")
    ? { maxConnections: Option.some(50), poolConnections: 20 }
    : { maxConnections: Option.none<number>(), poolConnections: 10 };

export const previewDatabaseProvider = Config.Literals(
  ["neon", "planetscale"],
  "TEST_STAGE_DATABASE_PROVIDER",
);

export const previewDatabase = (stage: TestStage) =>
  Effect.gen(function* () {
    const provider = yield* previewDatabaseProvider;
    if (provider === "planetscale") {
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
          initSource: "parent-data",
          endpoints: [
            {
              type: "read_write",
              autoscalingLimitMinCu: 0.25,
              autoscalingLimitMaxCu: 1,
            },
          ],
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

export const previewBranchSettings = (stage: TestStage) =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return Option.none();
    if ((yield* AlchemyContext).dev || (yield* previewDatabaseProvider) !== "planetscale")
      return Option.none();
    const preview = yield* previewDatabase(stage);
    const shape = previewShape(stage);
    const settings = yield* Command.Exec("PreviewPoolSize", {
      command: "node scripts/preview-pool-size.ts",
      env: {
        TEST_STAGE_DATABASE: yield* Config.NonEmptyString("TEST_STAGE_DATABASE"),
        TEST_STAGE_DATABASE_BRANCH: Output.all(
          preview.branchName,
          preview.runtimeUrl,
          preview.migrationUrl,
        ).pipe(Output.map(([branch]) => branch)),
        POOL_SIZE: String(shape.poolConnections),
        ...Option.match(shape.maxConnections, {
          onNone: () => ({}),
          onSome: (connections) => ({ MAX_CONNECTIONS: String(connections) }),
        }),
      },
      timeout: "9 minutes",
    });
    return Option.some(settings.hash);
  });
