/** Database infrastructure belongs to cloud; Docker and local keep their own drivers. */
import * as Output from "alchemy/Output";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Planetscale from "alchemy/Planetscale";
import { Random } from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { adopt } from "alchemy/AdoptPolicy";
import { retain } from "alchemy/RemovalPolicy";
import { Config, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { developmentDatabase } from "./development.ts";
import { LogicalDatabase } from "./logical-database.ts";
import { cloudOrigin, testStage } from "./stage.ts";
import { testStageConnectionLimit } from "../contracts/test-stage-capacity.ts";

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

/** PlanetScale roles connect over TLS only; the CA above is what makes verify-full succeed. */
const roleUrl = (origin: Planetscale.PostgresOrigin, database: string) =>
  Redacted.make(
    `${origin.scheme}://${encodeURIComponent(origin.user)}:${encodeURIComponent(Redacted.value(origin.password))}` +
      `@${origin.host}:${origin.port}/${encodeURIComponent(database)}?sslmode=verify-full`,
  );

/** Both SQL adapters create schema objects as the stable owner, not the rotating login. */
const migrationUrl = (origin: Planetscale.PostgresOrigin) => {
  const url = new URL(Redacted.value(roleUrl(origin, origin.database)));
  url.searchParams.set("options", "-c role=postgres");
  return Redacted.make(url.toString());
};

/**
 * One binding on both paths. Alchemy dev declares only a local Hyperdrive passthrough;
 * deployment declares PlanetScale resources and a real Hyperdrive connection.
 * Props are resolved during infrastructure evaluation, never inside a Worker request.
 */
export const DatabaseConnection = Effect.gen(function* () {
  // Inside the Worker only the binding's identity is needed, not provisioning config.
  if (globalThis.__ALCHEMY_RUNTIME__)
    return yield* Cloudflare.Hyperdrive.Connection.ref("DatabaseConnection");
  return yield* Cloudflare.Hyperdrive.Connection(
    "DatabaseConnection",
    Effect.gen(function* () {
      if ((yield* AlchemyContext).dev) {
        const origin = yield* developmentDatabase;
        return origin.pipe(
          Output.map((origin) => ({
            origin,
            dev: { ...origin, sslmode: "disable" as const },
            caching: { disabled: true },
          })),
        );
      }

      const connectionLimit = yield* Config.Number("CLOUD_DATABASE_CONNECTION_LIMIT").pipe(
        Config.option,
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Option(Schema.Int.check(Schema.isGreaterThanOrEqualTo(5))),
          ),
        ),
      );
      const pooling = Option.match(connectionLimit, {
        onNone: () => ({}),
        onSome: (originConnectionLimit) => ({ originConnectionLimit }),
      });
      const stage = yield* testStage;
      if (Option.isSome(stage)) {
        const settings = yield* Config.all({
          name: Config.String("TEST_STAGE_DATABASE"),
          adminUrl: Config.Redacted("TEST_STAGE_DATABASE_ADMIN_URL"),
          clusterSize: Config.String("PLANETSCALE_CLUSTER_SIZE"),
          region: Config.String("PLANETSCALE_REGION"),
        });
        // Every test stage shares this cluster. Adopting and retaining it stops one destroy from taking the rest with it.
        const cluster = yield* Planetscale.PostgresDatabase("Database", {
          name: settings.name,
          clusterSize: settings.clusterSize,
          region: { slug: settings.region },
        }).pipe(adopt(true), retain());
        // Cluster-wide roles would expose every other stage's data, so this role starts with nothing
        // and receives its rights as grants on its own logical database.
        const role = yield* Planetscale.PostgresRole("RuntimeRole", {
          database: cluster,
          inheritedRoles: [],
        });
        const database = yield* LogicalDatabase("LogicalDatabase", {
          adminUrl: settings.adminUrl,
          name: `executor_${stage.value.slug.replaceAll("-", "_")}`,
          // PlanetScale appends the branch id to the login name; the Postgres role has no suffix.
          owner: role.username.pipe(Output.map((username) => username.split(".")[0] ?? username)),
        });
        const migrations = yield* Command.Exec("Migrations", {
          command: "node src/migrate.ts",
          env: {
            DATABASE_URL: Output.all(role.origin, database.name).pipe(
              Output.map(([origin, name]) => roleUrl(origin, name)),
            ),
            // The same logical id as `cloudSecrets`, so the job signs with the secret the Worker will verify.
            BETTER_AUTH_SECRET: (yield* Random("AuthSecret")).text,
            BETTER_AUTH_URL: stage.value.origin,
          },
          memo: false,
          timeout: "5 minutes",
        });
        const fixtureOutput = yield* Config.String("TEST_STAGE_ACCOUNTS_OUTPUT").pipe(
          Config.option,
        );
        if (Option.isSome(fixtureOutput)) {
          const fixtureOrganization = yield* Config.String("TEST_STAGE_APP_ORGANIZATION").pipe(
            Config.option,
          );
          if (!stage.value.name.startsWith("test-e2e-"))
            return yield* Effect.die(
              new Error("Account fixtures require a dedicated test-e2e- stage"),
            );
          yield* Command.Exec("TestAccounts", {
            command: "node scripts/test-accounts.ts",
            env: {
              ALCHEMY_STAGE: stage.value.name,
              BETTER_AUTH_URL: stage.value.origin,
              BETTER_AUTH_SECRET: (yield* Random("AuthSecret")).text,
              TEST_STAGE_ACCOUNTS_OUTPUT: fixtureOutput.value,
              ...(Option.isSome(fixtureOrganization)
                ? { TEST_STAGE_APP_ORGANIZATION: fixtureOrganization.value }
                : {}),
              DATABASE_URL: Output.all(role.origin, database.name, migrations.hash).pipe(
                Output.map(([origin, name]) => roleUrl(origin, name)),
              ),
            },
            memo: false,
            timeout: "2 minutes",
          });
        }
        const authority = yield* certificateAuthority;
        return {
          // Depending on the migration hash keeps the Worker from serving an empty schema.
          origin: Output.all(role.origin, database.name, migrations.hash).pipe(
            Output.map(([origin, name]) => ({ ...origin, database: name })),
          ),
          originConnectionLimit: testStageConnectionLimit,
          caching: { disabled: true },
          mtls: { sslmode: "verify-full" as const, caCertificateId: authority.mtlsCertificateId },
        };
      }

      const settings = yield* Config.all({
        name: Config.String("PLANETSCALE_DATABASE_NAME"),
        clusterSize: Config.String("PLANETSCALE_CLUSTER_SIZE"),
        region: Config.String("PLANETSCALE_REGION"),
        adopt: Config.Boolean("PLANETSCALE_ADOPT_DATABASE").pipe(Config.withDefault(false)),
      });
      const database = yield* Planetscale.PostgresDatabase("Database", {
        name: settings.name,
        clusterSize: settings.clusterSize,
        region: { slug: settings.region },
      }).pipe(adopt(settings.adopt), retain());
      const role = yield* Planetscale.PostgresRole("RuntimeRole", {
        database,
        inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
      });
      // Only the deploy job receives this role. Worker bindings retain the runtime role.
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
        },
        memo: false,
        timeout: "5 minutes",
      });
      const authority = yield* certificateAuthority;
      return {
        // Every database consumer waits for the migration, including an existing Worker update.
        origin: Output.all(role.origin, migrations.hash).pipe(Output.map(([origin]) => origin)),
        ...pooling,
        caching: { disabled: true },
        mtls: { sslmode: "verify-full" as const, caCertificateId: authority.mtlsCertificateId },
      };
    }).pipe(Effect.orDie),
  );
});
