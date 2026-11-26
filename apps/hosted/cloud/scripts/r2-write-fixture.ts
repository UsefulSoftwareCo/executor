import { BlobStore, BuildId, type BlobStorage } from "@executor-js/sdk/core";
import { retainWorkerBuild } from "@executor-js/sdk/workerd";
import { Effect, Schema, Tracer } from "effect";
import { persistR2Object, writeR2Object } from "../src/implementation/r2-write.ts";

const r2Error = (code: number) => new Error(`put: We encountered an internal error (${code})`);

const cases = {
  "rate-limited": [10058],
  internal: [10001],
  unavailable: [10043],
  precondition: [10031],
  persistent: [10058, 10058, 10058, 10058],
  "invalid-key": [10020],
} as const;

const run = (failures: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    let attempts = 0;
    const started = Date.now();
    const write = Effect.suspend(() => {
      attempts += 1;
      const code = failures[attempts - 1];
      return code === undefined ? Effect.succeed("stored") : Effect.fail(r2Error(code));
    });
    const result = yield* persistR2Object(write).pipe(Effect.result);
    return {
      attempts,
      outcome: result._tag === "Success" ? result.success : "failed",
      elapsedMs: Date.now() - started,
    };
  });

const attempts = Effect.forEach(
  [
    ["stored-at-once", []],
    ["rate-limited-once", [10058]],
    ["persistent", [10058, 10058, 10058, 10058]],
  ] as const,
  ([name, failures]) => {
    let calls = 0;
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    return writeR2Object(
      Effect.suspend(() => {
        const code = failures[calls++];
        return code === undefined ? Effect.succeed("stored") : Effect.fail(r2Error(code));
      }),
    ).pipe(
      Effect.result,
      Effect.withSpan("storage.blob.put"),
      Effect.withTracer(tracer),
      Effect.map(() => [name, spans[0]?.attributes.get("storage.blob.attempts") ?? null] as const),
    );
  },
).pipe(Effect.map((entries) => Object.fromEntries(entries)));

const statuses = Effect.forEach([10020, 10058, 10001], (code) =>
  writeR2Object(Effect.fail(r2Error(code))).pipe(
    Effect.flip,
    Effect.map((error) => [`r2.${code}`, error.status ?? null] as const),
  ),
).pipe(Effect.map((entries) => Object.fromEntries(entries)));

const framework = Effect.gen(function* () {
  const objects = new Map<string, Uint8Array>();
  const lastWrite = new Map<string, number>();
  const seen = { attempts: 0, refused: 0, stored: 0 };
  const isFramework = (key: string) => key.startsWith("frameworks/");
  const r2Put = (key: string, body: Uint8Array) =>
    Effect.gen(function* () {
      if (isFramework(key)) seen.attempts += 1;
      const last = lastWrite.get(key);
      if (last !== undefined && Date.now() - last < 1_000) {
        if (isFramework(key)) seen.refused += 1;
        return yield* Effect.fail(r2Error(10058));
      }
      lastWrite.set(key, Date.now() + 300);
      yield* Effect.sleep("300 millis");
      objects.set(key, body);
      lastWrite.set(key, Date.now());
      if (isFramework(key)) seen.stored += 1;
      return { key };
    });
  const store = {
    exists: (key) => Effect.sync(() => objects.has(key)),
    put: (key, body) => writeR2Object(r2Put(key, body)),
  } as Pick<BlobStorage, "exists" | "put"> as BlobStorage;
  const started = Date.now();
  const builds = yield* Effect.forEach(
    Array.from({ length: 17 }, (_, index) => index),
    () =>
      Effect.gen(function* () {
        const build = yield* Schema.decodeUnknownEffect(BuildId)(`bld_${crypto.randomUUID()}`);
        return yield* retainWorkerBuild(
          build,
          {
            mainModule: "index.js",
            modules: { "index.js": "export default {};" },
            database: false,
            protocol: 1,
          },
          { version: "0.0.1-fixture", modules: { "apps.js": "export const apps = 1;" } },
          undefined,
        ).pipe(Effect.provideService(BlobStore, store), Effect.result);
      }),
    { concurrency: "unbounded" },
  );
  const frameworkWrites = [...objects.keys()].filter(isFramework);
  return {
    retained: builds.filter((result) => result._tag === "Success").length,
    failed: builds
      .filter((result) => result._tag === "Failure")
      .map((result) => (result._tag === "Failure" ? String(result.failure._tag) : "")),
    frameworkObjects: frameworkWrites.length,
    ...seen,
    elapsedMs: Date.now() - started,
  };
});

Effect.runPromise(
  Effect.forEach(Object.entries(cases), ([name, failures]) =>
    run(failures).pipe(Effect.map((result) => [name, result] as const)),
  ).pipe(
    Effect.map((entries) => Object.fromEntries(entries)),
    Effect.flatMap((writes) =>
      Effect.all({ statuses, framework, attempts }).pipe(
        Effect.map((more) => ({ ...writes, ...more })),
      ),
    ),
  ),
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
