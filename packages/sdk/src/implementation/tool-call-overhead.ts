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

const staleClockToleranceMs = 10;

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
  const known =
    runner.started !== undefined && (supervisor === undefined || supervisor.started !== undefined);
  const started = known ? StartedPart.literals.filter((part) => reported.has(part)) : undefined;
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
