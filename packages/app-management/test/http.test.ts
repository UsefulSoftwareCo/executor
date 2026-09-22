/** Real app identities and Git HTTP share the same authorization and publication paths. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http";
import { NetAddress } from "effect/unstable/net";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { pgliteLayer } from "fumadb-effect/pglite";
import {
  App,
  OwnerId,
  SourceFiles,
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
  makeRegistryStorage,
  storedRegistry,
  remoteRegistry,
} from "@executor-js/app-registry";
import {
  AppAccess,
  AppAccessDenied,
  AppGitAccess,
  AppIdentity,
  AppManagementHost,
  AppAuthoringMetadata,
  AppSourceView,
  appManagementRoutes,
  appManagementApi,
  gitRoutes,
  registryRoutes,
} from "../src/http.ts";

const source = SourceFiles.make([
  {
    path: "index.ts",
    content: `import {defineApp,object,query} from 'apps'; export default defineApp({accounts:{}},async()=>({queries:{hello:query({description:'Say hello',input:object({})},async()=>({message:'Hello'}))}}));`,
  },
  {
    path: "package.json",
    content: JSON.stringify({ name: "@fixture/example", version: "1.0.0", dependencies: {} }),
  },
]);

test(
  "create, clone, push, deploy and publish operate on one app ID with source authorization",
  { timeout: 60000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-management-" });
          const storage = yield* makeExecutorStorage({ provider: "postgresql" });
          yield* storage.migrate;
          const packageStorage = yield* makeRegistryStorage;
          yield* packageStorage.migrate;
          const blobs = memoryBlobStore();
          const repositories = nativeRepositories(`${directory}/repositories`);
          const sources = gitSourceStorage(repositories);
          const registry = storedRegistry(packageStorage, sources, "https://registry.example");
          const executor = yield* createExecutor({
            storage,
            blobs,
            sources,
            credentials: yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto),
            runtime: nodeRuntime({ workDirectory: `${directory}/runtime` }),
          });
          const owner = OwnerId.make("fixture");
          const identity = {
            owner,
            readOwner: owner,
            scope: "fixture",
            namespace: "fixture",
            canWrite: true,
            protectedApps: [],
          };
          const access = Layer.succeed(AppAccess, (response) =>
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              if (request.headers.authorization !== "Bearer fixture")
                return yield* new AppAccessDenied({ reason: "authentication" });
              return yield* response.pipe(
                Effect.provideService(AppIdentity, {
                  ...identity,
                  canWrite: request.headers["x-fixture-role"] !== "member",
                  readOwner:
                    request.headers["x-fixture-owner"] === "other" ? OwnerId.make("other") : owner,
                }),
              );
            }),
          );
          const gitAccess = Layer.succeed(
            AppGitAccess,
            AppGitAccess.of({
              authenticate: (request, scope) =>
                request.headers.origin === undefined &&
                scope === "fixture" &&
                request.headers.authorization === `Basic ${btoa("executor:fixture")}`
                  ? Effect.succeed(identity)
                  : Effect.fail(new AppAccessDenied({ reason: "authentication" })),
            }),
          );
          const host = Layer.succeed(
            AppManagementHost,
            Effect.succeed({
              executor,
              sources,
              repositories,
              // Hosted members must not inherit local pairing's default management authority.
              access: (app: typeof App.Type, caller: { readonly canWrite: boolean }) =>
                Effect.succeed({
                  visible: true,
                  manage: caller.canWrite,
                  edit: caller.canWrite,
                  accounts: app.accounts,
                }),
              registry,
              blobs,
              publisher: createAppRegistry({ storage: packageStorage, executor, sources }),
            }),
          );
          const server = yield* HttpServer.HttpServer;
          assert.ok(NetAddress.isInetAddress(server.address));
          const origin = `http://127.0.0.1:${server.address.port}`;
          yield* server.serve(
            yield* HttpRouter.toHttpEffect(
              Layer.mergeAll(
                appManagementRoutes(appManagementApi("/api", AppAccess)),
                gitRoutes,
                registryRoutes,
              ).pipe(
                Layer.provide(access),
                HttpRouter.provideRequest(gitAccess),
                HttpRouter.provideRequest(host),
              ),
            ),
          );
          const request = (path: string, body?: object, headers?: Record<string, string>) =>
            Effect.promise(() =>
              fetch(origin + path, {
                method: body === undefined ? "GET" : "POST",
                headers: {
                  authorization: "Bearer fixture",
                  "content-type": "application/json",
                  ...headers,
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              }),
            );
          const json = (path: string, body?: object) =>
            request(path, body).pipe(
              Effect.flatMap((response) =>
                Effect.promise(async () => {
                  assert.equal(response.status, 200, await response.clone().text());
                  return response.json();
                }),
              ),
            );
          const app = yield* json("/api/apps/drafts", { name: "Example", files: source }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(App))),
          );
          assert.equal(app.activeDeployment, null);
          // Materialize the lazy Git repository before making it unavailable.
          const view = yield* json(`/api/apps/${app.id}/workspace`).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(AppSourceView)),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                fs.rename(`${directory}/repositories`, `${directory}/repositories-unavailable`),
                () =>
                  fs
                    .rename(`${directory}/repositories-unavailable`, `${directory}/repositories`)
                    .pipe(Effect.orDie),
              );
              const metadata = yield* json(`/api/apps/${app.id}/authoring`).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(AppAuthoringMetadata)),
              );
              assert.deepEqual(metadata, {
                namespace: "fixture",
                gitPath: "/git/fixture/example.git",
                canEdit: true,
                canPublish: true,
              });
            }),
          );
          assert.equal(
            (yield* request(`/api/apps/${app.id}/authoring`, undefined, {
              "x-fixture-role": "member",
            })).status,
            403,
          );
          assert.equal(
            (yield* request(`/api/apps/${app.id}/authoring`, undefined, {
              "x-fixture-owner": "other",
            })).status,
            404,
          );
          assert.equal(view.publication?.status, "ready");
          assert.equal(view.gitPath, "/git/fixture/example.git");
          assert.deepEqual(yield* json(`/api/apps/${app.id}/git`), { path: view.gitPath });
          yield* executor.apps.create({
            owner: OwnerId.make("other"),
            name: "Example",
            files: SourceFiles.make([
              ...source,
              { path: "README.md", content: "Private other-owner source" },
            ]),
          });
          assert.equal(
            (yield* request(`/api/apps/${app.id}/workspace`, undefined, {
              "x-fixture-role": "member",
            })).status,
            403,
          );
          const foreign = yield* request(`/api/apps/${app.id}/workspace`, undefined, {
            "x-fixture-owner": "other",
          });
          assert.equal(foreign.status, 404);
          assert.equal((yield* Effect.promise(() => foreign.text())).includes("Say hello"), false);
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const git = (args: ReadonlyArray<string>) =>
            Effect.scoped(
              Effect.gen(function* () {
                const child = yield* spawner.spawn(
                  ChildProcess.make("git", args, {
                    stdout: "ignore",
                    stderr: "ignore",
                    extendEnv: true,
                    env: {
                      GIT_TERMINAL_PROMPT: "0",
                      GIT_CONFIG_GLOBAL: "/dev/null",
                      GIT_CONFIG_NOSYSTEM: "1",
                    },
                  }),
                );
                return Number(yield* child.exitCode);
              }),
            );
          const remote = origin + view.gitPath;
          const checkout = `${directory}/example`;
          assert.notEqual(yield* git(["clone", remote, `${directory}/denied`]), 0);
          const auth = ["-c", `http.extraHeader=Authorization: Basic ${btoa("executor:fixture")}`];
          assert.equal(yield* git(["-C", directory, ...auth, "clone", remote]), 0);
          assert.equal(yield* fs.readFileString(`${checkout}/index.ts`), source[0]?.content);
          assert.equal(yield* fs.exists(`${checkout}/README.md`), false);
          yield* fs.writeFileString(`${checkout}/README.md`, "Edited through normal Git.\n");
          assert.equal(yield* git(["-C", checkout, "add", "README.md"]), 0);
          assert.equal(
            yield* git([
              "-C",
              checkout,
              "-c",
              "user.name=Example",
              "-c",
              "user.email=example@example.test",
              "commit",
              "-m",
              "Local edit",
            ]),
            0,
          );
          assert.equal(yield* git(["-C", checkout, ...auth, "push", "origin", "main"]), 0);
          const edited = yield* json(`/api/apps/${app.id}/workspace`).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(AppSourceView)),
          );
          assert.notEqual(edited.revision.commit, view.revision.commit);
          assert.equal((yield* executor.apps.get({ owner, app: app.id })).activeDeployment, null);
          const history: unknown = yield* json(`/api/apps/${app.id}/history`);
          assert.ok(Array.isArray(history) && history.length === 2);
          yield* json(`/api/apps/${app.id}/deploy`, {
            commit: edited.revision.commit,
          });
          assert.ok((yield* executor.apps.get({ owner, app: app.id })).activeDeployment);
          yield* json(`/api/apps/${app.id}/publication`, { commit: edited.revision.commit });
          const releases = yield* Effect.promise(() => fetch(origin + "/api/registry/apps"));
          assert.equal(releases.status, 200);
          const remoteCatalog = remoteRegistry(origin);
          const installed = yield* json("/api/apps/copies", {
            from: { package: "@fixture/example", commit: edited.revision.commit },
            name: "Installed copy",
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(App))));
          assert.notEqual(installed.code, app.code);
          const snapshot = yield* remoteCatalog.snapshot(
            "@fixture/example",
            edited.revision.commit,
          );
          assert.ok(snapshot.files.some((file) => file.path === "README.md"));
          yield* json("/api/app-publications/unpublish", { package: "@fixture/example" });
          const missing = yield* remoteCatalog
            .snapshot("@fixture/example", edited.revision.commit)
            .pipe(Effect.flip);
          assert.equal(missing.reason, "not-found");
          const installedTool = (yield* executor.tools.list({ app: installed.id })).items[0];
          assert.ok(installedTool);
          assert.deepEqual(
            yield* executor.tools.call({
              app: installed.id,
              tool: installedTool.name,
              input: {},
            }),
            { status: "completed", value: { message: "Hello" } },
          );

          assert.notEqual(yield* git(["clone", remote, `${directory}/still-private`]), 0);
          const tools = yield* executor.tools.list({ app: app.id });
          const tool = tools.items[0];
          assert.ok(tool);
          assert.deepEqual(
            yield* executor.tools.call({ app: app.id, tool: tool.name, input: {} }),
            { status: "completed", value: { message: "Hello" } },
          );
        }),
      ).pipe(
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpServer.layerTest, pgliteLayer())),
      ),
    ),
);
