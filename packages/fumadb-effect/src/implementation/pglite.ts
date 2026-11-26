import { PgliteClient } from "@effect/sql-pglite";
import { rmdir } from "node:fs/promises";
import { Effect, FileSystem, Layer, Path, Schedule } from "effect";
import { PgliteCreationFailed } from "../contracts/errors.ts";

type Options = Omit<PgliteClient.PgliteClientConfig.Create, "parsers">;

export const pgliteLayer = (options: Options = {}) =>
  PgliteClient.layer({ ...options, parsers: { 1082: (value) => value, 1114: (value) => value } });

const systemCode = (error: unknown): string | undefined => {
  for (const candidate of [error, (error as { cause?: unknown } | undefined)?.cause]) {
    const code = (candidate as { code?: unknown } | undefined)?.code;
    if (typeof code === "string") return code;
  }
  return undefined;
};

const heldCodes = ["EPERM", "EBUSY", "EACCES"];

const whileHeld =
  (database: string, step: PgliteCreationFailed["step"]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    process.platform !== "win32"
      ? effect
      : Effect.suspend(() => {
          let refused: { readonly code: string; readonly at: number } | undefined;
          const held = (error: E) => heldCodes.includes(systemCode(error) ?? "");
          const annotations = (code: string | undefined) =>
            Effect.annotateLogs({
              database,
              step,
              ...(code === undefined ? {} : { code }),
              ...(refused === undefined ? {} : { heldMs: Date.now() - refused.at }),
            });
          return effect.pipe(
            Effect.tapError((error) =>
              refused !== undefined || !held(error)
                ? Effect.void
                : Effect.suspend(() => {
                    refused = { code: systemCode(error) ?? "", at: Date.now() };
                    return Effect.logWarning(
                      "A database step was refused while another process held its files; retrying",
                    ).pipe(Effect.annotateLogs({ database, step, code: refused.code }));
                  }),
            ),
            Effect.retry({
              while: held,
              schedule: Schedule.exponential("50 millis").pipe(
                Schedule.upTo({ duration: "5 seconds" }),
              ),
            }),
            Effect.tap(() =>
              refused === undefined
                ? Effect.void
                : Effect.logWarning(
                    "A database step went through once its files were released",
                  ).pipe(annotations(refused.code)),
            ),
            Effect.tapError((error) =>
              refused === undefined
                ? Effect.void
                : Effect.logWarning(
                    "A database step gave up while another process still held its files",
                  ).pipe(annotations(systemCode(error))),
            ),
          );
        });

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
    yield* whileHeld(
      database,
      "clear",
    )(fs.remove(staging, { recursive: true, force: true })).pipe(Effect.mapError(failed("clear")));
    yield* fs
      .makeDirectory(staging, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(failed("create")));
    yield* Layer.build(pgliteLayer({ ...options, dataDir: staging })).pipe(
      Effect.scoped,
      Effect.mapError(failed("create")),
    );
    if (yield* exists(dataDir)) {
      const entries = yield* fs.readDirectory(dataDir).pipe(Effect.mapError(failed("set aside")));
      if (entries.length === 0)
        yield* whileHeld(
          database,
          "move into place",
        )(Effect.tryPromise({ try: () => rmdir(dataDir), catch: (error) => error })).pipe(
          Effect.mapError(failed("move into place")),
        );
      else {
        const aside = `${dataDir}.unrecognised-${Date.now()}-${crypto.randomUUID()}`;
        yield* whileHeld(
          database,
          "set aside",
        )(fs.rename(dataDir, aside)).pipe(Effect.mapError(failed("set aside")));
        yield* Effect.logWarning(
          "A database directory without PG_VERSION held files; they were moved aside",
        ).pipe(Effect.annotateLogs({ database, aside: path.basename(aside) }));
      }
    }
    yield* whileHeld(
      database,
      "move into place",
    )(fs.rename(staging, dataDir)).pipe(Effect.mapError(failed("move into place")));
  });

export const persistentPgliteLayer = (dataDir: string, options: Omit<Options, "dataDir"> = {}) =>
  Layer.unwrap(
    createPgliteDatabase(dataDir, options).pipe(Effect.as(pgliteLayer({ ...options, dataDir }))),
  );
