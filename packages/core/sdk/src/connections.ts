import { Data, Effect, Schema } from "effect";

import { ConnectionId, ScopeId, SecretId } from "./ids";

// ---------------------------------------------------------------------------
// Connections — the product-level "sign-in state" primitive. A Connection
// owns one or more backing `secret` rows (access + refresh tokens) via
// `secret.owned_by_connection_id`; the user sees the Connection, the SDK
// handles every refresh internally. Plugins register a refresh handler
// per provider via `plugin.connectionProviders`, mirroring the shape of
// `plugin.secretProviders` for ordinary secret backends.
// ---------------------------------------------------------------------------

/** Minimal JSON-object carrier for the plugin-owned `providerState`
 *  blob. The SDK never inspects its shape; plugins encode/decode their
 *  own structure. Never sensitive — that's what the secret rows are
 *  for. */
export const ConnectionProviderState = Schema.Record(Schema.String, Schema.Unknown);
export type ConnectionProviderState = typeof ConnectionProviderState.Type;

// ---------------------------------------------------------------------------
// ConnectionRef — metadata projection returned from `ctx.connections.list`
// / `executor.connections.list`. Holds token secret ids (so a plugin can
// reference them from its source config) but not token values.
// ---------------------------------------------------------------------------

export class ConnectionRef extends Schema.Class<ConnectionRef>("ConnectionRef")({
  id: ConnectionId,
  scopeId: ScopeId,
  provider: Schema.String,
  identityLabel: Schema.NullOr(Schema.String),
  accessTokenSecretId: SecretId,
  refreshTokenSecretId: Schema.NullOr(SecretId),
  /** Epoch ms when the access token expires; null if not declared. */
  expiresAt: Schema.NullOr(Schema.Number),
  /** OAuth-style scope string as returned by the token endpoint. Named
   *  `oauthScope` to avoid collision with the executor scope id. */
  oauthScope: Schema.NullOr(Schema.String),
  providerState: Schema.NullOr(ConnectionProviderState),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}

// ---------------------------------------------------------------------------
// CreateConnectionInput — what a plugin passes to create a fresh
// Connection after a successful OAuth exchange. The SDK writes the
// backing secret rows and the connection row in one transaction, and
// stamps `owned_by_connection_id` so `ctx.secrets.list` automatically
// hides them from the bare-secrets UI.
//
// `provider` must match a registered `ConnectionProvider.key`. The SDK
// validates this at create time so a typo surfaces immediately instead
// of the first time a refresh is attempted.
// ---------------------------------------------------------------------------

export class TokenMaterial extends Schema.Class<TokenMaterial>("TokenMaterial")({
  /** Target secret id. Plugins typically derive this from the source id
   *  + a stable suffix (e.g. `${sourceId}.access_token`). */
  secretId: SecretId,
  /** Display name stamped on the secret row. Only visible to code — the
   *  Connections UI hides connection-owned secrets. */
  name: Schema.String,
  value: Schema.String,
}) {}

export class CreateConnectionInput extends Schema.Class<CreateConnectionInput>(
  "CreateConnectionInput",
)({
  id: ConnectionId,
  /** Executor scope id that will own this connection + its backing
   *  secrets. This is the sharing boundary: a user scope is personal,
   *  an org/workspace scope is shared with descendants. */
  scope: ScopeId,
  provider: Schema.String,
  identityLabel: Schema.NullOr(Schema.String),
  accessToken: TokenMaterial,
  refreshToken: Schema.NullOr(TokenMaterial),
  expiresAt: Schema.NullOr(Schema.Number),
  /** OAuth-style scope string. Distinct from the executor scope above. */
  oauthScope: Schema.NullOr(Schema.String),
  providerState: Schema.NullOr(ConnectionProviderState),
}) {}

// ---------------------------------------------------------------------------
// ConnectionRefreshError — typed error surface for refresh handlers.
// Plugins either return a fresh token envelope or fail with this error;
// the SDK rethrows it from `ctx.connections.accessToken` callers.
// ---------------------------------------------------------------------------

export class ConnectionRefreshError extends Data.TaggedError("ConnectionRefreshError")<{
  readonly connectionId: ConnectionId;
  readonly message: string;
  /**
   * Set by providers when the refresh failed in a way that the stored
   * refresh token cannot recover from (RFC 6749 §5.2 `invalid_grant`
   * — the AS has revoked the grant, the user changed their password,
   * the refresh token rotated out from under us, ...). The SDK
   * translates this into a `ConnectionReauthRequiredError` so callers
   * can prompt the user to sign in again instead of silently retrying.
   */
  readonly reauthRequired?: boolean;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// ConnectionRefreshInput — what the SDK hands to a provider's `refresh`
// callback. Includes the current refresh-token value (already resolved
// from the secret row) and the opaque providerState blob so handlers
// don't need to hit secrets themselves.
// ---------------------------------------------------------------------------

export interface ConnectionRefreshInput {
  readonly connectionId: ConnectionId;
  readonly scopeId: ScopeId;
  readonly identityLabel: string | null;
  /** Resolved refresh token value, or null if the connection has none. */
  readonly refreshToken: string | null;
  /** Plugin-owned blob persisted at create / previous refresh. */
  readonly providerState: ConnectionProviderState | null;
  /** OAuth scope string from the last token issuance. */
  readonly oauthScope: string | null;
}

// ---------------------------------------------------------------------------
// ConnectionRefreshResult — what a provider's `refresh` callback returns
// on success. The SDK writes the new token values through the secret
// providers, updates `expires_at` / `scope` / `provider_state` on the
// connection row, and returns the fresh access token to the caller.
//
// `refreshToken` is optional: if the AS rotates refresh tokens it's
// present, if the AS issues long-lived refresh tokens it's absent. The
// SDK updates the refresh secret only when a new value is supplied.
// ---------------------------------------------------------------------------

export interface ConnectionRefreshResult {
  readonly accessToken: string;
  readonly refreshToken?: string | null;
  readonly expiresAt?: number | null;
  readonly oauthScope?: string | null;
  readonly providerState?: ConnectionProviderState | null;
}

// ---------------------------------------------------------------------------
// ConnectionProvider — plugin contribution. Registered via
// `plugin.connectionProviders`. One per refresh strategy (oauth2
// authorization-code, oauth2 client-credentials, per-provider custom,
// etc). Keyed by `key`; the connection row's `provider` column
// references this key.
//
// Omitting `refresh` means "tokens minted by this provider never
// refresh" — accessToken(id) just returns the stored value. Useful for
// long-lived API tokens wrapped as connections for UX consistency.
// ---------------------------------------------------------------------------

export interface ConnectionProvider {
  readonly key: string;
  readonly refresh?: (
    input: ConnectionRefreshInput,
  ) => Effect.Effect<ConnectionRefreshResult, ConnectionRefreshError>;
}

// ---------------------------------------------------------------------------
// UpdateConnectionTokensInput — for flows that re-exchange tokens out
// of band (e.g. an OAuth re-auth where the user signs in again). The
// SDK overwrites the backing secrets and updates the connection row in
// one transaction.
// ---------------------------------------------------------------------------

export class UpdateConnectionTokensInput extends Schema.Class<UpdateConnectionTokensInput>(
  "UpdateConnectionTokensInput",
)({
  id: ConnectionId,
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.NullOr(Schema.String)),
  expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
  oauthScope: Schema.optional(Schema.NullOr(Schema.String)),
  providerState: Schema.optional(Schema.NullOr(ConnectionProviderState)),
  identityLabel: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

export class RemoveConnectionInput extends Schema.Class<RemoveConnectionInput>(
  "RemoveConnectionInput",
)({
  id: ConnectionId,
  /** Scope id whose connection row and owned token secrets should be removed. */
  targetScope: ScopeId,
}) {}
