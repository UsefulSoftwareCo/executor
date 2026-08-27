import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import type * as Tracer from "effect/Tracer";

import type { ErrorEvent } from "@sentry/cloudflare";

import {
  addCurrentOtelCorrelationTags,
  beforeSendCloudEvent,
  beforeSendWithOtelCorrelation,
  DO_CAUSE_OWNER_TAG,
  DO_CAUSE_OWNER_VALUE,
  OTEL_SPAN_ID_TAG,
  OTEL_TRACE_ID_TAG,
  sentryPayloadForCause,
} from "./index";

// Mirrors Sentry core's `is.isError`: it picks the proper-Error path iff
// `Object.prototype.toString.call(x) === "[object Error]"`. Anything that
// fails this check goes down the synthetic "<className> captured as exception
// with keys: ..." path that produced the original CauseImpl Sentry issue.
const looksLikeErrorToSentry = (value: unknown): boolean =>
  Object.prototype.toString.call(value) === "[object Error]";

const traceId = "4268a606000000000000000000000000";
const spanId = "1234567890abcdef";

const makeFixedTracer = (): Tracer.Tracer => ({
  span: (options) => {
    const attributes = new Map<string, unknown>();
    let status: Tracer.SpanStatus = { _tag: "Started", startTime: options.startTime };
    return {
      _tag: "Span",
      name: options.name,
      spanId,
      traceId,
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
});

describe("sentryPayloadForCause", () => {
  it("hands Sentry a real Error when the defect is itself a Cause", () => {
    // Reproduces the production chain: an inner runPromise rejects with a
    // CauseImpl (from Effect v4's causeSquash), Effect.promise re-wraps it
    // as Die(CauseImpl), and the outer catchCause receives this shape.
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: observability test must build a real Error for Sentry-compatible payload assertions
    const innerCause = Cause.fail(new Error("inner failure"));
    const outerCause = Cause.die(innerCause);

    const { primary, pretty } = sentryPayloadForCause(outerCause);

    expect(looksLikeErrorToSentry(primary)).toBe(true);
    expect(pretty).not.toBeNull();
  });

  it("hands Sentry a real Error for an ordinary failed Cause", () => {
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: observability test must build a real Error for Sentry-compatible payload assertions
    const { primary } = sentryPayloadForCause(Cause.fail(new Error("plain failure")));
    expect(looksLikeErrorToSentry(primary)).toBe(true);
  });

  it("forwards non-Cause inputs as-is with no pretty cause attached", () => {
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: observability test must build a real Error for Sentry-compatible payload assertions
    const err = new Error("raw");
    const { primary, pretty } = sentryPayloadForCause(err);
    expect(primary).toBe(err);
    expect(pretty).toBeNull();
  });
});

// Grouping keys are decided inside the Sentry SDK and never appear on any
// product surface, so the e2e harness cannot observe them; the running
// beforeSend itself is covered by e2e/cloud/sentry-otel-correlation.test.ts.
describe("Sentry grouping", () => {
  // The worker bundle ships as content-hashed chunks, so the only module name
  // Sentry ever sees for a given frame changes on every deploy.
  const workerEvent = (chunkHash: string): ErrorEvent => ({
    type: undefined,
    exception: {
      values: [
        {
          type: "GateCheckTimeoutError",
          value: "balance check timed out",
          stacktrace: {
            frames: [
              {
                filename: `/assets/execution-rate-limit-${chunkHash}.js`,
                module: `execution-rate-limit-${chunkHash}`,
                function: "timeoutOrElse",
                in_app: true,
              },
            ],
          },
        },
      ],
    },
  });

  it("pins one fingerprint across two deploys of the same chunk", () => {
    const before = beforeSendCloudEvent(workerEvent("BAuwphPA"), {});
    const after = beforeSendCloudEvent(workerEvent("DkcPBbWe"), {});

    expect(before?.fingerprint).toBeDefined();
    expect(before?.fingerprint).toEqual(after?.fingerprint);
  });

  it("leaves unhashed events on Sentry's default grouping", () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [
          {
            type: "AutumnError",
            stacktrace: {
              frames: [
                { filename: "/src/engine/execution-gate.ts", function: "checkExecutionBalance" },
              ],
            },
          },
        ],
      },
    };

    const sent = beforeSendCloudEvent(event, {});

    expect(sent).not.toBeNull();
    expect(sent?.fingerprint).toBeUndefined();
  });
});

describe("Sentry OTel correlation", () => {
  it.effect("adds tags from the active Effect span", () =>
    Effect.gen(function* () {
      const baseEvent: { readonly tags: Record<string, unknown> } = { tags: { existing: "tag" } };
      const event = yield* addCurrentOtelCorrelationTags(baseEvent);

      expect(event.tags.existing).toBe("tag");
      expect(event.tags[OTEL_TRACE_ID_TAG]).toBe(traceId);
      expect(event.tags[OTEL_SPAN_ID_TAG]).toBe(spanId);
    }).pipe(Effect.withSpan("test.sentry_capture"), Effect.withTracer(makeFixedTracer())),
  );
});

// One Durable Object failure used to open two Sentry issues: the DO's own
// `captureCause` seam reported it (mechanism `generic`), and then
// `instrumentDurableObjectWithSentry` reported the very same rejection again as
// it escaped the method (mechanism `auto.faas.cloudflare.durable_object`). The
// DO is the owner — it has the session, the classification and the OTel
// correlation — so its claim suppresses the echo and nothing else.
describe("Durable Object capture ownership", () => {
  const doEcho = (overrides: Partial<ErrorEvent> = {}): ErrorEvent => ({
    type: undefined,
    tags: { [DO_CAUSE_OWNER_TAG]: DO_CAUSE_OWNER_VALUE },
    exception: {
      values: [
        {
          type: "Error",
          value: "Durable Object reset because its code was updated.",
          mechanism: { type: "auto.faas.cloudflare.durable_object", handled: false },
        },
      ],
    },
    ...overrides,
  });

  it("drops the auto-instrumentation's copy of a cause the DO already claimed", () => {
    expect(beforeSendWithOtelCorrelation(doEcho())).toBeNull();
  });

  it("keeps the DO's own report, which carries no auto mechanism", () => {
    const own = doEcho({
      exception: {
        values: [
          {
            type: "Error",
            value: "Durable Object reset because its code was updated.",
            mechanism: { type: "generic", handled: true },
          },
        ],
      },
    });
    expect(beforeSendWithOtelCorrelation(own)).not.toBeNull();
  });

  // An alarm crash or a transport fault is never claimed by the DO seam, and
  // the auto-instrumentation is the ONLY thing that reports it. Dropping those
  // would trade duplicate noise for silence.
  it("keeps an unclaimed Durable Object failure", () => {
    const unclaimed = doEcho({ tags: {} });
    expect(beforeSendWithOtelCorrelation(unclaimed)).not.toBeNull();
  });

  it("keeps ordinary worker events untouched", () => {
    const workerEvent: ErrorEvent = {
      type: undefined,
      tags: { [OTEL_TRACE_ID_TAG]: traceId },
      exception: {
        values: [
          {
            type: "TypeError",
            value: "x is not a function",
            mechanism: { type: "auto.http.cloudflare", handled: false },
          },
        ],
      },
    };
    expect(beforeSendWithOtelCorrelation(workerEvent)).not.toBeNull();
  });

  // The two stages of the installed `beforeSend` answer different questions and
  // must both keep working: capture ownership decides WHETHER an event is
  // reported, stable grouping decides HOW a reported one is grouped. A dropped
  // event is never fingerprinted, and a surviving one still is.
  describe("composed with stable grouping", () => {
    const hashedFrames = (chunkHash: string) => ({
      stacktrace: {
        frames: [
          {
            filename: `/assets/session-durable-object-${chunkHash}.js`,
            module: `session-durable-object-${chunkHash}`,
            function: "handleSessionRequest",
            in_app: true,
          },
        ],
      },
    });

    it("drops a claimed echo rather than fingerprinting it", () => {
      const echo = doEcho({
        exception: {
          values: [
            {
              type: "Error",
              value: "Durable Object reset because its code was updated.",
              mechanism: { type: "auto.faas.cloudflare.durable_object", handled: false },
              ...hashedFrames("BAuwphPA"),
            },
          ],
        },
      });

      expect(beforeSendCloudEvent(echo, {})).toBeNull();
    });

    it("pins a stable fingerprint on the report the DO itself owns", () => {
      const ownReport = (chunkHash: string): ErrorEvent =>
        doEcho({
          exception: {
            values: [
              {
                type: "Error",
                value: "Durable Object reset because its code was updated.",
                mechanism: { type: "generic", handled: true },
                ...hashedFrames(chunkHash),
              },
            ],
          },
        });

      const before = beforeSendCloudEvent(ownReport("BAuwphPA"), {});
      const after = beforeSendCloudEvent(ownReport("DkcPBbWe"), {});

      expect(before?.fingerprint).toBeDefined();
      expect(before?.fingerprint).toEqual(after?.fingerprint);
    });
  });
});
