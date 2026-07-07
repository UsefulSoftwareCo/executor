// Cloud: a TRANSIENT WorkOS outage during the per-request live-membership check
// must NOT destroy a live MCP session. This is the churn-risk defect: every
// /mcp request re-verifies org membership against WorkOS, and a WorkOS
// 429/5xx/timeout used to be indistinguishable from a genuinely revoked
// membership — it collapsed to Forbidden, and a Forbidden carrying a session id
// schedules the session Durable Object for destruction (in-flight executions,
// paused approvals, undelivered results — all gone). For a shared-API-key org a
// single WorkOS blip could mass-condemn every session at once.
//
// The contract this pins: during the blip the request fails RETRYABLY (503),
// the session is left intact, and once WorkOS recovers the SAME session id keeps
// serving requests. We inject the outage at the real upstream by arming a fault
// on the WorkOS emulator's membership endpoint (the same emulator the product's
// real WorkOS SDK talks to) — no product code or stubs touched.
//
// Red/green: on the pre-fix code the outage request returns a session-destroying
// Forbidden, so the post-outage request gets 404 "reconnect" (the session is
// dead). With the fix the outage request is a 503 and the post-outage request is
// a clean 200.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { connectEmulator } from "@executor-js/emulate";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";
import { WORKOS_EMULATOR_PORT } from "../targets/cloud";

const JSON_AND_SSE = "application/json, text/event-stream";
const PROTOCOL_VERSION = "2025-03-26";

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "executor-e2e-workos-blip", version: "0.0.1" },
  },
};

const INITIALIZED_NOTIFICATION = {
  jsonrpc: "2.0" as const,
  method: "notifications/initialized",
};

const toolsList = (id: number) => ({
  jsonrpc: "2.0" as const,
  id,
  method: "tools/list",
  params: {},
});

type JsonRpcError = {
  readonly jsonrpc: string;
  readonly error: { readonly code: number; readonly message: string };
};

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

const mcpPost = (
  url: string,
  init: {
    readonly bearer?: string;
    readonly sessionId?: string;
    readonly body: unknown;
  },
): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: {
      accept: JSON_AND_SSE,
      "content-type": "application/json",
      ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      ...(init.sessionId ? { "mcp-session-id": init.sessionId } : {}),
    },
    body: JSON.stringify(init.body),
  });

/** initialize → session id → notifications/initialized. */
const openSession = async (mcpUrl: string, bearer: string): Promise<string> => {
  const initialize = await mcpPost(mcpUrl, {
    bearer,
    body: INITIALIZE_REQUEST,
  });
  const sessionId = initialize.headers.get("mcp-session-id");
  await initialize.text();
  if (initialize.status !== 200 || !sessionId) {
    throw new Error(`openSession: initialize failed (${initialize.status})`);
  }
  const initialized = await mcpPost(mcpUrl, {
    bearer,
    sessionId,
    body: INITIALIZED_NOTIFICATION,
  });
  await initialized.text();
  if (initialized.status !== 202) {
    throw new Error(`openSession: notifications/initialized failed (${initialized.status})`);
  }
  return sessionId;
};

// The live membership check is `GET /user_management/organization_memberships`
// (WorkOS `listOrganizationMemberships`). A bounded count covers the outage
// request without leaking into later (post-clear) requests; we also clear
// explicitly. `times` is generous so any internal retry inside the one faulted
// request still sees the outage, but the finalizer removes whatever remains.
const MEMBERSHIP_FAULT = {
  match: {
    method: "GET",
    pathPattern: "/user_management/organization_memberships*",
  },
  response: { status: 503, body: { error: "temporary upstream failure" } },
  times: 8,
} as const;

scenario(
  "MCP sessions · a transient WorkOS outage 503s retryably and leaves the session alive",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    const workos = yield* Effect.promise(() =>
      connectEmulator({ baseUrl: `http://127.0.0.1:${WORKOS_EMULATOR_PORT}` }),
    );

    // A healthy session doing real work before the outage.
    const sessionId = yield* Effect.promise(() => openSession(target.mcpUrl, bearer));
    const healthy = yield* Effect.promise(() =>
      mcpPost(target.mcpUrl, { bearer, sessionId, body: toolsList(2) }),
    );
    expect(healthy.status, "the session serves requests before the blip").toBe(200);
    yield* Effect.promise(() => healthy.text());

    yield* Effect.gen(function* () {
      // The blip: WorkOS membership lookups start failing with 503.
      yield* Effect.promise(() => workos.faults.arm(MEMBERSHIP_FAULT));

      // A request issued DURING the outage. The membership lookup fails
      // transiently — this must be a retryable 503, NOT a Forbidden (which
      // would condemn the session).
      const duringOutage = yield* Effect.promise(() =>
        mcpPost(target.mcpUrl, { bearer, sessionId, body: toolsList(3) }),
      );
      const outageBody = (yield* Effect.promise(() => duringOutage.json())) as JsonRpcError;
      expect(
        duringOutage.status,
        "a WorkOS blip is a retryable 503, not a session-destroying error",
      ).toBe(503);
      expect(
        duringOutage.status,
        "the blip is NOT surfaced as a 404 reconnect (which would mean the session was destroyed)",
      ).not.toBe(404);
      expect(
        outageBody.error.code,
        "the 503 is a JSON-RPC error envelope the transport retries",
      ).toBe(-32001);
      expect(
        duringOutage.headers.get("retry-after"),
        "the 503 advertises a Retry-After so clients back off",
      ).toEqual(expect.any(String));
    }).pipe(
      // Always lift the outage, even if an assertion above fails, so the
      // recovery request runs against a healthy WorkOS.
      Effect.ensuring(Effect.promise(() => workos.faults.clear())),
    );

    // WorkOS has recovered. The SAME session id must still serve requests: the
    // blip left it untouched. On the pre-fix code this is a 404 (the outage
    // request destroyed the DO); with the fix it is a clean 200.
    const afterOutage = yield* Effect.promise(() =>
      mcpPost(target.mcpUrl, { bearer, sessionId, body: toolsList(4) }),
    );
    expect(
      afterOutage.status,
      "the session survived the blip and resumes work once WorkOS recovers",
    ).toBe(200);
    yield* Effect.promise(() => afterOutage.text());
  }),
);
