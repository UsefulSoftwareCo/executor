// ---------------------------------------------------------------------------
// W3C traceparent parsing shared by the worker edge (server.ts), the MCP agent
// handler, and the session DO. The header grammar itself is single-sourced in
// `@executor-js/cloudflare/mcp/do-headers` beside the producer that stamps the
// header; this module only layers the OTel `tracestate` carrier on top for the
// consumers that join the span via the OTel API.
// ---------------------------------------------------------------------------

import { createTraceState } from "@opentelemetry/api";
import { parseTraceparentHeader } from "@executor-js/cloudflare/mcp/do-headers";

export type IncomingSpanContext = {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceState?: ReturnType<typeof createTraceState>;
};

export const parseTraceparent = (
  traceparent: string | null | undefined,
  tracestate: string | null | undefined,
): IncomingSpanContext | null => {
  const parsed = parseTraceparentHeader(traceparent);
  if (!parsed) return null;
  return {
    ...parsed,
    ...(tracestate ? { traceState: createTraceState(tracestate) } : {}),
  };
};
