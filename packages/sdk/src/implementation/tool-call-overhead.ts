/**
 * Executor's own time on one tool call. Each isolate the call runs in measures its own part on its
 * own clock: the caller its work outside runtime calls, and the runner, data supervisor and app
 * isolate their work outside waiting on the next isolate, on upstream providers, on elicitation
 * answers and on the app's authored code. The parts are summed; no duration is subtracted across
 * isolates. Transit between isolates is on no single clock and is not included.
 */
import { Effect, type Tracer } from "effect";
import { measuredSpan } from "@executor-js/telemetry";
import type { InvocationTiming } from "apps/contracts";
import {
  RuntimeCallTimings,
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
  const appOwnMs = dispatch.elapsedMs - app.upstreamMs - app.elicitationMs - app.authoredMs;
  return {
    ownMs:
      runner.elapsedMs -
      runner.waitMs +
      (supervisor === undefined ? 0 : supervisor.elapsedMs - supervisor.waitMs) +
      appOwnMs,
    appOwnMs,
    upstreamMs: app.upstreamMs,
    elicitationMs: app.elicitationMs,
    authoredMs: app.authoredMs,
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
