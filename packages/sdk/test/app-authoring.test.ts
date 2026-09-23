/** Draft, authoring, and deployed behavior use one app identity and real Git storage. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { pgliteLayer } from "fumadb-effect/pglite";
import { gitSourceStorage } from "@executor-js/app-source";
import { nativeRepositories } from "@executor-js/app-source/node";
import { memoryBlobStore } from "../src/blobs.ts";
import { nodeRuntime } from "../src/node.ts";
import {
  AppNotDeployed,
  OwnerId,
  SourceError,
  SourceFiles,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
} from "../src/core.ts";

const source = (message: string) =>
  SourceFiles.make([
    {
      path: "index.ts",
      content: `import {defineApp,object,query} from 'apps'; export default defineApp({accounts:{}},async()=>({queries:{hello:query({description:'Say hello',input:object({})},async()=>({message:${JSON.stringify(message)}}))}}));`,
    },
  ]);

test("drafts deploy in place, edits stay inactive, and copies use running source and independent history", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-app-authoring-" });
        const repos = nativeRepositories(`${directory}/repositories`);
        const sources = gitSourceStorage(repos);
        const storage = yield* makeExecutorStorage({ provider: "postgresql" });
        yield* storage.migrate;
        const executor = yield* createExecutor({
          storage,
          sources,
          blobs: memoryBlobStore(),
          credentials: yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto),
          runtime: nodeRuntime({ workDirectory: `${directory}/runtime` }),
        });
        const owner = OwnerId.make("fixture");
        const draft = yield* executor.apps.create({
          owner,
          name: "Draft",
          files: SourceFiles.make([{ path: "index.ts", content: "unfinished code" }]),
        });
        assert.equal(draft.activeDeployment, null);
        assert.ok((yield* executor.apps.list({ owner })).some((app) => app.id === draft.id));
        assert.ok(
          Schema.is(AppNotDeployed)(
            yield* executor.tools.list({ app: draft.id }).pipe(Effect.flip),
          ),
        );
        const initial = yield* executor.apps.workspace({ owner, app: draft.id });
        const edited = yield* executor.apps.commit({
          owner,
          app: draft.id,
          expected: initial.revision.commit,
          files: source("First"),
          message: "Finish app",
        });
        const stale = yield* executor.apps
          .commit({
            owner,
            app: draft.id,
            expected: initial.revision.commit,
            files: source("Stale"),
            message: "Stale edit",
          })
          .pipe(Effect.flip);
        assert.ok(Schema.is(SourceError)(stale));
        assert.equal(stale.reason, "conflict");
        const deployed = yield* executor.apps.deploy({
          owner,
          app: draft.id,
          commit: edited.revision.commit,
        });
        assert.equal(deployed.app.id, draft.id);
        assert.equal(deployed.deployment.sourceCommit, edited.revision.commit);
        const head = yield* executor.apps.workspace({ owner, app: draft.id });
        yield* executor.apps.commit({
          owner,
          app: draft.id,
          expected: head.revision.commit,
          files: source("Draft changes"),
          message: "Edit without deploying",
        });
        const pinned = yield* executor.apps.deploy({
          owner,
          app: draft.id,
          commit: head.revision.commit,
        });
        assert.equal(pinned.deployment.sourceCommit, head.revision.commit);
        assert.deepEqual(
          (yield* executor.apps.workspace({ app: draft.id })).files,
          source("Draft changes"),
        );
        const tools = yield* executor.tools.list({ app: draft.id });
        const hello = tools.items[0];
        assert.ok(hello);
        assert.deepEqual(
          yield* executor.tools.call({ app: draft.id, tool: hello.name, input: {} }),
          { status: "completed", value: { message: "First" } },
        );
        const fork = yield* executor.apps.copy({ owner, from: draft.id, name: "Fork" });
        assert.notEqual(fork.code, draft.code);
        assert.notEqual(fork.activeDeployment, null);
        assert.notEqual(fork.activeDeployment, deployed.deployment.id);
        assert.deepEqual(fork.copiedFrom, {
          reference: `app:${draft.id}`,
          name: "Draft",
          commit: deployed.deployment.sourceCommit,
        });
        assert.equal(Object.hasOwn(fork, "accounts"), false);
        assert.deepEqual(
          (yield* executor.apps.workspace({ owner, app: fork.id })).files,
          source("First"),
        );
        assert.ok(
          Schema.is(SourceError)(
            yield* repos.read(fork.code, initial.revision.commit).pipe(Effect.flip),
          ),
        );
        const unfinished = yield* executor.apps.create({
          owner,
          name: "Unfinished",
          files: initial.files,
        });
        const saved = yield* executor.apps.copy({ owner, from: unfinished.id, name: "Saved copy" });
        assert.equal(saved.activeDeployment, null);
        assert.notEqual(saved.code, unfinished.code);
        assert.deepEqual((yield* executor.apps.workspace({ app: saved.id })).files, initial.files);
        const renamed = yield* executor.apps.rename({ app: fork.id, name: "Renamed copy" });
        assert.deepEqual(renamed.copiedFrom, fork.copiedFrom);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pgliteLayer()))),
  ));
