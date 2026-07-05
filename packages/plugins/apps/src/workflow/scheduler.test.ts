import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeSelfHostAppsRuntime } from "../plugin/self-host-runtime";
import { makeInMemoryAppsStore, makeTestResolver, dailyBriefFileSet } from "../testing";
import { cronMatches, makeScheduler, validateCron, CronError } from "./scheduler";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

describe("scheduler", () => {
  it("matches cron fields (minute hour dom mon dow)", () => {
    // "0 9 * * 1-5" -> weekdays at 09:00 UTC.
    const weekdayNine = new Date(Date.UTC(2026, 0, 5, 9, 0, 0)); // Mon 2026-01-05
    expect(cronMatches("0 9 * * 1-5", weekdayNine)).toBe(true);
    const weekendNine = new Date(Date.UTC(2026, 0, 4, 9, 0, 0)); // Sun
    expect(cronMatches("0 9 * * 1-5", weekendNine)).toBe(false);
    const weekdayTen = new Date(Date.UTC(2026, 0, 5, 10, 0, 0));
    expect(cronMatches("0 9 * * 1-5", weekdayTen)).toBe(false);
    expect(cronMatches("*/15 * * * *", new Date(Date.UTC(2026, 0, 5, 3, 30, 0)))).toBe(true);
    expect(cronMatches("*/15 * * * *", new Date(Date.UTC(2026, 0, 5, 3, 31, 0)))).toBe(false);
  });

  // --- Fix 8: adversarial cron strings never hang the parser ---------------
  it("rejects adversarial cron fields via validateCron (never loops)", () => {
    // A step of 0 would loop forever in the naive parser.
    expect(() => validateCron("*/0 * * * *")).toThrow(CronError);
    expect(() => validateCron("*/-1 * * * *")).toThrow(CronError);
    // Out-of-range and reversed ranges are bounded, not billion-iteration loops.
    expect(() => validateCron("0 0 1 1 0-999")).toThrow(CronError);
    expect(() => validateCron("0 0 999999999-0 * *")).toThrow(CronError);
    expect(() => validateCron("nonsense")).toThrow(CronError);
    expect(() => validateCron("* * * *")).toThrow(CronError); // 4 fields
    // A valid cron passes.
    expect(() => validateCron("0 9 * * 1-5")).not.toThrow();
    expect(() => validateCron("*/15 * * * *")).not.toThrow();
  });

  it("cronMatches returns quickly (no hang) on adversarial strings", () => {
    const date = new Date(Date.UTC(2026, 0, 5, 9, 0, 0));
    // The guard: each of these completes near-instantly and never matches. If the
    // parser hung, this test would time out instead of asserting false.
    const start = Date.now();
    for (const cron of [
      "*/0 * * * *",
      "*/-5 * * * *",
      "0 0 1 1 0-2000000000",
      "0-999999999/0 * * * *",
    ]) {
      expect(cronMatches(cron, date)).toBe(false);
    }
    // Generous upper bound; the real signal is that it returns at all.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("fires a due workflow schedule and starts the run", async () => {
    const store = makeInMemoryAppsStore();
    const resolver = makeTestResolver({
      github: {
        "repos.listForAuthenticatedUser": () => [{ full_name: "acme/app" }],
        "issues.listForRepo": () => [],
      },
    });
    const host = makeSelfHostAppsRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "apps-sched-")),
      store,
      resolver,
      inMemory: true,
    });
    await run(host.runtime.publish({ scope: "rhys", files: dailyBriefFileSet() }));

    const scheduler = makeScheduler({ runtime: host.runtime, scopes: ["rhys"] });
    // morning-sync is "0 9 * * 1-5". Tick at a matching minute.
    const at = new Date(Date.UTC(2026, 0, 5, 9, 0, 0));
    const started = await run(scheduler.tick(at));
    expect(started.length).toBe(1);

    const run1 = await run(host.runtime.getRun(started[0]));
    expect(run1?.workflow).toBe("morning-sync");
    expect(run1?.status).toBe("completed");

    // A second tick in the same minute does not double-fire.
    const again = await run(scheduler.tick(at));
    expect(again.length).toBe(0);

    await host.close();
  });
});
