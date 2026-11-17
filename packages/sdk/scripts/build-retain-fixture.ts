/**
 * Local-only probe of what a deploy says when its build's retain stage meets a store that refuses
 * writes to one key faster than a limit, through the SDK's own deploy path: `executor.apps.deploy`,
 * the real `appRuntime` and the real `retainWorkerBuild`, PGlite in memory, and a stub in place of
 * the compiler only. Every build links the same framework, so concurrent deploys write the same
 * framework object, as Cloud's builds did on 17 Nov (17 writes in 2 s, one refused with R2's
 * `r2.10058`, its deploy answered 422).
 *
 * The stand-in store refuses a put to a key while another put to that key is in flight or finished
 * under a second ago, as R2 does (one write a second per key), and otherwise stores it after
 * 300 ms. Prints, as JSON, each deploy's outcome and what the store saw, for
 * `build-retain-storage.spec.ts` to judge.
 *
 * - `concurrent`: 17 deploys at once.
 * - `refused`: the store refuses every write to the framework's key: the deploy fails.
 * - `source`: the app's own code does not compile: the deploy fails once, unrepeated.
 * - `ui-name`: a UI file's name holds a control character, which source paths allow and no
 *   storage key does: the deploy fails once as the app's, unrepeated.
 * - `invalid-key`: the store refuses the framework's key as invalid (HTTP 400, as R2's 10020 for
 *   a key over 1,024 bytes): the deploy fails once as the app's, unrepeated.
 */
import { Effect, Layer, Redacted, Schema, Stream } from "effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { pgliteLayer } from "fumadb-effect/pglite";
import { SqlClient } from "effect/sql";
import { BlobKey, BlobStore, BlobStoreError, type BlobStorage } from "../src/contracts/blobs.ts";
import { BuildId } from "../src/contracts/shared.ts";
import { BuiltApp, RuntimeBuildFailed } from "../src/contracts/runtime.ts";
import { CurrentActor, createExecutor, makeExecutorStorage, runtimeAdapter } from "../src/core.ts";
import { appRuntime } from "../src/implementation/app-runtime.ts";
import { memoryBlobStore } from "../src/implementation/memory-blobs.ts";
import { retainWorkerBuild } from "../src/implementation/worker-build-storage.ts";
import { markdownRefusals } from "../src/markdown.ts";
import { memoryRegistry, memoryRepositories } from "../src/testing.ts";

const cases = ["concurrent", "refused", "source", "ui-name", "invalid-key"] as const;
type Case = (typeof cases)[number];
const name = process.argv[process.argv.indexOf("--case") + 1] as Case;
if (!cases.includes(name)) throw new Error(`--case must be one of ${cases.join(", ")}`);

const writeMs = 300;
const spacingMs = 1_000;
/** What the stand-in saw of writes to the framework's key. */
const framework = { stored: 0, refused: 0, existsAnswers: [] as boolean[] };
let builds = 0;

/** A store over memory that refuses a key's writes faster than one a second, as R2 does. */
const limitedStore = (inner: BlobStorage): BlobStorage => {
  const lastWrite = new Map<string, number>();
  const isFramework = (key: string) => key.startsWith("frameworks/");
  return {
    ...inner,
    exists: (key) =>
      inner
        .exists(key)
        .pipe(
          Effect.tap((found) =>
            Effect.sync(() => (isFramework(key) ? framework.existsAnswers.push(found) : undefined)),
          ),
        ),
    put: (key, body) =>
      Effect.gen(function* () {
        const now = Date.now();
        const last = lastWrite.get(key);
        if (name === "invalid-key" && isFramework(key)) {
          framework.refused += 1;
          return yield* new BlobStoreError({ operation: "put", status: 400 });
        }
        if (
          (name === "refused" && isFramework(key)) ||
          (last !== undefined && now - last < spacingMs)
        ) {
          if (isFramework(key)) framework.refused += 1;
          return yield* new BlobStoreError({ operation: "put", status: 429 });
        }
        // The write holds the key from its start to a second after it lands.
        lastWrite.set(key, now + writeMs);
        yield* Effect.sleep(`${writeMs} millis`);
        yield* inner.put(key, body);
        lastWrite.set(key, Date.now());
        if (isFramework(key)) framework.stored += 1;
      }),
  };
};

const blobs = limitedStore(memoryBlobStore());
/** The same framework for every build, as one host release links one. */
const sharedFramework = {
  version: "0.0.1-fixture",
  modules: { "apps.js": "export const apps = 1;" },
};

/** The compiler stub: compiles instantly, then retains through the real retain stage. */
const transport = {
  name: "runtime.stub",
  loadBuild: () => Effect.die(new Error("The stub runtime keeps no builds")),
  build: () =>
    Effect.gen(function* () {
      builds += 1;
      if (name === "source")
        return yield* new RuntimeBuildFailed({
          stage: "compile",
          message: "index.ts:1:1: ERROR: Expected an expression",
        });
      const build = yield* Schema.decodeUnknownEffect(BuildId)(`bld_${crypto.randomUUID()}`).pipe(
        Effect.orDie,
      );
      yield* retainWorkerBuild(
        build,
        {
          mainModule: "index.js",
          modules: { "index.js": "export default {};" },
          database: false,
          protocol: 1,
        },
        sharedFramework,
        name === "ui-name"
          ? [
              {
                path: "assets/report\u0007.js",
                contentType: "text/javascript",
                body: new TextEncoder().encode("export {};"),
              },
            ]
          : undefined,
      ).pipe(Effect.provideService(BlobStore, blobs));
      return yield* Schema.decodeUnknownEffect(BuiltApp)({
        build,
        requirements: { accounts: { app: {}, user: {} } },
      }).pipe(Effect.orDie);
    }),
  asset: () => Effect.succeed(undefined),
  changes: () => Stream.empty,
  invoke: () => Effect.die(new Error("The stub runtime runs no tools")),
};

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const storage = yield* makeExecutorStorage({ provider: "postgresql" }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
  );
  yield* storage.migrate;
  const runtime = yield* appRuntime(transport as never);
  const executor = yield* createExecutor({
    database: storage,
    secret: Redacted.make("0".repeat(64)),
    git: memoryRepositories(),
    markdown: markdownRefusals,
    blobs,
    runtime: runtimeAdapter(runtime as never),
    registry: memoryRegistry(),
  } as never);
  const deploy = (index: number) =>
    executor.apps
      .deploy({
        owner: "local",
        name: `Retain ${index}`,
        files: [
          { path: "index.ts", content: "export default {}" },
          {
            path: "package.json",
            content: JSON.stringify({ type: "module", dependencies: { apps: "0.0.1" } }),
          },
        ],
      } as never)
      .pipe(
        Effect.match({
          onSuccess: () => ({ outcome: "deployed" as const }),
          onFailure: (error) => {
            const failure = error as unknown as Record<string, unknown>;
            return {
              outcome: "failed" as const,
              tag: failure._tag,
              stage: failure.stage,
              message: typeof failure.message === "string" ? failure.message : undefined,
            };
          },
        }),
      );
  const count = name === "concurrent" ? 17 : 1;
  const started = Date.now();
  const deploys = yield* Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    deploy,
    { concurrency: "unbounded" },
  );
  return {
    deploys,
    builds,
    framework,
    elapsedMs: Date.now() - started,
    frameworkObjects: (yield* blobs.list(
      yield* Schema.decodeUnknownEffect(BlobKey)("frameworks").pipe(Effect.orDie),
      {
        limit: 10,
      },
    )).names.length,
  };
}).pipe(Effect.provideService(CurrentActor, "local" as never));

Effect.runPromise(
  Effect.scoped(program).pipe(
    Effect.provide(
      Layer.mergeAll(pgliteLayer({}), NodeCrypto.layerSecureRandom, NodeCrypto.layerDigest),
    ),
    Effect.timeout("120 seconds"),
  ) as never,
).then(
  (result) => {
    console.log(JSON.stringify(result));
    process.exit(0);
  },
  (error) => {
    console.error(String(error).slice(0, 2000));
    process.exit(1);
  },
);
