/**
 * A deploy whose build cannot be kept because storage refused the write answers "try again", not
 * "your app is wrong". On 17 Nov a Cloud stage's 17 concurrent builds wrote the same framework
 * object within 2 s; R2 takes one write a second per key and refused one (`r2.10058`), and that
 * deploy answered 422, failing deployed run #1093 before any scenario ran.
 *
 * Through the SDK's own deploy path (packages/sdk/scripts/build-retain-fixture.ts: the real
 * `appRuntime` and retain stage, a compiler stub, and a store that refuses a key's writes faster
 * than one a second):
 * - 17 concurrent deploys sharing a framework all deploy; the framework is written once and every
 *   refused write is answered by the object already being there;
 * - a framework write refused every time ends with `StorageError` (500, "try again"), naming
 *   storage, not `VersionBuildFailed`;
 * - an app whose own code does not compile still gets `VersionBuildFailed` (422), built once;
 * - so does a UI file whose name no storage key can hold (a control character), and a key the
 *   store refuses as invalid (a 400, as R2's 10020 for a key over 1,024 bytes): the app's own
 *   failures at the retain stage answer 422 once, with no look-again and no repeat.
 *
 * And through Cloud's blob store write (apps/hosted/cloud/scripts/r2-write-fixture.ts): R2's
 * rate limit (10058), internal error (10001) and temporary unavailability (10043) are repeated and
 * the write lands; a failed condition (10031) and an invalid key (10020) are not repeated, and
 * the invalid key's failure keeps R2's 400; a persistent refusal stops after three attempts. And
 * 17 builds keeping their shared framework at once through that write and the retain stage's
 * look-again, against a put refusing a key's writes faster than one a second, are all kept.
 */
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
const Retain = Schema.Struct({
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

/** Runs a fixture and decodes the JSON line it ends with; its output is kept as evidence. */
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
            // Every refused write was answered by the object another build stored.
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
            // The look before the write, the refused write, then four looks for the object (at once,
            // then after 1, 2 and 4 s), none finding it: about 7 s, then the write's own failure.
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
              // Only the look before the write: no look-again after the refusal.
              expect(own.framework.existsAnswers).toEqual([false]);
            }
          }),
        );
        // One run of Cloud's write fixture: the write retry alone, and with the look-again.
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
          "17 builds keep a shared framework through Cloud's write retry and the look-again together",
          Effect.gen(function* () {
            const { framework } = writes;
            expect(framework).toMatchObject({ retained: 17, failed: [], frameworkObjects: 1 });
            // R2 takes one write a second to the key: a write or two land, the rest are refused.
            expect(framework.refused).toBeGreaterThan(0);
            expect(framework.stored).toBeGreaterThanOrEqual(1);
            expect(framework.stored).toBeLessThan(5);
          }),
        );
      }),
    ),
  );
});
