/**
 * A failed case's evidence keeps the trace of every request it sent, with the server's spans: the
 * failing request whether it failed in the test, in its cleanup or in an acquisition, behind
 * unanswered, refused, background or cleanup requests. Past its trace budget it leaves out the
 * oldest traces, and past its collection deadline it lists the oldest as not read. The cases in
 * e2e/failure-evidence fail on purpose, so they run in their own Vitest process with a run
 * directory of their own, and this scenario reads the results and evidence they leave there.
 */
import { expect, layer } from "@effect/vitest";
import { Config, Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { SpanQuery } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";
import {
  caseDeadlineMs,
  failureCases,
  probePath,
  slowTraceRead,
} from "../failure-evidence/titles.ts";

const Results = Schema.Struct({
  testResults: Schema.Array(
    Schema.Struct({
      assertionResults: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          status: Schema.String,
          failureMessages: Schema.Array(Schema.String),
        }),
      ),
    }),
  ),
});
const CaseResult = Schema.Struct({
  title: Schema.String,
  status: Schema.Literals(["passed", "failed"]),
  duration: Schema.Number,
  errors: Schema.Array(Schema.String),
});
const Rows = Schema.Array(Schema.Struct({ path: Schema.String, traceId: Schema.String }));
const TraceIds = Schema.Struct({
  state: Schema.Literals(["complete", "partial"]),
  failure: Schema.Array(Schema.String),
  dropped: Schema.Array(Schema.String),
  unfetched: Schema.Array(Schema.String),
});
const Telemetry = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    kept: Schema.Array(Schema.String),
    data: Schema.optionalKey(SpanQuery.fields.data),
    error: Schema.optionalKey(Schema.String),
  }),
);
const Lifecycle = Schema.Struct({ title: Schema.String, cleanupMs: Schema.NullOr(Schema.Number) });

layer(TestLive, { excludeTestServices: true })("Failure evidence", (it) => {
  it.effect(
    scenarios.failureEvidence.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const target = yield* Target,
            fs = yield* FileSystem.FileSystem,
            path = yield* Path.Path,
            evidence = yield* Evidence,
            processes = yield* ChildProcessSpawner.ChildProcessSpawner,
            http = yield* HttpClient.HttpClient;
          const run = path.join(target.directory, "failure-cases");
          yield* fs.makeDirectory(run, { recursive: true, mode: 0o700 });
          yield* fs.copyFile(
            path.join(yield* Config.String("EXECUTOR_E2E_RUN"), "run.json"),
            path.join(run, "run.json"),
          );
          const exitCode = yield* evidence.step(
            "Run the failing cases",
            processes.exitCode(
              ChildProcess.make(
                "node",
                [
                  "node_modules/vitest/vitest.mjs",
                  "run",
                  "--config",
                  "e2e/failure-evidence/vitest.config.ts",
                ],
                { env: { EXECUTOR_E2E_RUN: run }, extendEnv: true, stdout: "inherit" },
              ),
            ),
          );
          const read = <S extends Schema.Codec<unknown>>(schema: S, file: string) =>
            fs
              .readFileString(file)
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))));
          const results = new Map(
            (yield* read(Results, path.join(run, "results.json"))).testResults
              .flatMap((file) => file.assertionResults)
              .map((result) => [result.title, result]),
          );
          yield* evidence.json(
            "failure-cases.json",
            [...results.values()].map(({ title, status }) => ({ title, status })),
          );
          expect(Number(exitCode), "the cases fail on purpose").toBe(1);
          const folders = path.join(run, "report/evidence");
          const cases = new Map<string, string>();
          for (const name of yield* fs.readDirectory(folders)) {
            const result = yield* read(CaseResult, path.join(folders, name, "result.json"));
            cases.set(result.title, path.join(folders, name));
          }
          // Each probe's path names its role, so traces are compared by role.
          const kept = (title: string) =>
            Effect.gen(function* () {
              const folder = cases.get(title);
              if (folder === undefined)
                return yield* Effect.die(`The case "${title}" left no evidence`);
              const rows = [
                ...(yield* read(Rows, path.join(folder, "requests.json"))),
                ...(yield* read(Rows, path.join(folder, "unanswered-requests.json"))),
              ];
              const role = (traceId: string) =>
                rows.find((row) => row.traceId === traceId)?.path.replace(probePath(""), "");
              const telemetry = yield* read(Telemetry, path.join(folder, "telemetry.json"));
              const traceOf = (wanted: string) => telemetry.find(({ id }) => role(id) === wanted);
              const traceIds = yield* read(TraceIds, path.join(folder, "trace-ids.json"));
              const result = yield* read(CaseResult, path.join(folder, "result.json"));
              return {
                title,
                result,
                reported: results.get(title),
                // Probe roles, newest first. The session's own requests have no role.
                failure: traceIds.failure.map(role).filter((name) => name !== undefined),
                dropped: traceIds.dropped.map(role),
                state: traceIds.state,
                unfetched: traceIds.unfetched.map(role),
                unfetchedIds: traceIds.unfetched,
                folder,
                unanswered: (yield* read(Rows, path.join(folder, "unanswered-requests.json"))).map(
                  ({ traceId }) => role(traceId),
                ),
                every: rows.map(({ traceId }) => traceId),
                failureIds: traceIds.failure,
                droppedIds: traceIds.dropped,
                telemetry: telemetry.map(({ id, kept, error }) => ({
                  role: role(id),
                  kept,
                  error,
                })),
                keptReasons: telemetry.flatMap(({ kept }) => kept),
                // The server's spans arrived: one of them answered the test's client span.
                serverAnswered: (wanted: string) => {
                  const spans = traceOf(wanted)?.data ?? [];
                  const client = spans.find(({ span }) => span.serviceName === "executor-e2e");
                  return spans.some(({ span }) => span.parentSpanId === client?.span.spanId);
                },
              };
            });
          const tens = (prefix: string, indexes: ReadonlyArray<number>) =>
            indexes.map((index) => `${prefix}-${index}`);
          const down = (prefix: string, from: number, to: number) =>
            tens(
              prefix,
              Array.from({ length: from - to + 1 }, (_, index) => from - index),
            );
          // A failed case under its budget keeps every request it sent, the failing one included.
          const everyRequestKept = (title: string, also: ReadonlyArray<string> = []) =>
            Effect.gen(function* () {
              const evidence = yield* kept(title);
              expect(evidence.reported?.status, title).toBe("failed");
              expect(evidence.result.status, title).toBe("failed");
              expect(evidence.state, title).toBe("complete");
              expect(evidence.droppedIds, title).toEqual([]);
              expect(evidence.failureIds.toSorted(), title).toEqual(evidence.every.toSorted());
              expect(evidence.failure, title).toEqual(expect.arrayContaining(["failing", ...also]));
              return evidence;
            });

          const unanswered = yield* everyRequestKept(
            failureCases.unanswered,
            tens("unanswered", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
          );
          expect(unanswered.failure[0]).toBe("failing");
          expect(unanswered.unanswered.toSorted()).toEqual(
            ["failing", ...tens("unanswered", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])].toSorted(),
          );

          for (const title of [failureCases.innerScope, failureCases.sameMillisecond]) {
            const cleanup = yield* everyRequestKept(title, down("cleanup", 9, 0));
            // The cleanup ran after the failing request answered, so it is newer.
            expect(cleanup.failure, title).toEqual([...down("cleanup", 9, 0), "failing"]);
            expect(cleanup.serverAnswered("failing"), title).toBe(true);
          }

          const nested = yield* everyRequestKept(failureCases.nestedSteps);
          expect(nested.failure).toEqual(["failing", ...down("inner", 3, 0), "outer"]);

          const timeout = yield* kept(failureCases.timeout);
          expect(timeout.reported?.status).toBe("failed");
          expect(timeout.reported?.failureMessages.join("\n")).toContain("timed out");
          expect(timeout.failure).toEqual(["before-deadline"]);

          // Evidence waits five seconds for the unanswered request's spans, past the deadline.
          const nearDeadline = yield* everyRequestKept(failureCases.nearDeadline, ["answered"]);
          const reported = nearDeadline.reported?.failureMessages.join("\n") ?? "";
          expect(reported).toContain("cross-origin request rejected");
          expect(reported).not.toContain("timed out");
          expect(nearDeadline.result.errors.join("\n")).toContain("cross-origin request rejected");
          expect(nearDeadline.failure).toEqual(["failing", "answered"]);
          // Its evidence was finished after the deadline, and the reported error is still its own.
          expect(nearDeadline.result.duration).toBeGreaterThan(caseDeadlineMs);

          const passing = yield* kept(failureCases.passing);
          expect(passing.reported?.status).toBe("passed");
          expect(passing.result.status).toBe("passed");
          expect(passing.failure).toEqual([]);
          expect(passing.dropped).toEqual([]);
          expect(passing.unanswered).toEqual([]);
          expect(passing.keptReasons.filter((reason) => reason !== "slowest")).toEqual([]);
          // It has no failure traces to wait five seconds for; it takes about a tenth of a second.
          expect(passing.result.duration).toBeLessThan(5_000);

          // The failing request was sent before sixteen refused requests and answered after them.
          const refused = yield* everyRequestKept(
            failureCases.answeredAfterRefused,
            down("refused", 15, 0),
          );
          expect(refused.reported?.failureMessages.join("\n")).toContain("the intended failure");
          expect(refused.failure.slice(0, 17)).toEqual(["failing", ...down("refused", 15, 0)]);
          expect(refused.serverAnswered("failing")).toBe(true);

          // A recovered attempt's requests are kept too, older than the failure's.
          const retried = yield* everyRequestKept(failureCases.retriedStep, ["recovered"]);
          expect(retried.failure).toEqual([
            "failing",
            ...down("attempt-2", 11, 0),
            "recovered",
            ...down("attempt-1", 11, 0),
          ]);
          for (const title of [failureCases.reusedPrimitive, failureCases.repeatedInterruption]) {
            const recovered = yield* everyRequestKept(title, [
              "recovered",
              ...down("later", 11, 0),
            ]);
            expect(recovered.failure[0], title).toBe("failing");
            expect(recovered.serverAnswered("failing"), title).toBe(true);
          }

          // Release, onExit, a closed scope's finalizer and ensuring, all inside the step.
          const inStep = yield* everyRequestKept(failureCases.cleanupInStep, [
            ...down("release", 2, 0),
            ...down("on-exit", 2, 0),
            ...down("scope-close", 2, 0),
            ...down("ensuring", 2, 0),
          ]);
          expect(inStep.serverAnswered("failing")).toBe(true);

          // An acquisition runs uninterruptibly like cleanup, and the scope's cleanup follows it.
          const acquire = yield* everyRequestKept(
            failureCases.failedAcquire,
            down("cleanup", 3, 0),
          );
          expect(acquire.failure.slice(0, 5)).toEqual([...down("cleanup", 3, 0), "failing"]);
          expect(acquire.serverAnswered("failing")).toBe(true);

          // Twelve background requests sent after the failing one, in a step of their own.
          const background = yield* everyRequestKept(
            failureCases.backgroundAfterFailure,
            down("background", 11, 0),
          );
          expect(background.failure.slice(0, 13)).toEqual([
            ...down("background", 11, 0),
            "failing",
          ]);
          expect(background.serverAnswered("failing")).toBe(true);

          // The body passed; the case's own finalizer failed. Vitest and the evidence agree.
          const caseCleanup = yield* everyRequestKept(failureCases.failedCaseCleanup, [
            "answered",
            ...down("cleanup", 3, 0),
          ]);
          expect(caseCleanup.result.errors.join("\n")).toContain("the intended failure");
          expect(caseCleanup.failure.slice(0, 6)).toEqual([
            ...down("cleanup", 3, 0),
            "failing",
            "answered",
          ]);
          expect(caseCleanup.serverAnswered("failing")).toBe(true);

          // Past the budget the oldest answered traces are left out. The newest request, the
          // unanswered one and the slowest five are kept however old they are.
          const budget = yield* kept(failureCases.overBudget);
          expect(budget.reported?.status).toBe("failed");
          expect(budget.result.status).toBe("failed");
          expect(budget.failure[0]).toBe("failing");
          expect(budget.failure).toContain("refused");
          expect(budget.unanswered).toEqual(["refused"]);
          const index = (role: string | undefined) => Number(role?.replace("old-", ""));
          const recent = budget.telemetry
            .filter(({ role, kept }) => role?.startsWith("old-") && !kept.includes("slowest"))
            .map(({ role }) => index(role));
          expect(budget.dropped.length, "traces left out").toBeGreaterThanOrEqual(10);
          expect(recent.length, "recent traces kept within the budget").toBeGreaterThanOrEqual(3);
          expect(budget.dropped.every((role) => role?.startsWith("old-"))).toBe(true);
          // Every trace left out is older than every trace kept for fitting the budget.
          expect(Math.max(...budget.dropped.map(index))).toBeLessThan(Math.min(...recent));
          expect(budget.failureIds.length + budget.droppedIds.length).toBe(budget.every.length);

          // Reading every trace through a slow collector takes longer than the evidence may spend.
          // It stops at its deadline with the newest traces read, inside the cleanup hook's time.
          const slow = yield* kept(failureCases.slowCollector);
          const slowReported = slow.reported?.failureMessages.join("\n") ?? "";
          expect(slow.reported?.status).toBe("failed");
          expect(slowReported).toContain("the intended failure");
          expect(slowReported).not.toContain("timed out");
          expect(slow.result.status).toBe("failed");
          expect(slow.state).toBe("partial");
          expect(slow.failure[0]).toBe("failing");
          expect(slow.serverAnswered("failing")).toBe(true);
          const readOld = slow.telemetry
            .filter(
              ({ role, kept, error }) =>
                role?.startsWith("old-") && !kept.includes("slowest") && error === undefined,
            )
            .map(({ role }) => index(role));
          expect(slow.unfetched.length, "traces not read").toBeGreaterThanOrEqual(50);
          expect(readOld.length, "traces read").toBeGreaterThanOrEqual(32);
          expect(slow.unfetched.every((role) => role?.startsWith("old-"))).toBe(true);
          // Newest first: every trace not read is older than every trace read.
          expect(Math.max(...slow.unfetched.map(index))).toBeLessThan(Math.min(...readOld));
          expect(slow.failureIds.length + slow.unfetchedIds.length).toBe(slow.every.length);
          expect(slow.every.length).toBeGreaterThan(slowTraceRead.requests);
          // telemetry.json lists each trace not read.
          expect(
            slow.telemetry.filter(({ error }) => error === "Not read before the evidence deadline")
              .length,
          ).toBe(slow.unfetchedIds.length);
          // The cleanup hook finished, so the product was stopped and no longer listens.
          const lifecycles = path.join(run, "report/lifecycle");
          const cleanups: (number | null)[] = [];
          for (const name of yield* fs.readDirectory(lifecycles)) {
            const record = yield* read(Lifecycle, path.join(lifecycles, name));
            if (record.title === failureCases.slowCollector) cleanups.push(record.cleanupMs);
          }
          expect(cleanups).toHaveLength(1);
          expect(cleanups[0]).toBeLessThan(60_000);
          const { origin } = yield* read(
            Schema.Struct({ origin: Schema.String }),
            path.join(slow.folder, "product.json"),
          );
          const answer = yield* http
            .get(`${origin}/`)
            .pipe(Effect.timeout("5 seconds"), Effect.result);
          expect(answer._tag, "the product stopped").toBe("Failure");
        }),
      ),
    120_000,
  );
});
