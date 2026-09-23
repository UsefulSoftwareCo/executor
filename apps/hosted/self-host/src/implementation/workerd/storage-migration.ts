/** Import the previous native PostgreSQL directory without mutating its backup. */
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { Effect, Schema } from "effect";
import { PgliteFilesystem } from "./pglite-filesystem.ts";

/** Only the trusted product actor receives access to the old product directory. */
export interface LegacyDatabase {
  readonly fetch: (request: Request) => Promise<Response>;
}

/** A failed import never opens a replacement empty product database. */
export class StorageMigrationFailed extends Schema.TaggedError<StorageMigrationFailed>()(
  "StorageMigrationFailed",
  { reason: Schema.Literals(["source", "version", "incomplete", "storage"]) },
) {}

const Directory = Schema.Array(
  Schema.Struct({
    name: Schema.String.check(
      Schema.isPattern(/^[^/\\\0]+$/),
      Schema.makeFilter((name) => name !== "." && name !== ".."),
    ),
    type: Schema.Literals(["file", "directory"]),
  }),
);
const Journal = Schema.Struct({
  version: Schema.Literal(1),
  phase: Schema.Literals(["copying", "initializing", "imported", "ready"]),
  files: Schema.Int,
  bytes: Schema.Int,
});

const journalKey = "executor.postgres-migration.v1";
const failure = (reason: StorageMigrationFailed["reason"]) =>
  new StorageMigrationFailed({ reason });
const diskUrl = (path: string) =>
  `http://legacy.internal/${path.split("/").map(encodeURIComponent).join("/")}`;

/**
 * Retry only an unfinished bootstrap. A completed import is immutable, and normal
 * opens never read the legacy directory again. The host holds the exclusive
 * product volume lock while this operation runs. Motel is not involved.
 */
export const prepareProductFilesystem = (storage: DurableObjectStorage, legacy: LegacyDatabase) =>
  Effect.gen(function* () {
    const fs = new PgliteFilesystem(storage);
    const saved = yield* Effect.tryPromise({
      try: () => storage.get<unknown>(journalKey),
      catch: () => failure("storage"),
    });
    const journal =
      saved === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(Journal)(saved).pipe(
            Effect.mapError(() => failure("storage")),
          );
    if (journal?.phase === "ready") return fs;
    // No application writes are admitted before ready. An interrupted copy/initdb
    // can therefore restart, but partial bytes can never be treated as a database.
    fs.resetBootstrap();
    const request = (path: string) =>
      Effect.tryPromise({
        try: async () => {
          const response = await legacy.fetch(new Request(diskUrl(path)));
          if (!response.ok) throw new Error("Legacy database read failed");
          return response;
        },
        catch: () => failure("source"),
      });
    const listing = (path: string) =>
      request(path).pipe(
        Effect.flatMap((response) =>
          Effect.tryPromise({ try: () => response.json(), catch: () => failure("source") }),
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(Directory)),
        Effect.mapError(() => failure("source")),
      );
    const root = yield* listing("");
    if (root.length === 0) {
      yield* Effect.tryPromise({
        try: async () => {
          await storage.put(journalKey, { version: 1, phase: "initializing", files: 0, bytes: 0 });
          await storage.sync();
        },
        catch: () => failure("storage"),
      });
      return fs;
    }
    if (!root.some((entry) => entry.name === "PG_VERSION" && entry.type === "file"))
      return yield* failure("incomplete");
    const version = yield* request("PG_VERSION").pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.text(),
          catch: () => failure("source"),
        }),
      ),
    );
    if (version.trim() !== "18") return yield* failure("version");
    yield* Effect.tryPromise({
      try: async () => {
        await storage.put(journalKey, { version: 1, phase: "copying", files: 0, bytes: 0 });
        await storage.sync();
      },
      catch: () => failure("storage"),
    });
    let files = 0,
      bytes = 0;
    const copy = (
      path: string,
      entries: typeof Directory.Type,
    ): Effect.Effect<void, StorageMigrationFailed> =>
      Effect.gen(function* () {
        for (const entry of entries) {
          const name = path === "" ? entry.name : `${path}/${entry.name}`;
          if (entry.type === "directory") {
            fs.mkdir(name);
            yield* copy(name, yield* listing(name));
            continue;
          }
          const response = yield* request(name);
          const expected = Number(response.headers.get("content-length"));
          if (
            !response.headers.has("content-length") ||
            !Number.isSafeInteger(expected) ||
            expected < 0 ||
            response.body === null
          )
            return yield* failure("source");
          const body = response.body;
          yield* Effect.tryPromise({
            try: async () => {
              const descriptor = fs.open(name, "wx");
              const reader = body.getReader();
              let position = 0;
              try {
                for (;;) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  fs.write(descriptor, chunk.value, 0, chunk.value.byteLength, position);
                  const stored = new Uint8Array(chunk.value.byteLength);
                  if (
                    fs.read(descriptor, stored, 0, stored.byteLength, position) !==
                      stored.byteLength ||
                    stored.some((value, index) => value !== chunk.value[index])
                  )
                    throw new Error("Import verification failed");
                  position += chunk.value.byteLength;
                  if (position > expected) throw new Error("Source file grew during import");
                }
                if (position !== expected) throw new Error("Incomplete source file");
                files += 1;
                bytes += position;
              } finally {
                fs.close(descriptor);
                await reader.cancel();
                reader.releaseLock();
              }
            },
            catch: () => failure("incomplete"),
          });
        }
      });
    yield* copy("", root);
    // PostgreSQL's cluster control and catalog directories must exist; initdb
    // must never quietly replace an incomplete old cluster.
    for (const required of ["global/pg_control", "base", "pg_wal"]) {
      yield* Effect.try({ try: () => fs.lstat(required), catch: () => failure("incomplete") });
    }
    yield* Effect.tryPromise({
      try: async () => {
        await fs.syncToFs();
        await storage.put(journalKey, { version: 1, phase: "imported", files, bytes });
        await storage.sync();
      },
      catch: () => failure("storage"),
    });
    return fs;
  });

/** Persist the completion marker only after PostgreSQL has opened and flushed successfully. */
export const completeProductBootstrap = (storage: DurableObjectStorage) =>
  Effect.gen(function* () {
    const saved = yield* Effect.tryPromise({
      try: () => storage.get(journalKey),
      catch: () => failure("storage"),
    });
    const journal = yield* Schema.decodeUnknownEffect(Journal)(saved).pipe(
      Effect.mapError(() => failure("storage")),
    );
    if (journal.phase === "copying") return yield* failure("incomplete");
    if (journal.phase === "ready") return;
    yield* Effect.tryPromise({
      try: async () => {
        await storage.sync();
        await storage.put(journalKey, { ...journal, phase: "ready" });
        await storage.sync();
      },
      catch: () => failure("storage"),
    });
  });
