// ---------------------------------------------------------------------------
// W3C traceparent parsing shared by the worker edge (server.ts), the MCP agent
// handler, and the session DO. Single-sourced so the producer (the worker span
// stamping traceparent onto the forwarded request) and the consumers (the
// Effect programs joining that span) cannot drift on the header grammar.
// ---------------------------------------------------------------------------

import { createTraceState } from "@opentelemetry/api";

const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

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
  if (!traceparent) return null;
  const match = TRACEPARENT_PATTERN.exec(traceparent);
  if (!match) return null;
  return {
    traceId: match[2]!,
    spanId: match[3]!,
    traceFlags: parseInt(match[4]!, 16),
    ...(tracestate ? { traceState: createTraceState(tracestate) } : {}),
  };
};
