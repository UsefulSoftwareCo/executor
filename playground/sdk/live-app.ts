import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Given a deployed live-inbox app, one caller watches and another writes. */
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import {
  createExecutor,
  makeExecutorStorage,
  OwnerId,
  type AppId,
  type ExecutorOptions,
} from "@executor-js/sdk";
import { nodeRuntime } from "@executor-js/sdk/node";
import { Effect, FileSystem, Layer, Path, Redacted } from "effect";
import { NodeServices } from "@effect/platform-node";
import { pgliteLayer } from "fumadb-effect/pglite";
import { aesGcmCredentials as credentials } from "@executor-js/sdk/core";

/** Storage belongs to the host; both clients share its connection and subscription coordinator. */
export async function liveInbox(options: ExecutorOptions, app: AppId) {
  const executor = await createExecutor(options);
  const updates = (await executor.appData.subscribe({ app, name: "listMessages", input: {} }))[
    Symbol.asyncIterator
  ]();
  try {
    const initial = await updates.next();
    const next = updates.next();
    const writer = await createExecutor(options);
    await writer.appData.mutate({
      app,
      name: "receiveMessage",
      input: { id: "hello", subject: "A live message" },
    });
    return { initial: initial.value, updated: (await next).value };
  } finally {
    await updates.return?.();
  }
}

/** Run the example with an isolated SQLite database and an actual retained app build. */
export async function liveStorageWalkthrough() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const storage = yield* makeExecutorStorage({ provider: "postgresql" });
        yield* storage.migrate;
        const credentialStore = yield* credentials(Redacted.make("ab".repeat(32)), crypto);
        const options = {
          blobs: memoryBlobStore(),
          sources: memorySourceStorage(),
          storage,
          runtime: nodeRuntime({ workDirectory: directory }),
          credentials: credentialStore,
        };
        const files = yield* Effect.forEach(["index.ts", "schema.ts"], (name) =>
          Effect.gen(function* () {
            const location = yield* path.fromFileUrl(
              new URL(`../demo-apps/live-inbox/${name}`, import.meta.url),
            );
            return { path: name, content: yield* fs.readFileString(location) };
          }),
        );
        return yield* Effect.promise(async () => {
          const executor = await createExecutor(options);
          const { app } = await executor.apps.deploy({
            owner: OwnerId.make("demo"),
            name: "Live inbox",
            files,
          });
          return liveInbox(options, app.id);
        });
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pgliteLayer()))),
    ),
  );
}
