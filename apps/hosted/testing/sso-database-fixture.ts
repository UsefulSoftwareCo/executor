/** Local-only DNS fixture and storage probe. Never installed in the HTTP server. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Pool } from "pg";
import { Config, Console, Effect, FileSystem, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { LocalDatabaseUrl } from "../cloud/src/contracts/database.ts";

const command = Command.make("sso-database-fixture", {
  configuration: Flag.String("configuration"),
  provider: Flag.String("provider"),
  verify: Flag.Boolean("verify").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withHandler((args) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Config.String("NODE_ENV").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literal("test"))),
        );
        const fs = yield* FileSystem.FileSystem;
        const configuration = yield* fs
          .readFileString(args.configuration)
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.Struct({ database: Schema.String })),
              ),
            ),
          );
        const database = yield* Schema.decodeUnknownEffect(LocalDatabaseUrl)(
          Redacted.make(configuration.database),
        );
        const pool = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: Redacted.value(database), max: 1 })),
          (pool) => Effect.promise(() => pool.end()),
        );
        if (!/^sso-[a-z0-9-]+$/.test(args.provider))
          return yield* Effect.die("Expected an SSO provider ID");
        // The reserved .test domain can never represent a customer. Protocol tests
        // seed ownership here; DNS failure is tested through the actual public API.
        if (args.verify)
          yield* Effect.promise(() =>
            pool.query(
              'UPDATE "ssoProvider" SET "domainVerified" = true WHERE "providerId" = $1 AND domain = $2',
              [args.provider, "sso.example.test"],
            ),
          );
        const result = yield* Effect.promise(() =>
          pool.query(
            `SELECT "domainVerified" AS verified,
       ("oidcConfig" IS NULL OR ("oidcConfig" NOT LIKE '{%' AND position('synthetic-sso-secret' in "oidcConfig") = 0))
       AND ("samlConfig" IS NULL OR "samlConfig" NOT LIKE '{%') AS encrypted
     FROM "ssoProvider" WHERE "providerId" = $1 AND domain = $2`,
            [args.provider, "sso.example.test"],
          ),
        );
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ verified: Schema.Boolean, encrypted: Schema.Boolean })]),
        )(result.rows);
        yield* Console.log(JSON.stringify(rows[0]));
      }),
    ),
  ),
);

NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)),
);
