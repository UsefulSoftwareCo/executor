// ---------------------------------------------------------------------------
// Regression coverage for the transient DO-relocation retry in the worker-side
// session-store dispatcher.
//
// Cloudflare may relocate a live Durable Object between machines; an in-flight
// `init` then throws "cannot access storage because object has moved to a
// different machine". Before the retry, that rejection became an unrecoverable
// defect the envelope rendered as a -32603 — exactly the prod incident on
// 2026-06-15 (one `mcp.do.init` failure a reconnect cleared). These tests inject
// that rejection at the `McpSessionDOStub` seam and pin the recovery behavior.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";

import {
  McpSessionStore,
  defaultMcpResource,
  type McpDispatchResult,
  type Principal,
} from "@executor-js/host-mcp";

import {
  DO_RELOCATION_MAX_RETRIES,
  makeDurableObjectMcpSessionStore,
  type McpSessionInit,
  type McpSessionDOStub,
} from "./session-store";
import { INTERNAL_RESOURCE_KEY_HEADER } from "./do-headers";

const RELOCATION_ERROR = "cannot access storage because object has moved to a different machine";

const TEST_PRINCIPAL: Principal = {
  accountId: "user_test",
  organizationId: "org_test",
  organizationName: "Test Org",
  email: "test@example.com",
  name: "Test",
  avatarUrl: null,
  roles: ["user"],
};

/** A POST with no session id — routes dispatch through the create/init path. */
const initializeRequest = (): Request =>
  new Request("https://mcp.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }),
  });

/** The JSON-RPC body the faked DO returns once `init` succeeds. */
const okResponse = (): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 0, result: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Drive `dispatch` for a create over a store built from one fake stub. */
const dispatchCreate = (stub: McpSessionDOStub): Effect.Effect<McpDispatchResult> =>
  Effect.gen(function* () {
    const store = yield* McpSessionStore;
    return yield* store.dispatch({
      request: initializeRequest(),
      principal: TEST_PRINCIPAL,
      resource: defaultMcpResource,
      sessionId: null,
      method: "POST",
    });
  }).pipe(
    Effect.provide(makeDurableObjectMcpSessionStore({ newStub: () => stub, getStub: () => stub })),
  );

/** Rendered cause of a failed dispatch (empty for a success) — keeps the
 *  message assertion unconditional, off the `Exit.isFailure` branch. */
const failureText = (exit: Exit.Exit<McpDispatchResult>): string =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";

describe("makeDurableObjectMcpSessionStore — DO-relocation retry", () => {
  it.live("passes the requested MCP resource into session init", () =>
    Effect.gen(function* () {
      let initMeta: McpSessionInit | undefined;
      const stub: McpSessionDOStub = {
        init: (meta) => {
          initMeta = meta;
          return Promise.resolve();
        },
        handleRequest: () => Promise.resolve(okResponse()),
        clearSession: () => Promise.resolve(),
      };

      const result = yield* Effect.gen(function* () {
        const store = yield* McpSessionStore;
        return yield* store.dispatch({
          request: initializeRequest(),
          principal: TEST_PRINCIPAL,
          resource: { kind: "toolkit", slug: "deploy" },
          sessionId: null,
          method: "POST",
        });
      }).pipe(
        Effect.provide(
          makeDurableObjectMcpSessionStore({ newStub: () => stub, getStub: () => stub }),
        ),
      );

      expect(result).toBeInstanceOf(Response);
      expect(initMeta?.resource, "the DO session is keyed to the requested resource").toEqual({
        kind: "toolkit",
        slug: "deploy",
      });
    }),
  );

  it.live("stamps the requested MCP resource on forwarded session requests", () =>
    Effect.gen(function* () {
      let forwardedResourceKey: string | null = null;
      const stub: McpSessionDOStub = {
        init: () => Promise.resolve(),
        handleRequest: (request) => {
          forwardedResourceKey = request.headers.get(INTERNAL_RESOURCE_KEY_HEADER);
          return Promise.resolve(okResponse());
        },
        clearSession: () => Promise.resolve(),
      };

      const result = yield* Effect.gen(function* () {
        const store = yield* McpSessionStore;
        return yield* store.dispatch({
          request: initializeRequest(),
          principal: TEST_PRINCIPAL,
          resource: { kind: "toolkit", slug: "deploy" },
          sessionId: "existing-session",
          method: "POST",
        });
      }).pipe(
        Effect.provide(
          makeDurableObjectMcpSessionStore({ newStub: () => stub, getStub: () => stub }),
        ),
      );

      expect(result).toBeInstanceOf(Response);
      expect(
        forwardedResourceKey,
        "the DO can reject a session id reused on another resource",
      ).toBe("toolkit:deploy");
    }),
  );

  it.live("retries mcp.do.init past a relocation, then returns the DO response", () =>
    Effect.gen(function* () {
      let initCalls = 0;
      let handleCalls = 0;
      const stub: McpSessionDOStub = {
        init: () => {
          initCalls += 1;
          if (initCalls === 1) {
            // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: fake DO stub rejects to simulate a Cloudflare relocation throw
            return Promise.reject(new Error(RELOCATION_ERROR));
          }
          return Promise.resolve();
        },
        handleRequest: () => {
          handleCalls += 1;
          return Promise.resolve(okResponse());
        },
        clearSession: () => Promise.resolve(),
      };

      const result = yield* dispatchCreate(stub);

      expect(initCalls, "init retried once after the relocation").toBe(2);
      expect(handleCalls, "handleRequest runs once, after init recovers").toBe(1);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(200);
    }),
  );

  it.live("gives up after the retry budget when relocation never clears", () =>
    Effect.gen(function* () {
      let initCalls = 0;
      let handleCalls = 0;
      const stub: McpSessionDOStub = {
        init: () => {
          initCalls += 1;
          // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: fake DO stub rejects to simulate a Cloudflare relocation throw
          return Promise.reject(new Error(RELOCATION_ERROR));
        },
        handleRequest: () => {
          handleCalls += 1;
          return Promise.resolve(okResponse());
        },
        clearSession: () => Promise.resolve(),
      };

      const exit = yield* Effect.exit(dispatchCreate(stub));

      expect(Exit.isFailure(exit), "exhausted retries surface as a defect").toBe(true);
      expect(initCalls, "one initial attempt plus the full retry budget").toBe(
        1 + DO_RELOCATION_MAX_RETRIES,
      );
      expect(handleCalls, "handleRequest is never reached when init never succeeds").toBe(0);
      expect(failureText(exit), "the relocation cause is preserved").toContain(RELOCATION_ERROR);
    }),
  );

  it.live("does not retry a non-relocation failure — surfaces it immediately", () =>
    Effect.gen(function* () {
      let initCalls = 0;
      const stub: McpSessionDOStub = {
        init: () => {
          initCalls += 1;
          // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: fake DO stub rejects to simulate a non-transient init failure
          return Promise.reject(new Error("schema spread bug — not transient"));
        },
        handleRequest: () => Promise.resolve(okResponse()),
        clearSession: () => Promise.resolve(),
      };

      const exit = yield* Effect.exit(dispatchCreate(stub));

      expect(Exit.isFailure(exit), "a non-transient rejection still dies").toBe(true);
      expect(initCalls, "non-relocation errors are not retried").toBe(1);
      expect(failureText(exit), "the original failure is preserved").toContain("schema spread bug");
    }),
  );
});
