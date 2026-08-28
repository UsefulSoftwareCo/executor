import { afterEach, describe, expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { Data, Effect } from "effect";
import type * as Tracer from "effect/Tracer";

import type { ExecutionEngine } from "@executor-js/execution";

import {
  ExecutionRateLimiterDO,
  makeCloudExecutionRateLimiter,
  makeExecutionRateLimiter,
  RateLimitCounterError,
} from "./execution-rate-limit";
import { RATE_LIMIT_BLOCKED_MESSAGE } from "./execution-limit-messages";

const ORG = "org_test";

/** Stands in for whatever the real lookups fail with (Autumn down, DO down). */
class UpstreamDownError extends Data.TaggedError("UpstreamDownError")<{
  readonly which: string;
}> {}

// A stand-in engine: `execute` resolves to a marker, so a test tells an allowed
// execution (marker) from a blocked one (the gate's error result) by which of
// the two came back. A blocked decision never reaches the engine at all.
const engineStub: ExecutionEngine = {
  execute: () => Effect.succeed({ result: "ran" }),
  executeWithPause: () => Effect.succeed({ status: "completed", result: { result: "ran" } }),
  resume: () => Effect.succeed(null),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("stub"),
  // The stub forks nothing, so there is no sandbox fiber to end.
  shutdown: Effect.void,
};

/** Counter that hands out a caller-controlled sequence of counts. */
const countingIncrement = (counts: ReadonlyArray<number>) => {
  let calls = 0;
  return () => Effect.succeed(counts[Math.min(calls++, counts.length - 1)] ?? 0);
};

const runExecute = (limiter: ReturnType<typeof makeExecutionRateLimiter>) =>
  Effect.runPromise(
    limiter.decorate(ORG, engineStub).execute("code", {
      // Never invoked: the stub ignores it, and a blocked execution never runs.
      onElicitation: () => Effect.die("elicitation is not exercised here"),
    }),
  );

describe("execution rate limiter — paid exemption", () => {
  it("allows executions under the cap without consulting the exemption", async () => {
    let exemptionCalls = 0;
    const limiter = makeExecutionRateLimiter(countingIncrement([1]), {
      limit: 10,
      isExempt: () => {
        exemptionCalls += 1;
        return Effect.succeed(false);
      },
    });

    expect(await runExecute(limiter)).toMatchObject({ result: "ran" });
    // The whole point of resolving lazily: the common path costs no lookup.
    expect(exemptionCalls).toBe(0);
  });

  it("blocks a non-exempt org over the cap", async () => {
    const limiter = makeExecutionRateLimiter(countingIncrement([11]), {
      limit: 10,
      isExempt: () => Effect.succeed(false),
    });

    expect(await runExecute(limiter)).toMatchObject({
      result: null,
      error: RATE_LIMIT_BLOCKED_MESSAGE,
    });
  });

  it("allows an exempt org over the cap", async () => {
    const limiter = makeExecutionRateLimiter(countingIncrement([11]), {
      limit: 10,
      isExempt: () => Effect.succeed(true),
    });

    expect(await runExecute(limiter)).toMatchObject({ result: "ran" });
  });

  it("caches the exemption so a paid org past the cap looks it up once", async () => {
    let exemptionCalls = 0;
    const limiter = makeExecutionRateLimiter(countingIncrement([11, 12, 13]), {
      limit: 10,
      exemptionTtlMs: 60_000,
      now: () => 1_000,
      isExempt: () => {
        exemptionCalls += 1;
        return Effect.succeed(true);
      },
    });

    for (let i = 0; i < 3; i += 1)
      expect(await runExecute(limiter)).toMatchObject({ result: "ran" });
    expect(exemptionCalls).toBe(1);
  });

  it("re-resolves once the cached exemption expires", async () => {
    let exemptionCalls = 0;
    let clock = 1_000;
    const limiter = makeExecutionRateLimiter(countingIncrement([11, 12]), {
      limit: 10,
      exemptionTtlMs: 1_000,
      now: () => clock,
      isExempt: () => {
        exemptionCalls += 1;
        return Effect.succeed(true);
      },
    });

    await runExecute(limiter);
    clock += 5_000;
    await runExecute(limiter);
    expect(exemptionCalls).toBe(2);
  });

  it("blocks when the exemption cannot be resolved and nothing is cached", async () => {
    // Deliberately NOT fail-open: an unresolvable exemption during an Autumn
    // outage must not switch the backstop off, which is the one scenario it
    // exists to cover.
    const limiter = makeExecutionRateLimiter(countingIncrement([11]), {
      limit: 10,
      isExempt: () => Effect.fail(new UpstreamDownError({ which: "autumn" })),
    });

    expect(await runExecute(limiter)).toMatchObject({
      result: null,
      error: RATE_LIMIT_BLOCKED_MESSAGE,
    });
  });

  it("honours a stale exemption when a later lookup fails", async () => {
    let clock = 1_000;
    let shouldFail = false;
    const limiter = makeExecutionRateLimiter(countingIncrement([11, 12]), {
      limit: 10,
      exemptionTtlMs: 1_000,
      now: () => clock,
      isExempt: () =>
        shouldFail ? Effect.fail(new UpstreamDownError({ which: "autumn" })) : Effect.succeed(true),
    });

    expect(await runExecute(limiter)).toMatchObject({ result: "ran" });

    // Cache expires and Autumn is now unreachable: the known-paid org keeps
    // running rather than getting blocked mid-workload by a blip.
    clock += 5_000;
    shouldFail = true;
    expect(await runExecute(limiter)).toMatchObject({ result: "ran" });
  });

  it("fails open when the counter itself is unreachable", async () => {
    const limiter = makeExecutionRateLimiter(
      (organizationId) =>
        Effect.fail(
          new RateLimitCounterError({
            organizationId,
            code: "unknown",
            reason: "counter DO unreachable",
            cause: null,
          }),
        ),
      {
        limit: 10,
        isExempt: () => Effect.succeed(false),
      },
    );

    expect(await runExecute(limiter)).toMatchObject({ result: "ran" });
  });

  it("applies the cap when no exemption predicate is wired", async () => {
    const limiter = makeExecutionRateLimiter(countingIncrement([11]), { limit: 10 });

    expect(await runExecute(limiter)).toMatchObject({
      result: null,
      error: RATE_LIMIT_BLOCKED_MESSAGE,
    });
  });
});

// ---------------------------------------------------------------------------
// Counter observability — the production DO wiring.
//
// The counter increment used to be a bare one-argument `Effect.tryPromise`
// with no span, so a Durable Object fault reached error reporting as
// `UnknownError: An error occurred in Effect.tryPromise` with no application
// frames, and the 2s check budget was invisible in traces. These tests pin
// the named spans, the typed/classified failure, and the timeout override —
// all read through the REAL `makeCloudExecutionRateLimiter` wiring against a
// fake `EXECUTION_RATE_LIMITER` binding.
// ---------------------------------------------------------------------------

type RecordedSpan = {
  readonly name: string;
  readonly attributes: Map<string, unknown>;
};

/** A tracer that keeps every span it is asked to open, with its attributes. */
const recordingTracer = (recorded: Array<RecordedSpan>): Tracer.Tracer => {
  let nextId = 1;
  return {
    span: (options) => {
      let status: Tracer.SpanStatus = { _tag: "Started", startTime: options.startTime };
      const attributes = new Map<string, unknown>();
      recorded.push({ name: options.name, attributes });
      const id = String(nextId++).padStart(16, "0");
      return {
        _tag: "Span",
        name: options.name,
        spanId: id,
        traceId: "00000000000000000000000000000001",
        parent: options.parent,
        annotations: options.annotations,
        get status() {
          return status;
        },
        attributes,
        links: options.links,
        sampled: options.sampled,
        kind: options.kind,
        end: (endTime, exit) => {
          status = { _tag: "Ended", startTime: options.startTime, endTime, exit };
        },
        attribute: (key, value) => {
          attributes.set(key, value);
        },
        event: () => undefined,
        addLinks: () => undefined,
      };
    },
  };
};

const spanNamed = (recorded: ReadonlyArray<RecordedSpan>, name: string): RecordedSpan => {
  const span = recorded.find((candidate) => candidate.name === name);
  expect(
    span,
    `a span named ${name} is recorded (got: ${recorded.map((s) => s.name).join(", ") || "none"})`,
  ).toBeDefined();
  return span ?? { name, attributes: new Map() };
};

/** A counter-DO namespace whose single RPC method behaves as the test says. */
const namespaceReturning = (increment: () => Promise<number>) => ({
  idFromName: (name: string) => ({ toString: () => name }),
  get: () => ({ increment }),
});

/** The three worker vars the production limiter reads at construction. */
type CounterEnv = {
  EXECUTION_RATE_LIMITER?: unknown;
  EXECUTION_RATE_LIMIT_PER_HOUR?: string;
  EXECUTION_RATE_LIMIT_CHECK_TIMEOUT_MS?: string;
};

const cloudEnv: CounterEnv = env;
const savedEnv: CounterEnv = { ...cloudEnv };

// Restore rather than leak: the limiter is built from the worker env, and a
// stale binding or budget would silently retune a later test.
afterEach(() => {
  delete cloudEnv.EXECUTION_RATE_LIMITER;
  delete cloudEnv.EXECUTION_RATE_LIMIT_PER_HOUR;
  delete cloudEnv.EXECUTION_RATE_LIMIT_CHECK_TIMEOUT_MS;
  Object.assign(cloudEnv, savedEnv);
});

// The exact platform fault behind the production issue: Cloudflare resets the
// object and the RPC rejects with a plain Error. The reference id is synthetic.
const DO_STORAGE_RESET =
  "Internal error in Durable Object storage caused object to be reset; reference = 0000000000000000";

// oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: the Durable Object RPC is a promise that rejects with a platform Error; the test double has to fail the same way for the classification to mean anything
const rejectStorageReset = (): Promise<number> => Promise.reject(new Error(DO_STORAGE_RESET));

/** Build the production limiter against a fake binding and worker env. */
const cloudLimiter = (options: {
  readonly namespace: ReturnType<typeof namespaceReturning>;
  readonly limit: string;
  readonly timeoutMs?: string;
}): ReturnType<typeof makeExecutionRateLimiter> => {
  cloudEnv.EXECUTION_RATE_LIMITER = options.namespace;
  cloudEnv.EXECUTION_RATE_LIMIT_PER_HOUR = options.limit;
  if (options.timeoutMs !== undefined)
    cloudEnv.EXECUTION_RATE_LIMIT_CHECK_TIMEOUT_MS = options.timeoutMs;
  return makeCloudExecutionRateLimiter(() => Effect.succeed(false));
};

const runExecuteTraced = (
  limiter: ReturnType<typeof makeExecutionRateLimiter>,
  recorded: Array<RecordedSpan>,
) =>
  Effect.runPromise(
    limiter
      .decorate(ORG, engineStub)
      .execute("code", { onElicitation: () => Effect.die("elicitation is not exercised here") })
      .pipe(Effect.withTracer(recordingTracer(recorded))),
  );

describe("execution rate limiter — counter observability", () => {
  it("reports a counter-DO fault as a typed, classified error on a named span", async () => {
    const recorded: Array<RecordedSpan> = [];
    const limiter = cloudLimiter({
      namespace: namespaceReturning(rejectStorageReset),
      limit: "10",
    });
    const result = await runExecuteTraced(limiter, recorded);

    // Fail-open semantics are unchanged: a broken counter never blocks.
    expect(result).toMatchObject({ result: "ran" });

    const increment = spanNamed(recorded, "rate_limit.increment");
    expect(increment.attributes.get("rate_limit.counter.error_tag")).toBe("RateLimitCounterError");
    expect(increment.attributes.get("rate_limit.counter.error_code")).toBe("storage_reset");

    const check = spanNamed(recorded, "rate_limit.check");
    expect(check.attributes.get("rate_limit.check.failed_open")).toBe(true);
    expect(check.attributes.get("rate_limit.check.timed_out")).toBe(false);
    expect(check.attributes.get("rate_limit.check.error_tag")).toBe("RateLimitCounterError");
  });

  it("honours the EXECUTION_RATE_LIMIT_CHECK_TIMEOUT_MS override", async () => {
    const recorded: Array<RecordedSpan> = [];
    const limiter = cloudLimiter({
      // Answers well past the tiny budget, with a count far over the cap. If
      // the override were ignored the default 2s budget would let that count
      // through and BLOCK the execution; honouring it times the check out and
      // fails open instead, so the two outcomes are distinguishable without
      // measuring wall time.
      namespace: namespaceReturning(
        () => new Promise((resolve) => setTimeout(() => resolve(999), 200)),
      ),
      limit: "10",
      timeoutMs: "5",
    });
    const result = await runExecuteTraced(limiter, recorded);

    expect(result).toMatchObject({ result: "ran" });

    const check = spanNamed(recorded, "rate_limit.check");
    expect(check.attributes.get("rate_limit.check.timed_out")).toBe(true);
    expect(check.attributes.get("rate_limit.check.error_tag")).toBe("RateLimitCheckTimeoutError");
  });

  // The healthy check's span (count / limit / blocked / failed_open) is NOT
  // asserted here: the cloud e2e scenario "the rate-limit counter check is
  // visible in the exported spans" pins it on the real workerd + Durable
  // Object topology, against the spans the worker actually exports. The two
  // cases above stay because neither is reachable from the e2e harness — it
  // has no fault seam for a Durable Object RPC, and the check budget is a
  // process-wide worker var that the shared cloud boot cannot vary per
  // scenario without disabling the backstop for the whole run.
});

// ---------------------------------------------------------------------------
// Counter Durable Object
// ---------------------------------------------------------------------------

/** Minimal DO storage that counts the calls the increment path makes. */
const fakeStorage = () => {
  const values = new Map<string, unknown>();
  const calls = { put: 0, setAlarm: 0, deleteAll: 0 };
  return {
    calls,
    storage: {
      get: (key: string) => Promise.resolve(values.get(key)),
      put: (key: string, value: unknown) => {
        calls.put += 1;
        values.set(key, value);
        return Promise.resolve();
      },
      setAlarm: () => {
        calls.setAlarm += 1;
        return Promise.resolve();
      },
      deleteAll: () => {
        calls.deleteAll += 1;
        values.clear();
        return Promise.resolve();
      },
    },
  };
};

const makeCounter = (storage: ReturnType<typeof fakeStorage>["storage"]) =>
  // oxlint-disable-next-line executor/no-double-cast -- test double: only the four storage methods the counter uses are implemented
  new ExecutionRateLimiterDO({ storage } as unknown as DurableObjectState, {} as Env);

describe("execution rate-limit counter DO", () => {
  it("writes the purge alarm once per window instead of on every increment", async () => {
    // The alarm only has to outlive the window; rewriting it on every call put
    // a second durable write on the hot path with the input gate closed.
    const fake = fakeStorage();
    const counter = makeCounter(fake.storage);

    expect(await counter.increment(7)).toBe(1);
    expect(await counter.increment(7)).toBe(2);
    expect(await counter.increment(7)).toBe(3);

    expect(fake.calls.put, "every increment still persists the count").toBe(3);
    expect(fake.calls.setAlarm, "the purge alarm is written once for the window").toBe(1);
  });

  it("moves the purge alarm when the window rolls", async () => {
    const fake = fakeStorage();
    const counter = makeCounter(fake.storage);

    await counter.increment(7);
    await counter.increment(7);
    expect(await counter.increment(8), "a new window restarts the count").toBe(1);

    expect(fake.calls.setAlarm, "one alarm write per window, not per increment").toBe(2);
  });

  it("re-arms the purge alarm after it has fired", async () => {
    const fake = fakeStorage();
    const counter = makeCounter(fake.storage);

    await counter.increment(7);
    await counter.alarm();
    expect(fake.calls.deleteAll, "the alarm purges the counter's storage").toBe(1);

    expect(await counter.increment(7), "the purge reset the window's count").toBe(1);
    expect(fake.calls.setAlarm, "a purged counter schedules a fresh purge").toBe(2);
  });
});
