import { Effect, type Schema as EffectSchema } from "effect";
import type { Context, Layer } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { HttpApiGroup } from "effect/unstable/httpapi";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import type { StorageFailure } from "./fuma-runtime";

import type { PluginBlobStore } from "./blob";
import type {
  Connection,
  ConnectionRef,
  CreateConnectionInput,
  UpdateConnectionInput,
} from "./connection";
import type {
  AuthMethodDescriptor,
  Integration,
  IntegrationConfig,
  IntegrationDisplayDescriptor,
  RegisterIntegrationInput,
} from "./integration";
import type { HealthCheckCandidate, HealthCheckResult, HealthCheckSpec } from "./health-check";
import type { ToolInvocationRow } from "./core-schema";
import type {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  Owner,
  ProviderItemId,
  ProviderKey,
  Subject,
  Tenant,
  ToolAddress,
} from "./ids";
import type { IntegrationDetectionResult } from "./types";
import type {
  ElicitationDeclinedError,
  ElicitationHandler,
  ElicitationRequest,
  ElicitationResponse,
  InvokeOptions,
} from "./elicitation";
import type {
  ExecuteError,
  ConnectionNotFoundError,
  CredentialProviderNotRegisteredError,
  IntegrationNotFoundError,
  IntegrationRemovalNotAllowedError,
  InvalidConnectionInputError,
} from "./errors";
import type { OAuthService } from "./oauth-client";
import type { CredentialProvider, ProviderEntry } from "./provider";
import type { PluginStorageConfig, PluginStorageFacade } from "./plugin-storage";
import type {
  CreateToolPolicyInput,
  EffectivePolicy,
  RemoveToolPolicyInput,
  ToolPolicy,
  UpdateToolPolicyInput,
} from "./policies";
import type { Tool, ToolAnnotations, ToolDef } from "./tool";

// ---------------------------------------------------------------------------
// OwnerBinding — replaces v1's scope stack. The (tenant, subject?) the executor
// acts as. `owner:"user"` writes require a subject; pure-org executors leave it
// null. Plugins rarely read this — core handles partitioning — but it's exposed
// for plugins that label or key their own state by owner.
// ---------------------------------------------------------------------------

export interface OwnerBinding {
  readonly tenant: Tenant;
  readonly subject: Subject | null;
}

// ---------------------------------------------------------------------------
// StorageDeps — backing passed to a plugin's `storage` factory. Plugins see
// host-owned storage facades only. The (tenant, owner, subject) partition is
// the host's concern; plugin storage is already owner-scoped under the hood.
// ---------------------------------------------------------------------------

export interface StorageDeps {
  readonly owner: OwnerBinding;
  readonly blobs: PluginBlobStore;
  readonly pluginStorage: PluginStorageFacade;
}

// ---------------------------------------------------------------------------
// Elicit — suspends the fiber, calls the invoke-time elicitation handler,
// resumes with the user's response. Available on static tool handlers and
// dynamic `invokeTool` handlers.
// ---------------------------------------------------------------------------

export type Elicit = (
  request: ElicitationRequest,
) => Effect.Effect<ElicitationResponse, ElicitationDeclinedError>;

// ---------------------------------------------------------------------------
// Active tool-policy provider.
//
// Normal executors resolve policies from core's owner-scoped `tool_policy`
// table. A plugin may opt one executor instance into a different rule source
// (for example, a toolkit-specific policy set). Core still owns enforcement;
// the plugin owns where those policy-shaped rows are stored.
// ---------------------------------------------------------------------------

export interface ToolPolicyProviderRule {
  readonly id: string;
  readonly pattern: string;
  readonly action: ToolPolicy["action"];
  readonly position: string;
}

export interface ToolPolicyProvider {
  readonly list: () => Effect.Effect<readonly ToolPolicyProviderRule[], StorageFailure>;
  readonly resolve?: (input: {
    readonly toolId: string;
    readonly defaultRequiresApproval?: boolean;
  }) => Effect.Effect<EffectivePolicy, StorageFailure>;
  /**
   * Batched per-operation resolver. When defined, core calls `prepare` once at
   * the start of an operation (a single tools/list or tools/call), fetching all
   * the underlying policy + connection state in one pass, and reuses the
   * returned pure resolver for every tool in that operation. This avoids the
   * per-tool `resolve` N+1 (2 uncached storage reads per tool) that scales with
   * the total catalog size on `toolsList`.
   *
   * The resolver is intentionally per-operation scoped, not memoized on the
   * provider: the provider instance is session-scoped (lives across many
   * requests), so caching on it would serve stale policy state. Each operation
   * gets a fresh snapshot.
   */
  readonly prepare?: () => Effect.Effect<
    (input: {
      readonly toolId: string;
      readonly defaultRequiresApproval?: boolean;
    }) => EffectivePolicy,
    StorageFailure
  >;
}

// ---------------------------------------------------------------------------
// IntegrationRecord — the catalog row a plugin reads back (its own opaque
// `config` included). Returned by `ctx.core.integrations.get`.
// ---------------------------------------------------------------------------

export interface IntegrationRecord extends Integration {
  readonly config: IntegrationConfig;
}

// ---------------------------------------------------------------------------
// PluginCtx — threaded into every extension method, static tool handler, and
// dynamic tool handler. The v2 fold folded `core.sources` into
// `core.integrations`, `secrets`/`connections`/`credentialBindings` into
// `connections` (provider-resolved) + `providers`, and `scopes` into `owner`.
// ---------------------------------------------------------------------------

export interface PluginCtx<TStore = unknown> {
  readonly owner: OwnerBinding;
  readonly storage: TStore;
  readonly pluginStorage: PluginStorageFacade;
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>;

  readonly core: {
    readonly integrations: {
      /** Register / replace this plugin's integration in the catalog. */
      readonly register: (input: RegisterIntegrationInput) => Effect.Effect<void, StorageFailure>;
      readonly update: (
        slug: IntegrationSlug,
        patch: {
          readonly name?: string;
          readonly description?: string;
          readonly config?: IntegrationConfig;
        },
      ) => Effect.Effect<void, StorageFailure>;
      readonly list: () => Effect.Effect<readonly Integration[], StorageFailure>;
      readonly get: (
        slug: IntegrationSlug,
      ) => Effect.Effect<IntegrationRecord | null, StorageFailure>;
      readonly remove: (
        slug: IntegrationSlug,
      ) => Effect.Effect<void, IntegrationRemovalNotAllowedError | StorageFailure>;
      /** Declare (or clear, with null) the integration's health check. Core
       *  owns this storage; plugins call it e.g. to install a zero-config
       *  default probe at registration time. */
      readonly setHealthCheck: (
        slug: IntegrationSlug,
        spec: HealthCheckSpec | null,
      ) => Effect.Effect<void, StorageFailure>;
      readonly detect: (
        url: string,
      ) => Effect.Effect<readonly IntegrationDetectionResult[], StorageFailure>;
      readonly configureSchemas: () => readonly IntegrationConfigureSchema[];
      readonly presets: () => readonly IntegrationPresetCatalogEntry[];
    };
    readonly policies: {
      readonly list: () => Effect.Effect<readonly ToolPolicy[], StorageFailure>;
      readonly create: (input: CreateToolPolicyInput) => Effect.Effect<ToolPolicy, StorageFailure>;
      readonly update: (input: UpdateToolPolicyInput) => Effect.Effect<ToolPolicy, StorageFailure>;
      readonly remove: (input: RemoveToolPolicyInput) => Effect.Effect<void, StorageFailure>;
    };
  };

  /** Saved credentials. A connection IS the credential; resolve its value
   *  (refreshing OAuth tokens as needed) via `resolveValue`. */
  readonly connections: {
    readonly create: (
      input: CreateConnectionInput,
    ) => Effect.Effect<
      Connection,
      | IntegrationNotFoundError
      | CredentialProviderNotRegisteredError
      | InvalidConnectionInputError
      | StorageFailure
    >;
    readonly list: (filter?: {
      readonly integration?: IntegrationSlug;
      readonly owner?: Owner;
    }) => Effect.Effect<readonly Connection[], StorageFailure>;
    readonly get: (ref: ConnectionRef) => Effect.Effect<Connection | null, StorageFailure>;
    /** Edit user-curated metadata (description, identityLabel). */
    readonly update: (
      ref: ConnectionRef,
      input: UpdateConnectionInput,
    ) => Effect.Effect<Connection, ConnectionNotFoundError | StorageFailure>;
    readonly remove: (
      ref: ConnectionRef,
    ) => Effect.Effect<void, ConnectionNotFoundError | StorageFailure>;
    readonly refresh: (
      ref: ConnectionRef,
    ) => Effect.Effect<
      readonly Tool[],
      ConnectionNotFoundError | IntegrationNotFoundError | StorageFailure
    >;
    /** Mark a connection's persisted tool catalog stale (clears its sync
     *  stamp) without re-listing inline. The next tools read re-produces it.
     *  For signals that arrive mid-invocation — e.g. an MCP server sending
     *  `notifications/tools/list_changed` or rejecting a call as an unknown
     *  tool — where an inline `refresh` would block the caller. */
    readonly markToolsStale: (ref: ConnectionRef) => Effect.Effect<void, StorageFailure>;
    /** Resolve a connection's value through its provider (and OAuth refresh).
     *  null if the provider can't produce one. */
    readonly resolveValue: (
      ref: ConnectionRef,
      options?: { readonly force?: boolean },
    ) => Effect.Effect<string | null, StorageFailure>;
  };

  /** Registered credential backends — for discovery (browse a backend's items). */
  readonly providers: {
    readonly list: () => Effect.Effect<readonly ProviderKey[]>;
    readonly items: (
      provider: ProviderKey,
    ) => Effect.Effect<readonly ProviderEntry[], StorageFailure>;
    /** Read an opaque item from a provider. Plugins use this for secret values
     *  they own that are not modeled as connections. */
    readonly get: (
      provider: ProviderKey,
      id: ProviderItemId,
    ) => Effect.Effect<string | null, StorageFailure>;
    readonly has: (
      provider: ProviderKey,
      id: ProviderItemId,
    ) => Effect.Effect<boolean, StorageFailure>;
    /** Write through the executor's default writable provider and return the
     *  provider key that owns the item. */
    readonly setDefault: (
      id: ProviderItemId,
      value: string,
    ) => Effect.Effect<ProviderKey, CredentialProviderNotRegisteredError | StorageFailure>;
    readonly remove: (
      provider: ProviderKey,
      id: ProviderItemId,
    ) => Effect.Effect<void, StorageFailure>;
  };

  /** Shared OAuth service. */
  readonly oauth: OAuthService;

  /** Invoke another catalog tool through the same executor request context:
   *  policy, approval, credential resolution, and plugin dispatch all stay in
   *  the core path. Intended for plugin sandboxes that expose higher-level
   *  virtual tools over existing integration tools. */
  readonly execute: (
    address: ToolAddress,
    args: unknown,
    options?: InvokeOptions,
  ) => Effect.Effect<unknown, ExecuteError>;

  /** Run `effect` inside a FumaDB transaction (atomic across plugin storage +
   *  core integration/tool writes). */
  readonly transaction: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | StorageFailure>;
}

// ---------------------------------------------------------------------------
// Per-connection tool production (the v2 successor to v1's `sources.register`
// inside a plugin's addSpec). Called by the executor at connections.create /
// refresh / oauth.complete; the result is stamped with addresses and persisted.
// ---------------------------------------------------------------------------

export interface ResolveToolsInput<TStore = unknown> {
  readonly ctx?: PluginCtx<TStore>;
  /** The catalog record (public projection) whose connection is being resolved. */
  readonly integration: Integration;
  /** The plugin's stored opaque config for that integration. */
  readonly config: IntegrationConfig;
  /** The plugin's typed store — the same instance the extension ctx sees.
   *  Lets spec-derived plugins load build artifacts kept behind the storage
   *  facades (e.g. a content-addressed spec blob) instead of inlining them
   *  in `config`. */
  readonly storage: TStore;
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>;
  /** The connection whose tools are being resolved. */
  readonly connection: ConnectionRef;
  /** Which of the integration's declared auth methods the connection binds
   *  (`connection.template`), so multi-method integrations render the right
   *  one during discovery. `null` when the connection row isn't persisted yet. */
  readonly template: AuthTemplateSlug | null;
  /** Lazily resolve the connection's credential value via its provider — only
   *  the kinds that actually call out (mcp) pay for it. */
  readonly getValue: (options?: {
    readonly force?: boolean;
  }) => Effect.Effect<string | null, StorageFailure>;
  /** Lazily resolve every credential input (`variable → value`) — the
   *  multi-input analog of `getValue`, for methods whose placements reference
   *  more than one variable. Empty map when the connection isn't persisted. */
  readonly getValues: (options?: {
    readonly force?: boolean;
  }) => Effect.Effect<Record<string, string | null>, StorageFailure>;
}

export interface ResolveToolsResult {
  readonly tools: readonly ToolDef[];
  /** Shared JSON-schema `$defs` reachable from the tools' `$ref`s. */
  readonly definitions?: Record<string, unknown>;
  /** The integration could not be (fully) enumerated: unreachable server, auth not
   *  ready, listing aborted. The result is non-authoritative, so the executor
   *  keeps the connection's existing persisted catalog instead of replacing it
   *  (a transient outage must not wipe working tools). Omit / `false` when the
   *  listing is authoritative, including a genuine "this integration has zero
   *  tools". */
  readonly incomplete?: boolean;
  /** Human-readable reason for an incomplete listing. Persisted by core when it
   *  preserves the prior catalog so operators can see why data is stale. */
  readonly incompleteReason?: string;
}

export interface ProjectToolSchemaInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  readonly toolRow: ToolInvocationRow;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

export interface ProjectToolSchemaResult {
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

// ---------------------------------------------------------------------------
// Resolved credential handed to `invokeTool` so the plugin renders auth onto
// the request (D11: "auth state derived into the auth-template format").
// ---------------------------------------------------------------------------

export interface ToolInvocationCredential {
  readonly owner: Owner;
  readonly integration: IntegrationSlug;
  readonly connection: ConnectionName;
  readonly template: AuthTemplateSlug;
  /** The primary (`token`) resolved value — for OAuth (the access token) and
   *  single-input apiKey methods. Equals `values.token`. */
  readonly value: string | null;
  /** Every resolved credential input (`variable → value`) for the connection.
   *  Single-input methods have just `{ token }`; an apiKey method with two
   *  distinct inputs (e.g. Datadog) has one entry per template variable. The
   *  render layer substitutes each `variable("<name>")` from this map. */
  readonly values: Record<string, string | null>;
  /** The integration's stored config, for template rendering. */
  readonly config: IntegrationConfig;
  /** The OAuth scopes the connection's grant actually covers, from the
   *  connection row's `oauth_scope` (space-delimited, as returned by the
   *  token endpoint). Absent for non-OAuth connections and for OAuth
   *  providers that never echo a scope; consumers comparing against an
   *  operation's declared scopes must fail open when this is undefined. */
  readonly grantedScopes?: readonly string[];
}

// ---------------------------------------------------------------------------
// Health-check hook inputs. A health check is a single declared authenticated
// operation a connection runs to prove its credential is still alive and to
// surface whose account it is. CORE owns the declared spec (its own column on
// the integration row, never the plugin's opaque config, so no plugin config
// cycle can strip it); plugins only enumerate candidates and run probes.
// ---------------------------------------------------------------------------

/** Input to `checkHealth`: run the given probe against a resolved credential.
 *  The credential may come from a saved connection OR from in-flight values
 *  (key-first validation, before the connection is saved). Core resolves the
 *  declared spec (or the editor's preview override) and passes it here; the
 *  plugin never reads it from storage. Absent spec ⇒ report `unknown`. */
export interface HealthCheckInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  /** The catalog record (with opaque config) whose health is being checked. */
  readonly integration: IntegrationRecord;
  /** The resolved credential to authenticate the probe. */
  readonly credential: ToolInvocationCredential;
  /** The probe to run, resolved by core. */
  readonly spec?: HealthCheckSpec;
}

/** Input to `listHealthCheckCandidates`: the operations a user can pick. */
export interface HealthCheckCandidatesInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  readonly integration: IntegrationRecord;
}

// ---------------------------------------------------------------------------
// Static tool / integration declarations. Unchanged from v1 except the ctx shape.
// ---------------------------------------------------------------------------

export interface StaticToolHandlerInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  readonly args: unknown;
  readonly elicit: Elicit;
}

export interface StaticToolExecuteContext<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  readonly elicit: Elicit;
}

export type StaticToolSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output> &
  StandardJSONSchemaV1<Input, Output>;

export interface StaticToolDecl<TStore = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: StaticToolSchema;
  readonly outputSchema?: StaticToolSchema;
  readonly annotations?: ToolAnnotations;
  readonly handler: (input: StaticToolHandlerInput<TStore>) => Effect.Effect<unknown, unknown>;
}

const decodeStaticToolArgs = (
  schema: StaticToolSchema | undefined,
  args: unknown,
): Effect.Effect<unknown, unknown> => {
  if (schema == null) return Effect.succeed(args);
  return Effect.promise(() => Promise.resolve(schema["~standard"].validate(args))).pipe(
    Effect.flatMap((result) =>
      "value" in result ? Effect.succeed(result.value) : Effect.fail(result),
    ),
  );
};

export interface StaticToolInput<
  TStore = unknown,
  TInputSchema extends StaticToolSchema | undefined = StaticToolSchema | undefined,
> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: TInputSchema;
  readonly outputSchema?: StaticToolSchema;
  readonly annotations?: ToolAnnotations;
  readonly execute: (
    args: TInputSchema extends StaticToolSchema
      ? StandardSchemaV1.InferOutput<TInputSchema>
      : unknown,
    context: StaticToolExecuteContext<TStore>,
  ) => Effect.Effect<unknown, unknown>;
}

export const tool = <
  TStore = unknown,
  TInputSchema extends StaticToolSchema | undefined = StaticToolSchema | undefined,
>(
  input: StaticToolInput<TStore, TInputSchema>,
): StaticToolDecl<TStore> => ({
  name: input.name,
  description: input.description,
  inputSchema: input.inputSchema,
  outputSchema: input.outputSchema,
  annotations: input.annotations,
  handler: ({ args, ctx, elicit }) =>
    decodeStaticToolArgs(input.inputSchema, args).pipe(
      Effect.flatMap((decoded) =>
        input.execute(
          decoded as TInputSchema extends StaticToolSchema
            ? StandardSchemaV1.InferOutput<TInputSchema>
            : unknown,
          { ctx, elicit },
        ),
      ),
    ),
});

export interface StaticIntegrationDecl<TStore = unknown> {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly url?: string;
  readonly canRemove?: boolean;
  readonly canRefresh?: boolean;
  readonly canEdit?: boolean;
  readonly tools: readonly StaticToolDecl<TStore>[];
}

// ---------------------------------------------------------------------------
// Dynamic invoke / connection lifecycle inputs.
// ---------------------------------------------------------------------------

export interface InvokeToolInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  /** Already-loaded per-connection tool row (carries integration, connection,
   *  owner, name, schemas). */
  readonly toolRow: ToolInvocationRow;
  /** The resolved credential to apply to the outbound request. */
  readonly credential: ToolInvocationCredential;
  readonly args: unknown;
  readonly elicit: Elicit;
  /** Original caller options for nested same-request tool calls. */
  readonly invokeOptions?: InvokeOptions;
}

/** Input for `validateToolArgs` — no credential/elicit: validation runs
 *  before approval enforcement and credential resolution, so it must depend
 *  on nothing but the tool row and the caller's args. */
export interface ValidateToolArgsInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  readonly toolRow: ToolInvocationRow;
  readonly args: unknown;
}

/** Called when the executor removes / refreshes a connection owned by this
 *  plugin's integration — plugin-side cleanup or re-resolution only; the
 *  executor handles the core tool rows. */
export interface ConnectionLifecycleInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  readonly integration: IntegrationSlug;
  readonly connection: ConnectionRef;
}

export interface IntegrationLifecycleInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  readonly integration: IntegrationRecord;
}

export interface ConfigureIntegrationHandlerInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  readonly integration: IntegrationSlug;
  readonly config: unknown;
}

export interface IntegrationConfigureDecl<TStore = unknown> {
  readonly type: string;
  readonly schema?: StaticToolSchema | EffectSchema.Decoder<unknown, never>;
  readonly configure: (
    input: ConfigureIntegrationHandlerInput<TStore>,
  ) => Effect.Effect<unknown, unknown>;
}

export interface IntegrationConfigureSchema {
  readonly pluginId: string;
  readonly type: string;
  readonly schema?: unknown;
}

export interface IntegrationPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly url?: string;
  readonly endpoint?: string;
  readonly icon?: string;
  readonly featured?: boolean;
  readonly family?: string;
  readonly specFormat?: string;
  readonly defaultSlug?: string;
  /** Plugin-specific RFC 6902 operations applied to a fetched specification. */
  readonly specOverrides?: readonly unknown[];
  readonly authTemplate?: readonly IntegrationPresetAuthentication[];
  readonly healthCheck?: HealthCheckSpec;
  readonly transport?: "remote" | "stdio";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export type IntegrationPresetAuthentication =
  | {
      readonly slug: string;
      readonly kind: "oauth2";
      readonly authorizationUrl: string;
      readonly tokenUrl: string;
      readonly resource?: string | null;
      readonly scopes: readonly string[];
      readonly supportsClientIdMetadataDocument?: boolean;
    }
  | {
      readonly kind: "apiKey";
      readonly slug?: string;
      readonly name?: string;
      readonly placements?: readonly unknown[];
      readonly headers?: Readonly<Record<string, readonly unknown[]>>;
      readonly queryParams?: Readonly<Record<string, readonly unknown[]>>;
      readonly cookies?: Readonly<Record<string, readonly unknown[]>>;
    };

export interface IntegrationPresetCatalogEntry extends IntegrationPreset {
  readonly pluginId: string;
}

// ---------------------------------------------------------------------------
// PluginSpec — kept from v1 wholesale; only the data-model hooks change.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface PluginSpec<
  TId extends string = string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TExtension extends object = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TStore = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TExtensionService extends Context.Service<any, any> | undefined = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  THandlersLayer extends Layer.Layer<any, any, any> = any,
  TGroup extends HttpApiGroup.Any = HttpApiGroup.Any,
> {
  readonly id: TId;
  /** npm package name. The Vite plugin uses this to derive the `./client`
   *  import path for the frontend bundle. */
  readonly packageName?: string;
  /** Build the plugin's typed store from host-owned backing. */
  readonly storage: (deps: StorageDeps) => TStore;

  /** Host-owned plugin storage declarations. */
  readonly pluginStorage?: PluginStorageConfig;

  /** JSON-serializable config the plugin wants its `./client` bundle to see. */
  readonly clientConfig?: unknown;

  /** Integration presets shown by the web UI's "Popular integrations" list. */
  readonly integrationPresets?: readonly IntegrationPreset[];

  /** Build the plugin's extension API — becomes `executor[plugin.id]` and the
   *  `self` passed to `staticIntegrations`. Field order matters: `extension` MUST
   *  appear before `staticIntegrations`. */
  readonly extension?: (ctx: PluginCtx<TStore>) => TExtension;

  /** Static integrations contributed by this plugin with inline tool handlers. */
  readonly staticIntegrations?: (
    self: NoInfer<TExtension>,
  ) => readonly StaticIntegrationDecl<TStore>[];

  /** HttpApiGroup contributed by this plugin. */
  readonly routes?: () => TGroup;

  /** Handlers Layer for this plugin's group. */
  readonly handlers?: () => THandlersLayer;

  /** Service tag the plugin's `handlers` layer requires. */
  readonly extensionService?: TExtensionService;

  /** Optional active policy source for this executor instance. At most one
   *  loaded plugin may return a provider. When absent, core uses the normal
   *  owner-scoped tool policies. */
  readonly toolPolicyProvider?: (
    ctx: PluginCtx<TStore>,
  ) => ToolPolicyProvider | null | Effect.Effect<ToolPolicyProvider | null, StorageFailure>;

  /** Produce a connection's tools (and shared $defs). The v2 successor to
   *  registering per-source tools — called by the executor at connection
   *  create / refresh / oauth.complete; the result is stamped with addresses
   *  and persisted per-connection. Omit for plugins with no dynamic tools. */
  readonly resolveTools?: (
    input: ResolveToolsInput<TStore>,
  ) => Effect.Effect<ResolveToolsResult, StorageFailure>;

  /** Declare that `resolveTools` lists a live remote catalog (an MCP server)
   *  that can change without any executor-side config change. Core keeps such
   *  connections fresh: their persisted tools are re-listed on a tools read
   *  once older than the executor's `toolsSyncTtlMs`, in addition to the
   *  config-revision and stale-mark triggers every plugin gets. Leave unset
   *  for catalogs derived purely from stored state (specs, static config). */
  readonly remoteToolCatalog?: boolean;

  /** Project a persisted tool row's stable schemas into the request-visible
   *  schema view. Use this only for volatile presentation data that should be
   *  current at read time, not persisted at catalog-refresh time. */
  readonly projectToolSchema?: (
    input: ProjectToolSchemaInput<TStore>,
  ) => Effect.Effect<ProjectToolSchemaResult, unknown>;

  /** Invoke a dynamic tool. Called when the static-handler map doesn't have the
   *  address. The plugin applies `input.credential` to the outbound request. */
  readonly invokeTool?: (input: InvokeToolInput<TStore>) => Effect.Effect<unknown, unknown>;

  /** Validate a dynamic tool's args before the executor enforces approval,
   *  so a call guaranteed to fail is rejected instead of pausing for an
   *  approval the user can only waste. Fail with the same error `invokeTool`
   *  would raise for those args; succeed (void) when the args would reach the
   *  wire. Must be side-effect free: no credential use, no elicitation, no
   *  outbound request. Omit to skip pre-approval validation. */
  readonly validateToolArgs?: (
    input: ValidateToolArgsInput<TStore>,
  ) => Effect.Effect<void, unknown>;

  /** Bulk resolve annotations for a set of tool rows under one connection. */
  readonly resolveAnnotations?: (input: {
    readonly ctx: PluginCtx<TStore>;
    readonly integration: IntegrationSlug;
    readonly connection: ConnectionName;
    readonly toolRows: readonly ToolInvocationRow[];
  }) => Effect.Effect<Record<string, ToolAnnotations>, unknown>;

  /** Plugin-side cleanup when a connection is removed. */
  readonly removeConnection?: (
    input: ConnectionLifecycleInput<TStore>,
  ) => Effect.Effect<void, unknown>;

  /** Plugin-side cleanup when a removable integration is removed. Core still
   *  owns deleting the integration, connection, tool, and definition rows. */
  readonly removeIntegration?: (
    input: IntegrationLifecycleInput<TStore>,
  ) => Effect.Effect<void, unknown>;

  /** Core-dispatched integration configuration (beyond auth). */
  readonly integrationConfigure?: IntegrationConfigureDecl<TStore>;

  /** Project this plugin's opaque integration config into catalog-visible
   *  declared auth methods. Synchronous and pure (the config is already loaded);
   *  must tolerate a malformed/foreign config blob by returning `[]`. Absent ⇒
   *  core surfaces `[]` (the client falls through to its generic fallback). */
  readonly describeAuthMethods?: (
    integration: IntegrationRecord,
  ) => readonly AuthMethodDescriptor[];

  /** Project this plugin's opaque integration config into safe catalog-visible
   *  display metadata. This is intentionally narrow: the client needs a URL for
   *  favicons without receiving the full plugin config. */
  readonly describeIntegrationDisplay?: (
    integration: IntegrationRecord,
  ) => IntegrationDisplayDescriptor;

  /** List the operations a user can pick as this integration's health check,
   *  ranked best-first (non-destructive, fewest required args). Declaring this
   *  is what marks the plugin health-check-capable; core owns storing the
   *  picked spec (integration row column, never plugin config). */
  readonly listHealthCheckCandidates?: (
    input: HealthCheckCandidatesInput<TStore>,
  ) => Effect.Effect<readonly HealthCheckCandidate[], unknown>;

  /** Run the given health check against a resolved credential and classify the
   *  outcome into a `HealthCheckResult`. Core resolves and passes the spec;
   *  the plugin never reads it from storage. */
  readonly checkHealth?: (
    input: HealthCheckInput<TStore>,
  ) => Effect.Effect<HealthCheckResult, unknown>;

  /** URL autodetection hook for onboarding. */
  readonly detect?: (input: {
    readonly ctx: PluginCtx<TStore>;
    readonly url: string;
  }) => Effect.Effect<IntegrationDetectionResult | null, unknown>;

  /** Credential providers contributed by this plugin (keychain, file, vault, …).
   *  The v2 successor to `secretProviders`. */
  readonly credentialProviders?:
    | readonly CredentialProvider[]
    | ((ctx: PluginCtx<TStore>) => readonly CredentialProvider[])
    | ((ctx: PluginCtx<TStore>) => Effect.Effect<readonly CredentialProvider[]>);

  readonly close?: () => Effect.Effect<void, unknown>;
}

export interface Plugin<
  TId extends string = string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TExtension extends object = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TStore = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TExtensionService extends Context.Service<any, any> | undefined = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  THandlersLayer extends Layer.Layer<any, any, any> = any,
  TGroup extends HttpApiGroup.Any = HttpApiGroup.Any,
> extends PluginSpec<TId, TExtension, TStore, TExtensionService, THandlersLayer, TGroup> {}

// ---------------------------------------------------------------------------
// definePlugin — factory-returning-spec.
// ---------------------------------------------------------------------------

export type ConfiguredPlugin<
  TId extends string,
  TExtension extends object,
  TStore,
  TOptions extends object,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TExtensionService extends Context.Service<any, any> | undefined = undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  THandlersLayer extends Layer.Layer<any, any, any> = Layer.Layer<unknown, never, never>,
  TGroup extends HttpApiGroup.Any = HttpApiGroup.Any,
> = (
  options?: TOptions & {
    readonly storage?: (deps: StorageDeps) => TStore;
  },
) => Plugin<TId, TExtension, TStore, TExtensionService, THandlersLayer, TGroup>;

// eslint-disable-next-line @typescript-eslint/ban-types
export function definePlugin<
  TId extends string,
  TExtension extends object,
  TStore,
  TOptions extends object = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TExtensionService extends Context.Service<any, any> | undefined = undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  THandlersLayer extends Layer.Layer<any, any, any> = Layer.Layer<unknown, never, never>,
  TGroup extends HttpApiGroup.Any = HttpApiGroup.Any,
>(
  authorFactory: (
    options?: TOptions,
  ) => PluginSpec<TId, TExtension, TStore, TExtensionService, THandlersLayer, TGroup>,
): ConfiguredPlugin<TId, TExtension, TStore, TOptions, TExtensionService, THandlersLayer, TGroup> {
  return (options) => {
    const {
      storage: storageOverride,
      ...rest
    }: {
      storage?: (deps: StorageDeps) => TStore;
      [key: string]: unknown;
    } = options ?? {};

    const hasAuthorOptions = Object.keys(rest).length > 0;
    const spec = authorFactory(hasAuthorOptions ? (rest as TOptions) : undefined);

    return {
      ...spec,
      storage: storageOverride ?? spec.storage,
    };
  };
}

// ---------------------------------------------------------------------------
// AnyPlugin / PluginExtensions — type-level glue for the Executor surface.
// ---------------------------------------------------------------------------

export type AnyPlugin = Plugin<string>;

export type PluginExtensions<TPlugins extends readonly AnyPlugin[]> = {
  readonly [P in TPlugins[number] as P["id"]]: P extends Plugin<string, infer TExt> ? TExt : never;
};

// Re-exported for consumers that check the elicitation handler type.
export type { ElicitationHandler };
