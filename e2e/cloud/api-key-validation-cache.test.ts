// Cloud: an Executor API key presented as a bearer is validated against
// WorkOS once per TTL window, not once per request. Every API-key-
// authenticated request used to buy a live `POST /api_keys/validations`
// round trip; with the per-isolate success cache, the first request pays it
// and back-to-back follow-ups ride the cached owner.
//
// Pinned black-box at the real upstream: the WorkOS emulator the cloud stack
// boots against keeps a request ledger, and a validation request carries the
// presented key value in its body — so "how many times was THIS key
// validated" is readable from the upstream's own records. The guarantees:
//
//  1. Back-to-back requests on one key land exactly ONE validation on
//     WorkOS. Without the cache this is one validation per request.
//  2. A DIFFERENT key is validated on its own first request — the cache is
//     keyed by credential, so key B neither rides key A's cached owner
//     (which would be a cross-credential auth hole) nor disturbs key A's
//     entry.
//
// Two scenarios because the two bearer surfaces wire the cache differently:
//
//  - /api/* resolves `ApiKeyService` from the app's boot layer, built once
//    per isolate.
//  - /mcp is served outside the app envelope by the agent handler, which
//    builds `cloudMcpAuth` once per isolate on a memoized ManagedRuntime
//    (apps/cloud/src/mcp/agent-handler.ts). It used to provide that layer
//    per request — a fresh `ApiKeyService`, a fresh cache map, a WorkOS
//    round trip on every MCP request — so this scenario pins the shared
//    wiring, not just the cache.
//
// Attribution: the emulator redacts secret-named fields (the response's
// `api_key` object), but the request body's `value` survives, and every key
// minted here is unique to this run — so filtering the shared suite-wide
// ledger by the key's own value is collision-free.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { AccountHttpApi } from "@executor-js/api";
import { connectEmulator, type EmulatorClient, type LedgerEntry } from "@executor-js/emulate";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";
import { WORKOS_EMULATOR_PORT } from "../targets/cloud";

const JSON_AND_SSE = "application/json, text/event-stream";
const PROTOCOL_VERSION = "2025-03-26";

/** The WorkOS route `apiKeys.validateApiKey` posts to — the round trip the
 *  cache exists to avoid. */
const VALIDATIONS_PATH = "/api_keys/validations";

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "executor-e2e-apikey-cache", version: "0.0.1" },
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

const mcpPost = (
  url: string,
  init: {
    readonly bearer: string;
    readonly sessionId?: string;
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
    },
    body: JSON.stringify(init.body),
  });

/** initialize → session id → notifications/initialized, all on the API key. */
const openSession = async (mcpUrl: string, bearer: string): Promise<string> => {
  const initialize = await mcpPost(mcpUrl, { bearer, body: INITIALIZE_REQUEST });
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

/** One tools/list on an open session; the response must be a real tool list,
 *  so a validation count of one can never come from requests that bounced at
 *  the door. */
const listTools = async (
  mcpUrl: string,
  init: { readonly bearer: string; readonly sessionId: string; readonly id: number },
): Promise<void> => {
  const response = await mcpPost(mcpUrl, {
    bearer: init.bearer,
    sessionId: init.sessionId,
    body: toolsList(init.id),
  });
  const text = await response.text();
  if (response.status !== 200 || !text.includes('"tools"')) {
    throw new Error(`listTools(id=${init.id}): failed (${response.status}): ${text.slice(0, 200)}`);
  }
};

/** One API-key-authenticated read of the protected API; the response must be
 *  a real integration listing (same reason as `listTools`). */
const listIntegrations = async (baseUrl: string, bearer: string): Promise<void> => {
  const response = await fetch(new URL("/api/integrations", baseUrl), {
    headers: { authorization: `Bearer ${bearer}` },
  });
  const text = await response.text();
  if (response.status !== 200 || !text.includes('"slug"')) {
    throw new Error(`listIntegrations: failed (${response.status}): ${text.slice(0, 200)}`);
  }
};

/** The ledger entries in which WorkOS was asked to validate THIS key value. */
const validationsOf = (
  entries: ReadonlyArray<LedgerEntry>,
  keyValue: string,
): ReadonlyArray<LedgerEntry> =>
  entries.filter(
    (entry) =>
      entry.path === VALIDATIONS_PATH &&
      typeof entry.request.body === "object" &&
      entry.request.body !== null &&
      (entry.request.body as { readonly value?: unknown }).value === keyValue,
  );

/** The shared fixtures both scenarios start from: two freshly minted keys
 *  (revoked on exit) and the WorkOS emulator the target validates against. */
const mintTwoKeys = Effect.gen(function* () {
  const target = yield* Target;
  const { client: apiClient } = yield* Api;
  const identity = yield* target.newIdentity();
  const client = yield* apiClient(AccountHttpApi, identity);

  const workos: EmulatorClient = yield* Effect.promise(() =>
    connectEmulator({ baseUrl: `http://127.0.0.1:${WORKOS_EMULATOR_PORT}` }),
  );

  const mintKey = (name: string) =>
    Effect.gen(function* () {
      const created = yield* client.account.createApiKey({ payload: { name } });
      yield* Effect.addFinalizer(() =>
        client.account.revokeApiKey({ params: { apiKeyId: created.id } }).pipe(Effect.ignore),
      );
      return created;
    });

  const keyA = yield* mintKey("e2e validation-cache key A");
  const keyB = yield* mintKey("e2e validation-cache key B");

  const readValidations = (keyValue: string) =>
    Effect.promise(async () => validationsOf(await workos.ledger.list(500), keyValue));

  return { target, keyA, keyB, readValidations } as const;
});

scenario(
  "API keys · back-to-back API requests validate the key with WorkOS once, and each key validates independently",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const { target, keyA, keyB, readValidations } = yield* mintTwoKeys;

      // ── Key A: two authenticated reads back to back ───────────────────────
      // Without the cache each request is its own WorkOS round trip; with it,
      // only the first request's miss reaches WorkOS.
      yield* Effect.promise(() => listIntegrations(target.baseUrl, keyA.value));
      yield* Effect.promise(() => listIntegrations(target.baseUrl, keyA.value));

      const afterA = yield* readValidations(keyA.value);
      expect(
        afterA.map((entry) => entry.summary),
        "back-to-back API requests cost exactly one WorkOS validation",
      ).toHaveLength(1);

      // ── Key B: a different credential misses the cache on its own ─────────
      // Key B's first request MUST reach WorkOS: a zero here would mean the
      // cache handed key A's owner to a different credential.
      yield* Effect.promise(() => listIntegrations(target.baseUrl, keyB.value));

      const afterB = yield* readValidations(keyB.value);
      expect(
        afterB.map((entry) => entry.summary),
        "a different key is validated on its own first request",
      ).toHaveLength(1);

      // And key B's request did not spend or duplicate key A's cache entry.
      const finalA = yield* readValidations(keyA.value);
      expect(
        finalA.map((entry) => entry.summary),
        "key A's single validation is undisturbed by key B's request",
      ).toHaveLength(1);
    }),
  ),
);

scenario(
  "MCP · back-to-back API-key requests validate the key with WorkOS once, and each key validates independently",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const { target, keyA, keyB, readValidations } = yield* mintTwoKeys;

      // ── Key A: one session, two tool-surface calls back to back ──────────
      // Four API-key-authenticated requests in total (initialize, initialized,
      // tools/list ×2). Without the cache each one is its own WorkOS round
      // trip; with it, only the first request's miss reaches WorkOS.
      const sessionA = yield* Effect.promise(() => openSession(target.mcpUrl, keyA.value));
      yield* Effect.promise(() =>
        listTools(target.mcpUrl, { bearer: keyA.value, sessionId: sessionA, id: 2 }),
      );
      yield* Effect.promise(() =>
        listTools(target.mcpUrl, { bearer: keyA.value, sessionId: sessionA, id: 3 }),
      );

      const afterA = yield* readValidations(keyA.value);
      expect(
        afterA.map((entry) => entry.summary),
        "the whole API-key session cost exactly one WorkOS validation",
      ).toHaveLength(1);

      // ── Key B: a different credential misses the cache on its own ────────
      // Key B's first request MUST reach WorkOS: a zero here would mean the
      // cache handed key A's owner to a different credential.
      const sessionB = yield* Effect.promise(() => openSession(target.mcpUrl, keyB.value));
      yield* Effect.promise(() =>
        listTools(target.mcpUrl, { bearer: keyB.value, sessionId: sessionB, id: 2 }),
      );

      const afterB = yield* readValidations(keyB.value);
      expect(
        afterB.map((entry) => entry.summary),
        "a different key is validated on its own first request",
      ).toHaveLength(1);

      // And key B's session did not spend or duplicate key A's cache entry.
      const finalA = yield* readValidations(keyA.value);
      expect(
        finalA.map((entry) => entry.summary),
        "key A's single validation is undisturbed by key B's session",
      ).toHaveLength(1);
    }),
  ),
);
