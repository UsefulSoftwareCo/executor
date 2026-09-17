// Reproduction harness for the "Expired" status + refresh defects analysed in
// plans/oauth-refresh-and-expired-status.md.
//
// Each root cause gets TWO tests, with no branching inside either:
//
//   "documents current behavior" — passes on main today. This is the
//     replication: it pins what a user actually sees, so the defect is not a
//     matter of interpretation.
//   "REPRO" — asserts the behavior we want. It FAILS on main today, so it is
//     checked in skipped; it is the acceptance anchor for the fix phase named
//     in its title, and that PR un-skips it green without editing it.
//
// Deployment shape under test: ONE database, ONE credential store, TWO executor
// instances each holding its OWN root db handle. That is cloud (per-request
// `DbService` rebuild + per-session Durable Objects) and any multi-process
// self-host. It is the shape `refreshGateFor`'s own doc block declares out of
// scope, and the shape `oauth-flow.test.ts`'s two-instance test already builds
// — that test asserts the spent token is not written back, but never looks at
// what the loser's `invalid_grant` does to the connection ROW. These do.

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
// R1 — the loser of a rotation race permanently bricks a healthy connection.
// ---------------------------------------------------------------------------

/** Run the race: A reads the stored refresh token and stalls, B wins and
 *  rotates it, A resumes and redeems the consumed token. Shared by both R1
 *  tests so they differ only in what they assert about the aftermath. */
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
    yield* Fiber.join(loser);

    // The store still holds B's valid rotated token: this connection is not out
    // of credentials, it lost a race.
    expect(race.store.values.get(refreshItemId!)).toBe(rotatedRefreshToken);
    return { refreshItemId: refreshItemId!, rotatedRefreshToken: rotatedRefreshToken! };
  });

describe("R1 — refresh race across two instances", () => {
  it.effect("documents current behavior: the loser bricks a connection holding a valid token", () =>
    withRace({}, (race) =>
      Effect.gen(function* () {
        yield* runRotationRace(race);

        // A's `invalid_grant` recorded a dead grant on a connection whose
        // stored refresh token is valid.
        expect(
          deadGrantStamp(yield* race.rawRow()),
          "the loser marked the grant permanently dead",
        ).toBeTypeOf("number");
        const health = yield* race.b.connections.checkHealth(REF);
        expect(health.status, "every surface now answers expired without probing").toBe("expired");

        // The rotated token is still perfectly good — nobody is allowed to use
        // it again. This is the permanent part.
        yield* race.expire();
        yield* race.server.clearRequests;
        const next = yield* Effect.exit(race.b.execute(ADDRESS, {}));
        expect(Exit.isSuccess(next), "the winner can no longer refresh either").toBe(false);
        expect(
          refreshGrants(yield* race.server.requests),
          "the known-dead gate never sends another grant",
        ).toHaveLength(0);
      }),
    ),
  );

  // Skipped, not deleted: this is the acceptance anchor for Phase 1 of
  // plans/oauth-refresh-and-expired-status.md. The PR that lands the fix
  // un-skips it and it must go green unchanged.
  it.effect.skip("REPRO: a lost rotation race must not record a dead grant (Phase 1)", () =>
    withRace({}, (race) =>
      Effect.gen(function* () {
        yield* runRotationRace(race);

        // Phase 1 target: the loser notices the rotation and adopts it, so no
        // dead grant is ever recorded.
        expect(
          deadGrantStamp(yield* race.rawRow()),
          "a lost race must not record a dead grant",
        ).toBeUndefined();
        const health = yield* race.b.connections.checkHealth(REF);
        expect(health.status, "and no surface answers expired").not.toBe("expired");

        yield* race.expire();
        yield* race.server.clearRequests;
        const next = yield* Effect.exit(race.b.execute(ADDRESS, {}));
        expect(Exit.isSuccess(next), "the winner can still refresh with its own valid token").toBe(
          true,
        );
        expect(
          refreshGrants(yield* race.server.requests).length,
          "executor asked the authorization server again",
        ).toBeGreaterThan(0);
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// R2 — one transient 4xx (a 429) permanently kills the grant.
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
 *  and take that first (failing) refresh. Shared by both R2 tests. */
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

describe("R2 — transient 4xx classification", () => {
  it.effect("documents current behavior: one 429 permanently disables a working grant", () =>
    withRateLimitedRefresh(({ race, flaky }) =>
      Effect.gen(function* () {
        const health = yield* race.a.connections.checkHealth(REF);
        expect(health.status, "one 429 rendered the connection permanently expired").toBe(
          "expired",
        );

        // The endpoint is healthy from here on — every later grant would be
        // forwarded to the real authorization server and succeed. Executor
        // never sends one.
        const attemptsBefore = flaky.attempts();
        const second = yield* Effect.exit(race.a.execute(ADDRESS, {}));
        expect(Exit.isSuccess(second), "and it never asks the healthy endpoint again").toBe(false);
        expect(flaky.attempts(), "no further grant was attempted").toBe(attemptsBefore);
      }),
    ),
  );

  // Skipped, not deleted: Phase 1 acceptance anchor (see the note above).
  it.effect.skip("REPRO: a 429 must stay retryable (Phase 1)", () =>
    withRateLimitedRefresh(({ race, flaky }) =>
      Effect.gen(function* () {
        // Phase 1 target: a 429 is retryable, so the next attempt reaches the
        // (now healthy) endpoint and the connection keeps working.
        const second = yield* Effect.exit(race.a.execute(ADDRESS, {}));
        expect(Exit.isSuccess(second), "a 429 does not end the grant").toBe(true);
        expect(flaky.attempts(), "executor retried the refresh").toBeGreaterThan(1);
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// R3 — the health probe never refreshes reactively, so it writes `expired` for
// a credential the tool path would have refreshed, then flips to healthy on the
// next tool call. That flip is the "disconnected, then connected" symptom.
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

describe("R3 — probe verdict vs reactive refresh", () => {
  it.effect("documents current behavior: probe says expired, the next tool call says healthy", () =>
    withRevokedToken((race) =>
      Effect.gen(function* () {
        // The probe persists `expired` without ever trying the refresh token
        // that would have fixed it …
        const verdict = yield* race.a.connections.checkHealth(REF);
        expect(verdict.status).toBe("expired");
        expect(
          refreshGrants(yield* race.server.requests),
          "the probe sent no refresh grant",
        ).toHaveLength(0);
        const persisted = yield* race.a.connections.get(REF);
        expect(
          persisted?.lastHealth?.status,
          "and the verdict is persisted for every surface to read",
        ).toBe("expired");

        // … then the very next tool call refreshes reactively, succeeds, and
        // heals the row. Same connection, seconds apart, no user action:
        // "disconnected" then "connected".
        yield* race.a.execute(ADDRESS, {});
        expect(
          race.state.calls.length,
          "the tool call retried with a re-minted token",
        ).toBeGreaterThan(1);
        const healed = yield* race.a.connections.get(REF);
        expect(healed?.lastHealth?.status, "heal-on-use flipped the badge back").toBe("healthy");
      }),
    ),
  );

  // Skipped, not deleted: Phase 3 acceptance anchor (see the note above).
  it.effect.skip("REPRO: the probe must refresh before concluding expired (Phase 3)", () =>
    withRevokedToken((race) =>
      Effect.gen(function* () {
        // Phase 3 target: the probe refreshes once before concluding expired.
        const verdict = yield* race.a.connections.checkHealth(REF);
        expect(verdict.status, "a refreshable revocation is not an expired connection").toBe(
          "healthy",
        );
        expect(
          refreshGrants(yield* race.server.requests).length,
          "the probe re-minted the token",
        ).toBeGreaterThan(0);
      }),
    ),
  );
});
