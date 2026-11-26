import { Clock, Console, Effect, FileSystem, Option, Path, type Terminal } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Argument, Command, Flag, Prompt } from "effect/cli";
import type * as CliError from "effect/cli/CliError";
import type { SqlError } from "effect/sql/SqlError";
import { MigrationError } from "../contracts/errors.ts";
import type { FumaDB } from "../index.ts";
import type { Migrator } from "../contracts/migration.ts";
import type { AnySchema } from "../contracts/schema/schema.ts";

export type FumaDBCliError = MigrationError | SqlError | PlatformError | Terminal.QuitError;

export type FumaDBCliServices = FileSystem.FileSystem | Path.Path | Terminal.Terminal;

export interface FumaDBCli<R> {
  readonly command: Command.Command<string, {}, {}, FumaDBCliError, R | FumaDBCliServices>;
  readonly run: (
    args?: ReadonlyArray<string>,
  ) => Effect.Effect<void, FumaDBCliError | CliError.CliError, R | Command.Environment>;
}

export interface MakeCliOptions<Schemas extends ReadonlyArray<AnySchema>, R> {
  readonly db: FumaDB<Schemas, R>;
  readonly command: string;
  readonly description?: string | undefined;
  readonly version: string;
}

export const makeCli = <Schemas extends ReadonlyArray<AnySchema>, R>(
  options: MakeCliOptions<Schemas, R>,
): FumaDBCli<R> => {
  const { db, description = "FumaDB CLI for migrations and schema generation", version } = options;

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

  const resolveVersion = Effect.fnUntraced(function* (
    migrator: Migrator<R>,
    argument: Option.Option<string>,
  ) {
    return Option.isSome(argument) ? argument.value : yield* selectVersion(migrator);
  });

  const planMigration = (migrator: Migrator<R>, target: string, unsafe: boolean) =>
    target === "latest"
      ? migrator.migrateToLatest({ unsafe })
      : migrator.migrateTo(target, { unsafe });

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
