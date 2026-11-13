/**
 * The local server and the self-hosted server create their PGlite databases on their first start
 * (`persistentPgliteLayer` in fumadb-effect). When that start is ended partway, as
 * `executor service start` ends a background server that has not answered three probes in a row,
 * the next start must still open the database. PGlite takes a directory with PG_VERSION for a
 * database and writes PG_VERSION before pg_hba.conf, so a first start here is killed the moment
 * PGlite opens pg_hba.conf to write it. An existing database is never touched, and a directory
 * without PG_VERSION is removed only when it is empty.
 *
 * Each start is its own process running the product's own layer, Node for the local server's
 * `localDatabase` and Bun for the self-hosted server's `selfHostDatabase`, so a kill is a real one
 * and the next start reads only what the last one left on disk.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, FileSystem, Path, Schedule, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Kill this process the first time anything opens a pg_hba.conf for writing. */
const killAtConfiguration = `
import fs from "node:fs";
const open = fs.openSync;
fs.openSync = (file, flags, mode) => {
  const writes =
    typeof flags === "number"
      ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0
      : /[wa+]/.test(String(flags));
  if (writes && String(file).replaceAll("\\\\", "/").endsWith("/pg_hba.conf")) {
    fs.writeFileSync(process.env.KILLED_AT, String(file));
    process.kill(process.pid, "SIGKILL");
  }
  return open(file, flags, mode);
};
`;

/** Open the local server's database at argv[2] with `localDatabase` and run QUERY. */
const localStart = `
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pathToFileURL } from "node:url";
const { localDatabase } = await import(pathToFileURL(process.env.LAYER).href);
const rows = await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe(process.env.QUERY);
  }).pipe(Effect.provide(localDatabase(process.argv[2])), Effect.provide(NodeServices.layer)),
);
console.log(JSON.stringify(rows));
`;

/** Open the self-hosted server's database in EXECUTOR_DATA_DIR with `selfHostDatabase`. */
const selfHostStart = `
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pathToFileURL } from "node:url";
const { selfHostDatabase } = await import(pathToFileURL(process.env.LAYER).href);
const rows = await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe(process.env.QUERY);
  }).pipe(Effect.provide(selfHostDatabase), Effect.provide(NodeServices.layer)),
);
console.log(JSON.stringify(rows));
`;

const one = JSON.stringify([{ one: 1 }]);

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scratch = yield* fs.makeTempDirectoryScoped();
  const killedAt = path.join(scratch, "killed-at");
  const preload = path.join(scratch, "kill-at-configuration.mjs");
  yield* fs.writeFileString(preload, killAtConfiguration);
  const local = path.resolve("apps/local/server");
  const selfHost = path.resolve("apps/hosted/self-host");

  /** One start; `kill` kills it at pg_hba.conf. Its scripts sit in the product's package. */
  const start = (options: {
    readonly product: "local" | "self-host";
    readonly dataDir: string;
    readonly query?: string;
    readonly kill?: boolean;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = options.product === "local" ? local : selfHost;
        const script = path.join(cwd, `.first-start-${crypto.randomUUID()}.mjs`);
        yield* Effect.acquireRelease(
          fs.writeFileString(script, options.product === "local" ? localStart : selfHostStart),
          () => fs.remove(script, { force: true }).pipe(Effect.ignore),
        );
        const env = {
          QUERY: options.query ?? "select 1 as one",
          KILLED_AT: killedAt,
          ...(options.product === "local"
            ? { LAYER: path.join(local, "src/implementation/local-database.ts") }
            : {
                LAYER: path.join(selfHost, "src/database.ts"),
                // The self-hosted database is `hosted.pglite` in its data directory.
                EXECUTOR_DATA_DIR: path.dirname(options.dataDir),
                BETTER_AUTH_URL: "http://127.0.0.1:9",
                BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
              }),
        };
        // Node runs the local server's layer, which Node runs in the CLI; Bun the self-hosted one.
        // Node's --import takes a URL, which a Windows path is not.
        const preloads =
          options.kill !== true
            ? []
            : options.product === "local"
              ? ["--import", (yield* path.toFileUrl(preload)).href]
              : ["--preload", preload];
        const child = yield* processes.spawn(
          ChildProcess.make(
            options.product === "local" ? "node" : "bun",
            [...preloads, script, options.dataDir],
            { cwd, env, extendEnv: true },
          ),
        );
        const [stdout, stderr] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            Effect.exit(child.exitCode),
          ],
          { concurrency: "unbounded" },
        );
        // The query's rows are the last line; logs, such as a warning, come before them.
        const lines = stdout.trim().split("\n");
        return { stdout: lines.at(-1) ?? "", logs: lines.slice(0, -1).join("\n"), stderr };
      }),
    );

  /** A complete database, created at a path of its own by a start that ended normally. */
  const complete = (name: string) =>
    Effect.gen(function* () {
      const dataDir = path.join(scratch, name);
      const created = yield* start({ product: "local", dataDir });
      expect(created.stdout, created.stderr).toBe(one);
      return dataDir;
    });

  return { fs, path, scratch, killedAt, start, complete };
});

const test = (name: string, body: Effect.Effect<void, unknown, never>) =>
  it.live(name, () => body, 120_000);

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.asVoid);

test(
  "a local database whose first start was killed while PGlite wrote it opens on the next start",
  run(
    Effect.gen(function* () {
      const { fs, path, scratch, killedAt, start } = yield* setup;
      const dataDir = path.join(scratch, "browser-auth.pglite");
      // The local server creates the directory before it opens the database.
      yield* fs.makeDirectory(dataDir, { mode: 0o700 });

      const first = yield* start({ product: "local", dataDir, kill: true });
      // The first start was killed at pg_hba.conf, not ended by anything else.
      expect(first.stdout, first.stderr).toBe("");
      expect(yield* fs.exists(killedAt), first.stderr).toBe(true);

      const next = yield* start({ product: "local", dataDir });
      expect(next.stdout, next.stderr).toBe(one);
      expect(yield* fs.exists(path.join(dataDir, "PG_VERSION"))).toBe(true);
    }),
  ),
);

test(
  "a database directory without PG_VERSION that holds files is moved aside whole, never removed",
  run(
    Effect.gen(function* () {
      const { fs, path, scratch, start } = yield* setup;
      const dataDir = path.join(scratch, "executor.pglite");
      yield* fs.makeDirectory(path.join(dataDir, "notes"), { recursive: true });
      yield* fs.writeFileString(path.join(dataDir, "notes", "kept.txt"), "kept");

      const opened = yield* start({ product: "local", dataDir });
      expect(opened.stdout, opened.stderr).toBe(one);
      expect(opened.logs).toContain("they were moved aside");
      const aside = (yield* fs.readDirectory(scratch)).filter((name) =>
        name.startsWith("executor.pglite.unrecognised-"),
      );
      expect(aside).toHaveLength(1);
      expect(yield* fs.readFileString(path.join(scratch, aside[0]!, "notes", "kept.txt"))).toBe(
        "kept",
      );
      expect(yield* fs.exists(path.join(dataDir, "PG_VERSION"))).toBe(true);
    }),
  ),
);

test(
  "a complete .new copy left before the rename opens, with an empty database directory or none",
  run(
    Effect.gen(function* () {
      const { fs, path, scratch, start, complete } = yield* setup;
      // A start killed after PGlite closed the copy, before or during the rename into place:
      // the directory it would replace is still there empty, or already gone.
      for (const final of ["empty", "missing"] as const) {
        const dataDir = path.join(scratch, `${final}.pglite`);
        yield* fs.rename(yield* complete(`${final}-copy`), `${dataDir}.new`);
        if (final === "empty") yield* fs.makeDirectory(dataDir);

        const opened = yield* start({ product: "local", dataDir });
        expect(opened.stdout, `${final}: ${opened.stderr}`).toBe(one);
        expect(yield* fs.exists(path.join(dataDir, "PG_VERSION")), final).toBe(true);
        expect(yield* fs.exists(`${dataDir}.new`), final).toBe(false);
      }
    }),
  ),
);

test(
  "an existing database is opened as it is, whatever a .new directory beside it holds",
  run(
    Effect.gen(function* () {
      const { fs, path, scratch, start, complete } = yield* setup;
      const dataDir = path.join(scratch, "mcp-auth.pglite");
      const written = yield* start({
        product: "local",
        dataDir,
        query: "create table kept as select 7 as x",
      });
      expect(written.stderr).toBe("");
      yield* fs.rename(yield* complete("stray"), `${dataDir}.new`);

      const read = yield* start({ product: "local", dataDir, query: "select x from kept" });
      expect(read.stdout, read.stderr).toBe(JSON.stringify([{ x: 7 }]));
      // The stray copy was not used, nor removed: only a missing database is created.
      expect(yield* fs.exists(path.join(`${dataDir}.new`, "PG_VERSION"))).toBe(true);
    }),
  ),
);

test(
  "a self-hosted database whose first start was killed while PGlite wrote it opens on the next start",
  run(
    Effect.gen(function* () {
      const { fs, path, scratch, killedAt, start } = yield* setup;
      const dataDir = path.join(scratch, "volume", "hosted.pglite");

      const first = yield* start({ product: "self-host", dataDir, kill: true });
      expect(first.stdout, first.stderr).toBe("");
      expect(yield* fs.exists(killedAt), first.stderr).toBe(true);
      // The killed server's volume lock (proper-lockfile) refuses every start until it is stale,
      // 10 s after its last heartbeat, as it would refuse a restart of the real server.
      yield* Effect.sleep("11 seconds");

      const next = yield* start({ product: "self-host", dataDir });
      expect(next.stdout, next.stderr).toBe(one);
      expect(yield* fs.exists(path.join(dataDir, "PG_VERSION"))).toBe(true);
    }),
  ),
);

/**
 * Open the local server's database at argv[2] with `localDatabase`, logging to DIAGNOSTICS'
 * `executor-local.jsonl` as the local server does, and print the rows or the failure.
 */
const loggedStart = `
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Logger } from "effect";
import { SqlClient } from "effect/sql";
import { pathToFileURL } from "node:url";
const { localDatabase } = await import(pathToFileURL(process.env.LAYER).href);
const { rotatingJsonLogger } = await import("@executor-js/telemetry/files");
const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const log = yield* rotatingJsonLogger(process.env.DIAGNOSTICS, "executor-local");
      return yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe("select 1 as one");
      }).pipe(
        Effect.provide(localDatabase(process.argv[2])),
        Effect.provide(Logger.layer([log.logger])),
        Effect.catch((error) =>
          Effect.succeed({
            failed: { tag: error._tag, stage: error.stage, step: error.step, code: error.code },
          }),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
console.log(JSON.stringify(result));
`;

/** Holds its working directory, which Windows then refuses to remove or rename, until killed. */
const holder = `process.stdout.write("holding\\n"); setInterval(() => {}, 1000);`;

const refused = "A database step was refused while another process held its files; retrying";
const wentThrough = "A database step went through once its files were released";
const gaveUp = "A database step gave up while another process still held its files";

/**
 * Start the local server's database in an empty `browser-auth.pglite` that another process holds
 * as its working directory. With `release`, the holder ends once the first refusal is in the
 * diagnostics log, so the retry has been seen and then goes through; without, it holds until the
 * start has ended. Nothing waits a fixed time.
 */
const heldStart = (release: boolean) =>
  Effect.gen(function* () {
    const { fs, path, scratch } = yield* setup;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const local = path.resolve("apps/local/server");
    const dataDir = path.join(scratch, "browser-auth.pglite");
    const diagnostics = path.join(scratch, "diagnostics");
    const logFile = path.join(diagnostics, "executor-local.jsonl");
    yield* fs.makeDirectory(dataDir, { mode: 0o700 });

    const holding = yield* processes.spawn(
      ChildProcess.make("node", ["--eval", holder], { cwd: dataDir }),
    );
    // The holder has the directory once it says so.
    yield* holding.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line === "holding"),
      Stream.runHead,
    );

    const script = path.join(local, `.first-start-${crypto.randomUUID()}.mjs`);
    yield* Effect.acquireRelease(fs.writeFileString(script, loggedStart), () =>
      fs.remove(script, { force: true }).pipe(Effect.ignore),
    );
    const starting = yield* processes.spawn(
      ChildProcess.make("node", [script, dataDir], {
        cwd: local,
        env: {
          LAYER: path.join(local, "src/implementation/local-database.ts"),
          DIAGNOSTICS: diagnostics,
        },
        extendEnv: true,
      }),
    );
    const output = yield* Effect.all(
      [
        starting.stdout.pipe(Stream.decodeText(), Stream.mkString),
        starting.stderr.pipe(Stream.decodeText(), Stream.mkString),
        Effect.exit(starting.exitCode),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.forkScoped);
    const log = fs
      .exists(logFile)
      .pipe(Effect.flatMap((exists) => (exists ? fs.readFileString(logFile) : Effect.succeed(""))));
    if (release) {
      // Poll the log until the first refusal is written, or the start ends without one.
      yield* log.pipe(
        Effect.repeat({
          until: (text) => text.includes(refused),
          schedule: Schedule.spaced("25 millis"),
        }),
        Effect.raceFirst(Fiber.await(output)),
      );
      yield* holding.kill().pipe(Effect.ignore);
    }
    const [stdout, stderr] = yield* Fiber.join(output);
    yield* holding.kill().pipe(Effect.ignore);
    // The retry's lines in the job's log, so a passing run shows them too.
    for (const line of (yield* log).split("\n"))
      if (line.includes("A database step")) yield* Effect.logInfo(`diagnostics: ${line}`);
    const lines = (yield* log)
      .split("\n")
      .filter((line) => line !== "")
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly message: unknown;
            readonly annotations: Record<string, unknown>;
          },
      );
    const message = (entry: { readonly message: unknown }) =>
      [entry.message].flat().map(String).join(" ");
    return {
      result: stdout.trim().split("\n").at(-1) ?? "",
      stderr,
      text: yield* log,
      /** The scratch directory's own name, which no log line may contain. */
      scratchName: path.basename(scratch),
      line: (text: string) => lines.find((entry) => message(entry).includes(text))?.annotations,
    };
  });

const heldCodes = ["EPERM", "EBUSY", "EACCES"];

// Only Windows refuses to remove or rename a directory another process holds.
if (process.platform === "win32") {
  test(
    "a local database whose directory another process holds for a moment is created once it is released, and the retry is logged",
    run(
      Effect.gen(function* () {
        const started = yield* heldStart(true);
        expect(started.result, `${started.stderr}\n${started.text}`).toBe(one);
        const first = started.line(refused);
        expect(first, started.text).toMatchObject({
          database: "browser-auth.pglite",
          step: "move into place",
        });
        expect(heldCodes, started.text).toContain(first?.code);
        const through = started.line(wentThrough);
        expect(through, started.text).toMatchObject({
          database: "browser-auth.pglite",
          step: "move into place",
          code: first?.code,
        });
        expect(through?.heldMs, started.text).toBeTypeOf("number");
        // No path reaches the log.
        expect(started.text).not.toContain(started.scratchName);
      }),
    ),
  );

  test(
    "a local database whose directory another process holds past the retry fails at the database stage with the code, and the give-up is logged",
    run(
      Effect.gen(function* () {
        const started = yield* heldStart(false);
        const first = started.line(refused);
        expect(heldCodes, started.text).toContain(first?.code);
        expect(JSON.parse(started.result), `${started.stderr}\n${started.text}`).toEqual({
          failed: {
            tag: "StartupFailed",
            stage: "database",
            step: "move into place",
            code: first?.code,
          },
        });
        expect(started.line(gaveUp), started.text).toMatchObject({
          database: "browser-auth.pglite",
          step: "move into place",
          code: first?.code,
        });
        expect(started.line(wentThrough), started.text).toBeUndefined();
      }),
    ),
  );
}
