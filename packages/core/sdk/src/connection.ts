import type {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  Owner,
  ProviderItemId,
  ProviderKey,
} from "./ids";

/* A Connection is THE saved credential — secret, account, and connection are one
 * concept — bound to exactly ONE integration (born wired; there is no unwired
 * state and no separate "connect" step). Named, owner-scoped. Its value lives in
 * a provider (the default store for pasted values, or an external one like
 * 1Password) and is applied to the integration's template lazily, per call —
 * never pre-baked. Reusing a credential across a provider's APIs is a property of
 * the integration grain (bundle the provider), not of the connection. */

export interface Connection {
  readonly owner: Owner;
  readonly name: ConnectionName;
  /** The one integration this credential is for. */
  readonly integration: IntegrationSlug;
  /** Which of the integration's auth methods this credential is applied through. */
  readonly template: AuthTemplateSlug;
  /** Which backend resolves the value — the default store, or e.g. "1password".
   *  Never the value itself. */
  readonly provider: ProviderKey;
  /** Callable handle `tools.<integration>.<owner>.<connection>`. Append `.<tool>`
   *  to reach one of its tools. */
  readonly address: ConnectionAddress;
  /** Optional human label (which account). Not load-bearing. */
  readonly identityLabel?: string | null;
  /** User-curated description of what this connection is for. Agent-visible:
   *  surfaces next to the connection's prefix in the execute-tool inventory
   *  and in `connections.list`, so it is the place to give agents context a
   *  spec can't (e.g. "the staging CRM — reads only"). */
  readonly description?: string | null;
  /** Epoch ms when an OAuth access token expires; null/absent for static creds. */
  readonly expiresAt?: number | null;
  /** The OAuth app (`oauth_client` slug) that minted this connection, when it
   *  came from an OAuth flow; null for static credentials. Lets the UI map a
   *  connection back to the app backing it. Never a secret — just the slug. */
  readonly oauthClient?: OAuthClientSlug | null;
  /** The OWNER of `oauthClient` — a Personal connection may be minted through a
   *  shared Workspace app, so the app's owner differs from this connection's.
   *  Stored at mint so refresh/reconnect load the client by an explicit
   *  `(slug, owner)` instead of re-deriving the owner. Null for static creds. */
  readonly oauthClientOwner?: Owner | null;
  /** The scope set the provider actually GRANTED (space-delimited), recorded at
   *  connect/refresh. Load-bearing: compared against the integration's currently
   *  declared scopes to decide whether this connection must reconnect to grant
   *  newly-needed access. Null for static creds / when the AS omitted `scope`. */
  readonly oauthScope?: string | null;
}

/** Identify one connection — unique by (owner, integration, name). */
export interface ConnectionRef {
  readonly owner: Owner;
  readonly name: ConnectionName;
  readonly integration: IntegrationSlug;
}

/** Where a single credential input comes from. `value` is pasted raw and written
 *  to the default provider; `from` references an external provider (1Password,
 *  keychain) by opaque id — we store the routing and resolve on demand, never
 *  holding the value. Applied to a template lazily, never pre-baked into
 *  `Bearer …`. */
export type ConnectionInputOrigin =
  | { readonly value: string }
  | { readonly from: { readonly provider: ProviderKey; readonly id: ProviderItemId } };

/** The value origin(s) for a new credential. A connection resolves a MAP of named
 *  inputs (`variable → value`); a single-secret connection uses the one `token`
 *  variable, an apiKey method with two distinct inputs (e.g. Datadog) carries one
 *  per variable. `value` / `from` are sugar for the single `token` input; `values`
 *  is pasted multi-input; `inputs` is the canonical per-variable origin map (mixes
 *  pasted + external). All inputs of one connection share one provider. */
export type ConnectionValueInput =
  | { readonly value: string }
  | { readonly from: { readonly provider: ProviderKey; readonly id: ProviderItemId } }
  | { readonly values: Record<string, string> }
  | { readonly inputs: Record<string, ConnectionInputOrigin> };

/** Save a credential for one integration (born wired). `template` picks which of
 *  the integration's auth methods to apply it through. For OAuth, use
 *  `oauth.start` instead. */
export type CreateConnectionInput = {
  readonly owner: Owner;
  readonly name: ConnectionName;
  readonly integration: IntegrationSlug;
  readonly template: AuthTemplateSlug;
  readonly identityLabel?: string | null;
  readonly description?: string | null;
} & ConnectionValueInput;

/** Edit a connection's user-curated metadata. Only the provided fields change;
 *  credentials and OAuth lifecycle are untouchable here (recreate or refresh
 *  instead). */
export interface UpdateConnectionInput {
  readonly description?: string | null;
  readonly identityLabel?: string | null;
}
