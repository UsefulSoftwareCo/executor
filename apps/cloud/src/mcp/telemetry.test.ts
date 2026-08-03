import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type * as Tracer from "effect/Tracer";

import { annotateMcpRequest } from "./telemetry";

// A tracer that records attributes per span so the test can assert what
// `annotateMcpRequest` stamps on the active request span. One record per span
// creation (never keyed by name) so same-named spans stay distinct.
type RecordedSpan = {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, unknown>;
};

const makeRecordingTracer = (): {
  tracer: Tracer.Tracer;
  attributesOf: (name: string) => ReadonlyMap<string, unknown> | undefined;
} => {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer.Tracer = {
    span: (options) => {
      const attributes = new Map<string, unknown>();
      spans.push({ name: options.name, attributes });
      let status: Tracer.SpanStatus = { _tag: "Started", startTime: options.startTime };
      return {
        _tag: "Span",
        name: options.name,
        spanId: `span-${spans.length}`,
        traceId: "trace-1",
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
  return { tracer, attributesOf: (name) => spans.find((span) => span.name === name)?.attributes };
};

const expectDefined: <T>(value: T) => asserts value is NonNullable<T> = (value) => {
  expect(value).toBeDefined();
};

const postRequest = (body: unknown): Request =>
  new Request("https://executor.sh/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-session-id": "sess-123" },
    body: JSON.stringify(body),
  });

const annotate = (request: Request) =>
  annotateMcpRequest(request, { token: null, parseBody: true });

describe("annotateMcpRequest — cancellation join keys", () => {
  it.effect("stamps the cancelled request id and reason from notifications/cancelled", () => {
    const { tracer, attributesOf } = makeRecordingTracer();
    return Effect.gen(function* () {
      yield* annotate(
        postRequest({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 42, reason: "client timeout" },
        }),
      );
      const attributes = attributesOf("mcp.request");
      expectDefined(attributes);
      expect(attributes.get("mcp.rpc.method")).toBe("notifications/cancelled");
      expect(attributes.get("mcp.rpc.cancelled_id")).toBe("42");
      expect(attributes.get("mcp.rpc.cancelled_reason")).toBe("client timeout");
      expect(attributes.get("mcp.request.session_id")).toBe("sess-123");
    }).pipe(Effect.withSpan("mcp.request"), Effect.withTracer(tracer));
  });

  it.effect("still stamps mcp.rpc.id on ordinary requests", () => {
    const { tracer, attributesOf } = makeRecordingTracer();
    return Effect.gen(function* () {
      yield* annotate(
        postRequest({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "execute" },
        }),
      );
      const attributes = attributesOf("mcp.request");
      expectDefined(attributes);
      expect(attributes.get("mcp.rpc.id")).toBe("7");
      expect(attributes.get("mcp.tool.name")).toBe("execute");
      expect(attributes.get("mcp.rpc.cancelled_id")).toBeUndefined();
    }).pipe(Effect.withSpan("mcp.request"), Effect.withTracer(tracer));
  });
});
