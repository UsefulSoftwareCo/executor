// Cloud: the org identity a session needs at init travels in the session props
// the worker already resolved — it is NOT re-read from Postgres inside the
// session Durable Object.
//
// The defect this pins: on EVERY cold DO init the DO opened a brand-new
// Postgres connection purely to re-read the `organizations` row the worker had
// just read microseconds earlier on the same request (the worker threw it away:
// the auth principal hardcoded an empty organization name). When that fresh
// connection could not be established the whole `initialize` died — a hard,
// client-visible failure on a healthy database, because the only unhealthy
// thing was a socket nothing needed to open.
//
// Two contracts, in the order a user meets them:
//
//   1. the session opens and WORKS — initialize mints a session id and the same
//      id then serves `tools/list`, all off the identity the props carried;
//   2. the whole request performs exactly ONE organization read (the worker's
//      own authorization check) and the DO opens no database connection of its
//      own to name the org.
//
// (2) is asserted on the EXPORTED spans, and the two planes — worker and
// Durable Object — export independently, so the count is only taken once a
// worker-plane span for this same request has landed. Without that wait a
// still-pending worker batch would make a two-read request look like a one-read
// request, and the assertion would pass for the wrong reason.
//
// The failure half of the fix (an unreachable directory becomes a bounded retry
// and a retryable 503 rather than a bare 500) is not reachable from here: the
// harness runs one single-process PGlite shared by the worker and the DO, and
// the worker's own authorization reads that same row on the same request — so
// freezing the database fails the request before init identically on both sides
// of the fix. Those branches are pinned in
// `apps/cloud/src/mcp/session-meta.node.test.ts`.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target, Telemetry } from "../src/services";
import type { Identity } from "../src/target";

const JSON_AND_SSE = "application/json, text/event-stream";

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "executor-e2e-session-cold-init", version: "0.0.1" },
  },
};

const INITIALIZED_NOTIFICATION = {
  jsonrpc: "2.0" as const,
  method: "notifications/initialized",
};

const TOOLS_LIST_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 2,
  method: "tools/list",
  params: {},
};

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

/** A client-supplied W3C trace context, so every span this one request produces
 *  — worker plane and Durable Object alike — is addressable by one trace id. */
const newTraceContext = (): { readonly traceId: string; readonly traceparent: string } => {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return { traceId, traceparent: `00-${traceId}-${spanId}-01` };
};

const mcpPost = (
  url: string,
  init: {
    readonly bearer: string;
    readonly sessionId?: string;
    readonly traceparent?: string;
    readonly body: unknown;
  },
): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: {
      accept: JSON_AND_SSE,
      "content-type": "application/json",
      authorization: `Bearer ${init.bearer}`,
      ...(init.sessionId ? { "mcp-session-id": init.sessionId } : {}),
      ...(init.traceparent ? { traceparent: init.traceparent } : {}),
    },
    body: JSON.stringify(init.body),
  });

scenario(
  "MCP session cold init · the org identity rides in the session props instead of a second Postgres read",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const telemetry = yield* Telemetry;

    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const trace = newTraceContext();

    // ---- 1. the session opens, and it works -------------------------------
    const response = yield* Effect.promise(() =>
      mcpPost(target.mcpUrl, {
        bearer,
        traceparent: trace.traceparent,
        body: INITIALIZE_REQUEST,
      }),
    );
    yield* Effect.promise(() => response.text());
    expect(response.status, "initialize opens a session").toBe(200);
    const sessionId = response.headers.get("mcp-session-id");
    expect(sessionId, "the session id is minted").toBeTruthy();

    const initialized = yield* Effect.promise(() =>
      mcpPost(target.mcpUrl, {
        bearer,
        sessionId: sessionId ?? "",
        body: INITIALIZED_NOTIFICATION,
      }),
    );
    yield* Effect.promise(() => initialized.text());
    expect(initialized.status, "the client completes the handshake").toBe(202);

    // The session built from the props-carried identity actually serves work —
    // the production symptom was an `initialize` that never got this far.
    const tools = yield* Effect.promise(() =>
      mcpPost(target.mcpUrl, {
        bearer,
        sessionId: sessionId ?? "",
        body: TOOLS_LIST_REQUEST,
      }),
    );
    const toolsBody = yield* Effect.promise(() => tools.text());
    expect(tools.status, "the session serves requests once open").toBe(200);
    expect(toolsBody, "the session advertises the execute tool").toContain("execute");

    // ---- 2. one organization read for the whole init request --------------
    // The DO really did resolve meta on this request (a cold init), and it
    // resolved it from the props the worker handed over.
    const resolveSpan = yield* telemetry.expectSpan({
      traceId: trace.traceId,
      operation: "McpSessionDOSqlite.resolveSessionMeta",
    });
    expect(resolveSpan.span.status, "the cold init resolved its meta without failing").toBe("ok");

    // The worker plane exports on its own batch, independently of the DO's.
    // Wait for a worker-plane span from this same request before counting, or
    // an unflushed worker batch would hide the very read being counted.
    yield* telemetry.expectSpan({ traceId: trace.traceId, operation: "mcp.request" });

    // One org read for the whole request: the worker's own authorization
    // lookup. A second one means the DO reopened a connection to re-read a row
    // the request already had.
    const orgReads = yield* telemetry.searchSpans({
      traceId: trace.traceId,
      operation: "user_store.getOrganization",
    });
    expect(
      orgReads.length,
      "only the worker's authorization check reads the organization row",
    ).toBe(1);

    // …and the DO's own database step never ran at all. `resolveSessionMeta`
    // has already landed and this span is its child, so its absence here is
    // absence, not lag.
    const doDatabaseReads = yield* telemetry.searchSpans({
      traceId: trace.traceId,
      operation: "mcp.session.resolve_organization",
    });
    expect(
      doDatabaseReads.length,
      "the session DO opens no connection of its own to name the organization",
    ).toBe(0);

    // …because the identity it used is the one the worker handed it.
    expect(
      resolveSpan.span.tags["mcp.session.meta_source"],
      "the session meta comes from the props the worker already resolved",
    ).toBe("props");
  }),
);
