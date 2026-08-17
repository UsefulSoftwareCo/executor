import { Data, type Effect } from "effect";

import type { StorageFailure } from "./fuma-runtime";
import type { ProviderItemId, ProviderKey } from "./ids";

/* Where a credential's value actually lives — the v2 successor to v1's
 * `SecretProvider`. The default store holds pasted values; external backends
 * (1Password, keychain, workos-vault) resolve an opaque `id` on demand — the
 * value never lands in our core storage. Core never knows how the id is shaped;
 * only the provider interprets it. Registered alongside the executor, a separate
 * axis from integration plugins. No `scope` arg — the connection row owns the
 * (tenant, owner, subject) partition; the provider sees only an opaque id. */

export interface ProviderEntry {
  /** The provider's own opaque handle for this entry. Surfaced for discovery so
   *  a connection can reference it without core knowing its internal shape. */
  readonly id: ProviderItemId;
  readonly name: string;
}

export interface CredentialProvider {
  readonly key: ProviderKey;
  /** If false, we never write here — `set`/`delete` are skipped and a referenced
   *  connection's `remove` only drops our routing, leaving the item intact. */
  readonly writable: boolean;
  /** Resolve a value by opaque id. The single hop a credential goes through
   *  before its template is applied. The provider interprets the id. */
  readonly get: (id: ProviderItemId) => Effect.Effect<string | null, StorageFailure>;
  readonly has?: (id: ProviderItemId) => Effect.Effect<boolean, StorageFailure>;
  readonly set?: (id: ProviderItemId, value: string) => Effect.Effect<void, StorageFailure>;
  readonly delete?: (id: ProviderItemId) => Effect.Effect<void, StorageFailure>;
  /** Browse entries for discovery (pick a 1Password item). Optional — some
   *  backends can't enumerate. */
  readonly list?: () => Effect.Effect<readonly ProviderEntry[], StorageFailure>;
  /** Perform the OAuth refresh grant inside the provider, instead of handing the
   *  refresh token out to be exchanged here.
   *
   *  A provider that serves an indirection can protect an access token: it is
   *  spent against a bound host, and the reply is not itself a credential. The
   *  refresh grant breaks that — the exchange needs the real refresh token and
   *  the reply carries a brand-new one — so a store the host genuinely cannot
   *  read has to refuse the refresh item, losing refresh entirely. Implementing
   *  this gives it the other option: own the exchange, seal the new tokens under
   *  the same item ids, and report only what the caller's bookkeeping needs.
   *
   *  OPTIONAL — when absent the caller performs the exchange itself, unchanged.
   *  Implement it only if the exchange genuinely happens somewhere the host
   *  cannot read; returning success without performing the grant is worse than
   *  not implementing it. */
  readonly refreshGrant?: (
    input: RefreshGrantInput,
  ) => Effect.Effect<RefreshGrantResult, StorageFailure | RefreshGrantRejected>;
}

/** What the provider needs to perform the grant on the caller's behalf.
 *
 *  Secrets are named by ITEM ID, never passed as values — passing the refresh
 *  token or the client secret here would reintroduce exactly the exposure this
 *  interface exists to remove.
 *
 *  SECURITY: this ENTIRE input tuple is the CALLER's view. A caller whose
 *  process is part of the threat model can rewrite not only `tokenUrl`, but
 *  also every item id, the client id/auth method, scopes, and resource. A
 *  provider that withholds credentials from that caller MUST authenticate the
 *  complete tuple against independently trusted enrollment metadata and reject
 *  mismatches before resolving or spending any secret. This warning documents
 *  the current contract; it does not solve the structural limitation that the
 *  API still transports caller-authored grant parameters rather than one
 *  provider-owned sealed descriptor. */
export interface RefreshGrantInput {
  /** The stored refresh token to spend. */
  readonly refreshItemId: ProviderItemId;
  /** Where to seal the newly minted access token. The caller reads it back from
   *  here through `get`. */
  readonly accessItemId: ProviderItemId;
  /** The OAuth app's client secret, by id. Absent for a public client. */
  readonly clientSecretItemId?: ProviderItemId;
  /** The token endpoint to post to. A mismatch against the provider's enrolled
   *  endpoint can exfiltrate the sealed refresh token. */
  readonly tokenUrl: string;
  readonly clientId: string;
  /** How to present the client secret: `"body"` is `client_secret_post`,
   *  `"basic"` is `client_secret_basic`. Passed explicitly so a provider never
   *  has to guess — RFC 6749 §2.3.1 prefers Basic, while this caller's default
   *  is post, so a guess would be wrong as often as right. */
  readonly clientAuth: "body" | "basic";
  readonly scopes: readonly string[];
  /** RFC 8707 — keeps the re-minted token bound to the same resource. */
  readonly resource?: string;
}

/** Deliberately carries NO token material.
 *
 *  These two fields are the whole of what the caller needs to update a
 *  connection row after a refresh; anything more would put the host back in the
 *  data path. A rotated refresh token is sealed by the provider under the same
 *  `refreshItemId` and is never reported here. */
export interface RefreshGrantResult {
  /** Lifetime in seconds (RFC 6749 §5.1 `expires_in`), or null when the
   *  authorization server did not say.
   *
   *  RELATIVE, not an absolute instant, precisely because the provider may run
   *  where the caller cannot read — which usually means a different machine and
   *  therefore a different clock. The caller converts against its OWN clock, the
   *  same one that later decides whether the token is due for refresh. Executor
   *  accepts only a finite, non-negative value no greater than
   *  `MAX_REFRESH_GRANT_EXPIRES_IN_SECONDS`. */
  readonly expiresInSeconds: number | null;
  /** The granted scope as reported by the authorization server, or null when it
   *  did not report one (distinct from an empty scope). Executor accepts only a
   *  canonical subset of the connection's already-recorded granted scopes. */
  readonly scope: string | null;
}

/** Largest delegated access-token lifetime Executor accepts: ten 365-day years. */
export const MAX_REFRESH_GRANT_EXPIRES_IN_SECONDS = 10 * 365 * 24 * 60 * 60;

/** The closed standards-defined token-endpoint error set.
 *
 * Keeping this classification closed is a custody boundary: a provider error
 * reaches host telemetry and, for `invalid_grant`, persisted connection health.
 * Free-form values would therefore be another channel for token material. The
 * first six values are RFC 6749 section 5.2; `invalid_target` is RFC 8707
 * section 4 for this API's optional `resource` parameter. */
const REFRESH_GRANT_REJECTION_CODES = [
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_target",
] as const;

export type RefreshGrantRejectionCode = (typeof REFRESH_GRANT_REJECTION_CODES)[number];

export const isRefreshGrantRejectionCode = (value: unknown): value is RefreshGrantRejectionCode =>
  typeof value === "string" && (REFRESH_GRANT_REJECTION_CODES as readonly string[]).includes(value);

/** The authorization server refused the grant.
 *
 *  Distinct from `StorageFailure` because the two demand opposite responses: a
 *  storage failure is transient and worth retrying, whereas a standards-defined
 *  token-endpoint refusal is the AS's standing verdict — `invalid_grant` in particular means
 *  the refresh token is dead and only re-authentication recovers it. Without
 *  this the caller cannot tell "the vault is down" from "this connection is
 *  finished", so it can neither prompt for re-auth nor stop re-sending a grant
 *  that will never succeed.
 *
 *  Only the closed standards-defined classification crosses this boundary. In particular
 *  there is deliberately no provider-controlled message or cause: those fields
 *  can contain response bodies, URLs, or secret-bearing errors and would be
 *  surfaced to callers, persistence, or logs by the host. */
export class RefreshGrantRejected extends Data.TaggedError("RefreshGrantRejected")<{
  /** The validated token-endpoint code (`invalid_grant`, `invalid_client`,
   *  `invalid_target`, …) when the endpoint returned one. Omit it for a failure
   *  that carried no code — the caller then treats the failure as transient. */
  readonly error?: RefreshGrantRejectionCode;
}> {}
