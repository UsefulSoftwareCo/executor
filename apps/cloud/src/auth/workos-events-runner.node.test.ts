// ---------------------------------------------------------------------------
// A reconciler run that does not end `"drained"` can still leave the mirror
// fresh (another run drained it moments ago) or leave it stale (nothing has
// drained inside the lag budget). `alertOnStaleReconciler` is the ONLY place
// that distinction is now reported — the request path no longer reads
// readiness at all — so this pins both branches directly against it: a
// fresh `drainedAt` logs nothing, and a stale or absent `drainedAt` logs a
// structured error. `captureCauseEffect` is not swapped out: it calls
// `Sentry.captureException` directly, is a no-op in this uninitialized test
// environment, and its call path is exercised for real rather than mocked.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Cause, Duration, Effect, Layer, Logger } from "effect";

import { WorkOsMirror, type WorkOsMirrorShape } from "./workos-mirror";
import { alertOnStaleReconciler } from "./workos-events-runner";
import type { WorkOsEventsSyncReport } from "./workos-events-sync";

const capturingLogger = (sink: Array<string>) =>
  Logger.make<unknown, void>((options) => {
    sink.push(String(options.message));
    sink.push(Cause.pretty(options.cause));
  });

const reportEndingWith = (stopped: WorkOsEventsSyncReport["stopped"]): WorkOsEventsSyncReport => ({
  pages: 1,
  events: 0,
  applied: 0,
  stale: 0,
  absent: 0,
  stopped,
  cursor: null,
});

const stubMirror = (drainedAt: Date | null) =>
  Layer.succeed(
    WorkOsMirror,
    new Proxy({} as WorkOsMirrorShape, {
      get: (_target, prop) => {
        if (prop === "drainedAt") return () => Effect.succeed(drainedAt);
        return () => Effect.die(`unexpected WorkOsMirror.${String(prop)} call`);
      },
    }),
  );

const run = (report: WorkOsEventsSyncReport, drainedAt: Date | null) => {
  const logged: string[] = [];
  return Effect.runPromise(
    alertOnStaleReconciler(report).pipe(
      Effect.provide(stubMirror(drainedAt)),
      Effect.provide(Logger.layer([capturingLogger(logged)])),
    ),
  ).then(() => logged);
};

describe("alertOnStaleReconciler", () => {
  it("does not alert when the run itself drained the stream", async () => {
    // A `"drained"` run just called `markDrained`, so it is healthy by
    // definition and `drainedAt` is never read.
    const logged = await run(reportEndingWith("drained"), null);
    expect(logged).toEqual([]);
  });

  it("does not alert when the mirror drained inside the lag budget", async () => {
    const fresh = new Date(Date.now() - Duration.toMillis(Duration.minutes(1)));
    const logged = await run(reportEndingWith("page_budget"), fresh);
    expect(logged).toEqual([]);
  });

  it("alerts when the mirror has not drained inside the lag budget", async () => {
    const stale = new Date(Date.now() - Duration.toMillis(Duration.minutes(11)));
    const logged = await run(reportEndingWith("page_budget"), stale);
    expect(logged.some((line) => line.includes("workos_events: reconciler stale"))).toBe(true);
  });

  it("alerts when the mirror has never drained", () =>
    run(reportEndingWith("awaiting_backfill"), null).then((logged) => {
      expect(logged.some((line) => line.includes("workos_events: reconciler stale"))).toBe(true);
    }));
});
