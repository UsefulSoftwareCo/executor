/** Local infrastructure. This module is evaluated only by Alchemy in dev mode. */
import * as Command from "alchemy/Command";
import * as Docker from "alchemy/Docker";
import * as Output from "alchemy/Output";
import { retain } from "alchemy/RemovalPolicy";
import { cloudSite } from "./site.ts";
import { Config, Effect, Schema } from "effect";
import { cloudDevelopment } from "../contracts/development.ts";
import { cloudDevelopmentDatabaseUrl } from "../contracts/database.ts";

/** Own a persistent local Postgres instance and apply schemas before the Worker starts. */
export const developmentDatabase = Effect.gen(function* () {
  const configuration = yield* cloudDevelopment;
  const password = yield* Config.Redacted("CLOUD_DEV_DATABASE_PASSWORD").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Redacted(Schema.NonEmptyString))),
  );
  const origin = {
    scheme: "postgresql" as const,
    host: "127.0.0.1",
    port: configuration.databasePort,
    user: "executor",
    password,
    database: "executor",
  };
  const url = cloudDevelopmentDatabaseUrl(password, configuration.databasePort);
  const external = yield* Config.Boolean("CLOUD_DEV_EXTERNAL_DATABASE").pipe(
    Config.withDefault(false),
  );
  const connection = external
    ? Output.asOutput(url)
    : yield* Effect.gen(function* () {
        const volume = yield* Docker.Volume("DevelopmentDatabaseData", {}).pipe(retain());
        const database = yield* Docker.Container("DevelopmentDatabase", {
          image: "postgres:17",
          environment: {
            POSTGRES_USER: "executor",
            POSTGRES_DB: "executor",
            POSTGRES_PASSWORD: password,
          },
          ports: [{ external: `127.0.0.1:${configuration.databasePort}`, internal: 5432 }],
          volumes: [{ hostPath: volume.name, containerPath: "/var/lib/postgresql/data" }],
          start: true,
          healthcheck: {
            cmd: "pg_isready -U executor -d executor",
            interval: "1 second",
            timeout: "2 seconds",
            retries: 60,
          },
        });
        return database.id.pipe(Output.map(() => url));
      });
  const migrations = yield* Command.Exec("DevelopmentMigrations", {
    command: "node scripts/migrate-development.ts",
    // The Output dependency makes migrations wait for the container.
    env: { DATABASE_URL: connection },
    memo: false,
    timeout: "2 minutes",
  });
  return migrations.hash.pipe(Output.map(() => origin));
});

/** Alchemy owns Vite directly; it serves HTTPS using the existing trusted certificate. */
export const developmentWeb = (apiUrl: Output.Output<string | undefined>) =>
  Effect.gen(function* () {
    const configuration = yield* cloudDevelopment.pipe(Effect.orDie);
    const password = yield* Config.Redacted("CLOUD_DEV_DATABASE_PASSWORD");
    const site = yield* cloudSite;
    yield* Command.Dev("DevelopmentWeb", {
      command: "node scripts/development-web.ts",
      env: {
        NODE_ENV: "development",
        // The Site resource owns marketing output; do not start a second writer.
        SITE_BUILD_HASH: site.hash.output,
        DATABASE_URL: cloudDevelopmentDatabaseUrl(password, configuration.databasePort),
        HOSTED_API_URL: apiUrl.pipe(Output.map(() => `http://127.0.0.1:${configuration.apiPort}`)),
      },
    });
    return configuration.origin;
  });
