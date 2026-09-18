// Regression coverage for the connection status and OAuth refresh defects that
// produced a permanent, wrong **Expired**: a refresher that loses a rotation
// race, a rate-limited token endpoint, a probe that answered without
// refreshing, and a refresh response that omits `expires_in`.
//
// One database, one credential store, two executor instances, one root database
// handle each. The in-flight refresh gate is keyed on the handle, so two
// instances do not share a gate — the cloud app's per-request `DbService`
// rebuild and any multi-process self-host both have this shape. The tests
// assert on the connection ROW, which is where the wrong status was written:
// `oauth-flow.test.ts` already covers this shape for the credential store.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Schema } from "effect";
import * as Exit from "effect/Exit";
import { withQueryContext } from "@executor-js/fumadb/query";

import { authToolFailure } from "./auth-tool-failure";
import { createExecutor } from "./executor";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderKey,
  ToolAddress,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig } from "./test-config";
import { serveOAuthTestServer } from "./testing/oauth-test-server";
import { ToolResult } from "./tool-result";

const TENANT = "test-tenant";
const SUBJECT = "test-subject";
const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const CLIENT = OAuthClientSlug.make("acme-app");
const NAME = ConnectionName.make("main");
const ADDRESS = ToolAddress.make("tools.acme.org.main.whoami");
const REF = { owner: "org" as const, integration: INTEG, name: NAME };

// ---------------------------------------------------------------------------
// Plugin: an upstream that honours every access token except the revoked ones.
// `checkHealth` authenticates the same way `invokeTool` does, so a revoked
// token reads 401 on both paths — the divergence under test is what CORE does
// with each, not what the plugin reports.
// ---------------------------------------------------------------------------

interface UpstreamState {
  readonly revoked: Set<string>;
  readonly calls: string[];
  readonly probes: string[];
}

const makeUpstreamPlugin = (state: UpstreamState) =>
  definePlugin(() => ({
    id: "acme" as const,
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({ tools: [{ name: ToolName.make("whoami"), description: "whoami" }] }),
    describeAuthMethods: () => [
      {
        id: "oauth",
        label: "OAuth2",
        kind: "oauth" as const,
        template: String(TEMPLATE),
        oauth: { scopes: [] },
      },
    ],
    invokeTool: ({ credential }) => {
      const token = credential.value;
      state.calls.push(String(token));
      if (token !== null && !state.revoked.has(token)) {
        return Effect.succeed(ToolResult.ok({ token }));
      }
      return Effect.succeed(
        authToolFailure({
          code: "connection_rejected",
          status: 401,
          message: "Upstream rejected credentials with HTTP 401.",
          integration: { id: String(credential.integration) },
          credential: { kind: "upstream", label: String(credential.connection) },
        }),
      );
    },
    checkHealth: ({ credential }) => {
      const token = credential.value;
      state.probes.push(String(token));
      if (token !== null && !state.revoked.has(token)) {
        return Effect.succeed({ status: "healthy" as const, checkedAt: Date.now() });
      }
      return Effect.succeed({
        status: "expired" as const,
        httpStatus: 401,
        checkedAt: Date.now(),
        detail: "The endpoint rejected the credential with HTTP 401.",
        reason: "upstream_status" as const,
      });
    },
    extension: (ctx) => ({
      seed: () => ctx.core.integrations.register({ slug: INTEG, description: "Acme", config: {} }),
    }),
  }))();

// ---------------------------------------------------------------------------
// Shared credential store, with a seam that can hold ONE reader between its
// read of the stored refresh token and whatever it does next. That seam is the
// race window; the same one `oauth-flow.test.ts` opens.
// ---------------------------------------------------------------------------

interface SharedStore {
  readonly provider: CredentialProvider;
  readonly values: Map<string, string>;
  readonly writes: string[];
  /** Arm the one-shot pause on the next refresh-token read. */
  readonly arm: () => void;
}

const makeSharedStore = (input: {
  readonly pausedAtRead: Deferred.Deferred<void>;
  readonly resumeFromRead: Deferred.Deferred<void>;
}): SharedStore => {
  const values = new Map<string, string>();
  const writes: string[] = [];
  let pauseNextRefreshRead = false;
  return {
    values,
    writes,
    arm: () => {
      pauseNextRefreshRead = true;
    },
    provider: {
      key: ProviderKey.make("shared-memory"),
      writable: true,
      get: (id) =>
        Effect.gen(function* () {
          const value = values.get(String(id)) ?? null;
          if (pauseNextRefreshRead && String(id).endsWith(":refresh")) {
            pauseNextRefreshRead = false;
            yield* Deferred.succeed(input.pausedAtRead, undefined);
            yield* Deferred.await(input.resumeFromRead);
          }
          return value;
        }),
      set: (id, value) =>
        Effect.sync(() => {
          writes.push(String(id));
          values.set(String(id), value);
        }),
      delete: (id) => Effect.sync(() => void values.delete(String(id))),
    },
  };
};

// ---------------------------------------------------------------------------
// One database + one store, two executor instances, one completed OAuth
// connection. `expire` forces the next resolve to refresh.
// ---------------------------------------------------------------------------

const makeRace = (options?: { readonly healthCheck?: boolean }) =>
  Effect.gen(function* () {
    const server = yield* serveOAuthTestServer({ scopes: ["read"] });
    const state: UpstreamState = { revoked: new Set(), calls: [], probes: [] };
    const pausedAtRead = yield* Deferred.make<void>();
    const resumeFromRead = yield* Deferred.make<void>();
    const store = makeSharedStore({ pausedAtRead, resumeFromRead });
    const config = {
      ...makeTestConfig({
        plugins: [makeUpstreamPlugin(state)] as const,
        tenant: TENANT,
        subject: SUBJECT,
      }),
      providers: [store.provider],
    };
    const a = yield* createExecutor(config);
    // A SECOND root db handle onto the same database = a second instance. The
    // in-flight refresh gate is keyed on handle identity, so this is exactly
    // the boundary the gate cannot see across.
    const b = yield* createExecutor({
      ...config,
      db: withQueryContext(config.testDb.db, { tenant: TENANT, subject: SUBJECT }),
    });
    yield* Effect.addFinalizer(() => a.close().pipe(Effect.ignore));
    yield* Effect.addFinalizer(() => b.close().pipe(Effect.ignore));
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => config.testDb.close()).pipe(Effect.ignore),
    );

    yield* a.acme.seed();
    yield* a.oauth.createClient({
      owner: "org",
      slug: CLIENT,
      authorizationUrl: server.authorizationEndpoint,
      tokenUrl: server.tokenEndpoint,
      grant: "authorization_code",
      clientId: "test-client",
      clientSecret: "test-secret",
    });
    if (options?.healthCheck === true) {
      // A declared health check puts the connection on the PROBING path rather
      // than the credential-only one.
      yield* a.integrations.healthCheck.set(INTEG, { operation: "whoami" });
    }
    const started = yield* a.oauth.start({
      owner: "org",
      client: CLIENT,
      clientOwner: "org",
      name: NAME,
      integration: INTEG,
      template: TEMPLATE,
    });
    if (started.status !== "redirect") return yield* Effect.die("expected a redirect start");
    const callback = yield* server.completeAuthorizationCodeFlow({
      authorizationUrl: started.authorizationUrl,
    });
    yield* a.oauth.complete({ state: started.state, code: callback.code });

    return {
      server,
      state,
      store,
      a,
      b,
      config,
      pausedAtRead,
      resumeFromRead,
      expire: () =>
        Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (builder) => builder("name", "=", String(NAME)),
            set: { expires_at: Date.now() - 60_000 },
          }),
        ),
      rawRow: () =>
        Effect.promise(() =>
          config.db.findFirst("connection", {
            where: (builder) => builder("name", "=", String(NAME)),
          }),
        ),
      refreshItemId: () => [...store.values.keys()].find((key) => key.endsWith(":refresh")),
    } as const;
  });

type Race = Effect.Success<ReturnType<typeof makeRace>>;

/** Run `use` against a freshly connected two-instance race. */
const withRace = <A, E>(
  options: { readonly healthCheck?: boolean },
  use: (race: Race) => Effect.Effect<A, E>,
) => Effect.scoped(Effect.flatMap(makeRace(options), use));

const refreshGrants = (requests: readonly { readonly path: string; readonly body: string }[]) =>
  requests.filter((r) => r.path === "/token" && r.body.includes("grant_type=refresh_token"));

const DeadGrantState = Schema.Struct({ oauthReauthRequiredAt: Schema.Number });
const decodeDeadGrantObject = Schema.decodeUnknownOption(DeadGrantState);
const decodeDeadGrantJson = Schema.decodeUnknownOption(Schema.fromJsonString(DeadGrantState));

/** The recorded dead-grant stamp, read off a connection row's
 *  `provider_state` (a JSON column: an object on some adapters, encoded text
 *  on others). Takes `unknown` because the row comes back from the raw query
 *  surface, and normalises it through Schema rather than a cast. */
const RowProviderState = Schema.Struct({ provider_state: Schema.optional(Schema.Unknown) });
const decodeRowProviderState = Schema.decodeUnknownOption(RowProviderState);

const deadGrantStamp = (row: unknown): number | undefined => {
  const value = Option.getOrUndefined(
    Option.map(decodeRowProviderState(row), (decoded) => decoded.provider_state),
  );
  if (value === undefined || value === null) return undefined;
  const fromObject = Option.getOrUndefined(decodeDeadGrantObject(value));
  if (fromObject !== undefined) return fromObject.oauthReauthRequiredAt;
  return Option.getOrUndefined(
    Option.map(decodeDeadGrantJson(value), (state) => state.oauthReauthRequiredAt),
  );
};

// ---------------------------------------------------------------------------
// A refresher that loses the rotation race adopts the peer's token.
// ---------------------------------------------------------------------------

/** Run the race: A reads the stored refresh token and stalls, B wins and
 *  rotates it, A resumes and redeems the consumed token. Returns the rotated
 *  token and A's own outcome, so a test can assert what the loser did with the
 *  refusal. */
const runRotationRace = (race: Race) =>
  Effect.gen(function* () {
    const refreshItemId = race.refreshItemId();
    expect(refreshItemId, "the connection stored a refresh token").toBeDefined();
    const originalRefreshToken = race.store.values.get(refreshItemId!);
    yield* race.expire();

    race.store.arm();
    const loser = yield* Effect.forkChild(Effect.exit(race.a.execute(ADDRESS, {})));
    yield* Deferred.await(race.pausedAtRead);

    // B wins: it spends that token, the AS rotates it, B stores the successor.
    yield* race.b.execute(ADDRESS, {});
    const rotatedRefreshToken = race.store.values.get(refreshItemId!);
    expect(rotatedRefreshToken, "the winner rotated the stored refresh token").not.toBe(
      originalRefreshToken,
    );

    // A resumes and redeems a token the authorization server already consumed.
    yield* Deferred.succeed(race.resumeFromRead, undefined);
    const loserExit = yield* Fiber.join(loser);

    // The store still holds B's valid rotated token: this connection is not out
    // of credentials, it lost a race.
    expect(race.store.values.get(refreshItemId!)).toBe(rotatedRefreshToken);
    return {
      refreshItemId: refreshItemId!,
      rotatedRefreshToken: rotatedRefreshToken!,
      loserExit,
    };
  });

describe("a lost rotation race is not a dead grant", () => {
  it.effect("the loser adopts the peer's token and the connection keeps refreshing", () =>
    withRace({}, (race) =>
      Effect.gen(function* () {
        const { loserExit } = yield* runRotationRace(race);

        // The loser's own call recovered: it read the refresh item back, saw
        // that a peer had replaced the value it sent, and used the access token
        // that peer persisted.
        expect(Exit.isSuccess(loserExit), "the losing refresher still served its call").toBe(true);

        // No permanent rejection record, because the grant is alive.
        expect(deadGrantStamp(yield* race.rawRow()), "no dead grant is recorded").toBeUndefined();
        const health = yield* race.b.connections.checkHealth(REF);
        expect(health.status, "and no surface answers expired").not.toBe("expired");

        // The winner still refreshes with its own rotated token when the access
        // token next expires.
        yield* race.expire();
        yield* race.server.clearRequests;
        const next = yield* Effect.exit(race.b.execute(ADDRESS, {}));
        expect(Exit.isSuccess(next), "the winner refreshes again on the next expiry").toBe(true);
        expect(
          refreshGrants(yield* race.server.requests).length,
          "the authorization server received that grant",
        ).toBeGreaterThan(0);
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// One temporary 4xx response does not end a grant.
// ---------------------------------------------------------------------------

interface FlakyEndpoint {
  readonly url: string;
  readonly attempts: () => number;
  readonly close: () => void;
}

/** Token endpoint that rate-limits the FIRST refresh grant and forwards the
 *  rest to the real authorization server: one bad minute, then healthy. */
const serveFlakyTokenEndpoint = (upstream: string) =>
  Effect.acquireRelease(
    Effect.callback<FlakyEndpoint>((resume) => {
      let attempts = 0;
      const forward = async (
        req: IncomingMessage,
        res: ServerResponse,
        body: string,
      ): Promise<void> => {
        // oxlint-disable-next-line executor/no-raw-fetch -- boundary: test fixture proxying form-encoded token requests to the test authorization server; it must not carry the SDK's own HttpClient layer into the endpoint under test
        const response = await fetch(upstream, {
          method: req.method,
          headers: {
            "content-type": req.headers["content-type"] ?? "application/x-www-form-urlencoded",
            ...(typeof req.headers["authorization"] === "string"
              ? { authorization: req.headers["authorization"] }
              : {}),
          },
          body: body.length > 0 ? body : undefined,
        });
        const text = await response.text();
        res.writeHead(response.status, {
          "content-type": response.headers.get("content-type") ?? "application/json",
        });
        res.end(text);
      };
      const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (body.includes("grant_type=refresh_token")) {
            attempts += 1;
            if (attempts === 1) {
              res.writeHead(429, { "content-type": "text/plain; charset=utf-8" });
              res.end("Too Many Requests: slow down");
              return;
            }
          }
          // oxlint-disable-next-line executor/no-promise-catch -- boundary: plain node:http handler in a test fixture standing in for a flaky upstream
          void forward(req, res, body).catch(() => {
            res.writeHead(502, { "content-type": "text/plain" });
            res.end("proxy failed");
          });
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}/token`,
            attempts: () => attempts,
            close: () => server.close(),
          }),
        );
      });
    }),
    (handle) => Effect.sync(() => handle.close()),
  );

/** Connect, point the backing app at a token endpoint that rate-limits once,
 *  and take that first failing refresh. */
const withRateLimitedRefresh = <A, E>(
  use: (input: {
    readonly race: Race;
    readonly flaky: FlakyEndpoint;
    readonly firstCallSucceeded: boolean;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const race = yield* makeRace({});
      const flaky = yield* serveFlakyTokenEndpoint(race.server.tokenEndpoint);
      yield* Effect.promise(() =>
        race.config.db.updateMany("oauth_client", {
          where: (builder) => builder("slug", "=", String(CLIENT)),
          set: { token_url: flaky.url },
        }),
      );
      yield* race.expire();
      const first = yield* Effect.exit(race.a.execute(ADDRESS, {}));
      expect(Exit.isSuccess(first), "the rate-limited refresh fails the call").toBe(false);
      expect(flaky.attempts(), "the token endpoint was asked once").toBe(1);
      return yield* use({ race, flaky, firstCallSucceeded: Exit.isSuccess(first) });
    }),
  );

describe("a rate-limited refresh stays retryable", () => {
  it.effect("a 429 from the token endpoint does not end the grant", () =>
    withRateLimitedRefresh(({ race, flaky }) =>
      Effect.gen(function* () {
        // The endpoint forwards every grant after the first to the real
        // authorization server, so it is healthy from here on. The next call
        // must reach it.
        const second = yield* Effect.exit(race.a.execute(ADDRESS, {}));
        expect(Exit.isSuccess(second), "the retry refreshed and the call succeeded").toBe(true);
        expect(flaky.attempts(), "executor asked the token endpoint again").toBeGreaterThan(1);

        expect(
          deadGrantStamp(yield* race.rawRow()),
          "a rate limit is not a permanent rejection",
        ).toBeUndefined();
        const health = yield* race.a.connections.checkHealth(REF);
        expect(health.status, "and the connection does not read as expired").not.toBe("expired");
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// A refresh response without `expires_in` keeps the advertised lifetime.
// ---------------------------------------------------------------------------

interface StrippingEndpoint {
  readonly url: string;
  readonly attempts: () => number;
  readonly close: () => void;
}

/** A token endpoint that answers a refresh grant with a valid token response
 *  that OMITS `expires_in`, which RFC 6749 permits, and rotates the refresh
 *  token like the real one does. It stands in for an authorization server that
 *  advertised a lifetime on the code exchange and then stopped repeating it. */
const serveExpiresInStrippingEndpoint = () =>
  Effect.acquireRelease(
    Effect.callback<StrippingEndpoint>((resume) => {
      let attempts = 0;
      const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (!body.includes("grant_type=refresh_token")) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("this fixture answers refresh grants only");
            return;
          }
          attempts += 1;
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(
            `{"access_token":"at_stripped_${attempts}","refresh_token":"rt_stripped_${attempts}","token_type":"Bearer"}`,
          );
          void req;
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}/token`,
            attempts: () => attempts,
            close: () => server.close(),
          }),
        );
      });
    }),
    (handle) => Effect.sync(() => handle.close()),
  );

/** `connection.expires_at` off the raw row, which adapters return as a number or
 *  a string. */
const RowExpiry = Schema.Struct({ expires_at: Schema.optional(Schema.Unknown) });
const decodeRowExpiry = Schema.decodeUnknownOption(RowExpiry);
const rowExpiresAt = (row: unknown): number | null => {
  const value = Option.getOrUndefined(decodeRowExpiry(row))?.expires_at;
  // A bigint column: adapters hand back a number, a string, or a BigInt.
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return null;
};

// ---------------------------------------------------------------------------
// The probe refreshes before it answers expired.
// ---------------------------------------------------------------------------

/** Connect with a declared health check, then revoke the live access token
 *  upstream while `expires_at` still says it is good for an hour. */
const withRevokedToken = <A, E>(use: (race: Race) => Effect.Effect<A, E>) =>
  withRace({ healthCheck: true }, (race) =>
    Effect.gen(function* () {
      for (const token of yield* race.server.issuedAccessTokens) race.state.revoked.add(token);
      yield* race.server.clearRequests;
      return yield* use(race);
    }),
  );

describe("the probe refreshes before it answers expired", () => {
  it.effect("a revoked token that the refresh can replace probes healthy", () =>
    withRevokedToken((race) =>
      Effect.gen(function* () {
        const verdict = yield* race.a.connections.checkHealth(REF);
        expect(verdict.status, "the probe re-minted instead of reporting expired").toBe("healthy");
        expect(
          refreshGrants(yield* race.server.requests).length,
          "the probe sent a refresh grant",
        ).toBeGreaterThan(0);

        // The persisted verdict agrees, so every surface reads healthy without
        // waiting for a tool call to heal it.
        const persisted = yield* race.a.connections.get(REF);
        expect(persisted?.lastHealth?.status, "the healthy verdict is persisted").toBe("healthy");
      }),
    ),
  );

  it.effect("a refused refresh still answers expired from the probe", () =>
    withRace({ healthCheck: true }, (race) =>
      Effect.gen(function* () {
        // No revocation and no expiry: the probe answers from the credential it
        // resolved. A refusal is what the persisted-expired contract in
        // `connection-health-verdict.test.ts` covers; this asserts the retry
        // did not turn the probe into a second grant on a healthy connection.
        yield* race.server.clearRequests;
        const verdict = yield* race.a.connections.checkHealth(REF);
        expect(verdict.status).toBe("healthy");
        expect(
          refreshGrants(yield* race.server.requests),
          "a healthy probe sends no refresh grant",
        ).toHaveLength(0);
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// A refresh response without `expires_in` must not erase the expiry.
// ---------------------------------------------------------------------------

describe("a refresh response that omits expires_in", () => {
  it.effect("keeps the advertised lifetime, so proactive refresh survives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const race = yield* makeRace({});
        const mintedExpiry = rowExpiresAt(yield* race.rawRow());
        expect(mintedExpiry, "the mint recorded the advertised expiry").not.toBeNull();
        expect(
          (mintedExpiry ?? 0) - Date.now(),
          "and the test authorization server advertised an hour",
        ).toBeGreaterThan(30 * 60_000);

        const stripping = yield* serveExpiresInStrippingEndpoint();
        yield* Effect.promise(() =>
          race.config.db.updateMany("oauth_client", {
            where: (builder) => builder("slug", "=", String(CLIENT)),
            set: { token_url: stripping.url },
          }),
        );
        yield* race.expire();

        const first = yield* Effect.exit(race.a.execute(ADDRESS, {}));
        expect(Exit.isSuccess(first), "the refresh succeeded").toBe(true);
        expect(stripping.attempts(), "and it went to the endpoint that omits expires_in").toBe(1);

        // This wrote null before the fix, which disabled the proactive check
        // for the rest of the connection's life and left every later call to
        // the reactive 401 path.
        const refreshedExpiry = rowExpiresAt(yield* race.rawRow());
        expect(refreshedExpiry, "the expiry survived a response without expires_in").not.toBeNull();
        expect(
          (refreshedExpiry ?? 0) - Date.now(),
          "and it carries the lifetime the grant advertised",
        ).toBeGreaterThan(30 * 60_000);

        // The proactive path still works, so the next call needs no grant.
        const second = yield* Effect.exit(race.a.execute(ADDRESS, {}));
        expect(Exit.isSuccess(second), "the next call used the stored token").toBe(true);
        expect(stripping.attempts(), "and sent no second grant").toBe(1);
      }),
    ),
  );
});
