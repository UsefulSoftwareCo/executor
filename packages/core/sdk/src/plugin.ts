import type { Context, Effect, Layer } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { HttpApiGroup } from "effect/unstable/httpapi";
import type { DBSchema, StorageFailure } from "@executor-js/storage-core";

import type { PluginBlobStore } from "./blob";
import type {
  ConnectionProvider,
  ConnectionRef,
  ConnectionRefreshError,
  CreateConnectionInput,
  RemoveConnectionInput,
  UpdateConnectionTokensInput,
} from "./connections";
import type { CredentialBindingsFacade } from "./credential-bindings";
import type { DefinitionsInput, SourceInput, ToolAnnotations, ToolRow } from "./core-schema";
import type { RemoveSourceInput, SourceDetectionResult } from "./types";
import type {
  ElicitationDeclinedError,
  ElicitationHandler,
  ElicitationRequest,
  ElicitationResponse,
} from "./elicitation";
import type {
  ConnectionInUseError,
  ConnectionNotFoundError,
  ConnectionProviderNotRegisteredError,
  ConnectionReauthRequiredError,
  ConnectionRefreshNotSupportedError,
  SecretInUseError,
  SecretOwnedByConnectionError,
} from "./errors";
import type { OAuthService } from "./oauth";
import type { Scope } from "./scope";
import type { ScopedDBAdapter, ScopedTypedAdapter } from "./scoped-adapter";
import type { RemoveSecretInput, SecretProvider, SecretRef, SetSecretInput } from "./secrets";
import type { Usage, UsagesForConnectionInput, UsagesForSecretInput } from "./usages";

// ---------------------------------------------------------------------------
// StorageDeps — backing passed to a plugin's `storage` factory. The only
// place a plugin ever sees storage; `PluginCtx` does not carry it. The
// `adapter` field is a `TypedAdapter<TSchema>` view narrowed by the
// plugin's own declared `schema` — plugins never import or construct
// a typed adapter themselves, the executor infers TSchema from the
// `schema` field on their spec and hands back a typed view.
//
// Plugins with no schema (secret-provider-only plugins, etc.) get a
// bare `DBAdapter` they can ignore.
// ---------------------------------------------------------------------------

export interface StorageDeps<TSchema extends DBSchema | undefined = undefined> {
  /**
   * Precedence-ordered scope stack visible to this executor. Innermost
   * first. Reads on scoped tables walk every scope; writes require the
   * plugin to name a target scope explicitly (via `scope_id` on the
   * adapter payload, via `options.scope` on the blob store).
   */
  readonly scopes: readonly Scope[];
  /**
   * Plugin-facing typed adapter. Failures surface as raw `StorageFailure`
   * (`StorageError` | `UniqueViolationError`). Plugins can
   * `catchTag("UniqueViolationError", …)` to translate to their own
   * user-facing errors. `StorageError` bubbles up; the HTTP edge (see
   * `@executor-js/api` `withCapture`) is the one place that
   * translates it to the opaque `InternalError({ traceId })`.
   */
  readonly adapter: TSchema extends DBSchema ? ScopedTypedAdapter<TSchema> : ScopedDBAdapter;
  readonly blobs: PluginBlobStore;
}

// ---------------------------------------------------------------------------
// defineSchema — sugar around `as const satisfies DBSchema`. Preserves
// literal types via the `const` type parameter modifier so plugins can
// just write `const mySchema = defineSchema({ ... })` without annotation
// ceremony.
// ---------------------------------------------------------------------------

export const defineSchema = <const S extends DBSchema>(schema: S): S => schema;

// ---------------------------------------------------------------------------
// Elicit — suspends the fiber, calls the invoke-time elicitation
// handler, resumes with the user's response. Available on both static
// tool handlers and dynamic `invokeTool` handlers. Threaded through
// the executor from `createExecutor({ onElicitation })`.
// ---------------------------------------------------------------------------

export type Elicit = (
  request: ElicitationRequest,
) => Effect.Effect<ElicitationResponse, ElicitationDeclinedError>;

// ---------------------------------------------------------------------------
// PluginCtx — threaded into every extension method, static tool handler,
// and dynamic tool handler. No raw adapter, no raw blobs. Core writes
// go through `core.sources.register` / `core.definitions.register`.
// ---------------------------------------------------------------------------

export interface PluginCtx<TStore = unknown> {
  /**
   * Precedence-ordered scope stack visible to this executor. Innermost
   * first. Plugins that write scoped rows must pick an element of
   * `scopes` as the `scope`/`scope_id` they stamp; reads through the
   * adapter or `ctx.secrets` automatically fall through the stack.
   */
  readonly scopes: readonly Scope[];
  readonly storage: TStore;
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>;

  readonly core: {
    readonly sources: {
      readonly register: (input: SourceInput) => Effect.Effect<void, StorageFailure>;
      readonly unregister: (input: RemoveSourceInput) => Effect.Effect<void, StorageFailure>;
      readonly update: (input: {
        readonly id: string;
        readonly scope: string;
        readonly name?: string;
        readonly url?: string | null;
      }) => Effect.Effect<void, StorageFailure>;
    };
    /** Register shared JSON-schema `$defs` for a source. Tool
     *  input/output schemas registered via `sources.register` can carry
     *  `$ref: "#/$defs/X"` pointers; `executor.tools.schema(toolId)`
     *  attaches matching defs to the returned schema. Call inside the
     *  same `ctx.transaction` as `sources.register` for atomicity.
     *  Replaces any existing defs for the given sourceId. */
    readonly definitions: {
      readonly register: (input: DefinitionsInput) => Effect.Effect<void, StorageFailure>;
    };
  };

  readonly secrets: {
    readonly get: (
      id: string,
    ) => Effect.Effect<string | null, SecretOwnedByConnectionError | StorageFailure>;
    readonly getAtScope: (
      id: string,
      scope: string,
    ) => Effect.Effect<string | null, SecretOwnedByConnectionError | StorageFailure>;
    /** List user-visible secrets. Connection-owned secrets (rows with
     *  `owned_by_connection_id` set) are filtered out so they don't
     *  clutter the UI — users see the Connection instead. */
    readonly list: () => Effect.Effect<
      readonly { readonly id: string; readonly name: string; readonly provider: string }[],
      StorageFailure
    >;
    /** Write a secret value through a provider. Used by plugins that
     *  mint secrets on behalf of the user (OAuth2 token storage,
     *  interactive onboarding flows). Normally writes go through
     *  `executor.secrets.set` on the host surface, but OAuth2 refresh
     *  and one-shot token capture from plugin-owned flows need it here
     *  too. Same routing rules as the host-level setter. */
    readonly set: (input: SetSecretInput) => Effect.Effect<SecretRef, StorageFailure>;
    /** Delete a secret from its pinned provider and the core table.
     *  Rejects with `SecretOwnedByConnectionError` if the row is owned
     *  by a connection — callers must go through `connections.remove`
     *  to drop the whole sign-in. Rejects with `SecretInUseError` if
     *  any plugin reports the secret as in use; the caller should ask
     *  the user to detach the listed sources first. */
    readonly remove: (
      input: RemoveSecretInput,
    ) => Effect.Effect<void, SecretOwnedByConnectionError | SecretInUseError | StorageFailure>;
  };

  /** Connections — product-level sign-in state. Owns backing secret
   *  rows via `secret.owned_by_connection_id`. Plugins call
   *  `connections.accessToken(id)` at invoke time to get a guaranteed-
   *  fresh token (the SDK handles refresh via the registered provider
   *  keyed by `connection.provider`). */
  readonly connections: {
    readonly get: (id: string) => Effect.Effect<ConnectionRef | null, StorageFailure>;
    readonly getAtScope: (
      id: string,
      scope: string,
    ) => Effect.Effect<ConnectionRef | null, StorageFailure>;
    readonly list: () => Effect.Effect<readonly ConnectionRef[], StorageFailure>;
    readonly create: (
      input: CreateConnectionInput,
    ) => Effect.Effect<ConnectionRef, ConnectionProviderNotRegisteredError | StorageFailure>;
    readonly updateTokens: (
      input: UpdateConnectionTokensInput,
    ) => Effect.Effect<ConnectionRef, ConnectionNotFoundError | StorageFailure>;
    readonly setIdentityLabel: (
      id: string,
      label: string | null,
    ) => Effect.Effect<void, ConnectionNotFoundError | StorageFailure>;
    /** Get a guaranteed-fresh access token. Calls the provider's
     *  `refresh` handler if `expires_at` is in the past / within the
     *  refresh skew window. */
    readonly accessToken: (
      id: string,
    ) => Effect.Effect<
      string,
      | ConnectionNotFoundError
      | ConnectionProviderNotRegisteredError
      | ConnectionRefreshNotSupportedError
      | ConnectionReauthRequiredError
      | ConnectionRefreshError
      | StorageFailure
    >;
    readonly accessTokenAtScope: (
      id: string,
      scope: string,
    ) => Effect.Effect<
      string,
      | ConnectionNotFoundError
      | ConnectionProviderNotRegisteredError
      | ConnectionRefreshNotSupportedError
      | ConnectionReauthRequiredError
      | ConnectionRefreshError
      | StorageFailure
    >;
    /** Refuses with `ConnectionInUseError` if any plugin reports the
     *  connection as in use. Caller surfaces the `usages` list to the
     *  user. */
    readonly remove: (
      input: RemoveConnectionInput,
    ) => Effect.Effect<void, ConnectionInUseError | StorageFailure>;
  };

  readonly credentialBindings: CredentialBindingsFacade;

  /** Shared OAuth service. Plugins use this to probe/start/complete OAuth
   *  flows; invocation should still resolve tokens via `connections.accessToken`. */
  readonly oauth: OAuthService;

  /** Run `effect` inside a database transaction. Wraps the underlying
   *  adapter's transaction method. Use this in extension methods that
   *  need atomicity across plugin storage writes AND core source/tool
   *  registration. */
  readonly transaction: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | StorageFailure>;
}

// ---------------------------------------------------------------------------
// Static tool / source declarations. Pure data + handlers declared at
// plugin-definition time.
//
// Importantly, `StaticToolDecl.handler` does NOT reference TExtension.
// If it did, the nested generic would break inference for the whole
// PluginSpec (TS would fall back to the `object` constraint on TExtension).
// `self: NoInfer<TExtension>` lives on `staticSources` one level up
// instead, and plugin authors close over it via the arrow-function
// closure when they write their handler.
// ---------------------------------------------------------------------------

export interface StaticToolHandlerInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  readonly args: unknown;
  /** Suspend the fiber to request user input. The handler passed to
   *  `createExecutor({ onElicitation })` is called. */
  readonly elicit: Elicit;
}

export interface StaticToolDecl<TStore = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  /** Default-policy annotations — `requiresApproval`, `approvalDescription`,
   *  `mayElicit`. Enforced by the executor before the handler runs.
   *  Inline because static tools have no plugin storage to resolve from;
   *  the plugin author literally writes this at definition time. */
  readonly annotations?: ToolAnnotations;
  readonly handler: (input: StaticToolHandlerInput<TStore>) => Effect.Effect<unknown, unknown>;
}

export interface StaticSourceDecl<TStore = unknown> {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly url?: string;
  /** Static sources default to `canRemove: false` — they represent
   *  plugin-provided control surfaces and shouldn't be user-removable.
   *  Override only if you really want that. */
  readonly canRemove?: boolean;
  readonly canRefresh?: boolean;
  readonly canEdit?: boolean;
  readonly tools: readonly StaticToolDecl<TStore>[];
}

// ---------------------------------------------------------------------------
// Dynamic invoke / source lifecycle inputs.
// ---------------------------------------------------------------------------

export interface InvokeToolInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  /** Already-loaded tool row. Plugin doesn't need to re-fetch or parse
   *  the tool id. Carries source_id, name, input/output schemas,
   *  annotations. */
  readonly toolRow: ToolRow;
  readonly args: unknown;
  /** Elicitation handle for plugins that need mid-invocation user input
   *  (onepassword auth prompt, interactive MCP tools, etc.). */
  readonly elicit: Elicit;
}

export interface SourceLifecycleInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  readonly sourceId: string;
  /**
   * Scope of the source row being removed/refreshed — resolved by the
   * SDK's `sources.remove` / `sources.refresh` via innermost-wins lookup
   * across the executor's scope stack. Plugins that own a side table
   * keyed by (id, scope_id) must pin their own cleanup to this scope;
   * relying on the scoped adapter's `scope_id IN (stack)` fall-through
   * would widen the mutation across the whole stack and wipe a
   * shadowed outer-scope row.
   */
  readonly scope: string;
}

// ---------------------------------------------------------------------------
// PluginSpec — what a `definePlugin(factory)` call returns.
// ---------------------------------------------------------------------------

// Defaults are `any` for slots that surface in contravariant positions
// (storage/extension callbacks consume `TStore`/`TSchema`; `staticSources`
// closes over `TExtension` via `NoInfer`). `any` is bivariant, so
// `Plugin<string>` is a structural supertype of every concrete plugin
// — `AnyPlugin = Plugin<string>` keeps the generic explosion contained
// to this single declaration. Concrete specs ignore the defaults; TS
// infers each slot from the literal returned by the author factory.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface PluginSpec<
  TId extends string = string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TExtension extends object = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TStore = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TSchema extends DBSchema | undefined = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TExtensionService extends Context.Service<any, any> | undefined = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  THandlersLayer extends Layer.Layer<any, any, any> = any,
  TGroup extends HttpApiGroup.Any = HttpApiGroup.Any,
> {
  readonly id: TId;
  /** npm package name. The Vite plugin uses this to derive the
   *  `./client` import path for the frontend bundle (so the same
   *  `executor.config.ts` drives both server and client) — `${packageName}/client`
   *  is what gets bundled. The author writes the same string they
   *  publish to npm; no transforms, no scope conventions. Required for
   *  plugins that ship a `./client` entry; can be omitted for SDK-only
   *  plugins (no client bundle = nothing to resolve). */
  readonly packageName?: string;
  /** Plugin-declared schema. Merged with coreSchema and other plugins'
   *  schemas at executor startup via `collectSchemas`. The type flows
   *  into the `storage` factory's `deps.adapter` as a `TypedAdapter<TSchema>`
   *  so plugins get narrowed model names + typed rows for free. */
  readonly schema?: TSchema;
  /** Build the plugin's typed store from backing. `deps.adapter` is
   *  already narrowed to this plugin's schema; `deps.blobs` is already
   *  scoped to the plugin id so key collisions across plugins are
   *  structurally impossible. */
  readonly storage: (deps: StorageDeps<TSchema>) => TStore;

  /** JSON-serializable config the plugin wants its `./client` bundle to
   *  see. The Vite plugin reads this off each `executor.config.ts` spec
   *  at build time and bakes it into the virtual `plugins-client`
   *  module by calling the plugin's default `./client` export as a
   *  factory: `__p(<JSON.stringify(clientConfig)>)`. Plugins that don't
   *  set this stay as bare-value default exports — no churn.
   *
   *  Use this when a server-side option (e.g. `dangerouslyAllowStdioMCP`)
   *  needs to drive client UI behaviour: declaring it once in
   *  `executor.config.ts` flows through to the bundle automatically,
   *  with no runtime fetch and no parallel client-side flag to keep in
   *  sync. */
  readonly clientConfig?: unknown;

  /** Build the plugin's extension API. The returned object becomes
   *  `executor[plugin.id]` and is also the `self` passed to
   *  `staticSources`. Field order matters: `extension` MUST appear
   *  before `staticSources` so TS infers TExtension from this
   *  factory's return BEFORE type-checking `self: NoInfer<TExtension>`. */
  readonly extension?: (ctx: PluginCtx<TStore>) => TExtension;

  /** Static sources contributed by this plugin with inline tool
   *  handlers. Lives entirely in memory — no DB writes at startup.
   *  Handlers close over `self` via the closure, so a control tool
   *  that delegates to the plugin's real API is a one-liner:
   *  `({ args }) => self.addSpec(args)`. */
  readonly staticSources?: (self: NoInfer<TExtension>) => readonly StaticSourceDecl<TStore>[];

  /** HttpApiGroup contributed by this plugin. Composed into the host's
   *  `HttpApi` via the `addGroup` helper at runtime. The host mounts
   *  the group at `/_executor/plugins/{id}/...` (or wherever the
   *  plugin declares its base path) with the host's auth + scope
   *  middleware applied. Endpoints automatically appear in the
   *  executor OpenAPI doc and the typed reactive client.
   *
   *  TGroup is inferred from the plugin's own group declaration so the
   *  precise group identity flows through `composePluginApi(plugins)` —
   *  the host's typed `HttpApi<"executor", CoreGroups | PluginGroups>`
   *  is derived from the plugin tuple alone, with no per-plugin Group
   *  imports at the host. Per-endpoint typing already lives inside the
   *  plugin — its `handlers` Layer is built against its own bundled
   *  `HttpApi.make("foo").add(FooApi)` for full `.handle("name", ...)`
   *  inference, and its client imports the same group directly. */
  readonly routes?: () => TGroup;

  /** Handlers Layer for this plugin's group. Built by the plugin against
   *  its own bundled API for full type safety on `.handle("name", ...)`,
   *  composes into the host's runtime `FullApi` because
   *  `HttpApiBuilder.group` keys the layer by group identity, not by the
   *  surrounding API.
   *
   *  Late-binding: the layer leaves the plugin's extension as a Service
   *  Tag requirement (see `extensionService` below). The host satisfies
   *  it however its runtime wants:
   *    - local: at boot via `Layer.succeed(extensionService)(executor[id])`
   *      (see `composePluginHandlers`)
   *    - cloud: per-request via `Effect.provideService(extensionService,
   *      requestExecutor[id])` in the auth middleware
   *
   *  The Layer's channels are typed `any` because `Layer<RIn, E, ROut>`'s
   *  `ROut` is contravariant — the host accepts any layer here and merges
   *  them; per-plugin requirements flow through the merge. */
  readonly handlers?: () => THandlersLayer;

  /** Service tag the plugin's `handlers` layer requires. Set by plugins
   *  whose handlers consume their extension via a `Context.Service` tag
   *  (the established pattern: `*Handlers` reads `*ExtensionService`).
   *  The host binds the tag to the live extension — at boot for local,
   *  per request for cloud. Pairs with `handlers`; either both fields
   *  are set or neither.
   *
   *  Inferred via the `TExtensionService` generic so the per-plugin
   *  Service class identity propagates through `composePluginHandlers`,
   *  `composePluginHandlerLayer`, and `providePluginExtensions` —
   *  cloud's per-request middleware needs the precise tag for layer
   *  satisfaction. */
  readonly extensionService?: TExtensionService;

  /** Invoke a dynamic tool. Called when the executor's static-handler
   *  map doesn't have the toolId. The plugin reads its own enrichment
   *  via `ctx.storage` and returns the result. Optional — plugins with
   *  only static tools can omit it. */
  readonly invokeTool?: (input: InvokeToolInput<TStore>) => Effect.Effect<unknown, unknown>;

  /** Bulk resolve annotations (requiresApproval, approvalDescription,
   *  mayElicit) for a set of tool rows under a single source. Called
   *  by the executor:
   *    - at invoke time with a single-element `toolRows` array, to
   *      enforce approval on the about-to-run tool
   *    - at list time with every dynamic tool row under each source,
   *      grouped by source_id, to populate `Tool.annotations` for UI
   *
   *  The expected implementation for most plugins is: read plugin
   *  storage once for the given source/rows, derive annotations from
   *  the same data that was used to build the tool (HTTP method +
   *  path for openapi, introspection kind for graphql, etc.), return
   *  a map keyed by tool id.
   *
   *  Omit if the plugin has no annotations to contribute — executor
   *  treats tools from that plugin as auto-approved with no
   *  elicitation. */
  readonly resolveAnnotations?: (input: {
    readonly ctx: PluginCtx<TStore>;
    readonly sourceId: string;
    readonly toolRows: readonly ToolRow[];
  }) => Effect.Effect<Record<string, ToolAnnotations>, unknown>;

  /** Find every place a secret id is referenced by this plugin's stored
   *  rows. Implementations query their normalized columns (e.g.
   *  `WHERE secret_id = $1`) and return one `Usage` per hit, with
   *  `ownerKind` / `slot` tagging the location. The executor fans out
   *  across all plugins and the result powers the Secrets-tab "Used
   *  by" list and the deletion-blocking check in `secrets.remove`.
   *
   *  Plugins that never store secret refs (secret-provider-only
   *  plugins like keychain / file-secrets / 1password) omit this. */
  readonly usagesForSecret?: (input: {
    readonly ctx: PluginCtx<TStore>;
    readonly args: UsagesForSecretInput;
  }) => Effect.Effect<readonly Usage[], unknown>;

  /** Same shape as `usagesForSecret`, but for connection refs. */
  readonly usagesForConnection?: (input: {
    readonly ctx: PluginCtx<TStore>;
    readonly args: UsagesForConnectionInput;
  }) => Effect.Effect<readonly Usage[], unknown>;

  /** Called when `executor.sources.remove({ id, targetScope })` targets
   *  a source owned by this plugin. Plugin-side cleanup only; the
   *  executor deletes the core source/tool rows after this callback
   *  returns, inside the same transaction. */
  readonly removeSource?: (input: SourceLifecycleInput<TStore>) => Effect.Effect<void, unknown>;

  readonly refreshSource?: (input: SourceLifecycleInput<TStore>) => Effect.Effect<void, unknown>;

  /** URL autodetection hook. When the user pastes a URL in the
   *  onboarding UI, `executor.sources.detect(url)` fans out to every
   *  plugin's `detect`. Return a `SourceDetectionResult` if you
   *  recognize the URL, `null` otherwise. Implementations should be
   *  defensive — swallow fetch errors and return null rather than
   *  throwing. First high-confidence match wins. */
  readonly detect?: (input: {
    readonly ctx: PluginCtx<TStore>;
    readonly url: string;
  }) => Effect.Effect<SourceDetectionResult | null, unknown>;

  /** Secret providers contributed by this plugin. Either a static
   *  array, a function of ctx (for providers that need per-instance
   *  state like the keychain's scope-derived service name), or a
   *  function returning an Effect so plugins can probe for backend
   *  availability at startup and register conditionally. Called once
   *  at executor startup after `storage` and `extension` have been
   *  built. */
  readonly secretProviders?:
    | readonly SecretProvider[]
    | ((ctx: PluginCtx<TStore>) => readonly SecretProvider[])
    | ((ctx: PluginCtx<TStore>) => Effect.Effect<readonly SecretProvider[]>);

  /** Connection providers contributed by this plugin. Same registration
   *  shape as `secretProviders`. Each provider's `key` is what
   *  `connection.provider` references in the core table; the `refresh`
   *  handler is the SDK's single entry point for token lifecycle —
   *  plugins don't run their own refresh loops anymore. */
  readonly connectionProviders?:
    | readonly ConnectionProvider[]
    | ((ctx: PluginCtx<TStore>) => readonly ConnectionProvider[])
    | ((ctx: PluginCtx<TStore>) => Effect.Effect<readonly ConnectionProvider[]>);

  readonly close?: () => Effect.Effect<void, unknown>;
}

export interface Plugin<
  TId extends string = string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TExtension extends object = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TStore = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TSchema extends DBSchema | undefined = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TExtensionService extends Context.Service<any, any> | undefined = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  THandlersLayer extends Layer.Layer<any, any, any> = any,
  TGroup extends HttpApiGroup.Any = HttpApiGroup.Any,
> extends PluginSpec<TId, TExtension, TStore, TSchema, TExtensionService, THandlersLayer, TGroup> {}

// ---------------------------------------------------------------------------
// definePlugin — factory-returning-spec. Options from the author factory
// are merged with a storage override so consumers can swap the default
// store implementation without touching plugin internals.
// ---------------------------------------------------------------------------

export type ConfiguredPlugin<
  TId extends string,
  TExtension extends object,
  TStore,
  TOptions extends object,
  TSchema extends DBSchema | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TExtensionService extends Context.Service<any, any> | undefined = undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  THandlersLayer extends Layer.Layer<any, any, any> = Layer.Layer<unknown, never, never>,
  TGroup extends HttpApiGroup.Any = HttpApiGroup.Any,
> = (
  options?: TOptions & {
    readonly storage?: (deps: StorageDeps<TSchema>) => TStore;
  },
) => Plugin<TId, TExtension, TStore, TSchema, TExtensionService, THandlersLayer, TGroup>;

// eslint-disable-next-line @typescript-eslint/ban-types
export function definePlugin<
  TId extends string,
  TExtension extends object,
  TStore,
  TSchema extends DBSchema | undefined = undefined,
  TOptions extends object = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TExtensionService extends Context.Service<any, any> | undefined = undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  THandlersLayer extends Layer.Layer<any, any, any> = Layer.Layer<unknown, never, never>,
  TGroup extends HttpApiGroup.Any = HttpApiGroup.Any,
>(
  authorFactory: (
    options?: TOptions,
  ) => PluginSpec<TId, TExtension, TStore, TSchema, TExtensionService, THandlersLayer, TGroup>,
): ConfiguredPlugin<
  TId,
  TExtension,
  TStore,
  TOptions,
  TSchema,
  TExtensionService,
  THandlersLayer,
  TGroup
> {
  return (options) => {
    const {
      storage: storageOverride,
      ...rest
    }: {
      storage?: (deps: StorageDeps<TSchema>) => TStore;
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

// `Plugin<string>` (with all subsequent slots taking their wide defaults)
// is structurally any concrete plugin — the `any` cascade stays inside
// the spec's defaults instead of leaking into every consumer.
export type AnyPlugin = Plugin<string>;

export type PluginExtensions<TPlugins extends readonly AnyPlugin[]> = {
  readonly [P in TPlugins[number] as P["id"]]: P extends Plugin<string, infer TExt> ? TExt : never;
};

/** Lightweight projection of a secret entry as returned by `ctx.secrets.list`. */
export interface SecretListEntry {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
}

// Re-exported for consumers that check the elicitation handler type.
export type { ElicitationHandler };
