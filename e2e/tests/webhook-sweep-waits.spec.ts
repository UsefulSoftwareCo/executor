/**
 * What the webhook waits conclude from the sweep's passes, and the deployed preparation's wait for
 * its start-up queue. The waits run their real loop against a simulated product, sweeper and
 * collector, on a clock the case controls: sleeping moves it on at once, so a case about a 60 s
 * bound takes milliseconds and its times are exact.
 */
import { expect, it } from "@effect/vitest";
import { Cause, Clock, Duration, Effect, Exit } from "effect";
import { attachedStage, axiomQueryMs } from "../support/axiom.ts";
import { collectorReadMs } from "../support/evidence.ts";
import {
  deployedPace as deployedSweepPace,
  localPace,
  managedCloudPace,
  sweepPaceFor,
} from "../support/webhook-sources.ts";
import {
  drainBound,
  type DrainPace,
  deployedPace as deployedDrainPace,
  drainWebhookQueue,
  type QueueDrain,
} from "../sdk/webhook-queue.ts";
import {
  type Delivered,
  type PendingRead,
  skippingPass,
  type SweepPace,
  waitOnSweep,
} from "../support/webhook-sweep.ts";

const t0 = Date.parse("2026-11-16T12:00:00.000Z");
const trace = (name: string) => Buffer.from(name).toString("hex").padEnd(32, "0").slice(0, 32);

/** A clock the case controls: sleeping moves it on by the time slept, at once. */
const virtualClock = () => {
  let now = t0;
  const nanos = () => BigInt(now) * 1_000_000n;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (duration) =>
      Effect.sync(() => {
        now += Duration.toMillis(duration);
      }),
  };
  return { clock, now: () => now };
};

const span = (
  name: string,
  operation: string,
  start: number,
  durationMs: number,
  tags: Record<string, string>,
): Delivered => ({
  traceId: trace(name),
  span: {
    spanId: trace(name).slice(0, 16),
    parentSpanId: null,
    operationName: operation,
    serviceName: "executor",
    startTime: new Date(start).toISOString(),
    durationMs,
    status: "ok",
    events: [],
    tags,
  },
});
/** A pass of the sweeper on server `instance` (none on Cloud). */
const pass = (name: string, start: number, taken: number, instance?: string, durationMs = 200) =>
  span(name, "sdk.webhooks.sweep", start, durationMs, {
    "executor.webhooks.sweep.taken": String(taken),
    "executor.webhooks.sweep.limit": "8",
    ...(instance === undefined ? {} : { "executor.webhooks.instance": instance }),
  });
/** A reconciliation of the source in pass `name`'s trace. */
const reconcile = (name: string, start: number, durationMs = 100) =>
  span(name, "sdk.webhooks.reconcileSource", start, durationMs, {});
const read = (start: number, end: number, instance?: string): PendingRead => ({
  start,
  end,
  instance,
});

it("a pass of the read's own server with room after a pending read, that reconciled nothing of the source, skipped it", () => {
  const reads = [read(t0, t0 + 10, "a")];
  const judge = (passes: Delivered[], served: Delivered[] = []) =>
    skippingPass({
      passes,
      served,
      reads,
      servedReadAt: t0 + 60_000,
      deliveryMs: 5_000,
      servers: "shared",
    });
  const room = pass("room", t0 + 1_000, 3, "a");
  expect(judge([pass("full", t0 + 500, 8, "a"), room])).toBe(room);
  // Full passes leave it queued; a pass from before the read proves nothing.
  expect(judge([pass("full", t0 + 500, 8, "a"), pass("early", t0 - 1_000, 0, "a")])).toBe(
    undefined,
  );
  // A pass that reconciled it took it.
  expect(judge([room], [reconcile("room", t0 + 1_050)])).toBe(undefined);
  // Another server's pass, sharing the collector, says nothing of this server's queue.
  expect(judge([pass("other", t0 + 1_000, 0, "b")])).toBe(undefined);
  // A pass is judged only once every reconciliation before it has surely been delivered.
  expect(
    skippingPass({
      passes: [room],
      served: [],
      reads,
      servedReadAt: t0 + 1_200 + 4_999,
      deliveryMs: 5_000,
      servers: "shared",
    }),
  ).toBe(undefined);
});

it("where each collector holds one coordinator's passes, a pass with room skips the source though another Worker answered the read", () => {
  // On Cloud the read is answered by the API Worker and the pass run by the coordinator, each with
  // its own webhook source service.
  const room = pass("room", t0 + 1_000, 0, "coordinator");
  const judge = (servers: "own" | "shared") =>
    skippingPass({
      passes: [room],
      served: [],
      reads: [read(t0, t0 + 10, "api")],
      servedReadAt: t0 + 60_000,
      deliveryMs: 5_000,
      servers,
    });
  expect(judge("own")).toBe(room);
  expect(judge("shared")).toBe(undefined);
});

it("a source served and queued again between two reads that showed it pending was not skipped by the pass between", () => {
  // Reads at 0 s and 1 s show it pending. A pass at 1.05 s serves it (ready at 1.2 s); a pass with
  // room at 1.22 s finds it ready; it is queued again at 1.24 s, before the next read.
  const reads = [read(t0, t0 + 10), read(t0 + 1_000, t0 + 1_010)];
  const judged = skippingPass({
    passes: [pass("served", t0 + 1_050, 1), pass("between", t0 + 1_220, 0)],
    served: [reconcile("served", t0 + 1_100, 100)],
    reads,
    servedReadAt: t0 + 60_000,
    deliveryMs: 5_000,
    servers: "own",
  });
  expect(judged).toBe(undefined);
  // A read after that reconciliation, then a pass with room that does not take it: skipped.
  const later = pass("later", t0 + 2_000, 0);
  expect(
    skippingPass({
      passes: [pass("served", t0 + 1_050, 1), pass("between", t0 + 1_220, 0), later],
      served: [reconcile("served", t0 + 1_100, 100)],
      reads: [...reads, read(t0 + 1_500, t0 + 1_510)],
      servedReadAt: t0 + 60_000,
      deliveryMs: 5_000,
      servers: "own",
    }),
  ).toBe(later);
});

const pace: SweepPace = {
  readSpacingMs: 250,
  spanSpacingMs: 2_000,
  deliveryMs: 5_000,
  queryMs: 5_000,
  reportMarginMs: 3_000,
  servers: "shared",
};

/**
 * One app with one pending source, as the product, its sweeper and the collector show it over
 * time: `readyAt` is when the product reads it ready (never, if undefined), `passes` and `served`
 * what the sweeper did, each readable once it has ended. `spans: "down"` fails every span read.
 */
const world = (input: {
  readonly readyAt?: number;
  readonly passes?: ReadonlyArray<Delivered>;
  readonly served?: ReadonlyArray<Delivered>;
  readonly instance?: string;
  /** "down" fails every span read; "slow" makes each take the reader's whole time-out. */
  readonly spans?: "down" | "slow";
}) => {
  const { clock, now } = virtualClock();
  const reads = new Map<string, Delivered>();
  let count = 0;
  const delivered = (all: ReadonlyArray<Delivered> = []) =>
    Effect.sync(() =>
      all.filter(({ span }) => Date.parse(span.startTime) + span.durationMs <= now()),
    );
  const spans = <A>(effect: Effect.Effect<A>): Effect.Effect<A, Error> =>
    input.spans === "down"
      ? Effect.fail(new Error("collector unreachable"))
      : input.spans === "slow"
        ? Effect.sleep(pace.queryMs).pipe(Effect.andThen(effect))
        : effect;
  const wait = waitOnSweep({
    what: "Webhook sources",
    deadline: t0 + 60_000,
    pace,
    reads: {
      attempt: Effect.sync(() => {
        const ready = input.readyAt !== undefined && now() >= input.readyAt;
        return { done: ready, value: now(), shown: JSON.stringify({ ready }) };
      }),
      pending: Effect.sync(() => {
        const name = `read-${count++}`;
        reads.set(
          trace(name),
          span(
            name,
            "sdk.webhooks.sources",
            now(),
            10,
            input.instance === undefined ? {} : { "executor.webhooks.instance": input.instance },
          ),
        );
        return {
          accounts: [{ account: "acc_team", label: "team-key" }],
          shown: [{ account: "acc_team", status: "pending" }],
          trace: trace(name),
        };
      }),
      passes: () => spans(delivered(input.passes)),
      served: () => spans(delivered(input.served)),
      readSpan: (id) =>
        spans(delivered([...reads.values()].filter((r) => r.traceId === id))).pipe(
          Effect.map((found) => found[0]?.span),
        ),
    },
  }).pipe(Effect.provideService(Clock.Clock, clock), Effect.exit);
  return { wait, now };
};
/** Full passes every second from `from` for `count` passes, on server `instance`. */
const fullPasses = (from: number, count: number, instance?: string) =>
  Array.from({ length: count }, (_, n) =>
    pass(`full-${instance}-${n}`, from + n * 1_000, 8, instance),
  );
const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";

it.effect("a source behind full passes is waited for until it is served", () =>
  Effect.gen(function* () {
    const { wait, now } = world({
      instance: "a",
      readyAt: t0 + 40_300,
      passes: [...fullPasses(t0 + 100, 40, "a"), pass("takes", t0 + 40_100, 1, "a")],
      served: [reconcile("takes", t0 + 40_150)],
    });
    const exit = yield* wait;
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(now()).toBeGreaterThanOrEqual(t0 + 40_300);
  }),
);

it.effect(
  "a pass with room that does not take a pending source fails the wait at once, naming it",
  () =>
    Effect.gen(function* () {
      const { wait, now } = world({
        instance: "a",
        passes: [...fullPasses(t0 + 100, 5, "a"), pass("skips", t0 + 6_000, 0, "a")],
      });
      const exit = yield* wait;
      const text = failure(exit);
      expect(text).toContain("the webhook source sweep skipped team-key");
      expect(text).toContain(`its pass at ${new Date(t0 + 6_000).toISOString()}`);
      expect(text).toContain(trace("skips"));
      expect(text).toContain("took 0 of its 8");
      // As soon as every reconciliation before the pass has surely been delivered, long before
      // the scenario's bound.
      expect(now()).toBeLessThan(t0 + 6_200 + pace.deliveryMs + pace.spanSpacingMs + 1_000);
    }),
);

it.effect("a pass with room from another server sharing the collector is not taken as a skip", () =>
  Effect.gen(function* () {
    const { wait } = world({
      instance: "a",
      readyAt: t0 + 30_300,
      passes: [
        ...fullPasses(t0 + 100, 30, "a"),
        ...fullPasses(t0 + 150, 30, "b").map((full, n) =>
          pass(`other-${n}`, Date.parse(full.span.startTime), 0, "b"),
        ),
        pass("takes", t0 + 30_100, 1, "a"),
      ],
      served: [reconcile("takes", t0 + 30_150)],
    });
    expect(Exit.isSuccess(yield* wait)).toBe(true);
  }),
);

it.effect("with the collector unreadable, a source that is then served passes", () =>
  Effect.gen(function* () {
    const { wait } = world({ instance: "a", readyAt: t0 + 40_000, spans: "down" });
    expect(Exit.isSuccess(yield* wait)).toBe(true);
  }),
);

it.effect(
  "with the collector unreadable, a source never served fails at the bound, saying the passes could not be read",
  () =>
    Effect.gen(function* () {
      const { wait, now } = world({ instance: "a", spans: "down" });
      const text = failure(yield* wait);
      expect(text).toContain("did not settle before the scenario's time-out");
      expect(text).toContain("could not be read");
      expect(now()).toBe(t0 + 60_000 - pace.reportMarginMs);
    }),
);

it.effect(
  "a source served and queued again between reads is waited for, not reported skipped",
  () =>
    Effect.gen(function* () {
      // Served at 1.1 s by a pass with room; a pass with room at 1.22 s finds it ready; it is queued
      // again at 1.24 s and stays pending in every read until a full pass and then one that takes
      // it again, at 20 s.
      const { wait } = world({
        instance: "a",
        readyAt: t0 + 20_300,
        passes: [
          pass("served", t0 + 1_050, 1, "a"),
          pass("between", t0 + 1_220, 0, "a"),
          ...fullPasses(t0 + 1_300, 18, "a"),
          pass("again", t0 + 20_100, 1, "a"),
        ],
        served: [reconcile("served", t0 + 1_100, 100), reconcile("again", t0 + 20_150)],
      });
      expect(Exit.isSuccess(yield* wait)).toBe(true);
    }),
);

/** A sweep 100 times the deployed rate, so the bound is small; the clock is the case's own. */
const drainPace: DrainPace = {
  rate: 233,
  deliveryMs: 300,
  readSpacingMs: 50,
  provisioningMs: 1_000,
  idleWakeMs: 650,
};

/**
 * Drain a queue of 500 against the passes `passes` gives (each readable once it has started).
 * The stage's provisioning has 3 jobs left until `provisioningFor` ms in.
 */
const drain = (
  passes: ReadonlyArray<Delivered>,
  provisioningFor = 0,
  queue: { readonly pending: number; readonly pace: DrainPace } = { pending: 500, pace: drainPace },
) =>
  Effect.gen(function* () {
    const { clock, now } = virtualClock();
    let countedAt: number | undefined;
    let recorded: QueueDrain | undefined;
    const exit = yield* drainWebhookQueue({
      count: Effect.sync(() => {
        countedAt = now();
        return {
          pending: queue.pending,
          provisioning: now() - t0 < provisioningFor ? 3 : 0,
          at: now(),
        };
      }),
      passes: () =>
        Effect.sync(() => ({
          data: passes.filter(({ span }) => Date.parse(span.startTime) <= now()),
        })),
      record: (figures) =>
        Effect.sync(() => {
          recorded = figures;
        }),
      pace: queue.pace,
    }).pipe(Effect.provideService(Clock.Clock, clock), Effect.exit);
    return { exit, recorded, countedAt, finished: now() };
  });

it.effect(
  "preparation waits for provisioning to queue its sources, then until a pass after its count has room",
  () =>
    Effect.gen(function* () {
      // A pass with room during provisioning says nothing of the sources it has yet to queue.
      const result = yield* drain(
        [
          pass("before", t0 - 1_000, 2),
          pass("provisioning", t0 + 100, 0),
          ...Array.from({ length: 30 }, (_, n) =>
            pass(`full-${n}`, t0 + 600 + n * 33, 8, undefined, 30),
          ),
          pass("drained", t0 + 1_700, 4, undefined, 30),
        ],
        400,
      );
      expect(Exit.isSuccess(result.exit)).toBe(true);
      // Counted at the first read after provisioning finished, at 400 ms.
      expect(result.countedAt).toBeDefined();
      expect(result.recorded).toEqual({
        provisioningMs: 400,
        queued: 500,
        boundMs: drainBound(500, drainPace),
        passes: 31,
        passesWithRoom: 1,
        drainMs: 1_730 - 400,
        drainedBy: {
          startTime: new Date(t0 + 1_700).toISOString(),
          traceId: trace("drained"),
          taken: 4,
          limit: 8,
        },
      });
      expect(result.finished).toBe(t0 + 1_700);
    }),
);

it.effect(
  "provisioning that has not finished by its bound is recorded, and the queue is counted then",
  () =>
    Effect.gen(function* () {
      const result = yield* drain([pass("drained", t0 + 1_200, 1)], Number.POSITIVE_INFINITY);
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(result.recorded).toMatchObject({
        provisioningMs: drainPace.provisioningMs,
        provisioningOutstanding: 3,
        queued: 500,
      });
    }),
);

it.effect(
  "with the sweep stopped, preparation fails at the bound derived from its count, with the figures",
  () =>
    Effect.gen(function* () {
      // At the deployed rate: (500 + 2 × 8) / 2.33 s, then the coordinator's idle wake (60 s and
      // 5 s for a late trigger), then 30 s for the last pass's span.
      expect(drainBound(500)).toBe(Math.ceil((516 / 2.33) * 1000) + 65_000 + 30_000);
      const bound = drainBound(500, drainPace);
      const result = yield* drain([]);
      expect(failure(result.exit)).toContain("did not drain within its bound");
      // The first read at or after the bound, at the drain's own spacing.
      expect(result.finished).toBe(
        t0 + Math.ceil(bound / drainPace.readSpacingMs) * drainPace.readSpacingMs,
      );
      expect(result.recorded).toEqual({
        provisioningMs: 0,
        queued: 500,
        boundMs: bound,
        passes: 0,
        passesWithRoom: 0,
        pendingAtBound: 500,
      });
    }),
);

it.effect("a sweep that only takes full passes fails the bound too, saying none had room", () =>
  Effect.gen(function* () {
    const result = yield* drain(
      Array.from({ length: 200 }, (_, n) => pass(`full-${n}`, t0 + 10 + n * 33, 8, undefined, 30)),
    );
    expect(failure(result.exit)).toContain("did not drain within its bound");
    expect(result.recorded).toMatchObject({ queued: 500, passesWithRoom: 0 });
    expect(result.recorded?.passes).toBeGreaterThan(30);
  }),
);

it.effect("on a quiet stage, a drain with nothing queued finishes at once", () =>
  Effect.gen(function* () {
    const result = yield* drain([], 0, { pending: 0, pace: deployedDrainPace });
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.finished).toBe(t0);
    expect(result.recorded).toMatchObject({ queued: 0, drainMs: 0, passes: 0 });
  }),
);

it.effect(
  "a first pass 59 s after the count, on the idle coordinator's next wake, still drains a short queue",
  () =>
    Effect.gen(function* () {
      // The pass that took the last sources was already running at the count; the next comes on
      // the coordinator's minute heartbeat.
      const result = yield* drain([pass("running", t0 - 100, 8), pass("wake", t0 + 59_000, 0)], 0, {
        pending: 3,
        pace: deployedDrainPace,
      });
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(result.recorded).toMatchObject({ queued: 3, drainedBy: { traceId: trace("wake") } });
    }),
);

it.effect("no span read starts that could run past the report, however slow the reads", () =>
  Effect.gen(function* () {
    // Every read takes the reader's whole time-out, and another server's passes with room keep
    // the wait reading reconciliations and read spans too.
    const { wait, now } = world({
      instance: "a",
      spans: "slow",
      passes: Array.from({ length: 60 }, (_, n) =>
        pass(`other-${n}`, t0 + 500 + n * 1_000, 0, "b"),
      ),
    });
    const text = failure(yield* wait);
    expect(text).toContain("did not settle before the scenario's time-out");
    expect(now()).toBeGreaterThanOrEqual(t0 + 60_000 - pace.reportMarginMs);
    expect(now()).toBeLessThan(t0 + 60_000);
  }),
);

it.effect("an attached stage's origin must name its stage, once, before any scenario", () =>
  Effect.gen(function* () {
    expect(yield* attachedStage("https://e2e-abc123.executor-test.example")).toBe(
      "test-e2e-abc123",
    );
    const exit = yield* Effect.exit(attachedStage("https://Not_A_Stage.example"));
    expect(failure(exit)).toContain("does not name its stage");
  }),
);

it("the waits' paces follow the readers, Axiom's delay and its quota, and each target's collectors", () => {
  // No span read may outlast the report: each pace's query time is its reader's own time-out.
  expect(deployedSweepPace.queryMs).toBe(axiomQueryMs);
  expect(localPace.queryMs).toBe(collectorReadMs);
  // A skip is judged only after the slowest delivery measured on a test stage, 18 s.
  expect(deployedSweepPace.deliveryMs).toBeGreaterThanOrEqual(18_000);
  // 16 waiting workers read passes within a tenth of the organization's 1,800 queries a minute.
  expect(16 * (60_000 / deployedSweepPace.spanSpacingMs)).toBeLessThanOrEqual(180);
  // Each Cloud environment has its own collector, and a deployed stage is read by its name: any
  // pass there is the read's own coordinator's. Self-hosted and local servers may share one.
  expect(sweepPaceFor({ target: "cloud", mode: "attached" })).toBe(deployedSweepPace);
  expect(sweepPaceFor({ target: "cloud", mode: "managed" })).toBe(managedCloudPace);
  expect(managedCloudPace.servers).toBe("own");
  expect(deployedSweepPace.servers).toBe("own");
  expect(sweepPaceFor({ target: "self-host", mode: "managed" }).servers).toBe("shared");
  expect(sweepPaceFor({ target: "local", mode: "managed" }).servers).toBe("shared");
});
