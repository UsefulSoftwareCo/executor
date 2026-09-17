// Cloud: an MCP session's relationship to WorkOS after the membership mirror.
//
// Membership is authorized from the local mirror on every /mcp request
// (`auth/organization.ts`); WorkOS is a write target and an event source, not
// a per-request read. Two contracts follow, pinned here at the real upstream
// (faults armed on the WorkOS emulator's membership endpoint — the same
// emulator the product's real WorkOS SDK talks to; no product code or stubs
// touched):
//
// 1. A WorkOS OUTAGE is INVISIBLE to a live session. Before the mirror, a
//    5xx from the membership lookup had to be classified as transient (a
//    retryable 503 that left the session alive) so a blip could not
//    mass-condemn every session of a shared-API-key org. Now the request never
//    asks WorkOS at all: a request issued during the outage is a plain 200,
//    and the SAME session id keeps serving afterwards. The fault is armed on
//    the exact endpoint the old check hit, so an unnoticed regression back to
//    a per-request WorkOS read would fail this as a 503 (or worse, a 403).
//
// 2. A REVOKED membership still fails CLOSED. The mirror is not a cache with a
//    TTL: a removal made through the product writes the mirror in the same
//    request, so the removed member's next /mcp request is a Forbidden, the
//    session is condemned, and the id is dead. Retrying cannot help.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { connectEmulator } from "@executor-js/emulate";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";
import { WORKOS_EMULATOR_PORT } from "../targets/cloud";
import { cookieOf, joinOrg, orgSelectorOf } from "./support/session";

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

// The endpoint the pre-mirror per-request check hit
// (`GET /user_management/organization_memberships`). Armed to prove it is no
// longer on the request path: a request that reached it would fail. `times`
// is generous so any retry inside a faulted request still sees the outage; the
// finalizer removes whatever remains.
const MEMBERSHIP_FAULT = {
  match: {
    method: "GET",
    pathPattern: "/user_management/organization_memberships*",
  },
  response: { status: 503, body: { error: "temporary upstream failure" } },
  times: 8,
} as const;

scenario(
  "MCP sessions · a WorkOS outage is invisible to a live session, which is authorized from the mirror",
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
    expect(healthy.status, "the session serves requests before the outage").toBe(200);
    yield* Effect.promise(() => healthy.text());

    yield* Effect.gen(function* () {
      // The outage: WorkOS membership lookups would fail with 503 — if
      // anything asked.
      yield* Effect.promise(() => workos.faults.arm(MEMBERSHIP_FAULT));

      // A request issued DURING the outage. Membership is read from the
      // mirror, so WorkOS is never consulted and the request is a plain
      // success — not a retryable 503 (the pre-mirror contract) and never a
      // Forbidden (which would condemn the session).
      const duringOutage = yield* Effect.promise(() =>
        mcpPost(target.mcpUrl, { bearer, sessionId, body: toolsList(3) }),
      );
      expect(
        duringOutage.status,
        "a WorkOS outage does not touch a request: membership comes from the mirror",
      ).toBe(200);
      yield* Effect.promise(() => duringOutage.text());
    }).pipe(
      // Always lift the outage, even if an assertion above fails.
      Effect.ensuring(Effect.promise(() => workos.faults.clear())),
    );

    // The SAME session id keeps serving after the outage: nothing condemned it.
    const afterOutage = yield* Effect.promise(() =>
      mcpPost(target.mcpUrl, { bearer, sessionId, body: toolsList(4) }),
    );
    expect(afterOutage.status, "the session is untouched by the outage").toBe(200);
    yield* Effect.promise(() => afterOutage.text());
  }),
);

scenario(
  "MCP sessions · a revoked membership fails closed on the next request and condemns the session",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;

    // An admin's org with one plain member, joined through the real invite →
    // accept flow. The member is the one whose access is revoked.
    const admin = yield* target.newIdentity();
    const invitee = yield* target.newIdentity({ org: false });
    const member = yield* joinOrg(target, admin, invitee);
    const bearer = yield* mcp.mintBearer(emailOf(member));
    const orgSelector = orgSelectorOf(member);

    // The member's healthy session doing real work before the revocation.
    const mcpUrl = `${target.mcpUrl}`;
    const withOrg = (body: unknown, sessionId?: string) =>
      fetch(mcpUrl, {
        method: "POST",
        headers: {
          accept: JSON_AND_SSE,
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
          "x-executor-mcp-organization": orgSelector,
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify(body),
      });
    const initialize = yield* Effect.promise(() => withOrg(INITIALIZE_REQUEST));
    const sessionId = initialize.headers.get("mcp-session-id");
    yield* Effect.promise(() => initialize.text());
    expect(initialize.status, "the member opens a session in the org").toBe(200);
    if (!sessionId) throw new Error("initialize returned no session id");
    const initialized = yield* Effect.promise(() => withOrg(INITIALIZED_NOTIFICATION, sessionId));
    yield* Effect.promise(() => initialized.text());
    const healthy = yield* Effect.promise(() => withOrg(toolsList(2), sessionId));
    expect(healthy.status, "the session serves requests before the revocation").toBe(200);
    yield* Effect.promise(() => healthy.text());

    // The admin removes the member through the product. The removal writes
    // the mirror in the same request (a deletion tombstone keyed to the
    // WorkOS membership id), so no reconciler tick is needed for it to land.
    const members = yield* Effect.promise(async () => {
      const response = await fetch(new URL("/api/account/members", target.baseUrl), {
        headers: { ...(admin.headers ?? {}) },
      });
      if (!response.ok) throw new Error(`/api/account/members failed (${response.status})`);
      return (await response.json()) as {
        readonly members: ReadonlyArray<{ readonly id: string; readonly isCurrentUser: boolean }>;
      };
    });
    const removed = members.members.find((row) => !row.isCurrentUser);
    if (!removed) throw new Error("the joined member is not listed in the org");
    const removal = yield* Effect.promise(() =>
      fetch(new URL(`/api/account/members/${removed.id}`, target.baseUrl), {
        method: "DELETE",
        headers: { ...(admin.headers ?? {}), origin: new URL(target.baseUrl).origin },
      }),
    );
    expect(removal.status, "the admin removes the member").toBe(200);
    yield* Effect.promise(() => removal.text());

    // The removed member's NEXT request on the live session: a positive
    // determination from the mirror that they hold no active membership — a
    // real Forbidden, which condemns the session.
    const denied = yield* Effect.promise(() => withOrg(toolsList(3), sessionId));
    const deniedBody = (yield* Effect.promise(() => denied.json())) as JsonRpcError;
    expect(denied.status, "a revoked member fails closed as Forbidden on the next request").toBe(
      403,
    );
    expect(deniedBody.error.code, "the denial is a JSON-RPC error envelope").toBe(-32001);

    // While revoked, every further request is refused at the gate — still a
    // Forbidden, never a 200 (a removed member kept a live session) and never
    // a retryable 503 (nothing about this is transient).
    const stillDenied = yield* Effect.promise(() => withOrg(toolsList(4), sessionId));
    expect(stillDenied.status, "a revoked member stays refused, deterministically").toBe(403);
    yield* Effect.promise(() => stillDenied.text());

    // The Forbidden carried the session id, so the session was condemned. A
    // caller the gate admits proves it: the admin, still a member, presents
    // the condemned id with their own bearer. Had the id survived, the answer
    // would be the ownership Forbidden (-32003: the session belongs to someone
    // else); condemned, it is dead and the client is told to reconnect.
    const adminBearer = yield* mcp.mintBearer(emailOf(admin));
    const condemned = yield* Effect.promise(() =>
      fetch(mcpUrl, {
        method: "POST",
        headers: {
          accept: JSON_AND_SSE,
          "content-type": "application/json",
          authorization: `Bearer ${adminBearer}`,
          "x-executor-mcp-organization": orgSelectorOf(admin),
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify(toolsList(5)),
      }),
    );
    expect(condemned.status, "the condemned session id is dead (reconnect required)").toBe(404);
    const condemnedBody = (yield* Effect.promise(() => condemned.json())) as JsonRpcError;
    expect(condemnedBody.error.message, "the client is told to reconnect").toMatch(
      /timed out|reconnect|not found/i,
    );

    // The admin's own access is unaffected by removing someone else.
    const adminStillIn = yield* Effect.promise(() =>
      fetch(new URL("/api/account/me", target.baseUrl), { headers: { cookie: cookieOf(admin) } }),
    );
    expect(adminStillIn.status, "the admin keeps their access").toBe(200);
    yield* Effect.promise(() => adminStillIn.text());
  }),
);
