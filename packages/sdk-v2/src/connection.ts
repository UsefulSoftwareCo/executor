import type {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
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

export type Connection = {
  readonly owner: Owner;
  readonly name: ConnectionName;
  /** The one integration this credential is for. */
  readonly integration: IntegrationSlug;
  /** Which of the integration's auth methods this credential is applied through. */
  readonly template: AuthTemplateSlug;
  /** Which backend resolves the value — the default store, or e.g. "1password".
   *  Never the value itself. */
  readonly provider: ProviderKey;
  /** Callable handle. Append `.<tool>` to reach one of its tools. */
  readonly address: ConnectionAddress;
};

/** Identify one connection — unique by (owner, integration, name). */
export type ConnectionRef = {
  readonly owner: Owner;
  readonly name: ConnectionName;
  readonly integration: IntegrationSlug;
};

/** The value origin for a new credential — exactly one. A connection resolves to
 *  a single value. `value` is pasted raw, written to the default provider and
 *  applied to a template lazily — never pre-baked into `Bearer …`. `from`
 *  references an external provider (1Password, keychain) by an opaque id
 *  (typically picked via `providers.items`): we store the routing, resolve on
 *  demand, and never hold the value. */
export type ConnectionValueInput =
  | { readonly value: string }
  | { readonly from: { readonly provider: ProviderKey; readonly id: ProviderItemId } };

/** Save a credential for one integration (born wired). `template` picks which of
 *  the integration's auth methods to apply it through. For OAuth, use
 *  `oauth.start` instead. */
export type CreateConnectionInput = {
  readonly owner: Owner;
  readonly name: ConnectionName;
  readonly integration: IntegrationSlug;
  readonly template: AuthTemplateSlug;
} & ConnectionValueInput;
