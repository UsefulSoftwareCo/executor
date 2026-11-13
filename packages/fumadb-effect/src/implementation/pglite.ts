/** Native Effect PGlite client with FumaDB's UTC temporal contract. */
import { PgliteClient } from "@effect/sql-pglite";
import { rmdir } from "node:fs/promises";
import { Effect, FileSystem, Layer, Path, Schedule } from "effect";
import { PgliteCreationFailed } from "../contracts/errors.ts";

type Options = Omit<PgliteClient.PgliteClientConfig.Create, "parsers">;

/**
 * Keep naive timestamp/date values as text so the FumaDB codec decodes them as UTC.
 * PGlite otherwise creates Date objects in the machine timezone before the codec runs.
 * The native Effect layer owns serialization, transactions, and closing the database.
 */
export const pgliteLayer = (options: Options = {}) =>
  PgliteClient.layer({ ...options, parsers: { 1082: (value) => value, 1114: (value) => value } });

/** The system error code of a file system failure, as Node reports it. */
const systemCode = (error: unknown): string | undefined => {
  for (const candidate of [error, (error as { cause?: unknown } | undefined)?.cause]) {
    const code = (candidate as { code?: unknown } | undefined)?.code;
    if (typeof code === "string") return code;
  }
  return undefined;
};

/**
 * Antivirus scanners and the indexer on Windows briefly hold files just written, so removing or
 * renaming their directory fails with EPERM, EBUSY or EACCES for a moment. There such a step is
 * tried again for up to five seconds, as the desktop's `whileHeld` does, before it fails.
 */
const whileHeld = <A, E, R>(step: Effect.Effect<A, E, R>) =>
  process.platform === "win32"
    ? step.pipe(
        Effect.retry({
          while: (error) => ["EPERM", "EBUSY", "EACCES"].includes(systemCode(error) ?? ""),
          schedule: Schedule.exponential("50 millis").pipe(
            Schedule.upTo({ duration: "5 seconds" }),
          ),
        }),
      )
    : step;

/**
 * Create the database at `dataDir` unless it holds one. PGlite takes a directory with PG_VERSION
 * for a database, and writes PG_VERSION before configuration files a database also needs, so a
 * first start ended between the two would leave a directory no later start can open. The database
 * is therefore created in `<dataDir>.new` and renamed into place once PGlite has written and closed
 * it; a `.new` directory is only ever this step's, so one left by an earlier start is replaced.
 *
 * A directory with PG_VERSION is never touched. One without it is removed only when it is empty,
 * by `rmdir`, which refuses a directory with contents; one with contents is moved aside to a name
 * no other start uses and logged. The caller holds the data directory's lock, so no other process
 * creates the database meanwhile.
 */
export const createPgliteDatabase = (dataDir: string, options: Omit<Options, "dataDir"> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const database = path.basename(dataDir);
    const failed = (step: PgliteCreationFailed["step"]) => (error: unknown) =>
      new PgliteCreationFailed({ database, step, code: systemCode(error) });
    const exists = (file: string) => fs.exists(file).pipe(Effect.mapError(failed("create")));
    if (yield* exists(path.join(dataDir, "PG_VERSION"))) return;
    const staging = `${dataDir}.new`;
    yield* whileHeld(fs.remove(staging, { recursive: true, force: true })).pipe(
      Effect.mapError(failed("clear")),
    );
    yield* fs
      .makeDirectory(staging, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(failed("create")));
    // Building the layer opens the database, which PGlite creates; closing the scope closes it.
    yield* Layer.build(pgliteLayer({ ...options, dataDir: staging })).pipe(
      Effect.scoped,
      Effect.mapError(failed("create")),
    );
    if (yield* exists(dataDir)) {
      const entries = yield* fs.readDirectory(dataDir).pipe(Effect.mapError(failed("set aside")));
      if (entries.length === 0)
        yield* whileHeld(
          Effect.tryPromise({ try: () => rmdir(dataDir), catch: (error) => error }),
        ).pipe(Effect.mapError(failed("move into place")));
      else {
        const aside = `${dataDir}.unrecognised-${Date.now()}-${crypto.randomUUID()}`;
        yield* whileHeld(fs.rename(dataDir, aside)).pipe(Effect.mapError(failed("set aside")));
        yield* Effect.logWarning(
          "A database directory without PG_VERSION held files; they were moved aside",
        ).pipe(Effect.annotateLogs({ database, aside: path.basename(aside) }));
      }
    }
    yield* whileHeld(fs.rename(staging, dataDir)).pipe(Effect.mapError(failed("move into place")));
  });

/**
 * A PGlite database persisted in `dataDir`, created whole on its first open so that a first start
 * ended at any point leaves either no database or a complete one. The caller holds the directory
 * against other processes.
 */
export const persistentPgliteLayer = (dataDir: string, options: Omit<Options, "dataDir"> = {}) =>
  Layer.unwrap(
    createPgliteDatabase(dataDir, options).pipe(Effect.as(pgliteLayer({ ...options, dataDir }))),
  );
