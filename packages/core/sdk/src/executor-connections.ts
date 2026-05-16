import { Deferred, Effect, Option, Result, Semaphore } from "effect";

import {
  ConnectionRef,
  ConnectionRefreshError,
  type ConnectionProvider,
  type ConnectionRefreshResult,
  type CreateConnectionInput,
  type RemoveConnectionInput,
  type UpdateConnectionTokensInput,
} from "./connections";
import type { ConnectionRow } from "./core-schema";
import {
  byId,
  byScopedId,
  decodeJsonColumn,
  decodeProviderState,
  makeCoreDb,
  scopedWhere,
} from "./executor-helpers";
import {
  ConnectionInUseError,
  ConnectionNotFoundError,
  ConnectionProviderNotRegisteredError,
  ConnectionReauthRequiredError,
  ConnectionRefreshNotSupportedError,
} from "./errors";
import { StorageError, type StorageFailure } from "./fuma-runtime";
import { ConnectionId, ScopeId, SecretId } from "./ids";
import type { SecretProvider } from "./secrets";
import type { Usage } from "./usages";

export const makeConnectionsFacade = (deps: {
  readonly core: ReturnType<typeof makeCoreDb>;
  readonly scopeIds: readonly string[];
  readonly scopeRank: (row: { readonly scope_id: unknown }) => number;
  readonly findInnermost: <T extends { readonly scope_id: unknown }>(
    rows: readonly T[],
  ) => T | null;
  readonly assertScopeInStack: (
    label: string,
    scopeId: string,
  ) => Effect.Effect<void, StorageError>;
  readonly findConnectionRowAtScope: (input: {
    readonly connectionId: string;
    readonly scopeId: string;
  }) => Effect.Effect<ConnectionRow | null, StorageFailure>;
  readonly transaction: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | StorageFailure>;
  readonly secretProviders: ReadonlyMap<string, SecretProvider>;
  readonly connectionProviders: ReadonlyMap<string, ConnectionProvider>;
  readonly connectionSecretGetAtScope: (
    id: string,
    scope: string,
  ) => Effect.Effect<string | null, StorageFailure>;
  readonly connectionsUsagesStrict: (id: string) => Effect.Effect<readonly Usage[], StorageFailure>;
}) => {
  const {
    core,
    scopeIds,
    scopeRank,
    findInnermost,
    assertScopeInStack,
    findConnectionRowAtScope,
    transaction,
    secretProviders,
    connectionProviders,
    connectionSecretGetAtScope,
    connectionsUsagesStrict,
  } = deps;

  const resolveConnectionProvider = (key: string): ConnectionProvider | undefined =>
    connectionProviders.get(key);

  // In-flight refresh dedup. connectionsAccessToken stamps a Deferred here before
  // calling the provider refresh callback; parallel callers await the same result.
  const refreshInFlight = new Map<
    string,
    Deferred.Deferred<
      string,
      | ConnectionNotFoundError
      | ConnectionProviderNotRegisteredError
      | ConnectionRefreshNotSupportedError
      | ConnectionReauthRequiredError
      | ConnectionRefreshError
      | StorageFailure
    >
  >();
  const refreshInFlightLock = Semaphore.makeUnsafe(1);

  // ------------------------------------------------------------------
  // Connections facade — sign-in state as a first-class primitive.
  // Connection rows own one or more backing `secret` rows via
  // `secret.owned_by_connection_id`; the SDK orchestrates refresh via
  // the registered provider keyed by `connection.provider`.
  // ------------------------------------------------------------------

  // Refresh skew: treat the access token as "about to expire" when
  // we're within this many ms of the expiry the AS declared.
  // Matches the value the old per-plugin refresh code used, so
  // behavior under the new SDK orchestration stays identical.
  const CONNECTION_REFRESH_SKEW_MS = 60_000;

  const rowToConnection = (row: ConnectionRow): ConnectionRef =>
    ConnectionRef.make({
      id: ConnectionId.make(row.id),
      scopeId: ScopeId.make(row.scope_id),
      provider: row.provider,
      identityLabel: row.identity_label ?? null,
      accessTokenSecretId: SecretId.make(row.access_token_secret_id),
      refreshTokenSecretId:
        row.refresh_token_secret_id != null ? SecretId.make(row.refresh_token_secret_id) : null,
      expiresAt: row.expires_at != null ? Number(row.expires_at) : null,
      oauthScope: row.scope ?? null,
      providerState: Option.getOrNull(decodeProviderState(decodeJsonColumn(row.provider_state))),
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    });

  const findInnermostConnectionRow = (
    id: string,
  ): Effect.Effect<ConnectionRow | null, StorageFailure> =>
    Effect.gen(function* () {
      const rows = yield* core.findMany("connection", {
        where: scopedWhere(scopeIds, byId(id)),
      });
      return findInnermost(rows as readonly ConnectionRow[]);
    });

  const connectionsGet = (id: string): Effect.Effect<ConnectionRef | null, StorageFailure> =>
    Effect.gen(function* () {
      const row = yield* findInnermostConnectionRow(id);
      return row ? rowToConnection(row) : null;
    });

  const connectionsGetAtScope = (
    id: string,
    scope: string,
  ): Effect.Effect<ConnectionRef | null, StorageFailure> =>
    Effect.gen(function* () {
      yield* assertScopeInStack("connection get scope", scope);
      const row = yield* findConnectionRowAtScope({
        connectionId: id,
        scopeId: scope,
      });
      return row ? rowToConnection(row) : null;
    });

  const connectionsList = (): Effect.Effect<readonly ConnectionRef[], StorageFailure> =>
    Effect.gen(function* () {
      const rows = yield* core.findMany("connection", { where: scopedWhere(scopeIds) });
      // Dedup by id, innermost scope wins — same rule as sources/tools.
      const byId = new Map<string, ConnectionRow>();
      const byIdRank = new Map<string, number>();
      for (const row of rows as readonly ConnectionRow[]) {
        const rank = scopeRank(row);
        const existing = byIdRank.get(row.id);
        if (existing === undefined || rank < existing) {
          byId.set(row.id, row);
          byIdRank.set(row.id, rank);
        }
      }
      return [...byId.values()].map(rowToConnection);
    });

  // Write a secret value through a specific provider, bypassing the
  // bare-secrets ownership check so the SDK can stamp
  // `owned_by_connection_id` atomically alongside a connection row.
  const writeOwnedSecret = (params: {
    id: string;
    scope: string;
    name: string;
    value: string;
    provider: string;
    ownedByConnectionId: string;
  }): Effect.Effect<void, StorageFailure> =>
    Effect.gen(function* () {
      const target = secretProviders.get(params.provider);
      if (!target) {
        return yield* new StorageError({
          message: `Unknown secret provider: ${params.provider}`,
          cause: undefined,
        });
      }
      if (!target.writable || !target.set) {
        return yield* new StorageError({
          message: `Secret provider "${target.key}" is read-only`,
          cause: undefined,
        });
      }
      yield* target.set(params.id, params.value, params.scope);

      const now = new Date();
      yield* core.deleteMany("secret", {
        where: byScopedId(params.scope, params.id),
      });
      yield* core.create("secret", {
        id: params.id,
        scope_id: params.scope,
        name: params.name,
        provider: target.key,
        owned_by_connection_id: params.ownedByConnectionId,
        created_at: now,
      });
    });

  const pickWritableProvider = (
    requested?: string,
  ): Effect.Effect<SecretProvider, StorageFailure> =>
    Effect.gen(function* () {
      if (requested) {
        const p = secretProviders.get(requested);
        if (!p) {
          return yield* new StorageError({
            message: `Unknown secret provider: ${requested}`,
            cause: undefined,
          });
        }
        return p;
      }
      for (const p of secretProviders.values()) {
        if (p.writable && p.set) return p;
      }
      return yield* new StorageError({
        message: "No writable secret providers registered",
        cause: undefined,
      });
    });

  const connectionsCreate = (
    input: CreateConnectionInput,
  ): Effect.Effect<ConnectionRef, ConnectionProviderNotRegisteredError | StorageFailure> =>
    Effect.gen(function* () {
      if (!scopeIds.some((scopeId) => scopeId === input.scope)) {
        return yield* new StorageError({
          message:
            `connections.create targets scope "${input.scope}" which is not ` +
            `in the executor's scope stack [${scopeIds.join(", ")}].`,
          cause: undefined,
        });
      }
      if (!resolveConnectionProvider(input.provider)) {
        return yield* new ConnectionProviderNotRegisteredError({
          provider: input.provider,
          connectionId: input.id,
        });
      }

      const writable = yield* pickWritableProvider();
      const now = new Date();

      return yield* transaction(
        Effect.gen(function* () {
          // Drop any existing connection row at this scope first so a
          // re-auth replaces cleanly. Owned-secret rows for the old
          // connection are removed by the cascade below (we delete
          // both old + new token secret ids explicitly).
          yield* core.deleteMany("connection", {
            where: byScopedId(input.scope, input.id),
          });

          yield* writeOwnedSecret({
            id: input.accessToken.secretId,
            scope: input.scope,
            name: input.accessToken.name,
            value: input.accessToken.value,
            provider: writable.key,
            ownedByConnectionId: input.id,
          });
          if (input.refreshToken) {
            yield* writeOwnedSecret({
              id: input.refreshToken.secretId,
              scope: input.scope,
              name: input.refreshToken.name,
              value: input.refreshToken.value,
              provider: writable.key,
              ownedByConnectionId: input.id,
            });
          }

          yield* core.create("connection", {
            id: input.id,
            scope_id: input.scope,
            provider: input.provider,
            identity_label: input.identityLabel ?? null,
            access_token_secret_id: input.accessToken.secretId,
            refresh_token_secret_id: input.refreshToken?.secretId ?? null,
            expires_at: input.expiresAt ?? null,
            scope: input.oauthScope ?? null,
            provider_state: input.providerState ?? null,
            created_at: now,
            updated_at: now,
          });

          return ConnectionRef.make({
            id: input.id,
            scopeId: input.scope,
            provider: input.provider,
            identityLabel: input.identityLabel,
            accessTokenSecretId: input.accessToken.secretId,
            refreshTokenSecretId: input.refreshToken?.secretId ?? null,
            expiresAt: input.expiresAt,
            oauthScope: input.oauthScope,
            providerState: input.providerState,
            createdAt: now,
            updatedAt: now,
          });
        }),
      );
    });

  // Write new token material into the existing secret rows and bump
  // the connection row's expiry / scope / providerState. Never
  // mutates `access_token_secret_id` or `refresh_token_secret_id` —
  // those stay pinned so consumers that stashed them in source
  // configs still resolve.
  const connectionsUpdateTokensForRow = (
    input: UpdateConnectionTokensInput,
    row: ConnectionRow,
  ): Effect.Effect<ConnectionRef, ConnectionNotFoundError | StorageFailure> =>
    Effect.gen(function* () {
      const writable = yield* pickWritableProvider();
      const accessName = `Connection ${input.id} access token`;
      const refreshName = `Connection ${input.id} refresh token`;

      return yield* transaction(
        Effect.gen(function* () {
          yield* writeOwnedSecret({
            id: row.access_token_secret_id,
            scope: row.scope_id,
            name: accessName,
            value: input.accessToken,
            provider: writable.key,
            ownedByConnectionId: row.id,
          });
          const rotatedRefresh = input.refreshToken ?? undefined;
          if (rotatedRefresh && row.refresh_token_secret_id) {
            yield* writeOwnedSecret({
              id: row.refresh_token_secret_id,
              scope: row.scope_id,
              name: refreshName,
              value: rotatedRefresh,
              provider: writable.key,
              ownedByConnectionId: row.id,
            });
          }
          const now = new Date();
          const patch: Record<string, unknown> = { updated_at: now };
          if (input.expiresAt !== undefined) patch.expires_at = input.expiresAt ?? null;
          if (input.oauthScope !== undefined) patch.scope = input.oauthScope ?? null;
          if (input.providerState !== undefined) patch.provider_state = input.providerState ?? null;
          if (input.identityLabel !== undefined) patch.identity_label = input.identityLabel ?? null;
          yield* core.updateMany("connection", {
            where: byScopedId(row.scope_id, row.id),
            set: patch,
          });
          const updated = yield* findConnectionRowAtScope({
            connectionId: row.id,
            scopeId: row.scope_id,
          });
          if (!updated) {
            return yield* new ConnectionNotFoundError({
              connectionId: input.id,
            });
          }
          return rowToConnection(updated);
        }),
      );
    });

  const connectionsUpdateTokens = (
    input: UpdateConnectionTokensInput,
  ): Effect.Effect<ConnectionRef, ConnectionNotFoundError | StorageFailure> =>
    Effect.gen(function* () {
      const row = yield* findInnermostConnectionRow(input.id);
      if (!row) {
        return yield* new ConnectionNotFoundError({ connectionId: input.id });
      }
      return yield* connectionsUpdateTokensForRow(input, row);
    });

  const connectionsSetIdentityLabel = (
    id: string,
    label: string | null,
  ): Effect.Effect<void, ConnectionNotFoundError | StorageFailure> =>
    Effect.gen(function* () {
      const row = yield* findInnermostConnectionRow(id);
      if (!row) {
        return yield* new ConnectionNotFoundError({
          connectionId: ConnectionId.make(id),
        });
      }
      yield* core.updateMany("connection", {
        where: byScopedId(row.scope_id, id),
        set: {
          identity_label: label ?? null,
          updated_at: new Date(),
        },
      });
    });

  const connectionsRemove = (
    input: RemoveConnectionInput,
  ): Effect.Effect<void, ConnectionInUseError | StorageFailure> =>
    Effect.gen(function* () {
      const id = input.id;
      const targetScope = input.targetScope;
      yield* assertScopeInStack("connection remove targetScope", targetScope);
      const allRows = yield* core.findMany("connection", {
        where: scopedWhere(scopeIds, byId(id)),
      });
      const row =
        (allRows as readonly ConnectionRow[]).find(
          (candidate) => candidate.scope_id === targetScope,
        ) ?? null;
      if (!row) return;
      const usages = (yield* connectionsUsagesStrict(id)).filter(
        (usage) => usage.scopeId === targetScope,
      );
      if (usages.length > 0) {
        return yield* new ConnectionInUseError({
          connectionId: ConnectionId.make(id),
          usageCount: usages.length,
        });
      }
      const scope = targetScope;
      yield* transaction(
        Effect.gen(function* () {
          // Find every owned secret at this scope and drop through
          // its provider + the core row. We look up by
          // `owned_by_connection_id` rather than just the two ids on
          // the connection row so any accidentally-orphaned siblings
          // get cleaned up too.
          const owned = yield* core.findMany("secret", {
            where: (b) => b.and(b("owned_by_connection_id", "=", id), b("scope_id", "=", scope)),
          });
          const deleters = [...secretProviders.values()].filter(
            (p): p is typeof p & { delete: NonNullable<typeof p.delete> } =>
              !!(p.writable && p.delete),
          );
          for (const secret of owned) {
            yield* Effect.all(
              deleters.map((p) =>
                p
                  .delete(secret.id, scope)
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        `Failed to delete connection-owned secret from provider ${p.key}`,
                        cause,
                      ).pipe(Effect.as(false)),
                    ),
                  ),
              ),
              { concurrency: "unbounded" },
            );
          }
          yield* core.deleteMany("secret", {
            where: (b) => b.and(b("owned_by_connection_id", "=", id), b("scope_id", "=", scope)),
          });
          yield* core.deleteMany("connection", {
            where: byScopedId(scope, id),
          });
        }),
      );
    });

  // Typed error union that `connectionsAccessToken` and every helper
  // that participates in a refresh returns. Pulled out into a type
  // alias because it has to match the Deferred's channel exactly —
  // otherwise concurrent waiters and the leader diverge on the error
  // type.
  type AccessTokenError =
    | ConnectionNotFoundError
    | ConnectionProviderNotRegisteredError
    | ConnectionRefreshNotSupportedError
    | ConnectionReauthRequiredError
    | ConnectionRefreshError
    | StorageFailure;

  // The actual work of a single refresh cycle, factored out so the
  // concurrency gate (`connectionsAccessToken`) stays readable. Runs
  // for the fiber that wins the `refreshInFlight` race.
  const performRefresh = (ref: ConnectionRef): Effect.Effect<string, AccessTokenError> =>
    Effect.gen(function* () {
      const provider = resolveConnectionProvider(ref.provider);
      if (!provider) {
        return yield* new ConnectionProviderNotRegisteredError({
          provider: ref.provider,
          connectionId: ref.id,
        });
      }
      if (!provider.refresh) {
        return yield* new ConnectionRefreshNotSupportedError({
          connectionId: ref.id,
          provider: ref.provider,
        });
      }

      const refreshTokenValue = ref.refreshTokenSecretId
        ? yield* connectionSecretGetAtScope(ref.refreshTokenSecretId, ref.scopeId)
        : null;

      // RFC 6749 §5.2 `invalid_grant` (and anything else the
      // provider tags with `reauthRequired`) is terminal — the
      // stored refresh token can't recover. Translate into the
      // caller-visible "re-authenticate" error so the UI can
      // prompt sign-in instead of silently retrying.
      const rawResult: Result.Result<ConnectionRefreshResult, ConnectionRefreshError> =
        yield* Effect.result(
          provider.refresh({
            connectionId: ref.id,
            scopeId: ref.scopeId,
            identityLabel: ref.identityLabel,
            refreshToken: refreshTokenValue,
            providerState: ref.providerState,
            oauthScope: ref.oauthScope,
          }),
        );
      if (Result.isFailure(rawResult)) {
        const err = rawResult.failure;
        if (err.reauthRequired) {
          return yield* new ConnectionReauthRequiredError({
            connectionId: err.connectionId,
            provider: ref.provider,
            // oxlint-disable-next-line executor/no-unknown-error-message -- typed: ConnectionRefreshError.message is provider-facing domain data, not an unknown caught error
            message: err["message"],
          });
        }
        return yield* err;
      }
      const result = rawResult.success;

      const row = yield* findConnectionRowAtScope({
        connectionId: ref.id,
        scopeId: ref.scopeId,
      });
      if (!row) {
        return yield* new ConnectionNotFoundError({
          connectionId: ref.id,
        });
      }
      yield* connectionsUpdateTokensForRow(
        {
          id: ref.id,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
          oauthScope: result.oauthScope,
          providerState: result.providerState,
        } as UpdateConnectionTokensInput,
        row,
      );

      return result.accessToken;
    });

  // accessToken(id) — the single surface plugins use at invoke time.
  // Resolves the backing secret, checks expiry, calls the provider's
  // refresh handler if we're inside the skew window. New tokens are
  // written back through the same provider and the connection row is
  // patched with the new expiry.
  //
  // Concurrent invokes on an expired token all share one refresh.
  // The fiber that wins the `refreshInFlightLock` race registers a
  // Deferred and performs the refresh; every other concurrent caller
  // observes the Deferred and awaits its completion. The Deferred is
  // pulled out of the map before the refresh result resolves so
  // later invokes don't reuse a completed slot.
  const connectionsAccessTokenForRow = (
    row: ConnectionRow,
  ): Effect.Effect<string, AccessTokenError> =>
    Effect.gen(function* () {
      const ref = rowToConnection(row);
      const now = Date.now();
      const needsRefresh =
        ref.expiresAt !== null && ref.expiresAt - CONNECTION_REFRESH_SKEW_MS <= now;

      if (!needsRefresh) {
        const current = yield* connectionSecretGetAtScope(ref.accessTokenSecretId, ref.scopeId);
        if (current !== null) return current;
        // Fall through to refresh if the stored token vanished — a
        // genuinely-missing secret with no way to refresh is a
        // hard-failure, same behavior as if `expires_at` had passed.
      }

      // Concurrency gate. `action` either returns the fresh access
      // token (this fiber did the refresh) or the already-running
      // Deferred that another fiber stamped into the map (this fiber
      // piggybacks on their refresh).
      const refreshKey = `${ref.scopeId}\u0000${ref.id}`;
      const action = yield* refreshInFlightLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = refreshInFlight.get(refreshKey);
          if (existing) {
            return {
              kind: "await" as const,
              deferred: existing,
            };
          }
          const deferred = yield* Deferred.make<string, AccessTokenError>();
          refreshInFlight.set(refreshKey, deferred);
          return { kind: "lead" as const, deferred };
        }),
      );

      if (action.kind === "await") {
        return yield* Deferred.await(action.deferred);
      }

      // Leader path: run the refresh, pipe the outcome into the
      // Deferred (so waiters wake up), and then clear the map slot
      // regardless of success or failure. Completing before delete
      // ensures a caller that arrives during cleanup can still observe
      // the settled leader result instead of starting a second refresh.
      return yield* performRefresh(ref).pipe(
        Effect.onExit((exit) =>
          refreshInFlightLock.withPermits(1)(
            Effect.gen(function* () {
              yield* Deferred.done(action.deferred, exit);
              refreshInFlight.delete(refreshKey);
            }),
          ),
        ),
      );
    });

  const connectionsAccessToken = (id: string): Effect.Effect<string, AccessTokenError> =>
    Effect.gen(function* () {
      const row = yield* findInnermostConnectionRow(id);
      if (!row) {
        return yield* new ConnectionNotFoundError({
          connectionId: ConnectionId.make(id),
        });
      }
      return yield* connectionsAccessTokenForRow(row);
    });

  const connectionsAccessTokenAtScope = (
    id: string,
    scope: string,
  ): Effect.Effect<string, AccessTokenError> =>
    Effect.gen(function* () {
      yield* assertScopeInStack("connection accessToken scope", scope);
      const row = yield* findConnectionRowAtScope({
        connectionId: id,
        scopeId: scope,
      });
      if (!row) {
        return yield* new ConnectionNotFoundError({
          connectionId: ConnectionId.make(id),
        });
      }
      return yield* connectionsAccessTokenForRow(row);
    });

  const connectionsListForCtx = () => connectionsList();

  return {
    accessToken: connectionsAccessToken,
    accessTokenAtScope: connectionsAccessTokenAtScope,
    create: connectionsCreate,
    get: connectionsGet,
    getAtScope: connectionsGetAtScope,
    list: connectionsList,
    listForCtx: connectionsListForCtx,
    remove: connectionsRemove,
    setIdentityLabel: connectionsSetIdentityLabel,
    updateTokens: connectionsUpdateTokens,
  };
};
