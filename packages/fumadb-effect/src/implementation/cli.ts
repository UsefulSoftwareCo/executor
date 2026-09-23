/**
 * An `effect/unstable/cli` command tree for migrations, mirroring upstream
 * fumadb's CLI: `migrate:up`, `migrate:down`, `migrate:to [version]`
 * (alias `migrate`), and `generate [version] --output <path>`.
 *
 * The tree is built from a bound {@link FumaDB} client, so a library author can
 * ship a migration CLI for their consumers in a few lines.
 */
import { Clock, Console, Effect, FileSystem, Option, Path, type Terminal } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";
import type * as CliError from "effect/unstable/cli/CliError";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { MigrationError } from "../contracts/errors.ts";
import type { FumaDB } from "../index.ts";
import type { Migrator } from "../contracts/migration.ts";
import type { AnySchema } from "../contracts/schema/schema.ts";

/**
 * Every failure a FumaDB CLI handler can produce.
 *
 * - `MigrationError`: planning problems (already up to date, no previous
 *   version, unknown version, an adapter that cannot render SQL) and statement
 *   execution failures.
 * - `SqlError`: a driver failure while reading settings or applying a migration.
 * - `PlatformError`: the generated SQL file could not be written.
 * - `Terminal.QuitError`: the user cancelled an interactive prompt. `run`
 *   turns this into an interrupt, the same way upstream exited with code 0.
 */
export type FumaDBCliError = MigrationError | SqlError | PlatformError | Terminal.QuitError;

/**
 * The services the CLI handlers need beyond the adapter environment `R`:
 * the file system and path services for `generate`, and the terminal for the
 * interactive prompts. All three are part of `Command.Environment`.
 */
export type FumaDBCliServices = FileSystem.FileSystem | Path.Path | Terminal.Terminal;

/**
 * The root command of a FumaDB CLI, plus a ready-to-run program.
 *
 * `command` is the `effect/unstable/cli` command tree. Compose it into a larger
 * CLI with `Command.withSubcommands`, or run it directly with `run`.
 */
export interface FumaDBCli<R> {
  /** The root command, with `migrate:up`, `migrate:down`, `migrate:to` and `generate` below it. */
  readonly command: Command.Command<string, {}, {}, FumaDBCliError, R | FumaDBCliServices>;
  /**
   * Run the command tree. With no arguments the arguments come from the
   * `Stdio` service; pass an array to run an explicit argument list (tests, or
   * a host CLI that already parsed `process.argv`).
   */
  readonly run: (
    args?: ReadonlyArray<string>,
  ) => Effect.Effect<void, FumaDBCliError | CliError.CliError, R | Command.Environment>;
}

/** Options for {@link makeCli}. */
export interface MakeCliOptions<Schemas extends ReadonlyArray<AnySchema>, R> {
  /** The client the CLI drives. Its adapter must support migrations. */
  readonly db: FumaDB<Schemas, R>;
  /** The CLI command name. Must be lowercase and contain no whitespace. */
  readonly command: string;
  /** The root command description shown in `--help`. */
  readonly description?: string | undefined;
  /** The CLI version, reported by `--version`. */
  readonly version: string;
}

/**
 * Build the migration CLI for a FumaDB client.
 *
 * Subcommands:
 *
 * - `migrate:up` — migrate to the next schema version.
 * - `migrate:down` — roll back to the previous schema version.
 * - `migrate:to [version]` (alias `migrate`) — migrate to a specific version.
 *   With no `version` argument it asks interactively; `latest` is accepted as
 *   a value and migrates to the newest schema of the current variant.
 * - `generate [version] --output <path>` — render the migration as SQL and
 *   write it to a file. With no `--output` it asks for a path, suggesting
 *   `./migrations/<timestamp>.sql`.
 *
 * Progress messages go to `Console`, including upstream's "Already up to date."
 * and "Cannot downgrade." notices. Those two cases still fail with a
 * `MigrationError`, so the process exits non-zero as upstream did. Failures are
 * typed ({@link FumaDBCliError}) and are never swallowed.
 *
 * The returned effect needs `Command.Environment` (file system, path,
 * terminal, stdio, child process spawner) and the adapter environment `R`. A
 * Node consumer provides `NodeServices.layer` and their `SqlClient` layer:
 *
 * ```ts
 * import { NodeRuntime, NodeServices } from "@effect/platform-node"
 * import { PgClient } from "@effect/sql-pg"
 * import { Effect, Layer, Redacted } from "effect"
 * import { makeCli } from "fumadb-effect/cli"
 *
 * const cli = makeCli({ db: client, command: "chat-db", version: "1.0.0" })
 *
 * cli.run().pipe(
 *   Effect.provide(Layer.mergeAll(
 *     NodeServices.layer,
 *     PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL ?? "") })
 *   )),
 *   NodeRuntime.runMain
 * )
 * ```
 */
export const makeCli = <Schemas extends ReadonlyArray<AnySchema>, R>(
  options: MakeCliOptions<Schemas, R>,
): FumaDBCli<R> => {
  const { db, description = "FumaDB CLI for migrations and schema generation", version } = options;

  /** Ask which schema version to migrate to, hinting the current and latest ones. */
  const selectVersion = Effect.fnUntraced(function* (migrator: Migrator<R>) {
    const stored = yield* migrator.version;
    const current = Option.getOrUndefined(stored);
    const schemas = db.schemas;
    const choices = schemas.map((schema, index): Prompt.SelectChoice<string> => {
      const isCurrent = schema.version === current;
      const hint = isCurrent ? "current" : index === schemas.length - 1 ? "latest" : undefined;
      return {
        title: schema.version,
        value: schema.version,
        ...(hint === undefined ? {} : { description: hint }),
        ...(isCurrent ? { selected: true } : {}),
      };
    });
    return yield* Prompt.Select({ message: "Select target schema version:", choices });
  });

  /** Resolve the target version from the argument, asking when it is absent. */
  const resolveVersion = Effect.fnUntraced(function* (
    migrator: Migrator<R>,
    argument: Option.Option<string>,
  ) {
    return Option.isSome(argument) ? argument.value : yield* selectVersion(migrator);
  });

  /** Plan the migration for a version, where `latest` means the newest schema. */
  const planMigration = (migrator: Migrator<R>, target: string, unsafe: boolean) =>
    target === "latest"
      ? migrator.migrateToLatest({ unsafe })
      : migrator.migrateTo(target, { unsafe });

  /**
   * Dropping a table or a column destroys its data, so it needs a deliberate
   * flag. Without it the migration keeps whatever the target schema dropped.
   */
  const unsafeFlag = Flag.Boolean("unsafe").pipe(
    Flag.withDescription("allow dropping tables and columns the target schema no longer has"),
    Flag.withDefault(false),
  );

  const migrateUp = Command.make(
    "migrate:up",
    { unsafe: unsafeFlag },
    Effect.fn("FumaDB.Cli.migrateUp")(function* ({ unsafe }) {
      const migrator = yield* db.createMigrator;
      const next = yield* migrator.next;
      if (Option.isNone(next)) {
        yield* Console.log("Already up to date.");
        return yield* new MigrationError({
          reason: "AlreadyUpToDate",
          message: "Already up to date.",
        });
      }
      const result = yield* migrator.migrateTo(next.value.version, { unsafe });
      yield* result.execute;
      yield* Console.log(`Migration to ${next.value.version} executed.`);
    }),
  ).pipe(Command.withDescription("Migrate to the next schema version"));

  const migrateDown = Command.make(
    "migrate:down",
    { unsafe: unsafeFlag },
    Effect.fn("FumaDB.Cli.migrateDown")(function* ({ unsafe }) {
      const migrator = yield* db.createMigrator;
      const previous = yield* migrator.previous;
      if (Option.isNone(previous)) {
        yield* Console.log("Cannot downgrade.");
        return yield* new MigrationError({ reason: "NoPrevious", message: "Cannot downgrade." });
      }
      const result = yield* migrator.migrateTo(previous.value.version, { unsafe });
      yield* result.execute;
      yield* Console.log(`Migration to ${previous.value.version} executed.`);
    }),
  ).pipe(Command.withDescription("Rollback to the previous schema version"));

  const migrateTo = Command.make(
    "migrate:to",
    {
      version: Argument.String("version").pipe(
        Argument.withDescription("the target schema version, or `latest`"),
        Argument.optional,
      ),
      unsafe: unsafeFlag,
    },
    Effect.fn("FumaDB.Cli.migrateTo")(function* ({ version: argument, unsafe }) {
      const migrator = yield* db.createMigrator;
      const target = yield* resolveVersion(migrator, argument);
      const result = yield* planMigration(migrator, target, unsafe);
      yield* result.execute;
      yield* Console.log(`Migrated to version ${target}.`);
    }),
  ).pipe(
    Command.withAlias("migrate"),
    Command.withDescription("Migrate to a specific schema version (interactive if not provided)"),
  );

  const generate = Command.make(
    "generate",
    {
      version: Argument.String("version").pipe(
        Argument.withDescription("the target schema version, or `latest`"),
        Argument.optional,
      ),
      output: Flag.String("output").pipe(
        Flag.withAlias("o"),
        Flag.withDescription("the output path of the generated SQL file"),
        Flag.optional,
      ),
      unsafe: unsafeFlag,
    },
    Effect.fn("FumaDB.Cli.generate")(function* ({ output, unsafe, version: argument }) {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrator = yield* db.createMigrator;
      const target = yield* resolveVersion(migrator, argument);
      const result = yield* planMigration(migrator, target, unsafe);
      if (Option.isNone(result.sql)) {
        return yield* new MigrationError({
          reason: "Unsupported",
          message: "The adapter doesn't support migration file generation.",
        });
      }

      let destination: string;
      if (Option.isSome(output)) {
        destination = output.value;
      } else {
        const timestamp = yield* Clock.currentTimeMillis;
        destination = yield* Prompt.String({
          message: "Where to output the SQL migration file?",
          default: `./migrations/${timestamp}.sql`,
        });
      }

      const directory = path.dirname(destination);
      if (directory !== "" && directory !== ".") {
        yield* fileSystem.makeDirectory(directory, { recursive: true });
      }
      yield* fileSystem.writeFileString(destination, result.sql.value);
      yield* Console.log("Successful.");
    }),
  ).pipe(Command.withDescription("Output the SQL for the migration"));

  const command: FumaDBCli<R>["command"] = Command.make(options.command).pipe(
    Command.withDescription(description),
    Command.withSubcommands([migrateUp, migrateDown, migrateTo, generate]),
  );

  return {
    command,
    run: (args) =>
      args === undefined
        ? Command.run(command, { version })
        : Command.runWith(command, { version })(args),
  };
};
