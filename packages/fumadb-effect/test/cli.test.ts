/**
 * CLI tests.
 *
 * The CLI never touches a database here: the fake adapter's migrator keeps the
 * stored version in memory, records the versions whose `execute` ran, and
 * renders a fixed SQL string. That keeps the tests about argument parsing,
 * prompts, and the handler logic.
 */
import { assert, describe, it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import * as Cause from "effect/Cause";
import {
  Context,
  Effect,
  Layer,
  Option,
  Path,
  Queue,
  Schema,
  Stdio,
  Terminal,
  type Result,
  type Scope,
} from "effect";
import { FileSystem } from "effect";
import { TestConsole } from "effect/testing";
import * as CliError from "effect/unstable/cli/CliError";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { Adapter } from "../src/contracts/adapter.ts";
import { makeCli } from "../src/implementation/cli.ts";
import { MigrationError } from "../src/contracts/errors.ts";
import { fumadb } from "../src/index.ts";
import type { MigrationResult, Migrator } from "../src/contracts/migration.ts";
import { type AnyTable, column, idColumn, schema, table } from "../src/schema.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const baseColumns = () => ({
  id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))).generated(),
  name: column("name", Schema.String),
});
const users = (extra: boolean): AnyTable =>
  extra
    ? table("users", {
        ...baseColumns(),
        email: column("email", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
      })
    : table("users", baseColumns());

const v1 = schema({ version: "1.0.0", tables: { users: users(false) } });
const v2 = schema({ version: "2.0.0", tables: { users: users(true) } });
const v3 = schema({ version: "3.0.0", tables: { users: users(true) } });

const allSchemas = [v1, v2, v3] as const;

// ---------------------------------------------------------------------------
// Fake adapter
// ---------------------------------------------------------------------------

interface FakeState {
  /** The version stored in the fake settings table. */
  version: string | undefined;
  /** Every version whose `MigrationResult.execute` ran, in order. */
  readonly executed: Array<string>;
}

const sqlFor = (version: string) => `-- migrate to ${version}\nselect 1;`;

const makeFakeAdapter = (initialVersion: string | undefined, canRenderSql = true) => {
  const state: FakeState = { version: initialVersion, executed: [] };
  const versions = allSchemas.map((s) => s.version);

  const indexOfStored = () => versions.findIndex((v) => v === state.version);

  const plan = (version: string): Effect.Effect<MigrationResult<never>, MigrationError> => {
    const found = allSchemas.find((s) => s.version === version);
    if (found === undefined) {
      return Effect.fail(
        new MigrationError({ reason: "UnknownVersion", message: `Invalid version ${version}` }),
      );
    }
    return Effect.succeed({
      operations: [],
      sql: canRenderSql ? Option.some(sqlFor(version)) : Option.none(),
      execute: Effect.sync(() => {
        state.executed.push(version);
        state.version = version;
      }),
    });
  };

  const next = Effect.sync(() => Option.fromNullishOr(allSchemas[indexOfStored() + 1]));
  const previous = Effect.sync(() => {
    const index = indexOfStored();
    return index <= 0 ? Option.none() : Option.fromNullishOr(allSchemas[index - 1]);
  });

  const migrator: Migrator<never> = {
    version: Effect.sync(() => Option.fromNullishOr(state.version)),
    nameVariants: Effect.succeed(Option.none()),
    next,
    previous,
    up: () =>
      Effect.flatMap(next, (n) =>
        Option.isNone(n)
          ? Effect.fail(
              new MigrationError({ reason: "AlreadyUpToDate", message: "Already up to date." }),
            )
          : plan(n.value.version),
      ),
    down: () =>
      Effect.flatMap(previous, (p) =>
        Option.isNone(p)
          ? Effect.fail(new MigrationError({ reason: "NoPrevious", message: "Cannot downgrade." }))
          : plan(p.value.version),
      ),
    migrateTo: (version) => plan(version),
    migrateToLatest: () => {
      const last = versions.at(-1);
      return last === undefined
        ? Effect.fail(
            new MigrationError({ reason: "UnknownVersion", message: "Cannot find other schemas" }),
          )
        : plan(last);
    },
  };

  const adapter: Adapter<never> = {
    name: "fake",
    createOrm: (): never => {
      throw new Error("the CLI never builds an ORM");
    },
    getSchemaVersion: () => Effect.sync(() => Option.fromNullishOr(state.version)),
    createMigrator: () => migrator,
  };

  return { adapter, state };
};

/**
 * A CLI bound to a fresh in-memory adapter. `initialVersion` is `undefined` for
 * a database that was never migrated; `canRenderSql` is `false` for an adapter
 * that cannot produce a migration script.
 */
const makeHarness = (initialVersion: string | undefined, canRenderSql = true) => {
  const { adapter, state } = makeFakeAdapter(initialVersion, canRenderSql);
  const db = fumadb({ namespace: "cli-test", schemas: allSchemas }).client(adapter);
  const cli = makeCli({ db, command: "chat-db", version: "9.9.9" });
  return { cli, state };
};

// ---------------------------------------------------------------------------
// Mock terminal
// ---------------------------------------------------------------------------

interface MockTerminal extends Terminal.Terminal {
  /** Everything the prompts rendered, in order. */
  readonly displayLines: Effect.Effect<ReadonlyArray<string>>;
  readonly inputText: (text: string) => Effect.Effect<void>;
  readonly inputKey: (key: string, modifiers?: { ctrl?: boolean }) => Effect.Effect<void>;
}

const MockTerminal = Context.Service<Terminal.Terminal, MockTerminal>()(Terminal.Terminal.key);

/** Ctrl+C / Ctrl+D end the input queue, exactly as effect's own MockTerminal does. */
const shouldQuit = (input: Terminal.UserInput): boolean =>
  input.key.ctrl && (input.key.name === "c" || input.key.name === "d");

const makeMockTerminal = Effect.gen(function* () {
  const output: Array<string> = [];
  const queue = yield* Effect.acquireRelease(Queue.make<Terminal.UserInput, Cause.Done>(), (q) =>
    Queue.shutdown(q),
  );
  const toUserInput = (key: string, ctrl = false): Terminal.UserInput => ({
    input: Option.some(key),
    key: { name: key, ctrl, meta: false, shift: false },
  });
  const readInput: Effect.Effect<
    Queue.Dequeue<Terminal.UserInput, Cause.Done>,
    never,
    Scope.Scope
  > = Effect.succeed(Queue.asDequeue(queue));
  const terminal = Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    display: (input) =>
      Effect.sync(() => {
        output.push(input);
      }),
    readInput,
    readLine: Effect.succeed(""),
  });
  return Object.assign(terminal, {
    displayLines: Effect.sync(() => output.slice()),
    inputText: (text: string) =>
      Effect.asVoid(
        Queue.offerAll(
          queue,
          text.split("").map((char) => toUserInput(char)),
        ),
      ),
    inputKey: (key: string, modifiers?: { ctrl?: boolean }) => {
      const input = toUserInput(key, modifiers?.ctrl ?? false);
      return Effect.asVoid(shouldQuit(input) ? Queue.end(queue) : Queue.offer(queue, input));
    },
  });
});

const inputText = (text: string): Effect.Effect<void, never, Terminal.Terminal> =>
  Effect.flatMap(MockTerminal, (terminal) => terminal.inputText(text));

const inputKey = (
  key: string,
  modifiers?: { ctrl?: boolean },
): Effect.Effect<void, never, Terminal.Terminal> =>
  Effect.flatMap(MockTerminal, (terminal) => terminal.inputKey(key, modifiers));

/** Everything the prompts rendered, joined so assertions can search it. */
const displayed: Effect.Effect<string, never, Terminal.Terminal> = Effect.flatMap(
  MockTerminal,
  (terminal) => Effect.map(terminal.displayLines, (lines) => lines.join("")),
);

// ---------------------------------------------------------------------------
// Test layer
// ---------------------------------------------------------------------------

const TestLayer = Layer.mergeAll(
  TestConsole.layer,
  NodeFileSystem.layer,
  Path.layer,
  Layer.effect(MockTerminal, makeMockTerminal),
  Stdio.layerTest({}),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("the CLI tests never spawn a process")),
  ),
);

const logged = Effect.map(TestConsole.logLines, (lines) => lines.map(String).join("\n"));

/** The `reason` of a `MigrationError` failure, or a failed assertion. */
const migrationFailureReason = (result: Result.Result<void, unknown>): string => {
  if (result._tag === "Failure" && result.failure instanceof MigrationError)
    return result.failure.reason;
  return assert.fail(`expected a MigrationError, got ${result._tag}`);
};

describe("cli", () => {
  it.effect("migrate:up executes the next version", () =>
    Effect.gen(function* () {
      const { cli, state } = makeHarness("1.0.0");

      yield* cli.run(["migrate:up"]);

      assert.deepStrictEqual(state.executed, ["2.0.0"]);
      assert.strictEqual(state.version, "2.0.0");
      assert.include(yield* logged, "Migration to 2.0.0 executed.");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("migrate:up fails with AlreadyUpToDate on the newest version", () =>
    Effect.gen(function* () {
      const { cli, state } = makeHarness("3.0.0");

      const result = yield* Effect.result(cli.run(["migrate:up"]));

      assert.strictEqual(migrationFailureReason(result), "AlreadyUpToDate");
      assert.include(yield* logged, "Already up to date.");
      assert.deepStrictEqual(state.executed, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("migrate:up executes the first version on an uninitialized database", () =>
    Effect.gen(function* () {
      const { cli, state } = makeHarness(undefined);

      yield* cli.run(["migrate:up"]);

      assert.deepStrictEqual(state.executed, ["1.0.0"]);
      assert.strictEqual(state.version, "1.0.0");
      assert.include(yield* logged, "Migration to 1.0.0 executed.");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("migrate:down fails with NoPrevious on an uninitialized database", () =>
    Effect.gen(function* () {
      const { cli, state } = makeHarness(undefined);

      const result = yield* Effect.result(cli.run(["migrate:down"]));

      assert.strictEqual(migrationFailureReason(result), "NoPrevious");
      assert.deepStrictEqual(state.executed, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("migrate:down executes the previous version", () =>
    Effect.gen(function* () {
      const { cli, state } = makeHarness("3.0.0");

      yield* cli.run(["migrate:down"]);

      assert.deepStrictEqual(state.executed, ["2.0.0"]);
      assert.include(yield* logged, "Migration to 2.0.0 executed.");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("migrate:down fails with NoPrevious on the oldest version", () =>
    Effect.gen(function* () {
      const { cli, state } = makeHarness("1.0.0");

      const result = yield* Effect.result(cli.run(["migrate:down"]));

      assert.strictEqual(migrationFailureReason(result), "NoPrevious");
      assert.include(yield* logged, "Cannot downgrade.");
      assert.deepStrictEqual(state.executed, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("migrate:to executes the requested version", () =>
    Effect.gen(function* () {
      const { cli, state } = makeHarness("1.0.0");

      yield* cli.run(["migrate:to", "2.0.0"]);

      assert.deepStrictEqual(state.executed, ["2.0.0"]);
      assert.include(yield* logged, "Migrated to version 2.0.0.");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("the `migrate` alias runs migrate:to", () =>
    Effect.gen(function* () {
      const { cli, state } = makeHarness("1.0.0");

      yield* cli.run(["migrate", "3.0.0"]);

      assert.deepStrictEqual(state.executed, ["3.0.0"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("migrate:to latest executes the newest version", () =>
    Effect.gen(function* () {
      const { cli, state } = makeHarness("1.0.0");

      yield* cli.run(["migrate:to", "latest"]);

      assert.deepStrictEqual(state.executed, ["3.0.0"]);
      assert.include(yield* logged, "Migrated to version latest.");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("migrate:to fails with UnknownVersion for a version outside the schema list", () =>
    Effect.gen(function* () {
      const { cli, state } = makeHarness("1.0.0");

      const result = yield* Effect.result(cli.run(["migrate:to", "4.0.0"]));

      assert.strictEqual(migrationFailureReason(result), "UnknownVersion");
      assert.deepStrictEqual(state.executed, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("migrate:to without a version pre-selects the stored version", () =>
    Effect.gen(function* () {
      // 2.0.0 is not the first choice, so accepting the prompt straight away
      // can only pick it if `selected: true` was honoured.
      const { cli, state } = makeHarness("2.0.0");

      yield* inputKey("enter");
      yield* cli.run(["migrate:to"]);

      assert.deepStrictEqual(state.executed, ["2.0.0"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("migrate:to without a version moves the selection with the arrow keys", () =>
    Effect.gen(function* () {
      const { cli, state } = makeHarness("2.0.0");

      yield* inputKey("down");
      yield* inputKey("enter");
      yield* cli.run(["migrate:to"]);

      assert.deepStrictEqual(state.executed, ["3.0.0"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("migrate:to without a version starts on the first schema when nothing is stored", () =>
    Effect.gen(function* () {
      const { cli, state } = makeHarness(undefined);

      yield* inputKey("enter");
      yield* cli.run(["migrate:to"]);

      assert.deepStrictEqual(state.executed, ["1.0.0"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("the version prompt lists every schema with `current` and `latest` hints", () =>
    Effect.gen(function* () {
      const { cli } = makeHarness("2.0.0");

      // A hint is only rendered for the choice under the cursor, so walk from
      // the stored version (`current`) onto the newest one (`latest`).
      yield* inputKey("down");
      yield* inputKey("enter");
      yield* cli.run(["migrate:to"]);

      const rendered = yield* displayed;
      assert.include(rendered, "Select target schema version:");
      for (const version of ["1.0.0", "2.0.0", "3.0.0"]) assert.include(rendered, version);
      assert.include(rendered, "current");
      assert.include(rendered, "latest");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("the version prompt marks nothing as current on an uninitialized database", () =>
    Effect.gen(function* () {
      const { cli, state } = makeHarness(undefined);

      // No choice is pre-selected, so the cursor starts on the first schema;
      // two `down` presses walk over every choice and onto `latest`.
      yield* inputKey("down");
      yield* inputKey("down");
      yield* inputKey("enter");
      yield* cli.run(["migrate:to"]);

      assert.deepStrictEqual(state.executed, ["3.0.0"]);
      const rendered = yield* displayed;
      assert.notInclude(rendered, "current");
      assert.include(rendered, "latest");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("cancelling the version prompt interrupts and runs nothing", () =>
    Effect.gen(function* () {
      const { cli, state } = makeHarness("1.0.0");

      yield* inputKey("c", { ctrl: true });
      const exit = yield* Effect.exit(cli.run(["migrate:to"]));

      if (exit._tag !== "Failure") return assert.fail("expected the run to be interrupted");
      assert.isTrue(Cause.hasInterrupts(exit.cause));
      assert.deepStrictEqual(state.executed, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("generate --output writes the migration SQL", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectory();
      const destination = path.join(directory, "nested", "migration.sql");
      const { cli, state } = makeHarness("1.0.0");

      yield* cli.run(["generate", "2.0.0", "--output", destination]);

      assert.strictEqual(yield* fs.readFileString(destination), sqlFor("2.0.0"));
      assert.include(yield* logged, "Successful.");
      // `generate` plans the migration but never applies it.
      assert.deepStrictEqual(state.executed, []);
      yield* fs.remove(directory, { recursive: true });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("generate -o accepts the short flag and `latest`", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectory();
      const destination = path.join(directory, "latest.sql");
      const { cli } = makeHarness("1.0.0");

      yield* cli.run(["generate", "latest", "-o", destination]);

      assert.strictEqual(yield* fs.readFileString(destination), sqlFor("3.0.0"));
      yield* fs.remove(directory, { recursive: true });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("generate without --output asks for the path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectory();
      const destination = path.join(directory, "asked.sql");
      const { cli } = makeHarness("1.0.0");

      // Ctrl+U clears the suggested `./migrations/<timestamp>.sql` path.
      yield* inputKey("u", { ctrl: true });
      yield* inputText(destination);
      yield* inputKey("enter");
      yield* cli.run(["generate", "2.0.0"]);

      assert.strictEqual(yield* fs.readFileString(destination), sqlFor("2.0.0"));
      yield* fs.remove(directory, { recursive: true });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("generate fails with Unsupported when the adapter cannot render SQL", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectory();
      const destination = path.join(directory, "never-written.sql");
      const { cli, state } = makeHarness("1.0.0", false);

      const result = yield* Effect.result(cli.run(["generate", "2.0.0", "--output", destination]));

      assert.strictEqual(migrationFailureReason(result), "Unsupported");
      assert.isFalse(yield* fs.exists(destination));
      assert.deepStrictEqual(state.executed, []);
      yield* fs.remove(directory, { recursive: true });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("the root command shows help and runs nothing", () =>
    Effect.gen(function* () {
      const { cli, state } = makeHarness("1.0.0");

      const result = yield* Effect.result(cli.run([]));

      if (result._tag !== "Failure") return assert.fail("expected the root command to show help");
      const failure = result.failure;
      assert.isTrue(CliError.isCliError(failure), "expected a CliError");
      if (!CliError.isCliError(failure) || failure._tag !== "ShowHelp") {
        return assert.fail("expected a CliError.ShowHelp");
      }
      assert.deepStrictEqual(failure.commandPath, ["chat-db"]);

      const help = yield* logged;
      for (const name of ["migrate:up", "migrate:down", "migrate:to", "generate"])
        assert.include(help, name);
      assert.deepStrictEqual(state.executed, []);
    }).pipe(Effect.provide(TestLayer)),
  );
});
