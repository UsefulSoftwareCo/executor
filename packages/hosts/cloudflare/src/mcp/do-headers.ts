// ---------------------------------------------------------------------------
// Worker <-> Durable-Object internal wire protocol headers + the trace/header
// plumbing the worker stamps before forwarding to the MCP session DO.
//
// The worker stamps the verified caller identity onto these headers before
// forwarding a request to the MCP session Durable Object; the DO reads them
// back to validate ownership against its stored session meta. Single-sourced
// here so the producer (worker, see withVerifiedIdentityHeaders) and the
// consumer (the DO, in session-durable-object.ts) cannot drift.
//
// This module stays react-start-free (it only uses `effect` + Web APIs) so the
// DO worker bundle that reaches it can be bundled by wrangler/esbuild.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

export const INTERNAL_ACCOUNT_ID_HEADER = "x-executor-mcp-account-id";
export const INTERNAL_ORGANIZATION_ID_HEADER = "x-executor-mcp-organization-id";

const TRUE_QUERY_VALUES = new Set(["1", "true", "yes", "on"]);

/** The verified identity used to stamp the DO's internal owner headers. */
export type VerifiedTokenHeaders = {
  readonly accountId: string;
  readonly organizationId: string;
};

// Worker and DO run in separate isolates with independent WebSdk tracer
// providers. Neither one can see the other's OTEL context, so the DO used
// to emit a brand-new root trace on every stub call. Ferry the worker span
// context across with W3C headers: `traceparent` generated from the active
// Effect span plus passthrough `tracestate` / `baggage` from the inbound
// request.
export type IncomingPropagationHeaders = {
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: string;
};

const currentTraceparent = Effect.map(Effect.currentSpan, (span) => {
  if (!span || !span.traceId || !span.spanId) return undefined;
  const flags = span.sampled ? "01" : "00";
  return `00-${span.traceId}-${span.spanId}-${flags}`;
}).pipe(Effect.orElseSucceed(() => undefined));

export const currentPropagationHeaders = (
  request: Request,
): Effect.Effect<IncomingPropagationHeaders> =>
  Effect.map(currentTraceparent, (traceparent) => ({
    traceparent,
    tracestate: request.headers.get("tracestate") ?? undefined,
    baggage: request.headers.get("baggage") ?? undefined,
  }));

export const withPropagationHeaders = (
  request: Request,
  propagation: IncomingPropagationHeaders,
): Request => {
  const headers = new Headers(request.headers);
  if (propagation.traceparent) {
    headers.set("traceparent", propagation.traceparent);
  }
  if (propagation.tracestate) {
    headers.set("tracestate", propagation.tracestate);
  }
  if (propagation.baggage) {
    headers.set("baggage", propagation.baggage);
  }
  return new Request(request, { headers });
};

export const withVerifiedIdentityHeaders = (
  request: Request,
  token: VerifiedTokenHeaders,
): Request => {
  const headers = new Headers(request.headers);
  headers.set(INTERNAL_ACCOUNT_ID_HEADER, token.accountId);
  headers.set(INTERNAL_ORGANIZATION_ID_HEADER, token.organizationId ?? "");
  return new Request(request, { headers });
};

export const withMcpResponseHeaders = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "mcp-session-id");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export type McpElicitationMode = "browser" | "model" | "native";

const MCP_ELICITATION_MODES = new Set<McpElicitationMode>(["browser", "model", "native"]);

export const readElicitationMode = (request: Request): McpElicitationMode => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("elicitation_mode");
  if (mode && MCP_ELICITATION_MODES.has(mode as McpElicitationMode)) {
    return mode as McpElicitationMode;
  }

  const legacyModelResume = url.searchParams.get("allow_model_resume");
  if (legacyModelResume !== null && TRUE_QUERY_VALUES.has(legacyModelResume.toLowerCase())) {
    return "model";
  }

  return "model";
};
