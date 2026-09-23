import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Storage replacement and cache loss through real SDK, filesystem and Node build boundaries. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, FileSystem, Option, Path, Redacted, Result, Schema } from "effect";
import { pgliteLayer } from "fumadb-effect/pglite";
import { BlobKey, BlobStore, BlobStoreError, memoryBlobStore } from "@executor-js/sdk/blobs";
import {
  BuildId,
  createExecutor,
  makeExecutorStorage,
  aesGcmCredentials,
  OwnerId,
  ToolName,
  toEffectRuntime,
  RuntimeBuildUnavailable,
  RuntimeBuildFailed,
} from "@executor-js/sdk/core";
import { filesystemBlobStore, nodeRuntime } from "@executor-js/sdk/node";
import { retainWorkerBuild, workerBuildAsset } from "@executor-js/sdk/workerd";

test("filesystem blobs publish complete bytes, distinguish absence and reject paths outside their root", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const directory = path.join(root, "objects");
        const blobs = filesystemBlobStore({ directory });
        const key = BlobKey.make("build/ui/asset.bin");
        assert.equal(Option.isNone(yield* blobs.get(key)), true);
        const bodies = [new Uint8Array(80_000).fill(17), new Uint8Array(80_000).fill(42)];
        yield* Effect.forEach(bodies, (body) => blobs.put(key, body), { concurrency: 2 });
        const saved = Option.getOrThrow(yield* blobs.get(key));
        assert.ok(
          bodies.some(
            (body) =>
              body.every((byte, index) => byte === saved[index]) && saved.length === body.length,
          ),
        );
        yield* blobs.remove(key);
        yield* blobs.remove(key);
        assert.equal(Option.isNone(yield* blobs.get(key)), true);
        const outside = path.join(root, "private");
        yield* fs.makeDirectory(outside);
        yield* fs.writeFileString(path.join(outside, "file"), "do not touch");
        yield* fs.symlink(outside, path.join(directory, "link"));
        const linked = BlobKey.make("link/file");
        for (const operation of [
          blobs.get(linked),
          blobs.put(linked, new Uint8Array()),
          blobs.remove(linked),
        ]) {
          const error = yield* operation.pipe(Effect.flip);
          assert.ok(Schema.is(BlobStoreError)(error));
        }
        assert.equal(yield* fs.readFileString(path.join(outside, "file")), "do not touch");
        for (const invalid of ["../outside", "/absolute", "a/../b", "a\\b", "a//b", ""])
          assert.equal(Schema.is(BlobKey)(invalid), false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  ));

const source = [
  {
    path: "index.ts",
    content: `import { query, mutation, defineApp, object } from "apps";
import { parse } from "yaml";
export default defineApp({ accounts: {} }, async (appContext) => ({  mutations: { read: mutation({ description: "Read with a retained dependency",
            input: object({}) }, async (operationContext, _input) => {
            return parse("hello: blobs");
        }) } }));
`,
  },
  { path: "package.json", content: JSON.stringify({ dependencies: { yaml: "2.8.1" } }) },
  {
    path: "ui/index.html",
    content:
      '<html><head><script type="module" src="./main.ts"></script></head><body></body></html>',
  },
  { path: "ui/main.ts", content: 'document.body.textContent = "Stored UI";' },
] as const;

test(
  "top-level blobs restore code, dependencies and UI after losing the Node working directory",
  { timeout: 60_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped();
          const work = path.join(directory, "first");
          const blobs = memoryBlobStore();
          const sources = memorySourceStorage();
          const storage = yield* makeExecutorStorage({ provider: "postgresql" });
          yield* storage.migrate;
          const credentials = yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto);
          const first = yield* createExecutor({
            storage,
            credentials,
            blobs,
            sources,
            runtime: nodeRuntime({ workDirectory: work }),
          });
          const { app, deployment } = yield* first.apps.deploy({
            owner: OwnerId.make("synthetic"),
            name: "Blob fixture",
            files: source,
          });
          const installedLink = yield* fs.readLink(
            path.join(work, deployment.build, "node_modules/.bin/yaml"),
          );
          const installedMode = (yield* fs.stat(
            path.join(work, deployment.build, "node_modules/yaml/bin.mjs"),
          )).mode;
          // No filesystem blob directory exists. The only retained authority is the supplied store.
          yield* fs.remove(work, { recursive: true });
          const next = path.join(directory, "restored");
          const runtime = nodeRuntime({ workDirectory: next });
          const second = yield* createExecutor({ storage, credentials, blobs, sources, runtime });
          const calls = yield* Effect.all(
            [1, 2].map(() =>
              second.tools.call({
                app: app.id,
                tool: ToolName.make("mutations.read"),
                input: {},
              }),
            ),
            { concurrency: 2 },
          );
          for (const result of calls) {
            assert.equal(result.status, "completed");
            if (result.status === "completed") assert.deepEqual(result.value, { hello: "blobs" });
          }
          assert.equal(
            yield* fs.readLink(path.join(next, deployment.build, "node_modules/.bin/yaml")),
            installedLink,
          );
          assert.equal(
            (yield* fs.stat(path.join(next, deployment.build, "node_modules/yaml/bin.mjs"))).mode,
            installedMode,
          );
          const bound = toEffectRuntime(runtime, blobs);
          assert.ok(bound.asset);
          const html = yield* bound.asset({ build: deployment.build, path: "index.html" });
          assert.equal(html?.contentType, "text/html");
          assert.match(new TextDecoder().decode(html?.body), /executor-ui/);

          // Revoking retained authority is not hidden by a warm materialized build.
          yield* blobs.remove(BlobKey.make(`${deployment.build}/build.json`));
          assert.ok(
            Schema.is(RuntimeBuildUnavailable)(
              yield* bound
                .call({
                  app: "synthetic-app",
                  build: deployment.build,
                  database: false,
                  accounts: Redacted.make({}),
                  tool: "mutations.read",
                  input: {},
                })
                .pipe(Effect.flip),
            ),
          );
        }),
      ).pipe(Effect.provide(pgliteLayer()), Effect.provide(NodeServices.layer)),
    ),
);

test("a failed artifact write cannot produce a successful build or committed manifest", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const stored = memoryBlobStore();
        const writes: string[] = [];
        const blobs = {
          ...stored,
          put: (key: BlobKey, body: Uint8Array) => {
            writes.push(key);
            return key.endsWith("server.tgz")
              ? Effect.fail(new BlobStoreError({ operation: "put" }))
              : stored.put(key, body);
          },
        };
        const runtime = toEffectRuntime(nodeRuntime({ workDirectory: directory }), blobs);
        const error = yield* runtime
          .build({
            files: [
              {
                path: "index.ts",
                content:
                  'import {query,mutation, defineApp } from "apps"; export default defineApp({ accounts: {} }, async (appContext) => ({   }));',
              },
            ],
          })
          .pipe(Effect.flip);
        assert.ok(Schema.is(RuntimeBuildFailed)(error));
        assert.equal(
          writes.some((key) => key.endsWith("build.json")),
          false,
        );
        assert.deepEqual(yield* fs.readDirectory(directory), []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  ));

test("Worker assets load independent objects together and still require the manifest allowlist", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const blobs = memoryBlobStore();
        const build = BuildId.make("bld_parallel_assets");
        const body = new TextEncoder().encode("export default 1;");
        yield* retainWorkerBuild(
          build,
          {
            mainModule: "server.js",
            modules: { "server.js": "private server code" },
            database: false,
          },
          [{ path: "main.js", contentType: "text/javascript", body }],
        ).pipe(Effect.provideService(BlobStore, blobs));
        const assetStarted = yield* Deferred.make<void>();
        const manifestKey = BlobKey.make(`${build}.json`);
        const assetKey = BlobKey.make(`${build}/ui/main.js`);
        const delayed = {
          ...blobs,
          get: (key: BlobKey) =>
            key === manifestKey
              ? Deferred.await(assetStarted).pipe(Effect.andThen(blobs.get(key)))
              : Deferred.succeed(assetStarted, undefined).pipe(Effect.andThen(blobs.get(key))),
        };
        const asset = yield* workerBuildAsset(build, "main.js").pipe(
          Effect.provideService(BlobStore, delayed),
          Effect.timeout("2 seconds"),
        );
        assert.deepEqual(asset?.body, body);
        assert.equal(asset?.contentType, "text/javascript");
        yield* blobs.put(
          BlobKey.make(`${build}/ui/unlisted.js`),
          new TextEncoder().encode("unlisted"),
        );
        for (const path of ["unlisted.js", "../server.js", "../../other/ui/main.js"])
          assert.equal(
            yield* workerBuildAsset(build, path).pipe(Effect.provideService(BlobStore, blobs)),
            undefined,
          );
        yield* blobs.remove(assetKey);
        const missing = yield* workerBuildAsset(build, "main.js").pipe(
          Effect.provideService(BlobStore, blobs),
          Effect.result,
        );
        assert.ok(Result.isFailure(missing) && Schema.is(RuntimeBuildUnavailable)(missing.failure));
      }),
    ),
  ));
