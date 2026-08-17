import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";

import { StorageError } from "./fuma-runtime";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import {
  MAX_REFRESH_GRANT_EXPIRES_IN_SECONDS,
  RefreshGrantRejected,
  type CredentialProvider,
  type RefreshGrantInput,
  type RefreshGrantRejectionCode,
} from "./provider";
import { makeTestWorkspaceHarness } from "./test-config";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

// A provider that OWNS the refresh grant never hands the refresh token out. These tests pin that
// property directly rather than asserting "the refresh succeeded" — success is not the claim. The
// claim is that the host never resolved the secret, and only a test watching `get` can tell a
// provider that protected the token from one that quietly served it. Both would go green.

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const CLIENT = OAuthClientSlug.make("acme-app");
const TOOL = ToolAddress.make("tools.acme.org.main.whoami");
const TOKEN_CANARY = "refresh-token-canary-must-never-cross-the-provider-boundary";

const oauthPlugin = definePlugin(() => ({
  id: "acme" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({ tools: [{ name: ToolName.make("whoami"), description: "whoami" }] }),
  describeAuthMethods: (record) => {
    const config = record.config as { readonly scopes?: readonly string[] } | null;
    return [
      {
        id: "oauth",
        label: "OAuth2",
        kind: "oauth" as const,
        template: String(TEMPLATE),
        oauth: { scopes: config?.scopes ?? [] },
      },
    ];
  },
  invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
  extension: (ctx) => ({
    seed: (scopes: readonly string[] = []) =>
      ctx.core.integrations.register({ slug: INTEG, description: "Acme", config: { scopes } }),
  }),
}))();

/** What the delegating provider does when the host asks it to perform the grant. */
type GrantBehaviour =
  /** The honest implementation: seal a new access token, report expiry and scope. */
  | {
      readonly kind: "seals";
      readonly scope: string | null;
      readonly expiresInSeconds: number | null;
    }
  /** Reports success but leaves nothing resolvable under `accessItemId`. */
  | { readonly kind: "sealsNothing" }
  /** The authorization server refused the grant (RFC 6749 §5.2). */
  | {
      readonly kind: "rejected";
      readonly error?: RefreshGrantRejectionCode;
      /** Test-only hostile fields a JavaScript/remote provider could attach despite the type. */
      readonly unsafeDetails?: string;
      readonly unsafeError?: string;
    }
  /** A provider-side storage failure whose diagnostic details must remain provider-side. */
  | { readonly kind: "storageFailure" }
  /** A provider implementation that throws before it can return an Effect. */
  | { readonly kind: "syncThrow" }
  /** A provider implementation that dies inside its Effect. */
  | { readonly kind: "defect" }
  /** A concurrent provider failure that contains cancellation plus a secret-bearing defect. */
  | { readonly kind: "interruptedDefect" }
  /** A malformed remote provider object whose classification getter throws. */
  | { readonly kind: "throwingRejectionGetter" }
  /** A stateful rejection getter that changes after returning one valid code. */
  | { readonly kind: "changingRejectionGetter" }
  /** Reading the optional capability itself throws before a grant can start. */
  | { readonly kind: "throwingCapabilityGetter" }
  /** A success object whose property access throws after the provider Effect succeeds. */
  | { readonly kind: "throwingResultGetter"; readonly field: "expiry" | "scope" }
  /** A method-shaped provider that relies on its receiver. */
  | { readonly kind: "requiresReceiver" }
  /** A successful grant followed by a failure while resolving the new access token. */
  | { readonly kind: "readFailure"; readonly failure: "storage" | "defect" };

const SEALS: GrantBehaviour = { kind: "seals", scope: "read", expiresInSeconds: 3_600 };

/** Records what the host asked the provider for, so a test can assert what it did NOT ask for. */
interface Recorder {
  readonly reads: string[];
  readonly grants: RefreshGrantInput[];
  rejectionErrorReads: number;
}

/** A memory provider that can also perform the refresh grant itself.
 *
 * `refreshGrant` seals under `accessItemId` exactly as a sealed-store provider would, and returns
 * only expiry and scope. It never calls `get`. `behaviour: null` omits the capability entirely,
 * which is how the fallback test shows the difference is the capability and not the harness. */
const delegatingCredentialsPlugin = (recorder: Recorder, behaviour: GrantBehaviour | null) =>
  definePlugin(() => {
    const store = new Map<string, string>();

    const base = {
      key: ProviderKey.make("memory"),
      writable: true as const,
      get: (id: ProviderItemId) =>
        Effect.suspend(() => {
          recorder.reads.push(String(id));
          if (
            behaviour?.kind === "readFailure" &&
            recorder.grants.length > 0 &&
            recorder.grants.some((grant) => String(grant.accessItemId) === String(id))
          ) {
            return behaviour.failure === "storage"
              ? Effect.fail(
                  new StorageError({
                    message: TOKEN_CANARY,
                    cause: { tokenResponse: TOKEN_CANARY },
                  }),
                )
              : Effect.die(
                  // oxlint-disable-next-line executor/no-error-constructor -- boundary: leak test deliberately injects a raw provider defect
                  new Error(TOKEN_CANARY),
                );
          }
          return Effect.succeed(store.get(String(id)) ?? null);
        }),
      set: (id: ProviderItemId, value: string) =>
        Effect.sync(() => {
          store.set(String(id), value);
        }),
      delete: (id: ProviderItemId) =>
        Effect.sync(() => {
          store.delete(String(id));
        }),
    };

    const provider: CredentialProvider =
      behaviour === null
        ? base
        : behaviour.kind === "throwingCapabilityGetter"
          ? (Object.defineProperty({ ...base }, "refreshGrant", {
              get: () => {
                // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: leak test simulates an untyped plugin capability getter
                throw TOKEN_CANARY;
              },
            }) as CredentialProvider)
          : {
              ...base,
              refreshGrant(input: RefreshGrantInput) {
                recorder.grants.push(input);
                if (behaviour.kind === "requiresReceiver" && this.key !== base.key) {
                  return Effect.die(TOKEN_CANARY);
                }
                // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: leak test simulates an untyped plugin throwing before it returns an Effect
                if (behaviour.kind === "syncThrow") throw new Error(TOKEN_CANARY);
                if (behaviour.kind === "storageFailure") {
                  return Effect.fail(
                    new StorageError({
                      message: TOKEN_CANARY,
                      cause: { tokenResponse: TOKEN_CANARY },
                    }),
                  );
                }
                if (behaviour.kind === "defect") {
                  // oxlint-disable-next-line executor/no-error-constructor -- boundary: leak test deliberately injects a raw provider defect
                  return Effect.die(new Error(TOKEN_CANARY));
                }
                if (behaviour.kind === "interruptedDefect") {
                  return Effect.failCause(
                    Cause.combine(Cause.die(TOKEN_CANARY), Cause.interrupt(123)),
                  );
                }
                if (behaviour.kind === "throwingRejectionGetter") {
                  const malformed = Object.defineProperty(
                    { _tag: "RefreshGrantRejected" },
                    "error",
                    {
                      get: () => {
                        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: leak test simulates a malformed remote object with a throwing getter
                        throw new Error(TOKEN_CANARY);
                      },
                    },
                  );
                  return Effect.fail(malformed as RefreshGrantRejected);
                }
                if (behaviour.kind === "changingRejectionGetter") {
                  const malformed = Object.defineProperty(
                    { _tag: "RefreshGrantRejected" },
                    "error",
                    {
                      get: () => {
                        recorder.rejectionErrorReads += 1;
                        return recorder.rejectionErrorReads === 1 ? "invalid_grant" : TOKEN_CANARY;
                      },
                    },
                  );
                  return Effect.fail(malformed as RefreshGrantRejected);
                }
                if (behaviour.kind === "throwingResultGetter") {
                  const result = { expiresInSeconds: 3_600, scope: "read" };
                  Object.defineProperty(
                    result,
                    behaviour.field === "expiry" ? "expiresInSeconds" : "scope",
                    {
                      get: () => {
                        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: leak test simulates a malformed remote success object
                        throw TOKEN_CANARY;
                      },
                    },
                  );
                  return Effect.succeed(result);
                }
                return Effect.suspend(() => {
                  if (behaviour.kind === "rejected") {
                    const rejection = new RefreshGrantRejected({ error: behaviour.error });
                    if (
                      behaviour.unsafeDetails === undefined &&
                      behaviour.unsafeError === undefined
                    ) {
                      return Effect.fail(rejection);
                    }
                    // Simulate an untyped JavaScript or remote provider. Executor must project only
                    // the validated RFC classification, even when extra secret-bearing fields exist.
                    return Effect.fail(
                      Object.assign(rejection, {
                        error: behaviour.unsafeError ?? rejection.error,
                        message: behaviour.unsafeDetails,
                        cause: { message: behaviour.unsafeDetails },
                      }),
                    );
                  }
                  if (behaviour.kind === "sealsNothing") {
                    // A provider reporting a grant it did not perform is out of contract. What the
                    // host CAN do is refuse to stamp the row healthy over a token it cannot read
                    // back, which is what this drives.
                    store.delete(String(input.accessItemId));
                    return Effect.succeed({ expiresInSeconds: 3_600, scope: "read" });
                  }
                  store.set(String(input.accessItemId), "delegated-access-token");
                  return Effect.succeed({
                    expiresInSeconds:
                      behaviour.kind === "readFailure" || behaviour.kind === "requiresReceiver"
                        ? 3_600
                        : behaviour.expiresInSeconds,
                    scope:
                      behaviour.kind === "readFailure" || behaviour.kind === "requiresReceiver"
                        ? "read"
                        : behaviour.scope,
                  });
                });
              },
            };

    return {
      id: "memory-credentials" as const,
      storage: () => ({}),
      credentialProviders: [provider],
    };
  })();

describe("provider-owned OAuth refresh grant", () => {
  const expectOpaqueProviderFailure = (exit: Exit.Exit<unknown, unknown>, message: string) => {
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(JSON.stringify(exit)).not.toContain(TOKEN_CANARY);
    expect(Cause.pretty(exit.cause)).not.toContain(TOKEN_CANARY);
    const reason = exit.cause.reasons.find(Cause.isFailReason);
    expect(reason).toBeDefined();
    if (reason === undefined) return;
    expect(reason.error).toBeInstanceOf(StorageError);
    expect((reason.error as StorageError).message).toBe(message);
    expect((reason.error as StorageError).cause).toBeUndefined();
  };

  /** Connect, force the connection past expiry, and hand back the pieces a test asserts on. The
   *  tool is NOT invoked here — each test drives the refresh itself so it can assert on failure. */
  const scenario = (options: {
    readonly behaviour: GrantBehaviour | null;
    readonly grant?: "authorization_code" | "client_credentials";
  }) =>
    Effect.gen(function* () {
      const recorder: Recorder = { reads: [], grants: [], rejectionErrorReads: 0 };
      const server = yield* serveOAuthTestServer({ scopes: ["read"] });
      const plugins = [
        delegatingCredentialsPlugin(recorder, options.behaviour),
        oauthPlugin,
      ] as const;
      const { executor, config } = yield* makeTestWorkspaceHarness({ plugins });
      yield* executor.acme.seed(["read"]);

      const grant = options.grant ?? "authorization_code";
      yield* executor.oauth.createClient({
        owner: "org",
        slug: CLIENT,
        authorizationUrl: server.authorizationEndpoint,
        tokenUrl: server.tokenEndpoint,
        grant,
        clientId: "test-client",
        clientSecret: "test-secret",
      });

      const started = yield* executor.oauth.start({
        owner: "org",
        client: CLIENT,
        clientOwner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
      });

      // `die` rather than `expect` — this is shared setup, not the assertion under test, and an
      // expect inside a branch is what the repo's no-conditional-tests rule exists to stop.
      if (grant === "authorization_code") {
        if (started.status !== "redirect") {
          return yield* Effect.die("expected a redirect-status OAuth start");
        }
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        yield* executor.oauth.complete({ state: started.state, code: callback.code });
      } else if (started.status !== "connected") {
        return yield* Effect.die("expected client_credentials to connect without a redirect");
      }

      // Force the next resolve down the refresh path.
      yield* Effect.promise(() =>
        config.db.updateMany("connection", {
          where: (b) => b("name", "=", "main"),
          set: { expires_at: Date.now() - 60_000 },
        }),
      );

      recorder.reads.length = 0;
      recorder.grants.length = 0;
      return { recorder, server, config, executor };
    });

  it.effect("delegates the grant and never resolves the refresh token through the host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { recorder, server, executor } = yield* scenario({ behaviour: SEALS });
        const out = yield* executor.execute(TOOL, {});

        // The grant was delegated, and named by id rather than handed a value.
        expect(recorder.grants).toHaveLength(1);
        const grant = recorder.grants[0]!;
        expect(String(grant.refreshItemId)).toContain(":refresh");
        expect(grant.tokenUrl).toBe(server.tokenEndpoint);
        expect(grant.clientAuth).toBe("body");

        // THE CUSTODY CLAIM. If this ever fails, the host is asking for the secret again and the
        // guarantee is gone — while the refresh itself still appears to work.
        expect(recorder.reads.some((id) => id.endsWith(":refresh"))).toBe(false);

        // The client secret is a long-lived credential too, and the provider was given its ID
        // precisely so it need never be revealed. Resolving it anyway would leave a sealed store
        // failing the refresh before `refreshGrant` was ever reached.
        expect(recorder.reads.some((id) => id.includes("secret"))).toBe(false);
        expect(grant.clientSecretItemId).toBeDefined();

        // The token the tool ran with is the one the provider sealed.
        expect(out).toEqual({ token: "delegated-access-token" });
      }),
    ),
  );

  it.effect("falls back to the host-side exchange when the provider cannot do the grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { recorder, executor } = yield* scenario({ behaviour: null });
        yield* executor.execute(TOOL, {});

        // Absence of `refreshGrant` changes nothing: the host performs the exchange, so it DOES
        // resolve the refresh token. Pinning that here is what makes the test above meaningful —
        // it shows the difference is the provider capability, not the harness.
        expect(recorder.grants).toHaveLength(0);
        expect(recorder.reads.some((id) => id.endsWith(":refresh"))).toBe(true);
      }),
    ),
  );

  it.effect("records the expiry and scope the provider reported", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const before = Date.now();
        const { config, executor } = yield* scenario({ behaviour: SEALS });
        yield* executor.execute(TOOL, {});

        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        // Converted against the HOST clock, so the stored instant is comparable with the one
        // `shouldRefreshToken` later reads. A provider-computed absolute instant would import that
        // machine's skew and either serve expired tokens or churn.
        expect(Number(row?.expires_at)).toBeGreaterThanOrEqual(before + 3_600_000);
        expect(Number(row?.expires_at)).toBeLessThanOrEqual(Date.now() + 3_600_000);
        expect(row?.oauth_scope).toBe("read");
      }),
    ),
  );

  it.effect("accepts the documented maximum delegated token lifetime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const before = Date.now();
        const { config, executor } = yield* scenario({
          behaviour: {
            kind: "seals",
            scope: "read",
            expiresInSeconds: MAX_REFRESH_GRANT_EXPIRES_IN_SECONDS,
          },
        });
        yield* executor.execute(TOOL, {});
        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        expect(Number(row?.expires_at)).toBeGreaterThanOrEqual(
          before + MAX_REFRESH_GRANT_EXPIRES_IN_SECONDS * 1_000,
        );
      }),
    ),
  );

  it.effect("rejects a delegated token lifetime above the documented maximum", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* scenario({
          behaviour: {
            kind: "seals",
            scope: "read",
            expiresInSeconds: MAX_REFRESH_GRANT_EXPIRES_IN_SECONDS + 1,
          },
        });
        const exit = yield* Effect.exit(executor.execute(TOOL, {}));
        expectOpaqueProviderFailure(
          exit,
          "Credential provider could not complete OAuth token refresh.",
        );
      }),
    ),
  );

  it.effect("leaves the recorded scope alone when the provider reports none", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { config, executor } = yield* scenario({
          behaviour: { kind: "seals", scope: null, expiresInSeconds: null },
        });
        // Give the row a scope to preserve. Without a known prior value the assertion below cannot
        // tell "left alone" from "cleared" — both would read null.
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("name", "=", "main"),
            set: { oauth_scope: "read" },
          }),
        );
        yield* executor.execute(TOOL, {});

        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        // `null` scope means "the AS did not report one", which must not clear what was granted at
        // connect time — distinct from an empty scope, which would.
        expect(row?.oauth_scope).toBe("read");
        expect(row?.expires_at).toBeNull();
      }),
    ),
  );

  it.effect("surfaces a refused grant as re-auth and arms the known-dead gate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { config, executor, recorder } = yield* scenario({
          behaviour: {
            kind: "rejected",
            error: "invalid_grant",
            unsafeDetails: TOKEN_CANARY,
          },
        });

        const failure = yield* Effect.flip(executor.execute(TOOL, {}));
        // Not a StorageError: that is scrubbed to "Internal tool error [id]" at the sandbox
        // boundary, so the user would never be told to reconnect.
        const serializedFailure = JSON.stringify(failure);
        expect(serializedFailure).toContain("invalid_grant");
        expect(serializedFailure).not.toContain(TOKEN_CANARY);

        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        expect(
          (row?.provider_state as { oauthReauthRequiredAt?: number } | null)?.oauthReauthRequiredAt,
        ).toEqual(expect.any(Number));
        expect(row?.last_health).toMatchObject({ status: "expired" });
        expect(
          JSON.stringify({ providerState: row?.provider_state, lastHealth: row?.last_health }),
        ).not.toContain(TOKEN_CANARY);

        // The gate is armed, so the doomed grant is not re-sent on the next resolve. Without this
        // a dead connection re-sends its dead grant on every proactive cycle, indefinitely.
        recorder.grants.length = 0;
        yield* Effect.flip(executor.execute(TOOL, {}));
        expect(recorder.grants).toHaveLength(0);
      }),
    ),
  );

  it.effect("preserves RFC 8707 invalid_target as a safe actionable classification", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { config, executor, recorder } = yield* scenario({
          behaviour: { kind: "rejected", error: "invalid_target" },
        });
        const exit = yield* Effect.exit(executor.execute(TOOL, {}));
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        expect(Cause.pretty(exit.cause)).toContain("invalid_target");
        expect(Cause.pretty(exit.cause)).not.toContain(TOKEN_CANARY);
        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        expect(
          (row?.provider_state as { oauthReauthRequiredAt?: number } | null)?.oauthReauthRequiredAt,
        ).toBeUndefined();

        // Unlike invalid_grant, invalid_target does not prove the refresh token is dead.
        recorder.grants.length = 0;
        yield* Effect.exit(executor.execute(TOOL, {}));
        expect(recorder.grants).toHaveLength(1);
      }),
    ),
  );

  it.effect("drops free-form rejection details and malformed classifications", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { config, executor, recorder } = yield* scenario({
          behaviour: {
            kind: "rejected",
            unsafeDetails: TOKEN_CANARY,
            unsafeError: TOKEN_CANARY,
          },
        });

        const failure = yield* Effect.flip(executor.execute(TOOL, {}));
        // This is also the failure object an outer boundary may log. A fixed message plus an
        // undefined cause proves the hostile provider payload cannot flow through that log path.
        expect(failure).toMatchObject({
          _tag: "StorageError",
          message: "Credential provider could not complete OAuth token refresh.",
          cause: undefined,
        });
        expect(JSON.stringify(failure)).not.toContain(TOKEN_CANARY);

        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        expect(
          (row?.provider_state as { oauthReauthRequiredAt?: number } | null)?.oauthReauthRequiredAt,
        ).toBeUndefined();
        expect(
          JSON.stringify({ providerState: row?.provider_state, lastHealth: row?.last_health }),
        ).not.toContain(TOKEN_CANARY);

        // An unknown classification is retryable and must not arm the known-dead gate.
        recorder.grants.length = 0;
        yield* Effect.flip(executor.execute(TOOL, {}));
        expect(recorder.grants).toHaveLength(1);
      }),
    ),
  );

  it.effect("scrubs provider storage failures before they reach host error channels", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { config, executor, recorder } = yield* scenario({
          behaviour: { kind: "storageFailure" },
        });

        const exit = yield* Effect.exit(executor.execute(TOOL, {}));
        expectOpaqueProviderFailure(
          exit,
          "Credential provider could not complete OAuth token refresh.",
        );

        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        expect(
          JSON.stringify({ providerState: row?.provider_state, lastHealth: row?.last_health }),
        ).not.toContain(TOKEN_CANARY);
        expect(
          (row?.provider_state as { oauthReauthRequiredAt?: number } | null)?.oauthReauthRequiredAt,
        ).toBeUndefined();

        // A storage failure is retryable and must not arm the known-dead grant gate.
        recorder.grants.length = 0;
        const retry = yield* Effect.exit(executor.execute(TOOL, {}));
        expectOpaqueProviderFailure(
          retry,
          "Credential provider could not complete OAuth token refresh.",
        );
        expect(recorder.grants).toHaveLength(1);
      }),
    ),
  );

  it.effect("scrubs a synchronous provider throw", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* scenario({ behaviour: { kind: "syncThrow" } });
        const exit = yield* Effect.exit(executor.execute(TOOL, {}));
        expectOpaqueProviderFailure(
          exit,
          "Credential provider could not complete OAuth token refresh.",
        );
      }),
    ),
  );

  it.effect("scrubs a provider defect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* scenario({ behaviour: { kind: "defect" } });
        const exit = yield* Effect.exit(executor.execute(TOOL, {}));
        expectOpaqueProviderFailure(
          exit,
          "Credential provider could not complete OAuth token refresh.",
        );
      }),
    ),
  );

  it.effect("scrubs malformed rejection getters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* scenario({
          behaviour: { kind: "throwingRejectionGetter" },
        });
        const exit = yield* Effect.exit(executor.execute(TOOL, {}));
        expectOpaqueProviderFailure(
          exit,
          "Credential provider could not complete OAuth token refresh.",
        );
      }),
    ),
  );

  it.effect("snapshots a stateful rejection classification exactly once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { config, executor, recorder } = yield* scenario({
          behaviour: { kind: "changingRejectionGetter" },
        });
        const exit = yield* Effect.exit(executor.execute(TOOL, {}));
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        expect(recorder.rejectionErrorReads).toBe(1);
        expect(Cause.pretty(exit.cause)).toContain("invalid_grant");
        expect(Cause.pretty(exit.cause)).not.toContain(TOKEN_CANARY);

        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        expect(
          JSON.stringify({ providerState: row?.provider_state, lastHealth: row?.last_health }),
        ).not.toContain(TOKEN_CANARY);
      }),
    ),
  );

  it.effect("scrubs a throwing refresh capability getter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* scenario({
          behaviour: { kind: "throwingCapabilityGetter" },
        });
        const exit = yield* Effect.exit(executor.execute(TOOL, {}));
        expectOpaqueProviderFailure(
          exit,
          "Credential provider could not complete OAuth token refresh.",
        );
      }),
    ),
  );

  it.effect("scrubs a throwing expiry getter on a successful provider result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* scenario({
          behaviour: { kind: "throwingResultGetter", field: "expiry" },
        });
        const exit = yield* Effect.exit(executor.execute(TOOL, {}));
        expectOpaqueProviderFailure(
          exit,
          "Credential provider could not complete OAuth token refresh.",
        );
      }),
    ),
  );

  it.effect("scrubs a throwing scope getter on a successful provider result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* scenario({
          behaviour: { kind: "throwingResultGetter", field: "scope" },
        });
        const exit = yield* Effect.exit(executor.execute(TOOL, {}));
        expectOpaqueProviderFailure(
          exit,
          "Credential provider could not complete OAuth token refresh.",
        );
      }),
    ),
  );

  it.effect("refuses to persist a provider scope outside the host-trusted grant set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { config, executor } = yield* scenario({
          behaviour: {
            kind: "seals",
            expiresInSeconds: 3_600,
            scope: TOKEN_CANARY,
          },
        });
        const exit = yield* Effect.exit(executor.execute(TOOL, {}));
        expectOpaqueProviderFailure(
          exit,
          "Credential provider could not complete OAuth token refresh.",
        );
        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        expect(
          JSON.stringify({ scope: row?.oauth_scope, lastHealth: row?.last_health }),
        ).not.toContain(TOKEN_CANARY);
      }),
    ),
  );

  it.effect("preserves a provider method's receiver", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* scenario({ behaviour: { kind: "requiresReceiver" } });
        expect(yield* executor.execute(TOOL, {})).toEqual({ token: "delegated-access-token" });
      }),
    ),
  );

  it.effect("preserves cancellation while dropping a concurrent secret-bearing defect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* scenario({ behaviour: { kind: "interruptedDefect" } });
        const exit = yield* Effect.exit(executor.execute(TOOL, {}));
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(exit.cause.reasons.every(Cause.isInterruptReason)).toBe(true);
        expect(Cause.pretty(exit.cause)).not.toContain(TOKEN_CANARY);
      }),
    ),
  );

  it.effect("scrubs storage failures while resolving the refreshed access token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* scenario({
          behaviour: { kind: "readFailure", failure: "storage" },
        });
        const exit = yield* Effect.exit(executor.execute(TOOL, {}));
        expectOpaqueProviderFailure(
          exit,
          "Credential provider could not resolve the refreshed access token.",
        );
      }),
    ),
  );

  it.effect("scrubs defects while resolving the refreshed access token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* scenario({
          behaviour: { kind: "readFailure", failure: "defect" },
        });
        const exit = yield* Effect.exit(executor.execute(TOOL, {}));
        expectOpaqueProviderFailure(
          exit,
          "Credential provider could not resolve the refreshed access token.",
        );
      }),
    ),
  );

  it.effect("fails rather than reporting success when the new token cannot be read back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { config, executor, recorder } = yield* scenario({
          behaviour: { kind: "sealsNothing" },
        });

        const failure = yield* Effect.flip(executor.execute(TOOL, {}));
        expect(failure).toBeInstanceOf(StorageError);
        expect(failure.message).toBe(
          "Credential provider did not make the refreshed access token resolvable.",
        );
        expect(failure.cause).toBeUndefined();

        // The row must NOT have been stamped with a fresh expiry — doing that over a token nobody
        // can resolve leaves the connection reading healthy for a full lifetime while every call
        // using it fails.
        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        expect(Number(row?.expires_at)).toBeLessThan(Date.now());
        expect(
          (row?.provider_state as { oauthReauthRequiredAt?: number } | null)?.oauthReauthRequiredAt,
        ).toBeUndefined();
        expect((row?.last_health as { status?: string } | null)?.status).not.toBe("expired");

        // This is a provider invariant/storage failure, not a dead OAuth grant: retry it.
        recorder.grants.length = 0;
        yield* Effect.flip(executor.execute(TOOL, {}));
        expect(recorder.grants).toHaveLength(1);
      }),
    ),
  );

  it.effect("refuses to delegate a grant to an endpoint the host's policy rejects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { recorder, executor, config } = yield* scenario({ behaviour: SEALS });
        // The token URL is read from the connection row, so it is the caller's view of where the
        // grant goes. Delegating the exchange must not delegate the guard: a provider holding a
        // sealed refresh token would otherwise post it wherever this column pointed.
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("name", "=", "main"),
            set: { oauth_token_url: "http://evil.example/token" },
          }),
        );

        const failure = yield* Effect.flip(executor.execute(TOOL, {}));
        expect(JSON.stringify(failure)).toContain("https:");
        // The point of the guard: the provider is never asked, so the sealed token never moves.
        expect(recorder.grants).toHaveLength(0);
      }),
    ),
  );

  it.effect("leaves client_credentials on the host-side exchange", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { recorder, executor } = yield* scenario({
          behaviour: SEALS,
          grant: "client_credentials",
        });
        yield* executor.execute(TOOL, {});

        // client_credentials has no refresh token to spend — the token is re-minted from the
        // client id/secret — so it is a different exchange and must not be delegated.
        expect(recorder.grants).toHaveLength(0);
      }),
    ),
  );

  it.effect("keeps refreshing a connection that has no recorded scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { config, executor } = yield* scenario({ behaviour: SEALS });
        // RFC 6749 §5.1 lets an authorization server omit the granted scope, so a live connection
        // can legitimately carry none. The scope validation must not turn that into a permanent
        // failure: with nothing recorded there is nothing to widen from.
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("name", "=", "main"),
            set: { oauth_scope: null },
          }),
        );

        const out = yield* executor.execute(TOOL, {});
        expect(out).toEqual({ token: "delegated-access-token" });

        // The provider's scope string is still never persisted — that is the property the
        // validation exists to hold, and it holds here by recording nothing at all.
        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        expect(row?.oauth_scope).toBeNull();
      }),
    ),
  );
});
