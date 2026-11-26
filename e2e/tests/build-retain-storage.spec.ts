import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";

const Deploy = Schema.Struct({
  outcome: Schema.Literals(["deployed", "failed"]),
  tag: Schema.optional(Schema.String),
  stage: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
const PutSpan = Schema.Struct({
  kind: Schema.String,
  size: Schema.Number,
  outcome: Schema.String,
  ended: Schema.Boolean,
  keys: Schema.Array(Schema.String),
});
const Retain = Schema.Struct({
  writes: Schema.optional(Schema.Array(PutSpan)),
  sourceBytes: Schema.optional(Schema.Number),
  deploys: Schema.Array(Deploy),
  builds: Schema.Number,
  framework: Schema.Struct({
    stored: Schema.Number,
    refused: Schema.Number,
    existsAnswers: Schema.Array(Schema.Boolean),
  }),
  frameworkObjects: Schema.Number,
  elapsedMs: Schema.Number,
});
const Write = Schema.Struct({
  attempts: Schema.Number,
  outcome: Schema.String,
  elapsedMs: Schema.Number,
});
const Writes = Schema.Struct({
  "rate-limited": Write,
  internal: Write,
  unavailable: Write,
  precondition: Write,
  persistent: Write,
  "invalid-key": Write,
  statuses: Schema.Record(Schema.String, Schema.NullOr(Schema.Number)),
  attempts: Schema.Record(Schema.String, Schema.NullOr(Schema.Number)),
  framework: Schema.Struct({
    retained: Schema.Number,
    failed: Schema.Array(Schema.String),
    frameworkObjects: Schema.Number,
    attempts: Schema.Number,
    refused: Schema.Number,
    stored: Schema.Number,
    elapsedMs: Schema.Number,
  }),
});

const fixture = <S extends Schema.Codec<unknown, unknown>>(
  script: string,
  args: ReadonlyArray<string>,
  schema: S,
  evidenceName: string,
) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner,
      evidence = yield* Evidence;
    const output = yield* processes.string(
      ChildProcess.make("node", [script, ...args], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        extendEnv: false,
      }),
    );
    const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
      output.trim().split("\n").at(-1) ?? "",
    );
    yield* evidence.json(evidenceName, result);
    return result as S["Type"];
  });

const retain = (name: string) =>
  fixture(
    "packages/sdk/scripts/build-retain-fixture.ts",
    ["--case", name],
    Retain,
    `build-retain-${name}.json`,
  );

layer(TestLive, { excludeTestServices: true })("Build retain storage", (it) => {
  it.effect(scenarios.buildRetainStorage.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;
        yield* evidence.step(
          "17 concurrent deploys sharing a framework all deploy, and the framework is written once",
          Effect.gen(function* () {
            const concurrent = yield* retain("concurrent");
            expect(concurrent.deploys).toHaveLength(17);
            expect(concurrent.deploys.filter((deploy) => deploy.outcome !== "deployed")).toEqual(
              [],
            );
            expect(concurrent.builds).toBe(17);
            expect(concurrent.frameworkObjects).toBe(1);
            expect(concurrent.framework.stored).toBe(1);
            expect(concurrent.framework.refused).toBeGreaterThan(0);
            expect(concurrent.framework.existsAnswers.filter(Boolean)).toHaveLength(
              concurrent.framework.refused,
            );
          }),
        );
        yield* evidence.step(
          "a framework write refused every time answers StorageError, naming storage, not the app",
          Effect.gen(function* () {
            const refused = yield* retain("refused");
            expect(refused.deploys).toEqual([
              {
                outcome: "failed",
                tag: "StorageError",
                message: "Executor could not read or write its saved data.",
              },
            ]);
            expect(refused.frameworkObjects).toBe(0);
            expect(refused.framework.refused).toBe(1);
            expect(refused.framework.existsAnswers).toEqual([false, false, false, false, false]);
            expect(refused.elapsedMs).toBeGreaterThan(6_000);
            expect(refused.elapsedMs).toBeLessThan(12_000);
          }),
        );
        yield* evidence.step(
          "an app whose own code does not compile still answers VersionBuildFailed, built once",
          Effect.gen(function* () {
            const source = yield* retain("source");
            expect(source.deploys).toEqual([
              expect.objectContaining({
                outcome: "failed",
                tag: "VersionBuildFailed",
                stage: "compile",
              }),
            ]);
            expect(source.builds).toBe(1);
            expect(source.framework.stored + source.framework.refused).toBe(0);
          }),
        );
        yield* evidence.step(
          "a UI file name no key can hold, and a key the store refuses as invalid, answer 422 once",
          Effect.gen(function* () {
            for (const name of ["ui-name", "invalid-key"]) {
              const own = yield* retain(name);
              expect(own.deploys).toEqual([
                {
                  outcome: "failed",
                  tag: "VersionBuildFailed",
                  stage: "retain",
                  message: "App build failed at the retain stage.",
                },
              ]);
              expect(own.builds).toBe(1);
              expect(own.framework.existsAnswers).toEqual([false]);
            }
          }),
        );
        yield* evidence.step(
          "a deploy's source writes each have a span with their kind, size and outcome, not their key",
          Effect.gen(function* () {
            const traced = yield* retain("spans");
            expect(traced.deploys).toEqual([{ outcome: "deployed" }]);
            const keys = ["storage.blob.kind", "storage.blob.outcome", "storage.blob.size"];
            expect(traced.writes).toEqual([
              {
                kind: "version-source",
                size: traced.sourceBytes,
                outcome: "stored",
                ended: true,
                keys,
              },
              {
                kind: "initial-source",
                size: traced.sourceBytes,
                outcome: "stored",
                ended: true,
                keys,
              },
            ]);
          }),
        );
        const writes = yield* fixture(
          "apps/hosted/cloud/scripts/r2-write-fixture.ts",
          [],
          Writes,
          "r2-write.json",
        );
        yield* evidence.step(
          "Cloud's blob store repeats R2's rate limit and transient failures, and nothing else",
          Effect.gen(function* () {
            for (const repeated of [writes["rate-limited"], writes.internal, writes.unavailable])
              expect(repeated).toMatchObject({ attempts: 2, outcome: "stored" });
            expect(writes.precondition).toMatchObject({ attempts: 1, outcome: "failed" });
            expect(writes["invalid-key"]).toMatchObject({ attempts: 1, outcome: "failed" });
            expect(writes.persistent).toMatchObject({ attempts: 3, outcome: "failed" });
            expect(writes.statuses).toEqual({
              "r2.10020": 400,
              "r2.10058": null,
              "r2.10001": null,
            });
          }),
        );
        yield* evidence.step(
          "Cloud's write records on its span how many attempts it took",
          Effect.sync(() =>
            expect(writes.attempts).toEqual({
              "stored-at-once": 1,
              "rate-limited-once": 2,
              persistent: 3,
            }),
          ),
        );
        yield* evidence.step(
          "17 builds keep a shared framework through Cloud's write retry and the look-again together",
          Effect.gen(function* () {
            const { framework } = writes;
            expect(framework).toMatchObject({ retained: 17, failed: [], frameworkObjects: 1 });
            expect(framework.refused).toBeGreaterThan(0);
            expect(framework.stored).toBeGreaterThanOrEqual(1);
            expect(framework.stored).toBeLessThan(5);
          }),
        );
      }),
    ),
  );
});
