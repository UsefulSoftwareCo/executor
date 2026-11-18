/**
 * A run's body meets an engine whose calls fail. The server's E2E fault list
 * (`EXECUTOR_TEST_WORKFLOW_ENGINE_FAULTS`, honoured only with `EXECUTOR_ENVIRONMENT=e2e`) fails
 * chosen calls as the platform's engine would, or holds one before it reaches the engine as a slow
 * call would be, so no case depends on timing or on the platform.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { type DeliveredSpan, Telemetry } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { withApps } from "../support/apps-release.ts";
import { WorkflowRun as Run } from "../support/workflow-app.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

/** How long `napOnce`'s first sleep waits; the case reads it to judge how that sleep ended. */
const napOnceMillis = 50;

/** Each workflow meets the fault the plan configures for its step names. */
const files = [
  { path: "package.json", content: JSON.stringify({ dependencies: withApps() }) },
  {
    path: "operations.ts",
    content: `import { query, mutation, object, string } from "apps";
export const count = mutation({ input: object({ label: string() }) }, async (ctx, input) => {
  ctx.sql.transaction((tx) => tx.exec("INSERT INTO calls (label) VALUES (?)", input.label));
  return null;
});
export const calls = query({ input: object({ label: string() }) }, async (ctx, input) =>
  ctx.sql.exec("SELECT COUNT(*) AS n FROM calls WHERE label = ?", input.label).one().n);
`,
  },
  {
    path: "workflows.ts",
    content: `import { workflow, object } from "apps";
import { count } from "./operations.ts";
/** Each sleep's engine call fails once, before the engine sees it. */
export const napOnce = workflow({ input: object({}) }, async (ctx) => {
  await ctx.step.sleep("nap-once", ${napOnceMillis});
  await ctx.step.sleepUntil("wake-once", Date.now() + 2000);
  return "awake";
});
/** The time this sleep waits for has passed before the call reaches the engine. */
export const lateWake = workflow({ input: object({}) }, async (ctx) => {
  await ctx.step.sleepUntil("late-wake", Date.now() - 1000);
  return "awake";
});
/** Every engine call for this sleep fails. */
export const napNever = workflow({ input: object({}) }, async (ctx) => {
  await ctx.step.sleepUntil("nap-never", Date.now() + 60000);
  return "unreachable";
});
/** The engine runs this step's write, then its answer fails once. */
export const stepOnce = workflow({ input: object({}) }, async (ctx) => {
  try {
    await ctx.step.runMutation("count-once", count, { label: "step-once" }, { retries: { limit: 0, delay: 0 } });
    return { failed: false };
  } catch (error) {
    return { failed: true, reason: error?.reason ?? null, errorName: error?.errorName ?? null, message: error?.message ?? null };
  }
});
/** The engine waits this sleep and only then fails to answer, four times over. */
export const waitedOut = workflow({ input: object({}) }, async (ctx) => {
  await ctx.step.sleep("waited-out", "1500 milliseconds");
  return "awake";
});
/**
 * Each of these sleeps' first call gets the engine's own answer, which must reach the body. A
 * repeat would find the fault spent, and the sleep would succeed.
 */
const answered = (name) => async (ctx) => {
  try {
    await ctx.step.sleep(name, "10 milliseconds");
    return { slept: true };
  } catch (error) {
    return { slept: false, reason: error?.reason ?? null, errorName: error?.errorName ?? null, message: error?.message ?? null };
  }
};
/** As \`answered\`, for a sleepUntil whose engine waited until its time and then answered. */
const answeredUntil = (name) => async (ctx) => {
  try {
    await ctx.step.sleepUntil(name, Date.now() + 50);
    return { slept: true };
  } catch (error) {
    return { slept: false, reason: error?.reason ?? null, errorName: error?.errorName ?? null, message: error?.message ?? null };
  }
};
export const pausedOnce = workflow({ input: object({}) }, answered("paused-once"));
export const pausedUntil = workflow({ input: object({}) }, answeredUntil("paused-until"));
export const terminatedUntil = workflow({ input: object({}) }, answeredUntil("terminated-until"));
export const transientUntil = workflow({ input: object({}) }, answeredUntil("transient-until"));
/**
 * Its sleepUntil, a second ahead, reaches the engine three seconds late: after its time. The step
 * after it counts how often it ran.
 */
export const lateUntil = workflow({ input: object({}) }, async (ctx) => {
  try {
    await ctx.step.sleepUntil("late-until", Date.now() + 1000);
  } catch (error) {
    return { slept: false, reason: error?.reason ?? null, errorName: error?.errorName ?? null, message: error?.message ?? null };
  }
  await ctx.step.runMutation("after-late-until", count, { label: "after-late-until" }, { retries: { limit: 0, delay: 0 } });
  return { slept: true };
});
export const terminatedOnce = workflow({ input: object({}) }, answered("terminated-once"));
export const relayedOnce = workflow({ input: object({}) }, answered("relayed-once"));
`,
  },
  {
    path: "index.ts",
    content: `import { defineApp, router } from "apps";
import { count, calls } from "./operations.ts";
import * as workflows from "./workflows.ts";
export default defineApp({}, { tools: router({ count, calls }), workflows });`,
  },
  {
    path: "migrations/0001_calls.sql",
    content: "CREATE TABLE calls (label TEXT NOT NULL);\n",
  },
];
const Deployed = Schema.Struct({ id: Schema.String });
/** The four calls a sleep gets in all: the first and three repeats. */
const sleepAttempts = 4;

layer(HostedLive, { excludeTestServices: true })("Workflow engine calls", (it) => {
  it.effect(scenarios.workflowEngineCalls.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          telemetry = yield* Telemetry;
        // Only Cloud delivers spans from inside a run; self-host's runner hands the host the
        // run's result as data (`app-failure-telemetry.spec.ts`).
        const cloud = (yield* Target).metadata.target === "cloud";
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const runs: string[] = [];
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Engine calls ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(Deployed, deployed);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const run of runs)
              yield* api.request(actors.owner, "POST", `${path}/workflow-runs/${run}/terminate`);
            expect((yield* api.request(actors.owner, "DELETE", path)).status).toBe(200);
          }).pipe(Effect.orDie),
        );
        const start = (workflow: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
              workflow,
              input: {},
              key: randomUUID(),
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const run = yield* body(Run, response);
            runs.push(run.id);
            return run.id;
          });
        /** The run once it has ended, whichever way. */
        const ended = (id: string) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + 40_000;
            while (true) {
              const response = yield* api.request(
                actors.owner,
                "GET",
                `${path}/workflow-runs/${id}`,
              );
              expect(response.status).toBe(200);
              const run = yield* body(Run, response);
              if (["complete", "errored", "terminated"].includes(run.status)) return run;
              expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
              yield* Effect.sleep("100 millis");
            }
          });
        const calls = (label: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
              tool: "calls",
              kind: "query",
              input: { label },
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return response.body;
          });
        /** The run's sleep spans, `count` of them once they have all been delivered. */
        const sleeps = (run: string, count: number) =>
          Effect.gen(function* () {
            const read = Effect.gen(function* () {
              const found = [
                ...(yield* telemetry.search("workflow.sleep", { run })).data,
                ...(yield* telemetry.search("workflow.sleepUntil", { run })).data,
              ];
              return found.length >= count
                ? Effect.succeed(found.map(({ span }) => span))
                : Effect.fail(new Error(`${found.length} of ${count} sleep spans delivered`));
            }).pipe(Effect.flatten);
            return yield* read.pipe(
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
            );
          });

        // A sleep whose engine call fails once is called again and the run completes.
        const once = yield* start("napOnce");
        const onceRun = yield* ended(once);
        expect(onceRun, JSON.stringify(onceRun)).toMatchObject({
          status: "complete",
          output: "awake",
        });
        if (cloud) {
          // A sleep's spans: one per execution of the body, and a span can be delivered twice.
          const named = (spans: ReadonlyArray<DeliveredSpan>, name: string) =>
            spans.filter((span) =>
              (span.tags["executor.workflow.step"] ?? "").includes(`:${name}:`),
            );
          const onceSpans = yield* sleeps(once, 1).pipe(
            Effect.flatMap((spans) =>
              ["nap-once", "wake-once"].every((name) => named(spans, name).length > 0)
                ? Effect.succeed(spans)
                : Effect.fail(new Error("a span of nap-once or wake-once is not delivered yet")),
            ),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
          );
          const facts = (spans: ReadonlyArray<DeliveredSpan>) =>
            JSON.stringify(
              spans.map((span) => ({
                status: span.status,
                attempts: span.tags["executor.workflow.call.attempts"],
                passed: span.tags["executor.workflow.call.passed"],
                repeated: span.tags["executor.workflow.call.repeat_1.code"],
                waited: span.tags["executor.workflow.call.waited"],
                waitedMs: span.tags["executor.workflow.call.waited_ms"],
              })),
            );
          // nap-once is a sleep. Its fault fails the first call before the engine sees it, and the
          // product then repeats it, unless that failed call itself lasted the sleep's duration:
          // then the sleep's time has passed and the product ends it (a slow failure can outlast
          // a 50 ms sleep on a busy host). Either is a correct end; any other is not.
          const nap = named(onceSpans, "nap-once");
          expect(
            nap.map((span) => span.status),
            `nap-once: ${facts(nap)}`,
          ).not.toContain("error");
          expect(
            nap.some(
              (span) =>
                (span.tags["executor.workflow.call.attempts"] === "2" &&
                  span.tags["executor.workflow.call.repeat_1.code"] === "internal") ||
                // The product's own record of how long the failed call lasted, not this
                // scenario's clock: a product that skipped the repeat would record less.
                (span.tags["executor.workflow.call.attempts"] === "1" &&
                  span.tags["executor.workflow.call.waited"] === "true" &&
                  Number(span.tags["executor.workflow.call.waited_ms"]) >= napOnceMillis),
            ),
            `nap-once was repeated after its fault, or its failed call outlasted it: ${facts(nap)}`,
          ).toBe(true);
          // wake-once is a sleepUntil, which ends without the engine once its time has passed.
          // The body computes that time with the app's clock, which advances only with its I/O,
          // so on a slow host the time can have passed by the first call, before the engine is
          // asked and before the fault is used. Either way the run is right: its fault failed the
          // first call and the repeat ended it, or its first call found the time passed.
          const wake = named(onceSpans, "wake-once");
          expect(
            wake.map((span) => span.status),
            `wake-once: ${facts(wake)}`,
          ).not.toContain("error");
          expect(
            wake.some(
              (span) =>
                (span.tags["executor.workflow.call.attempts"] === "2" &&
                  span.tags["executor.workflow.call.repeat_1.code"] === "internal") ||
                (span.tags["executor.workflow.call.attempts"] === "1" &&
                  span.tags["executor.workflow.call.passed"] === "true"),
            ),
            `wake-once was repeated after its fault, or found its time passed: ${facts(wake)}`,
          ).toBe(true);
        }

        // A sleepUntil a time that has passed is over without the engine, which refuses it.
        const late = yield* start("lateWake");
        const lateRun = yield* ended(late);
        expect(lateRun, JSON.stringify(lateRun)).toMatchObject({
          status: "complete",
          output: "awake",
        });
        if (cloud) {
          const [lateSpan] = yield* sleeps(late, 1);
          expect(lateSpan?.tags).toMatchObject({
            "executor.workflow.call.attempts": "1",
            "executor.workflow.call.passed": "true",
          });
        }

        // A sleep whose every call fails ends the run, its cause recorded for the owner and on
        // the span, after the bounded calls.
        const never = yield* start("napNever");
        const neverRun = yield* ended(never);
        expect(neverRun).toMatchObject({
          status: "errored",
          error: "engine",
          failure: {
            step: "nap-never",
            errorName: "WorkflowEngineCallFailed",
            message: `Executor called the workflow engine ${sleepAttempts} times for this sleepUntil and every call failed. The last failure: hop=platform; class=Error; code=internal.`,
          },
        });
        if (cloud) {
          const [neverSpan] = yield* sleeps(never, 1);
          expect(neverSpan?.tags).toMatchObject({
            "executor.workflow.call.attempts": String(sleepAttempts),
            "executor.workflow.call.outcome": "failed",
            "executor.workflow.call.hop": "platform",
            "executor.workflow.call.error_class": "Error",
            "executor.workflow.call.code": "internal",
          });
          // The waits the product scheduled before each repeat: 200, 400 and 800 ms, each 80-120%.
          for (const [repeat, base] of [
            [1, 200],
            [2, 400],
            [3, 800],
          ] as const) {
            const scheduled = Number(
              neverSpan?.tags[`executor.workflow.call.repeat_${repeat}.wait_ms`],
            );
            expect(scheduled).toBeGreaterThanOrEqual(base * 0.8);
            expect(scheduled).toBeLessThanOrEqual(base * 1.2);
          }
        }

        // A step whose answer failed after its write ran is not called again: the write ran once.
        const step = yield* start("stepOnce");
        const stepRun = yield* ended(step);
        expect(stepRun, JSON.stringify(stepRun)).toMatchObject({
          status: "complete",
          output: {
            failed: true,
            reason: "engine",
            errorName: "WorkflowEngineCallFailed",
            message: "hop=platform; class=Error; code=internal",
          },
        });
        expect(yield* calls("step-once")).toBe(1);

        // A sleep the engine waited, whose answer was then lost, is over: it is not waited again.
        // Its four faults would end the run if each call were repeated.
        const waited = yield* start("waitedOut");
        const waitedRun = yield* ended(waited);
        expect(waitedRun, JSON.stringify(waitedRun)).toMatchObject({
          status: "complete",
          output: "awake",
        });
        if (cloud) {
          const waitedSpans = yield* sleeps(waited, 1);
          expect(
            waitedSpans.some(
              (span) =>
                span.tags["executor.workflow.call.waited"] === "true" &&
                span.tags["executor.workflow.call.attempts"] === "1",
            ),
          ).toBe(true);
        }

        // The engine's own answers reach the body at once, unrepeated: a paused or terminated
        // instance, and a failure the engine relays from the app. Each fault fails one call.
        for (const [workflow, expected] of [
          [
            "pausedOnce",
            {
              reason: "engine",
              errorName: "WorkflowEngineCallFailed",
              message: "hop=platform; class=Error; code=aborted",
            },
          ],
          [
            "terminatedOnce",
            {
              reason: "engine",
              errorName: "WorkflowEngineCallFailed",
              message: "hop=platform; class=Error; code=aborted",
            },
          ],
          ["relayedOnce", { reason: "execution" }],
          // A pause or a termination that arrives after a sleepUntil's time is still the
          // engine's answer: it reaches the body, which does not go on as if it had slept.
          [
            "pausedUntil",
            {
              reason: "engine",
              errorName: "WorkflowEngineCallFailed",
              message: "hop=platform; class=Error; code=aborted",
            },
          ],
          [
            "terminatedUntil",
            {
              reason: "engine",
              errorName: "WorkflowEngineCallFailed",
              message: "hop=platform; class=Error; code=aborted",
            },
          ],
        ] as const) {
          const run = yield* ended(yield* start(workflow));
          expect(run, `${workflow}: ${JSON.stringify(run)}`).toMatchObject({
            status: "complete",
            output: { slept: false, ...expected },
          });
        }

        // A transient failure after a sleepUntil's time is over: the time has passed.
        const transient = yield* ended(yield* start("transientUntil"));
        expect(transient, JSON.stringify(transient)).toMatchObject({
          status: "complete",
          output: { slept: true },
        });

        // A sleepUntil that reaches the engine after its time meets the engine's refusal of a time
        // in the past, which ends the sleep: its time has passed. This engine words that refusal its
        // own way (`workflow-errors.ts`, `pastSleep`).
        const lateUntil = yield* ended(yield* start("lateUntil"));
        expect(lateUntil, JSON.stringify(lateUntil)).toMatchObject({
          status: "complete",
          output: { slept: true },
        });
        // The run went on past the sleep once: the step after it ran exactly once.
        expect(yield* calls("after-late-until")).toBe(1);
      }),
    ),
  );
});
