/** Pending SQL app rows recover into Git without putting repository creation on the creation path. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { gitSourceStorage } from "@executor-js/app-source";
import { nativeRepositories } from "@executor-js/app-source/node";
import { Crypto, Effect, FileSystem, Layer, Schema } from "effect";
import { pgliteLayer } from "fumadb-effect/pglite";
import { memoryBlobStore } from "../src/blobs.ts";
import { OwnerId, SourceError, SourceFiles, makeExecutorStorage } from "../src/core.ts";
import { makeAppAuthoring } from "../src/implementation/app-authoring.ts";
import { storedApp } from "../src/implementation/apps.ts";
import { database } from "../src/implementation/database.ts";
import { readInitialSource, recoverAppRepositories } from "../src/implementation/initial-source.ts";

const files = SourceFiles.make([{ path: "index.ts", content: "initial source" }]);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-initial-source-" });
  const sources = gitSourceStorage(nativeRepositories(`${directory}/repositories`));
  const storage = yield* makeExecutorStorage({ provider: "postgresql" });
  yield* storage.migrate;
  return {
    sources,
    storage,
    db: database(storage),
    blobs: memoryBlobStore(),
    crypto: yield* Crypto.Crypto,
  };
});

test("creating source succeeds while Git is unavailable, then background recovery initializes it", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { sources, storage, db, blobs, crypto } = yield* fixture;
        const unavailable = {
          ...sources,
          commit: () => Effect.fail(new SourceError({ reason: "git" })),
        };
        const authoring = makeAppAuthoring(db, unavailable, blobs, crypto);
        const app = yield* authoring.create({
          owner: OwnerId.make("fixture"),
          name: "Pending",
          files,
        });
        assert.equal(app.repository, null);
        assert.deepEqual(yield* readInitialSource(blobs, app.code), files);
        assert.equal((yield* storedApp(db, { app: app.id })).repository, null);
        const error = yield* authoring.workspace({ app: app.id }).pipe(Effect.flip);
        assert.ok(Schema.is(SourceError)(error));
        yield* recoverAppRepositories({ database: storage, sources, blobs });
        assert.equal((yield* storedApp(db, { app: app.id })).repository, app.code);
        assert.deepEqual((yield* sources.workspace(app.code))?.files, files);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pgliteLayer()))),
  ));

test("retry after a lost Git acknowledgement preserves an existing edited head", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { sources, storage, db, blobs, crypto } = yield* fixture;
        const lostAcknowledgement = {
          ...sources,
          commit: (input: Parameters<typeof sources.commit>[0]) =>
            sources
              .commit(input)
              .pipe(Effect.andThen(Effect.fail(new SourceError({ reason: "git" })))),
        };
        const authoring = makeAppAuthoring(db, lostAcknowledgement, blobs, crypto);
        const app = yield* authoring.create({
          owner: OwnerId.make("fixture"),
          name: "Retry",
          files,
        });
        yield* authoring.workspace({ app: app.id }).pipe(Effect.flip);
        assert.equal((yield* storedApp(db, { app: app.id })).repository, null);
        const initial = yield* sources.workspace(app.code);
        assert.ok(initial);
        const edited = yield* sources.commit({
          code: app.code,
          expected: initial.revision.commit,
          files: SourceFiles.make([{ path: "index.ts", content: "later edit" }]),
          message: "Edit",
        });
        yield* recoverAppRepositories({ database: storage, sources, blobs });
        assert.equal((yield* storedApp(db, { app: app.id })).repository, app.code);
        assert.deepEqual(yield* sources.workspace(app.code), edited);
        assert.deepEqual(yield* readInitialSource(blobs, app.code), files);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pgliteLayer()))),
  ));

test("an unavailable pending repository does not block recovery of another app", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { sources, storage, db, blobs, crypto } = yield* fixture;
        const authoring = makeAppAuthoring(db, sources, blobs, crypto);
        const first = yield* authoring.create({
          owner: OwnerId.make("fixture"),
          name: "Unavailable",
          files,
        });
        const second = yield* authoring.create({
          owner: OwnerId.make("fixture"),
          name: "Ready",
          files,
        });
        const partial = {
          ...sources,
          commit: (input: Parameters<typeof sources.commit>[0]) =>
            input.code === first.code
              ? Effect.fail(new SourceError({ reason: "git" }))
              : sources.commit(input),
        };
        yield* recoverAppRepositories({ database: storage, sources: partial, blobs });
        assert.equal((yield* storedApp(db, { app: first.id })).repository, null);
        assert.equal((yield* storedApp(db, { app: second.id })).repository, second.code);
        yield* recoverAppRepositories({ database: storage, sources, blobs });
        assert.equal((yield* storedApp(db, { app: first.id })).repository, first.code);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pgliteLayer()))),
  ));
