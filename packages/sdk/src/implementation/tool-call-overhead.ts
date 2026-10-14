/**
 * Executor's own time on one tool call. Each isolate the call runs in measures its own part on its
 * own clock: the caller its work outside runtime calls, and the runner, data supervisor and app
 * isolate their work outside waiting on the next isolate, on upstream providers, on elicitation
 * answers, on another call's cache load and on the app's authored code; work handed to the
 * background runs beside the call and counts for none of them. The parts are summed. Transit between isolates is on no single clock and is not included; an
 * isolate's start-up is, when the isolate started for this call (see `runtimeCallParts`).
 */
import { Effect, type Tracer } from "effect";
import { measuredSpan } from "@executor-js/telemetry";
import type { InvocationTiming } from "apps/contracts";
import {
  isolateStarts,
  RuntimeCallTimings,
  StartedPart,
  type DispatchTiming,
  type IsolateTiming,
  type RuntimeCallTiming,
} from "../contracts/runtime.ts";

/** Clock reads closer than this are not evidence that an isolate's clock stalled. */
const staleClockToleranceMs = 10;

/**
 * The parts of one runtime call that ran outside the caller. The time a parent waited on its child
 * must cover the child's elapsed time; where it does not, the two clocks disagree and the stalled
 * one under-measured its own part. The app isolate's part is its whole dispatch, which `app` divides
 * by owner within its own span.
 *
 * What a parent waited beyond its child's elapsed time is the hop's gap: transit, and the child's
 * start-up when it started for this call, which ran before its clock began. A cold hop's gap is
 * Executor's time, since nothing else measures it: the runner's when its isolate started, the
 * supervisor's when its object started, and the app's when its data facet started inside the
 * supervisor's wait. A facet's synchronous SQL and code never move its clock, so that gap also
 * holds the app's code on the call that started it. The app Worker's own start is already the
 * runner's (`runtime.app.rpc.start`), outside its wait. A warm hop's gap is transit and stays out.
 * A runner inside the supervisor (Cloud database calls) is reached in the supervisor's object, so
 * the caller's hop holds the supervisor's start and the runner's hop to the supervisor is local.
 */
export const runtimeCallParts = (
  callerWaitMs: number,
  runner: IsolateTiming,
  supervisor: IsolateTiming | undefined,
  dispatch: DispatchTiming,
  app: InvocationTiming,
): NonNullable<RuntimeCallTiming["parts"]> => {
  const waiting = [
    { isolate: "caller", waitMs: callerWaitMs },
    { isolate: "runner", waitMs: runner.waitMs },
    ...(supervisor === undefined ? [] : [{ isolate: "supervisor", waitMs: supervisor.waitMs }]),
  ];
  const waited = [
    { isolate: "runner", elapsedMs: runner.elapsedMs },
    ...(supervisor === undefined
      ? []
      : [{ isolate: "supervisor", elapsedMs: supervisor.elapsedMs }]),
    { isolate: "app", elapsedMs: dispatch.elapsedMs },
  ];
  const staleClocks = waited.flatMap((child, index) => {
    const parent = waiting[index]!;
    return parent.waitMs + staleClockToleranceMs < child.elapsedMs
      ? [`${parent.isolate}/${child.isolate}`]
      : [];
  });
  const gap = (index: number) => Math.max(0, waiting[index]!.waitMs - waited[index]!.elapsedMs);
  const gaps = {
    runner: gap(0),
    ...(supervisor === undefined ? {} : { supervisor: gap(1) }),
    app: gap(waited.length - 1),
  };
  const reported = new Set([...(runner.started ?? []), ...(supervisor?.started ?? [])]);
  // Each reporter on the path must say what started; one that predates it leaves it unknown.
  const known =
    runner.started !== undefined && (supervisor === undefined || supervisor.started !== undefined);
  const started = known ? StartedPart.literals.filter((part) => reported.has(part)) : undefined;
  // A runner inside the supervisor has no start of its own: the caller's hop to it holds the
  // supervisor's.
  const runnerHopStarted =
    runner.host === "supervisor" ? reported.has("supervisor") : reported.has("runner");
  const startMs =
    (runnerHopStarted ? gaps.runner : 0) +
    (reported.has("supervisor") ? (gaps.supervisor ?? 0) : 0) +
    (reported.has("facet") ? gaps.app : 0);
  const leaseMs = app.leaseMs ?? 0;
  const backgroundMs = app.backgroundMs ?? 0;
  const appOwnMs =
    dispatch.elapsedMs - app.upstreamMs - app.elicitationMs - app.authoredMs - leaseMs;
  return {
    ownMs:
      runner.elapsedMs -
      runner.waitMs +
      (supervisor === undefined ? 0 : supervisor.elapsedMs - supervisor.waitMs) +
      appOwnMs +
      startMs,
    appOwnMs,
    upstreamMs: app.upstreamMs,
    elicitationMs: app.elicitationMs,
    authoredMs: app.authoredMs,
    leaseMs,
    backgroundMs,
    startMs,
    unclockedMs: gaps.runner + (gaps.supervisor ?? 0) + gaps.app - startMs,
    started,
    cold: started?.some((part) => isolateStarts.has(part)),
    gaps,
    staleClocks,
  };
};

/** Milliseconds of `[start, end]` that the intervals cover, each instant counted once. */
const covered = (intervals: readonly (readonly [bigint, bigint])[], start: bigint, end: bigint) => {
  let total = 0n;
  let reached = start;
  for (const [from, to] of [...intervals].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    const lower = from > reached ? from : reached;
    const upper = to < end ? to : end;
    if (upper > lower) {
      total += upper - lower;
      reached = upper;
    }
  }
  return Number(total) / 1_000_000;
};

/**
 * Run a tool call in span `name` and record its Executor time on it, measured from the span's own
 * start to its own end.
 */
export const toolCallSpan =
  (name: string, options: Tracer.SpanOptionsNoTrace) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      measuredSpan(name, options, (start) => {
        const calls: RuntimeCallTiming[] = [];
        return {
          around: Effect.provideService(RuntimeCallTimings, (timing) => {
            calls.push(timing);
          }),
          end: (end, span) => {
            const callerOwnMs =
              Number(end - start) / 1_000_000 -
              covered(
                calls.flatMap(({ invoked }) => (invoked === undefined ? [] : [invoked])),
                start,
                end,
              );
            const parts = calls.flatMap(({ parts }) => (parts === undefined ? [] : [parts]));
            const sum = (value: (part: (typeof parts)[number]) => number) =>
              parts.reduce((total, part) => total + value(part), 0);
            span.attribute("executor.runtime.calls", calls.length);
            span.attribute(
              "executor.upstream.wait_ms",
              sum(({ upstreamMs }) => upstreamMs),
            );
            span.attribute(
              "executor.elicitation.wait_ms",
              sum(({ elicitationMs }) => elicitationMs),
            );
            span.attribute(
              "executor.authored_ms",
              sum(({ authoredMs }) => authoredMs),
            );
            span.attribute(
              "executor.lease.wait_ms",
              sum(({ leaseMs }) => leaseMs),
            );
            span.attribute(
              "executor.background_ms",
              sum(({ backgroundMs }) => backgroundMs),
            );
            span.attribute(
              "executor.start_ms",
              sum(({ startMs }) => startMs),
            );
            span.attribute(
              "executor.unclocked_ms",
              sum(({ unclockedMs }) => unclockedMs),
            );
            // Cold or warm is the main split of Executor time; it needs no join with the trace.
            // Unknown when no call reported its parts.
            // Only when every invoked call said what started; one that did not finish, or a
            // runner or supervisor that predates it, leaves the call neither cold nor warm.
            if (
              parts.length > 0 &&
              calls.every(
                ({ invoked, parts }) => invoked === undefined || parts?.started !== undefined,
              )
            ) {
              span.attribute(
                "executor.runtime.cold",
                parts.some(({ cold }) => cold === true),
              );
              const started = new Set(parts.flatMap((part) => part.started ?? []));
              span.attribute(
                "executor.runtime.started",
                StartedPart.literals.filter((part) => started.has(part)).join(","),
              );
            }
            // A call that was invoked but reported no parts did not finish, or its build or runner
            // predates timing: its Executor time cannot be told from the rest, so none is recorded.
            if (calls.every(({ invoked, parts }) => invoked === undefined || parts !== undefined)) {
              span.attribute("executor.caller.own_ms", callerOwnMs);
              span.attribute("executor.overhead_ms", callerOwnMs + sum(({ ownMs }) => ownMs));
            }
            const stale = [...new Set(parts.flatMap(({ staleClocks }) => staleClocks))];
            if (stale.length > 0) {
              span.attribute("executor.clock.stale", true);
              span.attribute("executor.clock.stale_between", stale.join(","));
            }
          },
        };
      }),
    );
