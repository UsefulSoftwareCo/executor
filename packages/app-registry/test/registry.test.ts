/** Public listings select Git source; installation owns a copy that can be edited without its publisher. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, FileSystem, Layer, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { pgliteLayer } from "fumadb-effect/pglite";
import {
  OwnerId,
  SourceFiles,
  ToolName,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
} from "@executor-js/sdk/core";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import { nodeRuntime } from "@executor-js/sdk/node";
import { gitSourceStorage } from "@executor-js/app-source";
import { nativeRepositories } from "@executor-js/app-source/node";
import {
  createAppRegistry,
  resolvePublication,
  makeRegistryStorage,
  storedRegistry,
} from "../src/index.ts";

const files = (message: string, extra: object = {}) =>
  SourceFiles.make([
    {
      path: "index.ts",
      content: `import {defineApp,object,query} from 'apps'; export default defineApp({accounts:{}},async()=>({queries:{hello:query({input:object({})},async()=>({message:${JSON.stringify(message)}}))}}));`,
    },
    {
      path: "package.json",
      content: JSON.stringify({
        name: "@fixture/example",
        description: "A shared example",
        dependencies: {},
        ...extra,
      }),
    },
  ]);
test(
  "publish a commit, install an owned copy, and rebuild it after the original is unlisted",
  { timeout: 60000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-public-app-" });
          const storage = yield* makeExecutorStorage({ provider: "postgresql" });
          yield* storage.migrate;
          const catalog = yield* makeRegistryStorage;
          yield* catalog.migrate;
          const sources = gitSourceStorage(nativeRepositories(`${directory}/repositories`));
          const executor = yield* createExecutor({
            storage,
            sources,
            blobs: memoryBlobStore(),
            credentials: yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto),
            runtime: nodeRuntime({ workDirectory: `${directory}/runtime` }),
          });
          const registry = storedRegistry(catalog, sources, "https://registry.example");
          const publisher = createAppRegistry({ storage: catalog, executor, sources });
          const owner = OwnerId.make("fixture");
          const recipient = OwnerId.make("recipient");
          const source = files("original");
          const app = yield* executor.apps.create({ owner, name: "Example", files: source });
          const first = yield* executor.apps.workspace({ owner, app: app.id });
          const preview = (
            candidate: SourceFiles,
            namespace = "fixture",
            identity = owner,
            appId = app.id,
          ) =>
            publisher.preview({
              owner: identity,
              namespace,
              app: appId,
              name: "Example",
              files: candidate,
            });
          assert.equal((yield* preview(source)).status, "ready");
          for (const [content, reason] of [
            [null, "missing-manifest"],
            ["{", "invalid-json"],
            ["{}", "missing-name"],
            ['{"name":"axiom"}', "unscoped-name"],
            ['{"name":"@fixture/Bad Name"}', "invalid-name"],
            ['{"name":"@someone/example"}', "forbidden-scope"],
            [
              JSON.stringify({ name: "@fixture/example", description: "x".repeat(2001) }),
              "invalid-metadata",
            ],
            [
              JSON.stringify({
                name: "@fixture/example",
                executor: { dependencies: { "@someone/app": "*" } },
              }),
              "unsupported-dependencies",
            ],
          ] as const) {
            const candidate = SourceFiles.make([
              source[0],
              ...(content === null ? [] : [{ path: "package.json", content }]),
            ]);
            const readiness = yield* preview(candidate);
            assert.equal(readiness.status, "blocked");
            if (readiness.status !== "blocked") throw new Error("Invalid source must be blocked");
            assert.equal(readiness.issue.reason, reason);
            assert.equal(readiness.suggestedName, "@fixture/example");
          }
          const publication = yield* publisher.publish({
            owner,
            namespace: "fixture",
            app: app.id,
            commit: first.revision.commit,
          });
          assert.equal(publication.name, "@fixture/example");
          assert.equal(publication.commit, first.revision.commit);
          assert.deepEqual(yield* registry.list(), [publication]);
          assert.deepEqual(
            yield* publisher.publish({
              owner,
              namespace: "fixture",
              app: app.id,
              commit: first.revision.commit,
            }),
            publication,
          );
          // A reserved handle still belongs to this owner after the organization is renamed.
          assert.equal((yield* preview(source, "renamed-fixture")).status, "ready");
          const ownCopy = yield* executor.apps.create({
            owner,
            name: "Example copy",
            files: source,
          });
          const conflict = yield* preview(source, "fixture", owner, ownCopy.id);
          assert.equal(conflict.status, "blocked");
          if (conflict.status !== "blocked")
            throw new Error("A second app cannot manage the first listing");
          assert.equal(conflict.issue.reason, "name-taken");
          assert.equal(conflict.suggestedName, "@fixture/example-copy");
          const ownCopySource = yield* executor.apps.workspace({ app: ownCopy.id });
          assert.equal(
            (yield* publisher
              .publish({
                owner,
                namespace: "fixture",
                app: ownCopy.id,
                commit: ownCopySource.revision.commit,
              })
              .pipe(Effect.flip)).reason,
            "conflict",
          );
          assert.deepEqual(yield* registry.list(), [publication]);
          const next = yield* executor.apps.commit({
            owner,
            app: app.id,
            expected: first.revision.commit,
            files: files("new upstream"),
            message: "Unpublished edit",
          });
          assert.deepEqual(
            (yield* registry.snapshot(publication.name, publication.commit)).files,
            source,
          );
          const installed = yield* executor.apps.copy({
            from: yield* resolvePublication(registry, {
              package: publication.name,
              commit: publication.commit,
            }),
            owner: recipient,
            name: "My copy",
          });
          assert.equal(installed.name, "My copy");
          assert.equal(installed.owner, recipient);
          assert.notEqual(installed.code, app.code);
          assert.equal(Object.hasOwn(installed, "accounts"), false);
          assert.deepEqual((yield* executor.apps.workspace({ app: installed.id })).files, source);
          assert.equal(installed.copiedFrom?.name, publication.name);
          assert.equal(installed.copiedFrom?.commit, publication.commit);
          assert.ok(installed.copiedFrom?.reference.startsWith("https://registry.example/"));
          assert.equal((yield* executor.apps.list({ owner: recipient })).length, 1);
          const wrongOwner = yield* preview(source, "recipient", recipient, installed.id);
          assert.equal(wrongOwner.status, "blocked");
          if (wrongOwner.status !== "blocked")
            throw new Error("A copied package cannot keep its publisher's handle");
          assert.equal(wrongOwner.issue.reason, "forbidden-scope");
          assert.equal(
            (yield* publisher
              .publish({
                owner: recipient,
                namespace: "recipient",
                app: installed.id,
                commit: (yield* executor.apps.workspace({ app: installed.id })).revision.commit,
              })
              .pipe(Effect.flip)).reason,
            "forbidden",
          );
          const updated = yield* publisher.publish({
            owner,
            namespace: "fixture",
            app: app.id,
            commit: next.revision.commit,
          });
          assert.equal((yield* registry.list()).length, 1);
          assert.equal(updated.commit, next.revision.commit);
          const stale = yield* registry
            .snapshot(publication.name, publication.commit)
            .pipe(Effect.flip);
          assert.equal(stale.reason, "changed");
          const denied = yield* publisher.unpublish(recipient, publication.name).pipe(Effect.flip);
          assert.equal(denied.reason, "forbidden");
          yield* publisher.unpublish(owner, publication.name);
          assert.deepEqual(yield* registry.list(), []);
          yield* executor.apps.remove({ owner, app: app.id });
          const copy = yield* executor.apps.workspace({ owner: recipient, app: installed.id });
          const edited = yield* executor.apps.commit({
            owner: recipient,
            app: installed.id,
            expected: copy.revision.commit,
            files: files("my edit"),
            message: "Edit owned copy",
          });
          const deployed = yield* executor.apps.deploy({
            owner: recipient,
            app: installed.id,
            files: edited.files,
          });
          assert.deepEqual(
            yield* executor.tools.call({
              app: installed.id,
              tool: ToolName.make("queries.hello"),
              input: {},
            }),
            { status: "completed", value: { message: "my edit" } },
          );
          assert.notEqual(deployed.app.activeDeployment, installed.activeDeployment);
          const unsupported = yield* executor.apps.create({
            owner,
            name: "Unsupported",
            files: files("dependency", { executor: { dependencies: { "@fixture/other": "*" } } }),
          });
          const head = yield* executor.apps.workspace({ app: unsupported.id });
          assert.equal(
            (yield* publisher
              .publish({
                owner,
                namespace: "fixture",
                app: unsupported.id,
                commit: head.revision.commit,
              })
              .pipe(Effect.flip)).reason,
            "unsupported-dependencies",
          );
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, pgliteLayer()))),
    ),
);
