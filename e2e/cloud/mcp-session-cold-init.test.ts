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
// The contract asserted here is deliberately about the DATA PATH, not the
// failure: `McpSessionDOSqlite.resolveSessionMeta` reports where the org
// identity came from, and the whole request performs exactly ONE org read (the
// worker's own authorization check) instead of two.
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

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

/** A client-supplied W3C trace context, so every span this one request produces
 *  — worker plane and Durable Object alike — is addressable by one trace id. */
const newTraceContext = (): { readonly traceId: string; readonly traceparent: string } => {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return { traceId, traceparent: `00-${traceId}-${spanId}-01` };
};

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

    const response = yield* Effect.promise(() =>
      fetch(target.mcpUrl, {
        method: "POST",
        headers: {
          accept: JSON_AND_SSE,
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
          traceparent: trace.traceparent,
        },
        body: JSON.stringify(INITIALIZE_REQUEST),
      }),
    );
    yield* Effect.promise(() => response.text());
    expect(response.status, "initialize opens a session").toBe(200);
    expect(response.headers.get("mcp-session-id"), "the session id is minted").toBeTruthy();

    // The DO really did resolve meta on this request (a cold init), and it
    // resolved it from the props the worker handed over.
    const resolveSpan = yield* telemetry.expectSpan({
      traceId: trace.traceId,
      operation: "McpSessionDOSqlite.resolveSessionMeta",
    });
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

    expect(
      resolveSpan.span.tags["mcp.session.meta_source"],
      "the session meta comes from the props the worker already resolved",
    ).toBe("props");
  }),
);
