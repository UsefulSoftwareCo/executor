import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type * as Tracer from "effect/Tracer";

import { annotateMcpRequest } from "./telemetry";

const makeRecordingTracer = (): {
  readonly tracer: Tracer.Tracer;
  readonly requestAttributes: () => ReadonlyMap<string, unknown> | undefined;
} => {
  const recorded: Array<{
    readonly name: string;
    readonly attributes: Map<string, unknown>;
  }> = [];
  const tracer: Tracer.Tracer = {
    span: (options) => {
      const attributes = new Map<string, unknown>();
      recorded.push({ name: options.name, attributes });
      let status: Tracer.SpanStatus = { _tag: "Started", startTime: options.startTime };
      return {
        _tag: "Span",
        name: options.name,
        spanId: `span-${recorded.length}`,
        traceId: "trace-modern",
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
  return {
    tracer,
    requestAttributes: () => recorded.find(({ name }) => name === "mcp.request")?.attributes,
  };
};

describe("annotateMcpRequest modern envelope", () => {
  it.effect("records the 2026 protocol version outside initialize", () => {
    const { tracer, requestAttributes } = makeRecordingTracer();
    const request = new Request("https://executor.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });

    return Effect.gen(function* () {
      yield* annotateMcpRequest(request, { token: null, parseBody: true });
      const attributes = requestAttributes();
      expect(attributes?.get("mcp.rpc.method")).toBe("tools/list");
      expect(attributes?.get("mcp.client.protocol_version")).toBe("2026-07-28");
    }).pipe(Effect.withSpan("mcp.request"), Effect.withTracer(tracer));
  });
});
