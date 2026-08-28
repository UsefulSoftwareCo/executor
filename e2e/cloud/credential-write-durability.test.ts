// Cloud: a refreshed OAuth credential has to be PERSISTED, and persisting it is
// a pair of version-checked writes into WorkOS Vault — the rotated refresh
// token and the new access token, one after the other, not atomically. Three
// production failures live in that gap.
//
//  1. Contention. Two concurrent probes of one connection each run a refresh and
//     each write the same two objects, so a version-checked write comes back 409
//     ("Current version does not match expected version"). A write that retries
//     with no wait re-collides inside the peer's own round trip, drains its
//     attempts in microseconds, and the refresh fails outright — the user saw a
//     500 on a connection health request.
//  2. Ordering. If the write that fails is the one carrying the rotated refresh
//     token, the credential is gone for good: minting already spent the refresh
//     token we sent, so nothing can mint again and every later use of the
//     connection comes back `invalid_grant`. The access token, by contrast, is
//     disposable — one more grant re-mints it.
//  3. Writability. Ordering bounds the damage but cannot remove it: when the
//     store refuses writes outright, a grant that has already run has spent the
//     stored refresh token and there is nowhere to put its successor. The
//     refresh must therefore be gated on a store that is proven writable BEFORE
//     the grant, so a storage outage costs the user nothing but the wait.
//
// Both are pinned here at the product surface, black box. Failures are armed on
// the WorkOS emulator that the product's own WorkOS client talks to; no product
// code, stubs, or internals are touched. Contention is modelled twice, because
// the two halves of the write policy fail differently: by a COUNT of collisions
// (does the loop have enough attempts, and does it still land the value when it
// runs out?) and by a WINDOW of time (does it wait long enough between attempts
// to still be trying when the peer lets go?). Every scenario also reads the
// emulator's ledger back to prove the collisions it armed were really served —
// a fault whose pattern stopped matching would otherwise leave a test that
// passes without ever contending.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import {
  type ArmedFault,
  connectEmulator,
  type EmulatorClient,
  type FaultArmInput,
} from "@executor-js/emulate";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import { WORKOS_EMULATOR_PORT } from "../targets/cloud";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

const VAULT_CONFLICT_RESPONSE = {
  status: 409,
  body: { code: "conflict", message: "Current version does not match expected version" },
} as const;

/** Every PUT the vault serves for a stored object — the version-checked write. */
const VAULT_WRITE = { method: "PUT", pathPattern: "/vault/v1/kv/*" } as const;

type UpstreamHandle = {
  readonly url: string;
  /** Stop honouring the bearer(s) seen so far, exactly as a revocation would —
   *  the deterministic way to make the very next call run a refresh. */
  readonly revokeSeenBearers: () => void;
  readonly close: () => void;
};

/** Upstream on 127.0.0.1 that authenticates for real: `GET /issues` is 200 for
 *  any bearer it has not been told to reject, and 401 for one it has. */
const serveUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<UpstreamHandle>((resume) => {
      const seen: string[] = [];
      const revoked = new Set<string>();
      const server = createServer((request, response) => {
        const bearer = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (request.method === "GET" && (request.url ?? "").startsWith("/issues")) {
          seen.push(bearer);
          if (revoked.has(bearer)) {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "invalid_token" }));
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ issues: [{ id: 1, title: "first" }] }));
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
            revokeSeenBearers: () => {
              for (const bearer of seen) revoked.add(bearer);
            },
            close: () => {
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(server.close),
  );

const spec = (
  baseUrl: string,
  oauth: { readonly authorizationEndpoint: string; readonly tokenEndpoint: string },
): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Issues API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/issues": {
        get: {
          operationId: "listIssues",
          summary: "List issues",
          security: [{ oauth: ["issues.read"] }],
          responses: { "200": { description: "issues" } },
        },
      },
    },
    components: {
      securitySchemes: {
        oauth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              scopes: { "issues.read": "Read issues" },
            },
          },
        },
      },
    },
  });

const invokeByAddressCode = (address: string, args: unknown) => `
const segments = ${JSON.stringify(address)}.split(".").slice(1);
let node = tools;
for (const segment of segments) node = node[segment];
const result = await node(${JSON.stringify(args)});
return JSON.stringify(result);
`;

/** One vault object as the emulated WorkOS itself sees it. Read from the
 *  emulator control plane — upstream state, never the product's own. */
type VaultObject = { readonly id: string; readonly name: string };

/** Read a vault row out of the emulator's generic store snapshot, or null when
 *  it is not shaped like one. */
const readVaultObject = (row: Record<string, unknown>): VaultObject | null =>
  typeof row.workos_id === "string" && typeof row.name === "string"
    ? { id: row.workos_id, name: row.name }
    : null;

/** Every vault object this connection owns. The object name embeds the logical
 *  item id, so the connection's own objects are the ones carrying its slug. */
const vaultObjectsFor = (workos: EmulatorClient, slug: string): Effect.Effect<VaultObject[]> =>
  Effect.promise(async () => {
    const snapshot = await workos.state();
    const items = snapshot.collections["workos.vault_objects"]?.items ?? [];
    return items
      .map((item) => readVaultObject({ ...item }))
      .filter((object): object is VaultObject => object !== null && object.name.includes(slug));
  });

/** Arm a fault on the shared emulator and take it back down with the scope, by
 *  id — a blanket `faults.clear()` would also disarm a neighbouring scenario's. */
const armFault = (workos: EmulatorClient, input: FaultArmInput) =>
  Effect.acquireRelease(
    Effect.promise(() => workos.faults.arm(input)),
    (armed) => Effect.promise(() => workos.faults.clear(armed.id)).pipe(Effect.ignore),
  );

/** How many responses this armed fault actually injected, read back from the
 *  emulator's ledger. This is the proof that the failure under test HAPPENED:
 *  an armed fault whose pattern never matched leaves the product's writes
 *  untouched, and a scenario asserting only "the call worked" would pass
 *  without ever exercising the retry it claims to cover. */
const faultsServed = (workos: EmulatorClient, armed: ArmedFault): Effect.Effect<number> =>
  Effect.promise(async () => {
    const entries = await workos.ledger.list(200);
    return entries.filter((entry) => entry.faultId === armed.id).length;
  });

/** Keep the vault's version-checked writes losing for a WINDOW of time that
 *  starts at the first collision the product actually suffers — a peer writer
 *  that holds the object for a while, rather than a fixed number of collisions.
 *  This is the shape of the production failure: attempts spaced by a wait
 *  outlast the peer's round trip; attempts fired back to back all land inside
 *  it, drain, and the refresh dies.
 *
 *  Anchoring on the first collision (not on arming) is what makes it
 *  deterministic — a refresh only begins several round trips after the fault is
 *  armed, so a window measured from arming would already be over. */
const holdWritesInConflict = (workos: EmulatorClient, windowMillis: number) =>
  Effect.gen(function* () {
    // Far more conflicts than any bounded retry policy can consume, so the
    // window — not a counter — is what ends the contention.
    const armed = yield* armFault(workos, {
      match: VAULT_WRITE,
      response: VAULT_CONFLICT_RESPONSE,
      times: 64,
    });
    const released = (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const live = (await workos.faults.list()).find((fault) => fault.id === armed.id);
        if (!live || live.remaining < armed.times) break;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      await new Promise((resolve) => setTimeout(resolve, windowMillis));
      await workos.faults.clear(armed.id);
    })().catch(() => undefined);
    return { armed, released };
  });

type CallResult = { readonly ok: boolean; readonly text: string };

type ToolEnvelope = {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly status?: number;
  };
};

/** An OAuth-backed integration, connected and proven working, plus the handles
 *  needed to break its credential writes: the upstream that can revoke a bearer
 *  (the deterministic refresh trigger) and the WorkOS emulator that serves the
 *  vault. Everything it creates is torn down by scope finalizers. */
const connectIntegration = Effect.gen(function* () {
  const target = yield* Target;
  const { client: makeClient } = yield* Api;
  const mcp = yield* Mcp;
  const identity = yield* target.newIdentity();
  const client = yield* makeClient(api, identity);
  const upstream = yield* serveUpstream();
  // Long-lived tokens: the proactive expiry check must never fire, so the
  // upstream's 401 is the only thing that triggers the refresh whose
  // persistence is under test.
  const oauth = yield* serveOAuthTestServer({
    scopes: ["issues.read"],
    tokenExpiresInSeconds: 3600,
  });
  const workos = yield* Effect.promise(() =>
    connectEmulator({ baseUrl: `http://127.0.0.1:${WORKOS_EMULATOR_PORT}` }),
  );
  const slug = unique("credwrite");
  const clientSlug = OAuthClientSlug.make(unique("credwriteclient"));

  yield* client.openapi.addSpec({
    payload: {
      spec: { kind: "blob", value: spec(upstream.url, oauth) },
      slug,
      baseUrl: upstream.url,
      authenticationTemplate: [
        {
          slug: "oauth",
          kind: "oauth2",
          authorizationUrl: oauth.authorizationEndpoint,
          tokenUrl: oauth.tokenEndpoint,
          scopes: ["issues.read"],
        },
      ],
    },
  });
  yield* Effect.addFinalizer(() =>
    client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
  );

  yield* client.oauth.createClient({
    payload: {
      owner: "org",
      slug: clientSlug,
      grant: "authorization_code",
      authorizationUrl: oauth.authorizationEndpoint,
      tokenUrl: oauth.tokenEndpoint,
      clientId: "test-client",
      clientSecret: "test-secret",
      originIntegration: IntegrationSlug.make(slug),
    },
  });
  yield* Effect.addFinalizer(() =>
    client.oauth
      .removeClient({ params: { slug: clientSlug }, payload: { owner: "org" } })
      .pipe(Effect.ignore),
  );

  const started = yield* client.oauth.start({
    payload: {
      client: clientSlug,
      clientOwner: "org",
      owner: "org",
      name: ConnectionName.make("main"),
      integration: IntegrationSlug.make(slug),
      template: AuthTemplateSlug.make("oauth"),
    },
  });
  expect(started.status, "oauth.start redirects to the authorization server").toBe("redirect");
  if (started.status !== "redirect") return yield* Effect.die("no redirect");

  // Drive the test IdP's consent by hand (authorize -> login -> code).
  const code = yield* Effect.promise(async () => {
    const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
    const loginUrl = authorize.headers.get("location");
    if (!loginUrl) throw new Error(`authorize did not redirect: ${authorize.status}`);
    const login = await fetch(loginUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("alice:password").toString("base64")}`,
      },
      redirect: "manual",
    });
    const callbackUrl = login.headers.get("location");
    if (!callbackUrl) throw new Error(`login did not redirect: ${login.status}`);
    const minted = new URL(callbackUrl).searchParams.get("code");
    if (!minted) throw new Error("callback carried no authorization code");
    return minted;
  });
  yield* client.oauth.complete({ payload: { state: started.state, code } });
  yield* Effect.addFinalizer(() =>
    client.connections
      .remove({
        params: {
          owner: "org",
          integration: IntegrationSlug.make(slug),
          name: ConnectionName.make("main"),
        },
      })
      .pipe(Effect.ignore),
  );

  const tools = yield* client.tools.list({ query: {} });
  const address = tools
    .filter((tool) => String(tool.integration) === slug)
    .map((tool) => String(tool.address))
    .find((addr) => addr.endsWith("listIssues"));
  expect(address, "the listIssues tool is in the catalog").toBeDefined();

  const session = mcp.session(identity);
  /** Invoke the connected tool and report what came back, success or not. */
  const attempt = (): Effect.Effect<CallResult, unknown> =>
    Effect.gen(function* () {
      let called = yield* session.call("execute", {
        code: invokeByAddressCode(address!, {}),
      });
      let guard = 0;
      while (called.text.includes("executionId:") && guard < 10) {
        called = yield* session.approvePaused(called.text);
        guard += 1;
      }
      return { ok: called.ok, text: called.text };
    });

  /** Invoke the tool and require it to have worked end to end. */
  const call = (label: string): Effect.Effect<ToolEnvelope, unknown> =>
    Effect.gen(function* () {
      const result = yield* attempt();
      expect(
        result.ok,
        `the ${label} call reached the upstream and came back (got: ${result.text.slice(0, 400)})`,
      ).toBe(true);
      const envelope = JSON.parse(result.text) as ToolEnvelope;
      expect(envelope.ok, `the ${label} call succeeded`).toBe(true);
      return envelope;
    });

  return { attempt, call, oauth, slug, upstream, workos } as const;
});

/** Is this one of the authorization server's refresh grants? Counting them is
 *  how a "success" is shown to involve a real re-mint, not a cached token. */
const isRefreshGrant = (request: {
  readonly path: string;
  readonly method: string;
  readonly body: string;
}) =>
  request.path === "/token" &&
  request.method === "POST" &&
  request.body.includes("grant_type=refresh_token");

scenario(
  "Credential persistence · contention on the vault write does not lose the refreshed credential",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const { call, oauth, upstream, workos } = yield* connectIntegration;

      // Baseline: the connection works on its freshly minted token.
      yield* call("baseline");

      // Transient contention: the next few version-checked writes lose their
      // race, exactly as a peer writer persisting the same connection's
      // credential would make them lose it. Three is as many as the pre-fix
      // policy could ever absorb.
      const transient = yield* Effect.scoped(
        Effect.gen(function* () {
          const armed = yield* armFault(workos, {
            match: VAULT_WRITE,
            response: VAULT_CONFLICT_RESPONSE,
            times: 3,
          });
          // Revoking upstream forces the very next call to refresh, so the
          // contended write happens inside a real user-visible request.
          upstream.revokeSeenBearers();
          yield* call("transiently-contended-refresh");
          return yield* faultsServed(workos, armed);
        }),
      );
      expect(transient, "the transiently-contended refresh really did collide three times").toBe(3);

      // Sustained contention: every version-checked attempt loses. Dropping a
      // credential that has just been minted is the one unrecoverable outcome,
      // so the write still has to land.
      const sustained = yield* Effect.scoped(
        Effect.gen(function* () {
          const armed = yield* armFault(workos, {
            match: VAULT_WRITE,
            response: VAULT_CONFLICT_RESPONSE,
            times: 5,
          });
          upstream.revokeSeenBearers();
          yield* call("continuously-contended-refresh");
          return yield* faultsServed(workos, armed);
        }),
      );
      expect(
        sustained,
        "the continuously-contended refresh exhausted every version-checked attempt",
      ).toBe(5);

      // The durability half: the credential those contended writes were
      // carrying is the rotated, single-use refresh token. If any of it had been
      // dropped, the connection could never mint anything again.
      upstream.revokeSeenBearers();
      yield* call("post-contention");

      expect(
        (yield* oauth.requests).filter(isRefreshGrant).length,
        "each revocation was absorbed by a real refresh grant",
      ).toBeGreaterThanOrEqual(3);
    }),
  ),
);

// The peer writer's round trip, in milliseconds. Long enough that a retry loop
// firing its attempts back to back drains all of them (and its last-resort
// write) inside the window; short enough that a loop waiting between attempts is
// still trying when the window closes — the shipped policy's fourth and fifth
// attempts fall no earlier than 175ms and 375ms after the first collision.
const CONTENTION_WINDOW_MS = 200;

scenario(
  "Credential persistence · a refresh outlasts contention that lasts longer than a round trip",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const { call, oauth, upstream, workos } = yield* connectIntegration;

      yield* call("baseline");

      // Contention bounded by TIME rather than by a count of collisions: this is
      // the production shape, where the peer holds the object for as long as its
      // own write takes and the loser has to still be trying when it lets go.
      const { armed, released } = yield* holdWritesInConflict(workos, CONTENTION_WINDOW_MS);
      upstream.revokeSeenBearers();
      yield* call("refresh-under-a-contention-window");
      yield* Effect.promise(() => released);

      expect(
        yield* faultsServed(workos, armed),
        "the refresh really was fighting a contended vault write",
      ).toBeGreaterThanOrEqual(3);

      // And the credential that survived the window is usable: the next
      // revocation is absorbed by another real refresh.
      upstream.revokeSeenBearers();
      yield* call("post-window");

      expect(
        (yield* oauth.requests).filter(isRefreshGrant).length,
        "both revocations were absorbed by real refresh grants",
      ).toBeGreaterThanOrEqual(2);
    }),
  ),
);

scenario(
  "Credential persistence · a write that fails mid-refresh leaves the connection able to refresh",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const { attempt, call, oauth, slug, upstream, workos } = yield* connectIntegration;

      yield* call("baseline");

      // A refresh persists two objects. Break the ACCESS TOKEN's object only,
      // once: whichever write runs first survives and whichever runs second is
      // lost, so failing this one is the direct question "which of the two does
      // the product persist first?".
      const objects = yield* vaultObjectsFor(workos, slug);
      const refreshObject = objects.find((object) => object.name.endsWith("refresh"));
      expect(refreshObject, "the connection stored a refresh token in the vault").toBeDefined();
      const accessObject = objects.find(
        (object) => object !== refreshObject && refreshObject!.name.startsWith(object.name),
      );
      expect(accessObject, "the connection stored an access token in the vault").toBeDefined();

      const interrupted = yield* Effect.scoped(
        Effect.gen(function* () {
          const armed = yield* armFault(workos, {
            match: { method: "PUT", pathPattern: `/vault/v1/kv/${accessObject!.id}` },
            response: {
              status: 503,
              body: { code: "unavailable", message: "vault unavailable" },
            },
            times: 1,
          });

          upstream.revokeSeenBearers();
          const result = yield* attempt();
          expect(
            yield* faultsServed(workos, armed),
            "the access token's write is the one that broke",
          ).toBe(1);
          return result;
        }),
      );
      expect(
        interrupted.ok,
        `the call whose credential write was interrupted reports the failure (got: ${interrupted.text.slice(0, 200)})`,
      ).toBe(false);

      // The interrupted refresh still spent the refresh token it sent: the
      // authorization server rotated it and will not honour the old one again.
      // The access token in the vault is the stale, revoked one, so the very
      // next call has to refresh — and can only do so if the ROTATED refresh
      // token is what survived the half-finished write.
      const recovered = yield* attempt();
      expect(
        recovered.ok,
        `the connection still refreshes after the interrupted write (got: ${recovered.text.slice(0, 400)})`,
      ).toBe(true);
      expect((JSON.parse(recovered.text) as ToolEnvelope).ok, "the recovered call succeeded").toBe(
        true,
      );

      expect(
        (yield* oauth.requests).filter(isRefreshGrant).length,
        "the interrupted refresh and the recovery were both real refresh grants",
      ).toBeGreaterThanOrEqual(2);
    }),
  ),
);

scenario(
  "Credential persistence · a store that cannot accept writes fails the refresh before the grant is spent",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const { attempt, call, oauth, slug, upstream, workos } = yield* connectIntegration;

      yield* call("baseline");

      // Break the REFRESH TOKEN's object, and only that one, with a status the
      // write policy cannot treat as contention — 503 is the store being down,
      // not a peer holding the row, so no amount of retrying can land it. This
      // is a store that will not accept a write at all.
      const objects = yield* vaultObjectsFor(workos, slug);
      const refreshObject = objects.find((object) => object.name.endsWith("refresh"));
      expect(refreshObject, "the connection stored a refresh token in the vault").toBeDefined();

      const grantsBeforeOutage = (yield* oauth.requests).filter(isRefreshGrant).length;

      const duringOutage = yield* Effect.scoped(
        Effect.gen(function* () {
          const armed = yield* armFault(workos, {
            match: { method: "PUT", pathPattern: `/vault/v1/kv/${refreshObject!.id}` },
            response: { status: 503, body: { code: "unavailable", message: "vault unavailable" } },
            times: 3,
          });

          upstream.revokeSeenBearers();
          const result = yield* attempt();
          expect(
            yield* faultsServed(workos, armed),
            "the refresh token's write is the one that broke",
          ).toBeGreaterThanOrEqual(1);
          return result;
        }),
      );
      expect(
        duringOutage.ok,
        `the call reports the failure while the store is down (got: ${duringOutage.text.slice(0, 200)})`,
      ).toBe(false);

      // The whole point: the failure landed on the writability check, not on
      // the persist that follows a grant. No grant ran, so the stored refresh
      // token was never spent and is still the one the authorization server
      // will honour.
      expect(
        (yield* oauth.requests).filter(isRefreshGrant).length,
        "no refresh grant is spent while the store cannot persist its rotated successor",
      ).toBe(grantsBeforeOutage);

      // The store is back. A transient outage must cost nothing but the wait:
      // the connection still holds a live grant and refreshes itself, with no
      // human reconnecting anything.
      const recovered = yield* attempt();
      expect(
        recovered.ok,
        `the connection refreshes itself once the store recovers (got: ${recovered.text.slice(0, 400)})`,
      ).toBe(true);
      expect((JSON.parse(recovered.text) as ToolEnvelope).ok, "the recovered call succeeded").toBe(
        true,
      );
      expect(
        (yield* oauth.requests).filter(isRefreshGrant).length,
        "the recovery was a real refresh grant on the token the outage preserved",
      ).toBe(grantsBeforeOutage + 1);
    }),
  ),
);
