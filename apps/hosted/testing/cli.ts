/** Local-only account provisioning. This command installs no HTTP route or production plugin. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Pool } from "pg";
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
} from "effect";
import { CliError, Command, Flag } from "effect/unstable/cli";
import { AuthDatabase } from "../self-host/src/contracts/database.ts";
import { selfHostDatabase } from "../self-host/src/database.ts";
import { cloudSessionCookiePrefix } from "../cloud/src/contracts/browser.ts";
import { LocalDatabaseUrl, cloudDevelopmentDatabaseUrl } from "../cloud/src/contracts/database.ts";
import {
  LocalDevelopmentUnavailable,
  readLocalSecrets,
  readLocalSession,
} from "../cloud/scripts/local-development.ts";
import { dataDirectory } from "../self-host/src/contracts/config.ts";
import { devOrigin } from "../../../scripts/dev-host.ts";
import {
  FixtureName,
  TestAccountFailed,
  TestOrigin,
  provisionTestAccount,
  testAccountAuth,
} from "./accounts.ts";

/**
 * With BETTER_AUTH_URL set, every target setting is explicit. Without it, the command targets this
 * checkout's zero-configuration dev stack: cloud's running session and generated secrets, or
 * self-host's data directory and the signing secret its first boot stored there.
 */
const targetSettings = (host: "self-host" | "cloud") =>
  Effect.gen(function* () {
    const explicitOrigin = yield* Config.String("BETTER_AUTH_URL").pipe(Config.option);
    if (Option.isSome(explicitOrigin)) {
      const secret = yield* Config.Redacted("BETTER_AUTH_SECRET");
      if (host === "self-host") {
        // Do not silently select the shared preview's default directory.
        yield* Config.NonEmptyString("EXECUTOR_DATA_DIR");
        return { origin: explicitOrigin.value, secret, database: undefined };
      }
      const database = yield* Config.Redacted("DATABASE_URL");
      return { origin: explicitOrigin.value, secret, database };
    }
    if (host === "self-host") {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.resolve(yield* dataDirectory);
      // Self-host's first boot stores its generated signing secret beside the database.
      const secret = yield* fs.readFileString(path.join(directory, "auth-secret.key")).pipe(
        Effect.mapError(
          () =>
            new LocalDevelopmentUnavailable({
              reason: `No self-host signing secret in ${directory}; start bun run hosted:dev once`,
            }),
        ),
      );
      return {
        origin: devOrigin("self-host"),
        secret: Redacted.make(secret.trim()),
        database: undefined,
      };
    }
    const session = yield* readLocalSession;
    const secrets = yield* readLocalSecrets;
    return {
      origin: session.origin,
      secret: Redacted.make(secrets.betterAuthSecret),
      database: cloudDevelopmentDatabaseUrl(
        Redacted.make(secrets.databasePassword),
        session.databasePort,
      ),
    };
  });

const command = Command.make("test-account", {
  host: Flag.Literals("host", ["self-host", "cloud"]),
  name: Flag.String("name").pipe(Flag.withDefault("agent")),
  organization: Flag.String("organization").pipe(Flag.withDefault("agent-tests")),
  role: Flag.Literals("role", ["owner", "admin", "member"]).pipe(Flag.withDefault("owner")),
  output: Flag.String("output").pipe(
    Flag.withDescription("New private JSON file for session cookies; refuses to overwrite"),
  ),
}).pipe(
  Command.withHandler((args) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Check all target constraints before opening a database or writing a fixture.
        yield* Config.String("NODE_ENV").pipe(
          Config.withDefault("development"),
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literals(["development", "test"]))),
        );
        const target = yield* targetSettings(args.host);
        const origin = yield* Schema.decodeUnknownEffect(TestOrigin)(target.origin);
        const secret = yield* Schema.decodeUnknownEffect(
          Schema.Redacted(Schema.String.check(Schema.isMinLength(32))),
        )(target.secret);
        const name = yield* Schema.decodeUnknownEffect(FixtureName)(args.name);
        const organization = yield* Schema.decodeUnknownEffect(FixtureName)(args.organization);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const output = path.resolve(args.output);
        yield* fs.makeDirectory(path.dirname(output), { recursive: true, mode: 0o700 });
        // Exclusive creation prevents following an existing symlink or overwriting a credential file.
        const file = yield* fs.open(output, { flag: "wx", mode: 0o600 });
        yield* Effect.addFinalizer((exit) =>
          Exit.isFailure(exit)
            ? fs.remove(output).pipe(Effect.catch(() => Effect.void))
            : Effect.void,
        );
        const input = { ...args, name, organization, origin };
        const provision = (database: Parameters<typeof testAccountAuth>[0]["database"]) =>
          provisionTestAccount(
            testAccountAuth({
              origin,
              secret,
              database,
              cookiePrefix:
                args.host === "cloud" ? cloudSessionCookiePrefix(origin) : "executor-hosted",
            }),
            input,
          );
        const result = yield* args.host === "self-host"
          ? Effect.flatMap(AuthDatabase, provision).pipe(
              Effect.provide(
                selfHostDatabase.pipe(
                  // The schema layer reads the host's auth settings; use the resolved target.
                  Layer.provide(
                    ConfigProvider.layerAdd(
                      ConfigProvider.fromUnknown({
                        BETTER_AUTH_URL: origin,
                        BETTER_AUTH_SECRET: Redacted.value(secret),
                      }),
                      { asPrimary: true },
                    ),
                  ),
                ),
              ),
            )
          : Effect.gen(function* () {
              const url = yield* Schema.decodeUnknownEffect(LocalDatabaseUrl)(target.database);
              const pool = yield* Effect.acquireRelease(
                Effect.try({
                  try: () => new Pool({ connectionString: Redacted.value(url), max: 2 }),
                  catch: () => new TestAccountFailed({ stage: "database" }),
                }),
                (pool) => Effect.promise(() => pool.end()),
              );
              // Serialize cooperating CLI runs so retries cannot duplicate memberships.
              // PGlite already owns an exclusive process lock in the self-host branch.
              const lock = yield* Effect.acquireRelease(
                Effect.tryPromise({
                  try: () => pool.connect(),
                  catch: () => new TestAccountFailed({ stage: "database" }),
                }),
                (client) => Effect.sync(() => client.release()),
              );
              yield* Effect.tryPromise({
                try: () =>
                  lock.query("SELECT pg_advisory_lock(hashtext('executor-test-accounts'))"),
                catch: () => new TestAccountFailed({ stage: "database" }),
              });
              // The command owns this pool; closing it releases the session-level lock on every exit.
              return yield* provision(pool);
            });
        yield* file.writeAll(
          new TextEncoder().encode(`${JSON.stringify(Redacted.value(result), null, 2)}\n`),
        );
        yield* Console.log(`Test account ready. Session saved to ${output}`);
      }),
    ),
  ),
);

NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.catch((error) =>
      CliError.isCliError(error)
        ? Effect.fail(error)
        : Console.error(
            error instanceof LocalDevelopmentUnavailable
              ? error.message
              : "Test account setup failed. Use NODE_ENV=development or test, this checkout's dev stack or explicit loopback settings, matching fixture role/organization, and a new output file. Stop self-host before opening its PGlite directory.",
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                process.exitCode = 1;
              }),
            ),
          ),
    ),
  ),
);
