import { Effect, Exit, FileSystem, Option, Path, Schema, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientRequest } from "effect/http";
import { acquisitionAppSource } from "./acquisition-product.ts";
import { appsManifest } from "./apps-release.ts";
import { lockedNpmRegistry } from "./npm-registry.ts";
import { Target } from "./platform.ts";
import { serverControl } from "./server-control.ts";

const Ready = Schema.Struct({
  port: Schema.Number,
  owner: Schema.String,
  app: Schema.String,
  provider: Schema.String,
});
const Checks = Schema.Struct({ count: Schema.Number });
const program = `import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { nativeRepositories, systemGit } from "@executor-js/app-source/node";
import {
  createExecutor, makeExecutorStorage, executorHandlers, requestRejections, ExecutorApi, OwnerId, AppId, ProviderId, StorageError,
  type Executor, type ExecutorOptions, type ResourceLifecycle,
} from "@executor-js/sdk/core";
import { accountAcquisitionDriver } from "@executor-js/sdk";
import { filesystemBlobStore, workerdApps } from "@executor-js/sdk/node";
import { memoryRegistry } from "@executor-js/sdk/testing";
import { InteractiveStart, InteractiveStatus, HostOperationFailed } from "apps/contracts";
import { Console, Deferred, Effect, Layer, Path, Redacted, Ref, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { pgliteLayer } from "fumadb-effect/pglite";
import { createServer } from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Runtime from "@effect/platform-node/NodeRuntime";
import { FetchHttpClient, HttpServerResponse } from "effect/http";

const input = INPUT;
const backendOrigin = input.backendOrigin;
Runtime.runMain(Effect.scoped(Effect.gen(function* () {

  const path = yield* Path.Path;
  const directory = input.directory;
  const database = yield* Layer.build(pgliteLayer({ dataDir: input.database }));
  const storage = yield* makeExecutorStorage({ provider: "postgresql" }).pipe(Effect.provideContext(database));
  yield* storage.migrate;
  const secret = Redacted.make("a".repeat(64));
  const blobs = filesystemBlobStore({ directory: path.join(directory, "blobs") });
  const ready = yield* Deferred.make<Executor>();
  const host = yield* workerdApps({
    directory: path.join(directory, "workerd"), blobs, executor: Deferred.await(ready),
    npmRegistry: input.npmRegistry, encryptionKey: secret, allowPrivateAppFetch: true,
  });
  const retireChecks = yield* Ref.make(0);
  const hooks: ResourceLifecycle = {
    userLinks: () => Effect.succeed([]), appLinks: () => Effect.succeed([]),
    sourceActorLost: () => Effect.void,
    appResolving: (_app, accounts) => Effect.succeed(new Set(accounts.map((a) => a.id))),
    removalResolving: (_app, accounts) => Effect.succeed(new Set(accounts.map((a) => a.id))),
    accountsResolving: (accounts) => Effect.succeed(new Set(accounts.map((a) => a.id))),
    connectionCompleting: () => Effect.void, appCreated: () => Effect.void,
    appRemoving: () => Effect.void, appAccountConnected: () => Effect.void,
    accountCreated: () => Effect.void, accountRemoving: () => Effect.void,
    accountRetiring: () => Ref.update(retireChecks, (n) => n + 1).pipe(Effect.andThen(Effect.fail(new StorageError()))),
  };
  const options: ExecutorOptions = {
    database: storage, secret, blobs, git: nativeRepositories(path.join(directory, "repositories"), systemGit),
    runtime: host.runtime, workflows: host.workflows, registry: memoryRegistry(), hooks,
  };
  const initial = yield* createExecutor(options).pipe(Effect.provide(NodeCrypto.layer));
  yield* Deferred.succeed(ready, initial);
  const owner = OwnerId.make("purge-owner-first");
  const files = input.files;
  const configured = input.app.length === 0
    ? yield* initial.apps.deploy({ owner, name: "Owner purge manager", files }).pipe(
        Effect.map(({ app }) => ({ app: app.id, provider: app.requirements.accounts.identity!.provider })))
    : { app: AppId.make(input.app), provider: ProviderId.make(input.provider) };
  const provider = configured.provider;
  const call = async <A, I>(context: import("@executor-js/sdk/core").AccountAcquisitionContext,
    step: string, schema: Schema.Codec<A, I>, data: object = {}) => {
    const response = await context.fetch(\`\${backendOrigin}/connect\`, {
      method: "POST", signal: context.signal,
      headers: { authorization: "Bearer synthetic-backend-key", "content-type": "application/json" },
      body: JSON.stringify({ step, method: context.method, caller: context.owner, operation: context.operation, ...data }),
    });
    if (!response.ok) throw new HostOperationFailed({});
    return Schema.decodeUnknownSync(schema)(await response.json());
  };
  const driver = accountAcquisitionDriver({
    id: "synthetic-purge-driver", revision: "purge-r1",
    start: (ctx) => call(ctx, "start", InteractiveStart),
    status: (ctx, input) => call(ctx, "status", InteractiveStatus, input),
    submit: (ctx, input) => call(ctx, "submit", InteractiveStatus, input),
    cancel: async (ctx, input) => { await call(ctx, "cancel", Schema.Null, input); },
    remove: async (ctx) => { await call(ctx, "remove", Schema.Null, { ref: Redacted.value(ctx.reference) }); },
  });
  const executor = yield* createExecutor({ ...options,
    acquisition: { registrations: [{ provider, method: "paste", current: true, driver, fetch: globalThis.fetch }] },
  }).pipe(Effect.provide(NodeCrypto.layer));
  const routes = Layer.mergeAll(
    HttpApiBuilder.layer(ExecutorApi).pipe(Layer.provide(executorHandlers(executor)), Layer.provide(requestRejections)),
    HttpRouter.add("GET", "/_fixture/retire-checks", Effect.gen(function* () {
      return yield* HttpServerResponse.json({ count: yield* Ref.get(retireChecks) });
    })),
  );
  const services = yield* Layer.build(HttpRouter.serve(routes, {
    disableLogger: true, disableListenLog: true,
  }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))));
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("SDK fixture must listen on TCP");
  yield* Console.log(JSON.stringify({ port: server.address.port, owner, app: configured.app, provider }));
  return yield* Effect.never;
})).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))));
`;

/** Run the complete public SDK HTTP host in its own process with real PostgreSQL, Git and workerd adapters. */
export const acquisitionSdk = (backendOrigin: string) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const client = yield* HttpClient.HttpClient;
    const files = [
      { path: "index.ts", content: acquisitionAppSource(backendOrigin) },
      appsManifest,
    ] as const;
    const registry = yield* lockedNpmRegistry;
    const entry = path.join(target.directory, "owner-purge-sdk.ts");
    const parentScope = yield* Scope.Scope;
    yield* serverControl("stop");
    // The runner owns this database and its declared storage-fault writes between generations.
    yield* Effect.addFinalizer(() => serverControl("start").pipe(Effect.orDie));
    let ready: typeof Ready.Type | undefined;
    let current: { readonly scope: Scope.Closeable; readonly origin: string } | undefined;
    let priorChecks = 0;
    const input = {
      directory: path.join(target.directory, "owner-purge-sdk"),
      database: path.join(target.directory, "data", "hosted.pglite"),
      backendOrigin,
      npmRegistry: registry.url,
      files,
    };
    const packages = path.join(target.directory, "node_modules");
    yield* fs.makeDirectory(packages, { recursive: true });
    yield* fs.makeDirectory(path.join(packages, "@executor-js"), { recursive: true });
    yield* fs.symlink(path.resolve("packages/apps"), path.join(packages, "apps"));
    yield* fs.symlink(
      path.resolve("packages/app-source"),
      path.join(packages, "@executor-js/app-source"),
    );
    yield* fs.symlink(
      path.resolve("packages/sdk/node_modules/fumadb-effect"),
      path.join(packages, "fumadb-effect"),
    );
    const config = path.join(target.directory, "owner-purge-sdk-tsconfig.json");
    yield* fs.writeFileString(
      config,
      JSON.stringify({
        extends: path.resolve("tsconfig.json"),
        compilerOptions: { typeRoots: [path.resolve("node_modules/@types")] },
        files: [entry],
        include: [],
        exclude: [],
      }),
    );
    const start = Effect.gen(function* () {
      if (current !== undefined) return;
      const source = program.replace(
        "INPUT",
        JSON.stringify({
          ...input,
          app: ready?.app ?? "",
          provider: ready?.provider ?? "",
        }) + " as const",
      );
      yield* fs.writeFileString(entry, source);
      if (ready === undefined) {
        const checked = yield* processes.exitCode(
          ChildProcess.make(path.resolve("node_modules/.bin/tsc-rs"), ["--noEmit", "-p", config], {
            stdout: "inherit",
            stderr: "inherit",
          }),
        );
        if (checked !== 0) return yield* Effect.die("Public SDK host entry failed its typecheck");
      }
      const scope = yield* Scope.fork(parentScope);
      const child = yield* processes
        .spawn(ChildProcess.make("node", [entry], { stdout: "pipe", stderr: "inherit" }))
        .pipe(Scope.provide(scope));
      const line = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.startsWith('{"port":')),
        Stream.runHead,
      );
      if (Option.isNone(line)) return yield* Effect.die("Public SDK host exited before listening");
      ready = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Ready))(line.value);
      current = { scope, origin: `http://127.0.0.1:${ready.port}` };
      return ready;
    });
    const request = (method: "GET" | "POST" | "DELETE", route: string, data?: unknown) =>
      Effect.gen(function* () {
        if (current === undefined) return yield* Effect.die("The SDK host is stopped");
        const base = HttpClientRequest.make(method)(current.origin + route);
        const configured =
          data === undefined ? base : yield* HttpClientRequest.bodyJson(data)(base);
        const response = yield* client.execute(configured);
        const text = yield* response.text;
        const body = text.length
          ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text)
          : null;
        return { status: response.status, body };
      });
    const generationChecks = request("GET", "/_fixture/retire-checks").pipe(
      Effect.flatMap((r) => Schema.decodeUnknownEffect(Checks)(r.body)),
      Effect.map((r) => r.count),
    );
    const stop = Effect.gen(function* () {
      if (current === undefined) return;
      priorChecks += yield* generationChecks;
      const { scope } = current;
      current = undefined;
      yield* Scope.close(scope, Exit.void);
    });
    const initial = yield* start;
    if (initial === undefined) return yield* Effect.die("SDK host did not start");
    return {
      owner: initial.owner,
      app: initial.app,
      files,
      request,
      start,
      stop,
      retireChecks: generationChecks.pipe(Effect.map((count) => priorChecks + count)),
    };
  });
