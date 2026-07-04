import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import type * as Tracer from "effect/Tracer";

import {
  addCurrentOtelCorrelationTags,
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
