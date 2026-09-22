/** Initial files seed one editable Git repository independently of deployment inputs. */
import { Context, Effect, Option, Schema } from "effect";
import { BlobKey, type BlobStorage } from "../contracts/blobs.ts";
import { type AppCodeId, StorageError } from "../contracts/shared.ts";
import { SourceError, SourceFiles, type AppSourceStorage } from "../contracts/source.ts";
import { StoredApp } from "../contracts/storage.ts";
import { database, query, type Query } from "./database.ts";
import type { ExecutorDatabase } from "./storage.ts";

const initialKey = (code: AppCodeId) => BlobKey.make(`app-source/${code}/initial.json`);

/** Save the seed for a newly allocated code identity before inserting its app; never call for updates. */
export const writeInitialSource = (blobs: BlobStorage, code: AppCodeId, files: SourceFiles) =>
  blobs
    .put(initialKey(code), new TextEncoder().encode(JSON.stringify(files)))
    .pipe(Effect.mapError(() => new SourceError({ reason: "storage" })));

/** Decode the original files without requiring an existing Git repository. */
export const readInitialSource = (blobs: BlobStorage, code: AppCodeId) =>
  Effect.gen(function* () {
    const value = yield* blobs
      .get(initialKey(code))
      .pipe(Effect.mapError(() => new SourceError({ reason: "storage" })));
    if (Option.isNone(value)) return yield* new SourceError({ reason: "not-found" });
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SourceFiles))(
      new TextDecoder().decode(value.value),
    ).pipe(Effect.mapError(() => new SourceError({ reason: "invalid-source" })));
  });

/** Initialize main once, preserve an existing head, and publish readiness only after Git confirms it. */
export const initializeAppRepository = (
  db: Query,
  sources: AppSourceStorage,
  blobs: BlobStorage,
  app: Pick<StoredApp, "id" | "code" | "repository">,
) =>
  Effect.gen(function* () {
    if (app.repository !== null) return;
    const files = yield* readInitialSource(blobs, app.code);
    yield* sources
      .commit({ code: app.code, expected: null, files, message: "Create app" })
      .pipe(
        Effect.catchTag("SourceError", (error) =>
          error.reason === "conflict"
            ? sources
                .workspace(app.code)
                .pipe(
                  Effect.flatMap((head) =>
                    head === null ? Effect.fail(error) : Effect.succeed(head),
                  ),
                )
            : Effect.fail(error),
        ),
      );
    yield* query(() =>
      db.updateMany("apps", {
        where: (b) =>
          b.and(b("id", "=", app.id), b("code", "=", app.code), b("repository", "is", null)),
        set: { repository: app.code },
      }),
    );
  }).pipe(Effect.withSpan("apps.repository.initialize"));

/** Retry pending repository creation with bounded parallel work; one unavailable repository does not stop the rest. */
export const recoverAppRepositories = (options: {
  readonly database: ExecutorDatabase;
  readonly sources: AppSourceStorage;
  readonly blobs: BlobStorage;
}) =>
  Effect.gen(function* () {
    const db = database(options.database);
    const rows = yield* query(() =>
      db.findMany("apps", {
        select: ["id", "code", "repository"],
        where: (b) => b("repository", "is", null),
      }),
    );
    const pending = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          id: StoredApp.fields.id,
          code: StoredApp.fields.code,
          repository: StoredApp.fields.repository,
        }),
      ),
    )(rows).pipe(Effect.mapError(() => new StorageError()));
    yield* Effect.forEach(
      pending,
      (app) =>
        initializeAppRepository(db, options.sources, options.blobs, app).pipe(
          Effect.catch(() =>
            Effect.logWarning("App repository initialization failed", { app: app.id }),
          ),
        ),
      { concurrency: 2, discard: true },
    );
  }).pipe(Effect.withSpan("apps.repository.recover"));

/** Host-owned recovery effect; Cloud resolves request-scoped SQL inside the cron event. */
export class AppRepositoryRecovery extends Context.Service<
  AppRepositoryRecovery,
  Effect.Effect<void, StorageError>
>()("executor/AppRepositoryRecovery") {}
