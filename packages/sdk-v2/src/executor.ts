import type { Effect } from "effect";

import type { Connection, ConnectionRef, CreateConnectionInput } from "./connection";
import type { InvokeOptions, OnElicitation } from "./elicitation";
import type { ExecuteError, StorageError } from "./errors";
import type { IntegrationSlug, OAuthClientSlug, ProviderKey, Subject, Tenant, ToolAddress } from "./ids";
import type { Integration } from "./integration";
import type {
  ConnectResult,
  CreateOAuthClientInput,
  OAuthCompleteInput,
  OAuthStartInput,
} from "./oauth";
import type { AddFn, AnyIntegrationPlugin } from "./plugin";
import type { CredentialProvider, ProviderEntry } from "./provider";
import type { Tool, ToolListFilter } from "./tool";

/**
 * Bind an Executor SDK to a tenant (the partition that owns the catalog) and
 * optionally a subject it acts as. `owner: "user"` writes require the subject.
 * Generic over the registered plugin tuple — the integration kinds this executor
 * can `add`. Bind with `<const TPlugins …>` so each plugin's literal `kind`
 * survives into the `add` projection.
 */
export type ExecutorConfig<
  TPlugins extends readonly AnyIntegrationPlugin[] = readonly AnyIntegrationPlugin[],
> = {
  readonly tenant: Tenant;
  readonly subject?: Subject;
  readonly redirectUri?: string;
  readonly plugins?: TPlugins;
  /** Credential backends. A "default" writable store is assumed for pasted
   *  values; add external ones (1Password, keychain) to reference instead. */
  readonly providers?: readonly CredentialProvider[];
  /** How to answer a tool's mid-invocation elicitation: a handler, or
   *  `"accept-all"` for tests / non-interactive hosts. Per-call overridable via
   *  `execute`'s options. */
  readonly onElicitation?: OnElicitation;
};

export type ExecutorSDK<
  TPlugins extends readonly AnyIntegrationPlugin[] = readonly AnyIntegrationPlugin[],
> = {
  /** The catalog — integration definitions. Carries no credentials. */
  readonly integrations: {
    /**
     * Add an integration to the catalog. Generic over every registered plugin's
     * add function: pass any plugin's kind-tagged input and `add` dispatches on
     * `input.kind`, narrowing the accepted shape and the return to that plugin.
     * A new integration kind is a new plugin in `TPlugins`, not a new method.
     */
    readonly add: AddFn<TPlugins>;
    /** Patch an integration's agnostic identity (description). */
    readonly update: (
      slug: IntegrationSlug,
      integration: Partial<Integration>,
    ) => Effect.Effect<void, StorageError>;
    readonly list: () => Effect.Effect<readonly Integration[], StorageError>;
  };

  /**
   * Connections — the saved credentials, one per integration. `create` (static)
   * or `oauth.start` (interactive) mints one already bound to its integration;
   * tools are resolved and persisted at that point.
   */
  readonly connections: {
    /** Save a static credential (apiKey/bearer) for an integration. */
    readonly create: (input: CreateConnectionInput) => Effect.Effect<Connection, StorageError>;
    /** Every saved credential. */
    readonly list: () => Effect.Effect<readonly Connection[], StorageError>;
    /** Forget a credential (and its persisted tools). Referenced (external)
     *  values are left in their provider. */
    readonly remove: (connection: ConnectionRef) => Effect.Effect<void, StorageError>;
    /** Re-run tool resolution for one connection — "refresh rhys' tools on
     *  vercel" — and re-persist. Scoped to the connection, never global. */
    readonly refresh: (connection: ConnectionRef) => Effect.Effect<readonly Tool[], StorageError>;
  };

  /** OAuth apps + flow. A client mints a connection bound to one integration. */
  readonly oauth: {
    readonly createClient: (
      input: CreateOAuthClientInput,
    ) => Effect.Effect<OAuthClientSlug, StorageError>;
    /** Begin a flow. client_credentials returns `connected`; authorization_code
     *  returns `redirect` and is finished with `complete`. Either way it mints a
     *  connection for the named integration and persists its tools. */
    readonly start: (input: OAuthStartInput) => Effect.Effect<ConnectResult, StorageError>;
    readonly complete: (input: OAuthCompleteInput) => Effect.Effect<Connection, StorageError>;
  };

  /**
   * The persisted tool catalog. Rows are written at `connections.create` /
   * `connections.refresh` / `oauth.complete` — never resolved live — so `list`
   * is a cheap read, the agent-facing surface.
   */
  readonly tools: {
    /** Read persisted tools, optionally narrowed by integration/owner/connection.
     *  Each carries its full callable address. */
    readonly list: (filter?: ToolListFilter) => Effect.Effect<readonly Tool[], StorageError>;
  };

  /** Credential backends — the registered stores a connection's value can
   *  resolve from. Used for discovery: browse a backend's entries to reference. */
  readonly providers: {
    readonly list: () => Effect.Effect<readonly ProviderKey[]>;
    /** Browse a provider's entries (e.g. 1Password items) to pick an id. */
    readonly items: (provider: ProviderKey) => Effect.Effect<readonly ProviderEntry[], StorageError>;
  };

  /**
   * Run a tool at `tools.<integration>.<owner>.<connection>.<tool>` with `args`.
   * Resolves the connection, applies its credential, and invokes the owning
   * plugin's handler — eliciting via `onElicitation` (the per-call override or
   * the executor default) when the tool needs input. Yields the tool's result.
   */
  readonly execute: (
    address: ToolAddress,
    args: unknown,
    options?: InvokeOptions,
  ) => Effect.Effect<unknown, ExecuteError>;
};
