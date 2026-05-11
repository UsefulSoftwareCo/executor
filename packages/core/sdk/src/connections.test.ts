import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Predicate } from "effect";

import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";

import { makeInMemoryBlobStore } from "./blob";
import {
  ConnectionRefreshError,
  CreateConnectionInput,
  RemoveConnectionInput,
  TokenMaterial,
  UpdateConnectionTokensInput,
  type ConnectionProvider,
  type ConnectionRefreshInput,
  type ConnectionRefreshResult,
} from "./connections";
import { collectSchemas, createExecutor } from "./executor";
import { ConnectionId, ScopeId, SecretId } from "./ids";
import { definePlugin } from "./plugin";
import { Scope } from "./scope";
import { RemoveSecretInput, SetSecretInput, type SecretProvider } from "./secrets";
import { makeTestConfig } from "./testing";

// ---------------------------------------------------------------------------
// Shared fixture helpers. Each test builds its own plugin stack so refresh
// handlers and captured provider inputs stay isolated.
// ---------------------------------------------------------------------------

const makeMemoryProvider = (): SecretProvider => {
  const store = new Map<string, string>();
  const key = (scope: string, id: string) => `${scope}\u0000${id}`;
  return {
    key: "memory",
    writable: true,
    get: (id, scope) => Effect.sync(() => store.get(key(scope, id)) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(key(scope, id), value);
      }),
    delete: (id, scope) => Effect.sync(() => store.delete(key(scope, id))),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((k) => {
          const name = k.split("\u0000", 2)[1] ?? k;
          return { id: name, name };
        }),
      ),
  };
};

const memorySecretsPlugin = (provider: SecretProvider = makeMemoryProvider()) =>
  definePlugin(() => ({
    id: "memory-secrets" as const,
    storage: () => ({}),
    secretProviders: [provider],
  }))();

// Connection provider factory that records every refresh call and returns
// whatever result the test asked for. The `refresh` handler is optional —
// tests that exercise "no refresh" behavior omit it.
const makeConnectionProvider = (opts: {
  key: string;
  refresh?: (input: ConnectionRefreshInput) => ConnectionRefreshResult;
}) => {
  const calls: ConnectionRefreshInput[] = [];
  const provider: ConnectionProvider = {
    key: opts.key,
    ...(opts.refresh
      ? {
          refresh: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return opts.refresh!(input);
            }),
        }
      : {}),
  };
  return { provider, calls };
};

const connPlugin = (provider: ConnectionProvider) =>
  definePlugin(() => ({
    id: "conn-test" as const,
    storage: () => ({}),
    connectionProviders: [provider],
  }))();

const sid = (s: string) => SecretId.make(s);
const cid = (s: string) => ConnectionId.make(s);
const scpid = (s: string) => ScopeId.make(s);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("connections", () => {
  it.effect("create + get + list round-trips", () =>
    Effect.gen(function* () {
      const { provider } = makeConnectionProvider({ key: "spotify" });
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), connPlugin(provider)] as const,
        }),
      );

      const created = yield* executor.connections.create(
        new CreateConnectionInput({
          id: cid("conn-1"),
          scope: scpid("test-scope"),
          provider: "spotify",
          identityLabel: "alice",
          accessToken: new TokenMaterial({
            secretId: sid("conn-1.access"),
            name: "access",
            value: "access-v1",
          }),
          refreshToken: new TokenMaterial({
            secretId: sid("conn-1.refresh"),
            name: "refresh",
            value: "refresh-v1",
          }),
          expiresAt: Date.now() + 3_600_000,
          oauthScope: "user-read",
          providerState: null,
        }),
      );
      expect(created.id).toBe(cid("conn-1"));
      expect(created.identityLabel).toBe("alice");

      const got = yield* executor.connections.get("conn-1");
      expect(got?.id).toBe(cid("conn-1"));
      expect(got?.accessTokenSecretId).toBe(sid("conn-1.access"));

      const list = yield* executor.connections.list();
      expect(list.map((r) => r.id)).toEqual([cid("conn-1")]);
    }),
  );

  it.effect("create fails when the provider is not registered", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin()] as const,
        }),
      );

      const err = yield* executor.connections
        .create(
          new CreateConnectionInput({
            id: cid("conn-x"),
            scope: scpid("test-scope"),
            provider: "unregistered",
            identityLabel: null,
            accessToken: new TokenMaterial({
              secretId: sid("conn-x.access"),
              name: "access",
              value: "a",
            }),
            refreshToken: null,
            expiresAt: null,
            oauthScope: null,
            providerState: null,
          }),
        )
        .pipe(Effect.flip);
      expect(Predicate.isTagged(err, "ConnectionProviderNotRegisteredError")).toBe(true);
    }),
  );

  it.effect("create fails when the target scope is outside the stack", () =>
    Effect.gen(function* () {
      const { provider } = makeConnectionProvider({ key: "spotify" });
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), connPlugin(provider)] as const,
        }),
      );

      const result = yield* Effect.exit(
        executor.connections.create(
          new CreateConnectionInput({
            id: cid("conn-y"),
            scope: scpid("not-in-stack"),
            provider: "spotify",
            identityLabel: null,
            accessToken: new TokenMaterial({
              secretId: sid("conn-y.access"),
              name: "access",
              value: "a",
            }),
            refreshToken: null,
            expiresAt: null,
            oauthScope: null,
            providerState: null,
          }),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("secrets.list hides connection-owned secrets but surfaces bare ones", () =>
    Effect.gen(function* () {
      const { provider } = makeConnectionProvider({ key: "spotify" });
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), connPlugin(provider)] as const,
        }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: sid("bare-api"),
          scope: scpid("test-scope"),
          name: "bare API key",
          value: "bare",
        }),
      );

      yield* executor.connections.create(
        new CreateConnectionInput({
          id: cid("conn-1"),
          scope: scpid("test-scope"),
          provider: "spotify",
          identityLabel: null,
          accessToken: new TokenMaterial({
            secretId: sid("conn-1.access"),
            name: "access",
            value: "a",
          }),
          refreshToken: new TokenMaterial({
            secretId: sid("conn-1.refresh"),
            name: "refresh",
            value: "r",
          }),
          expiresAt: null,
          oauthScope: null,
          providerState: null,
        }),
      );

      const list = yield* executor.secrets.list();
      const ids = list.map((s) => String(s.id));
      expect(ids).toContain("bare-api");
      expect(ids).not.toContain("conn-1.access");
      expect(ids).not.toContain("conn-1.refresh");
    }),
  );

  it.effect(
    "secrets.remove rejects connection-owned secrets with SecretOwnedByConnectionError",
    () =>
      Effect.gen(function* () {
        const { provider } = makeConnectionProvider({ key: "spotify" });
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [memorySecretsPlugin(), connPlugin(provider)] as const,
          }),
        );

        yield* executor.connections.create(
          new CreateConnectionInput({
            id: cid("conn-1"),
            scope: scpid("test-scope"),
            provider: "spotify",
            identityLabel: null,
            accessToken: new TokenMaterial({
              secretId: sid("conn-1.access"),
              name: "access",
              value: "a",
            }),
            refreshToken: null,
            expiresAt: null,
            oauthScope: null,
            providerState: null,
          }),
        );

        const err = yield* executor.secrets
          .remove(
            new RemoveSecretInput({
              id: sid("conn-1.access"),
              targetScope: scpid("test-scope"),
            }),
          )
          .pipe(Effect.flip);
        expect(Predicate.isTagged(err, "SecretOwnedByConnectionError")).toBe(true);
      }),
  );

  it.effect("connections.remove cascades through providers and deletes the core row", () =>
    Effect.gen(function* () {
      const secretProvider = makeMemoryProvider();
      const { provider } = makeConnectionProvider({ key: "spotify" });
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(secretProvider), connPlugin(provider)] as const,
        }),
      );

      yield* executor.connections.create(
        new CreateConnectionInput({
          id: cid("conn-1"),
          scope: scpid("test-scope"),
          provider: "spotify",
          identityLabel: null,
          accessToken: new TokenMaterial({
            secretId: sid("conn-1.access"),
            name: "access",
            value: "access-v1",
          }),
          refreshToken: new TokenMaterial({
            secretId: sid("conn-1.refresh"),
            name: "refresh",
            value: "refresh-v1",
          }),
          expiresAt: null,
          oauthScope: null,
          providerState: null,
        }),
      );

      // Pre-check: backing provider holds the tokens.
      expect(yield* secretProvider.get!("conn-1.access", "test-scope")).toBe("access-v1");
      expect(yield* secretProvider.get!("conn-1.refresh", "test-scope")).toBe("refresh-v1");

      yield* executor.connections.remove(
        new RemoveConnectionInput({ id: cid("conn-1"), targetScope: scpid("test-scope") }),
      );

      // Connection row gone.
      expect(yield* executor.connections.get("conn-1")).toBeNull();
      // Backing secret values gone from the provider.
      expect(yield* secretProvider.get!("conn-1.access", "test-scope")).toBeNull();
      expect(yield* secretProvider.get!("conn-1.refresh", "test-scope")).toBeNull();
    }),
  );

  it.effect("accessToken returns the stored value when not near expiry", () =>
    Effect.gen(function* () {
      const { provider, calls } = makeConnectionProvider({
        key: "spotify",
        refresh: () => ({
          accessToken: "should-not-be-used",
        }),
      });
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), connPlugin(provider)] as const,
        }),
      );

      yield* executor.connections.create(
        new CreateConnectionInput({
          id: cid("conn-1"),
          scope: scpid("test-scope"),
          provider: "spotify",
          identityLabel: null,
          accessToken: new TokenMaterial({
            secretId: sid("conn-1.access"),
            name: "access",
            value: "access-fresh",
          }),
          refreshToken: new TokenMaterial({
            secretId: sid("conn-1.refresh"),
            name: "refresh",
            value: "refresh-v1",
          }),
          // Expiry far in the future — no refresh.
          expiresAt: Date.now() + 3_600_000,
          oauthScope: null,
          providerState: null,
        }),
      );

      const token = yield* executor.connections.accessToken("conn-1");
      expect(token).toBe("access-fresh");
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect(
    "accessToken calls provider.refresh inside the skew window and writes new tokens back",
    () =>
      Effect.gen(function* () {
        const secretProvider = makeMemoryProvider();
        const { provider, calls } = makeConnectionProvider({
          key: "spotify",
          refresh: (input) => ({
            accessToken: `rotated-${input.refreshToken ?? "none"}`,
            refreshToken: "refresh-v2",
            expiresAt: Date.now() + 3_600_000,
            oauthScope: "user-read user-modify",
            providerState: { rotation: "bumped" },
          }),
        });
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [memorySecretsPlugin(secretProvider), connPlugin(provider)] as const,
          }),
        );

        yield* executor.connections.create(
          new CreateConnectionInput({
            id: cid("conn-1"),
            scope: scpid("test-scope"),
            provider: "spotify",
            identityLabel: "alice",
            accessToken: new TokenMaterial({
              secretId: sid("conn-1.access"),
              name: "access",
              value: "access-v1",
            }),
            refreshToken: new TokenMaterial({
              secretId: sid("conn-1.refresh"),
              name: "refresh",
              value: "refresh-v1",
            }),
            // Already expired so we're well inside the 60s skew window.
            expiresAt: Date.now() - 1_000,
            oauthScope: "user-read",
            providerState: { rotation: "fresh" },
          }),
        );

        const token = yield* executor.connections.accessToken("conn-1");
        expect(token).toBe("rotated-refresh-v1");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.identityLabel).toBe("alice");
        expect(calls[0]!.refreshToken).toBe("refresh-v1");
        expect(calls[0]!.providerState).toEqual({ rotation: "fresh" });

        // Backing secrets got rewritten at the same ids.
        expect(yield* secretProvider.get!("conn-1.access", "test-scope")).toBe(
          "rotated-refresh-v1",
        );
        expect(yield* secretProvider.get!("conn-1.refresh", "test-scope")).toBe("refresh-v2");

        const got = yield* executor.connections.get("conn-1");
        expect(got?.providerState).toEqual({ rotation: "bumped" });
        expect(got?.oauthScope).toBe("user-read user-modify");
      }),
  );

  it.effect("accessToken dedupes concurrent refreshes into a single provider call", () =>
    Effect.gen(function* () {
      // A gated refresh provider. Every concurrent caller that lands
      // inside the skew window must converge on the single pending
      // refresh instead of hitting the token endpoint N times. The
      // `entered` Deferred signals that the leader fiber is parked
      // inside `refresh`; we only release the `gate` once every
      // caller has had a chance to register.
      const gate = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const calls: ConnectionRefreshInput[] = [];
      let responseCounter = 0;
      const provider: ConnectionProvider = {
        key: "spotify",
        refresh: (input): Effect.Effect<ConnectionRefreshResult, ConnectionRefreshError> =>
          Effect.gen(function* () {
            calls.push(input);
            const n = ++responseCounter;
            yield* Deferred.succeed(entered, undefined as void);
            // Block the leader inside `refresh` until the test
            // releases the gate. Any other fiber that concurrently
            // calls `accessToken` must observe the in-flight
            // Deferred instead of entering this handler.
            yield* Deferred.await(gate);
            return {
              accessToken: `rotated-${n}`,
              refreshToken: `refresh-${n}`,
              expiresAt: Date.now() + 3_600_000,
              oauthScope: "user-read",
              providerState: null,
            };
          }),
      };

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), connPlugin(provider)] as const,
        }),
      );

      yield* executor.connections.create(
        new CreateConnectionInput({
          id: cid("conn-1"),
          scope: scpid("test-scope"),
          provider: "spotify",
          identityLabel: null,
          accessToken: new TokenMaterial({
            secretId: sid("conn-1.access"),
            name: "access",
            value: "stale",
          }),
          refreshToken: new TokenMaterial({
            secretId: sid("conn-1.refresh"),
            name: "refresh",
            value: "refresh-v1",
          }),
          // Expired so every caller enters the refresh branch.
          expiresAt: Date.now() - 1_000,
          oauthScope: null,
          providerState: null,
        }),
      );

      // Kick off the leader first and wait for it to park inside
      // `refresh`. Any subsequent caller is guaranteed to see the
      // in-flight Deferred the leader just registered.
      const leaderFiber = yield* Effect.forkDetach(executor.connections.accessToken("conn-1"), {
        startImmediately: true,
      });
      yield* Deferred.await(entered);

      const followerFibers = yield* Effect.forEach(
        [1, 2, 3, 4],
        () =>
          Effect.forkDetach(executor.connections.accessToken("conn-1"), {
            startImmediately: true,
          }),
        { concurrency: "unbounded" },
      );
      yield* Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow);

      // Every follower is queued on the leader's Deferred. Release
      // the gate — the leader resolves, waiters wake up with the
      // same token, no extra `refresh` is invoked.
      yield* Deferred.succeed(gate, undefined as void);

      const leaderResult = yield* Fiber.join(leaderFiber);
      const followerResults = yield* Effect.all(
        followerFibers.map((f) => Fiber.await(f)),
        { concurrency: "unbounded" },
      );
      expect(leaderResult).toBe("rotated-1");
      for (const result of followerResults) {
        expect(Exit.isSuccess(result)).toBe(true);
        if (!Exit.isSuccess(result)) continue;
        expect(result.value).toBe("rotated-1");
      }
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect(
    "accessToken surfaces ConnectionReauthRequiredError when refresh fails with reauthRequired",
    () =>
      Effect.gen(function* () {
        const provider: ConnectionProvider = {
          key: "spotify",
          refresh: (input) =>
            Effect.fail(
              new ConnectionRefreshError({
                connectionId: input.connectionId,
                message:
                  "OAuth token exchange failed: invalid_grant (stored refresh_token revoked)",
                reauthRequired: true,
              }),
            ),
        };

        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [memorySecretsPlugin(), connPlugin(provider)] as const,
          }),
        );

        yield* executor.connections.create(
          new CreateConnectionInput({
            id: cid("conn-1"),
            scope: scpid("test-scope"),
            provider: "spotify",
            identityLabel: "alice",
            accessToken: new TokenMaterial({
              secretId: sid("conn-1.access"),
              name: "access",
              value: "stale",
            }),
            refreshToken: new TokenMaterial({
              secretId: sid("conn-1.refresh"),
              name: "refresh",
              value: "revoked",
            }),
            expiresAt: Date.now() - 1_000,
            oauthScope: null,
            providerState: null,
          }),
        );

        const flipped = yield* executor.connections.accessToken("conn-1").pipe(Effect.flip);
        expect(Predicate.isTagged(flipped, "ConnectionReauthRequiredError")).toBe(true);
        if (!Predicate.isTagged(flipped, "ConnectionReauthRequiredError")) {
          return;
        }
        expect(flipped.provider).toBe("spotify");
        expect(flipped.message).toMatch(/invalid_grant/);
      }),
  );

  it.effect("accessToken preserves ConnectionRefreshError for non-reauth failures", () =>
    Effect.gen(function* () {
      // Transient failure path — the provider failed but not with a
      // terminal RFC 6749 code. The SDK must keep it as-is so
      // callers can tell "retry later" from "prompt for sign-in".
      const provider: ConnectionProvider = {
        key: "spotify",
        refresh: (input) =>
          Effect.fail(
            new ConnectionRefreshError({
              connectionId: input.connectionId,
              message: "network flake",
            }),
          ),
      };

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), connPlugin(provider)] as const,
        }),
      );

      yield* executor.connections.create(
        new CreateConnectionInput({
          id: cid("conn-1"),
          scope: scpid("test-scope"),
          provider: "spotify",
          identityLabel: null,
          accessToken: new TokenMaterial({
            secretId: sid("conn-1.access"),
            name: "access",
            value: "stale",
          }),
          refreshToken: new TokenMaterial({
            secretId: sid("conn-1.refresh"),
            name: "refresh",
            value: "refresh-v1",
          }),
          expiresAt: Date.now() - 1_000,
          oauthScope: null,
          providerState: null,
        }),
      );

      const err = yield* executor.connections.accessToken("conn-1").pipe(Effect.flip);
      expect(Predicate.isTagged(err, "ConnectionRefreshError")).toBe(true);
    }),
  );

  it.effect(
    "accessToken fails with ConnectionRefreshNotSupportedError when provider omits refresh",
    () =>
      Effect.gen(function* () {
        const { provider } = makeConnectionProvider({ key: "static-token" });
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [memorySecretsPlugin(), connPlugin(provider)] as const,
          }),
        );

        yield* executor.connections.create(
          new CreateConnectionInput({
            id: cid("conn-1"),
            scope: scpid("test-scope"),
            provider: "static-token",
            identityLabel: null,
            accessToken: new TokenMaterial({
              secretId: sid("conn-1.access"),
              name: "access",
              value: "a",
            }),
            refreshToken: null,
            expiresAt: Date.now() - 1_000,
            oauthScope: null,
            providerState: null,
          }),
        );

        const err = yield* executor.connections.accessToken("conn-1").pipe(Effect.flip);
        expect(Predicate.isTagged(err, "ConnectionRefreshNotSupportedError")).toBe(true);
      }),
  );

  it.effect("accessToken fails with ConnectionNotFoundError for an unknown id", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin()] as const,
        }),
      );

      const err = yield* executor.connections.accessToken("does-not-exist").pipe(Effect.flip);
      expect(Predicate.isTagged(err, "ConnectionNotFoundError")).toBe(true);
    }),
  );

  it.effect("updateTokens writes new values but does not rotate secret ids", () =>
    Effect.gen(function* () {
      const secretProvider = makeMemoryProvider();
      const { provider } = makeConnectionProvider({ key: "spotify" });
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(secretProvider), connPlugin(provider)] as const,
        }),
      );

      yield* executor.connections.create(
        new CreateConnectionInput({
          id: cid("conn-1"),
          scope: scpid("test-scope"),
          provider: "spotify",
          identityLabel: null,
          accessToken: new TokenMaterial({
            secretId: sid("conn-1.access"),
            name: "access",
            value: "v1",
          }),
          refreshToken: new TokenMaterial({
            secretId: sid("conn-1.refresh"),
            name: "refresh",
            value: "r1",
          }),
          expiresAt: null,
          oauthScope: null,
          providerState: null,
        }),
      );

      const updated = yield* executor.connections.updateTokens(
        new UpdateConnectionTokensInput({
          id: cid("conn-1"),
          accessToken: "v2",
          refreshToken: "r2",
          expiresAt: 1_700_000_000_000,
          oauthScope: "new-scope",
          providerState: { rotation: "next" },
        }),
      );

      expect(updated.accessTokenSecretId).toBe(sid("conn-1.access"));
      expect(updated.refreshTokenSecretId).toBe(sid("conn-1.refresh"));
      expect(updated.expiresAt).toBe(1_700_000_000_000);
      expect(updated.oauthScope).toBe("new-scope");
      expect(updated.providerState).toEqual({ rotation: "next" });

      expect(yield* secretProvider.get!("conn-1.access", "test-scope")).toBe("v2");
      expect(yield* secretProvider.get!("conn-1.refresh", "test-scope")).toBe("r2");
    }),
  );

  it.effect("updateTokens fails with ConnectionNotFoundError for unknown id", () =>
    Effect.gen(function* () {
      const { provider } = makeConnectionProvider({ key: "spotify" });
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), connPlugin(provider)] as const,
        }),
      );

      const err = yield* executor.connections
        .updateTokens(
          new UpdateConnectionTokensInput({
            id: cid("nope"),
            accessToken: "x",
          }),
        )
        .pipe(Effect.flip);
      expect(Predicate.isTagged(err, "ConnectionNotFoundError")).toBe(true);
    }),
  );

  it.effect("setIdentityLabel updates the label", () =>
    Effect.gen(function* () {
      const { provider } = makeConnectionProvider({ key: "spotify" });
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), connPlugin(provider)] as const,
        }),
      );

      yield* executor.connections.create(
        new CreateConnectionInput({
          id: cid("conn-1"),
          scope: scpid("test-scope"),
          provider: "spotify",
          identityLabel: "original",
          accessToken: new TokenMaterial({
            secretId: sid("conn-1.access"),
            name: "access",
            value: "a",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: null,
          providerState: null,
        }),
      );

      yield* executor.connections.setIdentityLabel("conn-1", "alice@example");
      const got = yield* executor.connections.get("conn-1");
      expect(got?.identityLabel).toBe("alice@example");
    }),
  );

  it.effect("setIdentityLabel fails with ConnectionNotFoundError for unknown id", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin()] as const,
        }),
      );

      const err = yield* executor.connections
        .setIdentityLabel("does-not-exist", "x")
        .pipe(Effect.flip);
      expect(Predicate.isTagged(err, "ConnectionNotFoundError")).toBe(true);
    }),
  );

  it.effect("providers() returns every registered connection provider key", () =>
    Effect.gen(function* () {
      const a = makeConnectionProvider({ key: "prov-a" });
      const b = makeConnectionProvider({ key: "prov-b" });
      const multiPlugin = definePlugin(() => ({
        id: "multi" as const,
        storage: () => ({}),
        connectionProviders: [a.provider, b.provider],
      }))();

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), multiPlugin] as const,
        }),
      );

      const keys = yield* executor.connections.providers();
      expect([...keys].sort()).toEqual(["oauth2", "prov-a", "prov-b"]);
    }),
  );
});

// ---------------------------------------------------------------------------
// Multi-scope behaviour — two executors sharing an adapter, same connection
// id registered at different scopes. Reads must innermost-win; removes at
// the inner scope must leave the outer-scope connection intact.
// ---------------------------------------------------------------------------

const makeLayeredConnExecutors = () =>
  Effect.gen(function* () {
    const { provider } = makeConnectionProvider({ key: "spotify" });
    const plugins = [memorySecretsPlugin(), connPlugin(provider)] as const;
    const schema = collectSchemas(plugins);
    const adapter = makeMemoryAdapter({ schema });
    const blobs = makeInMemoryBlobStore();

    const outerId = scpid("org");
    const innerId = scpid("user-org:u1:org");
    const outerScope = new Scope({
      id: outerId,
      name: "outer",
      createdAt: new Date(),
    });
    const innerScope = new Scope({
      id: innerId,
      name: "inner",
      createdAt: new Date(),
    });

    const execOuter = yield* createExecutor({
      scopes: [outerScope],
      adapter,
      blobs,
      plugins,
      onElicitation: "accept-all",
    });
    const execInner = yield* createExecutor({
      scopes: [innerScope, outerScope],
      adapter,
      blobs,
      plugins,
      onElicitation: "accept-all",
    });
    return { execOuter, execInner, outerId, innerId };
  });

describe("connections — multi-scope behaviour", () => {
  it.effect("get picks the innermost-scope row when the same id exists at two scopes", () =>
    Effect.gen(function* () {
      const { execOuter, execInner, outerId, innerId } = yield* makeLayeredConnExecutors();

      yield* execOuter.connections.create(
        new CreateConnectionInput({
          id: cid("shared"),
          scope: outerId,
          provider: "spotify",
          identityLabel: "outer",
          accessToken: new TokenMaterial({
            secretId: sid("shared.access.outer"),
            name: "access",
            value: "outer-access",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: null,
          providerState: null,
        }),
      );

      yield* execInner.connections.create(
        new CreateConnectionInput({
          id: cid("shared"),
          scope: innerId,
          provider: "spotify",
          identityLabel: "inner",
          accessToken: new TokenMaterial({
            secretId: sid("shared.access.inner"),
            name: "access",
            value: "inner-access",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: null,
          providerState: null,
        }),
      );

      const innerView = yield* execInner.connections.get("shared");
      expect(innerView?.identityLabel).toBe("inner");
      expect(innerView?.scopeId).toBe(innerId);

      const outerView = yield* execOuter.connections.get("shared");
      expect(outerView?.identityLabel).toBe("outer");
      expect(outerView?.scopeId).toBe(outerId);

      // Inner executor's list dedupes — one entry for "shared", the inner one.
      const innerList = yield* execInner.connections.list();
      const sharedEntries = innerList.filter((r) => r.id === cid("shared"));
      expect(sharedEntries).toHaveLength(1);
      expect(sharedEntries[0]!.identityLabel).toBe("inner");
    }),
  );

  it.effect("remove at the inner scope does not wipe the outer-scope connection", () =>
    Effect.gen(function* () {
      const { execOuter, execInner, outerId, innerId } = yield* makeLayeredConnExecutors();

      yield* execOuter.connections.create(
        new CreateConnectionInput({
          id: cid("shared"),
          scope: outerId,
          provider: "spotify",
          identityLabel: "outer",
          accessToken: new TokenMaterial({
            secretId: sid("shared.access.outer"),
            name: "access",
            value: "outer-access",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: null,
          providerState: null,
        }),
      );
      yield* execInner.connections.create(
        new CreateConnectionInput({
          id: cid("shared"),
          scope: innerId,
          provider: "spotify",
          identityLabel: "inner",
          accessToken: new TokenMaterial({
            secretId: sid("shared.access.inner"),
            name: "access",
            value: "inner-access",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: null,
          providerState: null,
        }),
      );

      yield* execInner.connections.remove(
        new RemoveConnectionInput({ id: cid("shared"), targetScope: innerId }),
      );

      const outerStill = yield* execOuter.connections.get("shared");
      expect(outerStill?.identityLabel).toBe("outer");
    }),
  );

  it.effect("accessTokenAtScope refreshes with token material from the selected scope", () =>
    Effect.gen(function* () {
      const secretProvider = makeMemoryProvider();
      const calls: ConnectionRefreshInput[] = [];
      const provider: ConnectionProvider = {
        key: "spotify",
        refresh: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return {
              accessToken: `rotated-${input.refreshToken ?? "none"}`,
              refreshToken: `${input.refreshToken ?? "none"}-next`,
              expiresAt: Date.now() + 3_600_000,
            };
          }),
      };
      const plugins = [memorySecretsPlugin(secretProvider), connPlugin(provider)] as const;
      const schema = collectSchemas(plugins);
      const adapter = makeMemoryAdapter({ schema });
      const blobs = makeInMemoryBlobStore();

      const outerId = scpid("org");
      const innerId = scpid("user-org:u1:org");
      const outerScope = new Scope({
        id: outerId,
        name: "outer",
        createdAt: new Date(),
      });
      const innerScope = new Scope({
        id: innerId,
        name: "inner",
        createdAt: new Date(),
      });

      const execOuter = yield* createExecutor({
        scopes: [outerScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });
      const execInner = yield* createExecutor({
        scopes: [innerScope, outerScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });

      const sharedConnection = cid("shared");
      yield* execOuter.connections.create(
        new CreateConnectionInput({
          id: sharedConnection,
          scope: outerId,
          provider: "spotify",
          identityLabel: "outer",
          accessToken: new TokenMaterial({
            secretId: sid("shared.access"),
            name: "access",
            value: "outer-access",
          }),
          refreshToken: new TokenMaterial({
            secretId: sid("shared.refresh"),
            name: "refresh",
            value: "outer-refresh",
          }),
          expiresAt: Date.now() - 1_000,
          oauthScope: null,
          providerState: null,
        }),
      );
      yield* execInner.connections.create(
        new CreateConnectionInput({
          id: sharedConnection,
          scope: innerId,
          provider: "spotify",
          identityLabel: "inner",
          accessToken: new TokenMaterial({
            secretId: sid("shared.access"),
            name: "access",
            value: "inner-access",
          }),
          refreshToken: new TokenMaterial({
            secretId: sid("shared.refresh"),
            name: "refresh",
            value: "inner-refresh",
          }),
          expiresAt: Date.now() - 1_000,
          oauthScope: null,
          providerState: null,
        }),
      );

      const token = yield* execInner.connections.accessTokenAtScope("shared", String(innerId));

      expect(token).toBe("rotated-inner-refresh");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.scopeId).toBe(innerId);
      expect(calls[0]!.refreshToken).toBe("inner-refresh");
      expect(yield* secretProvider.get!("shared.refresh", String(innerId))).toBe(
        "inner-refresh-next",
      );
      expect(yield* secretProvider.get!("shared.refresh", String(outerId))).toBe("outer-refresh");
    }),
  );
});
