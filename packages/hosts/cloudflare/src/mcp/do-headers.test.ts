import { describe, expect, it } from "@effect/vitest";
import { Effect, Tracer } from "effect";

import { currentPropagationHeaders } from "./do-headers";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

describe("currentPropagationHeaders", () => {
  it("emits a traceparent from an external parent span (the worker edge span)", async () => {
    // The worker joins the edge http.server span via OtelTracer.withSpanContext,
    // which provides an ExternalSpan (this is its effect-level shape) — not an
    // Effect-local Span. Propagation must still see it, or the session DO
    // starts a fresh root per request.
    const request = new Request("https://executor.sh/mcp", { method: "POST" });
    const headers = await Effect.runPromise(
      currentPropagationHeaders(request).pipe(
        Effect.withParentSpan(
          Tracer.externalSpan({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true }),
        ),
      ),
    );
    expect(headers.traceparent).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  it("emits a traceparent from an Effect-local span", async () => {
    const request = new Request("https://executor.sh/mcp", { method: "POST" });
    const headers = await Effect.runPromise(
      currentPropagationHeaders(request).pipe(Effect.withSpan("test.span")),
    );
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it("omits the traceparent when no span is active", async () => {
    const request = new Request("https://executor.sh/mcp", { method: "POST" });
    const headers = await Effect.runPromise(currentPropagationHeaders(request));
    expect(headers.traceparent).toBeUndefined();
  });

  it("passes through tracestate and baggage from the inbound request", async () => {
    const request = new Request("https://executor.sh/mcp", {
      method: "POST",
      headers: { tracestate: "vendor=state", baggage: "k=v" },
    });
    const headers = await Effect.runPromise(currentPropagationHeaders(request));
    expect(headers.tracestate).toBe("vendor=state");
    expect(headers.baggage).toBe("k=v");
  });
});
