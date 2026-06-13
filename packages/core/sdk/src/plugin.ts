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
import type { ToolInvocationRow } from "./core-schema";
import type {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  Owner,
  ProviderKey,
  Subject,
  Tenant,
} from "./ids";
import type { IntegrationDetectionResult } from "./types";
import type {
  ElicitationDeclinedError,
  ElicitationHandler,
  ElicitationRequest,
  ElicitationResponse,
} from "./elicitation";
import type {
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
// IntegrationRecord — the catalog row a plugin reads back (its own opaque
// `config` included). Returned by `ctx.core.integrations.get`.
// ---------------------------------------------------------------------------

export interface IntegrationRecord extends Integration {
  readonly config: IntegrationConfig;
}

// ---------------------------------------------------------------------------
// PluginCtx — threaded into every extension method, static tool handler, and
// dynamic tool handler. The v2 fold: `core.sources` → `core.integrations`,
// `secrets`/`connections`/`credentialBindings` → `connections` (provider-
// resolved) + `providers`, `scopes` → `owner`.
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
    /** Resolve a connection's value through its provider (and OAuth refresh).
     *  null if the provider can't produce one. */
    readonly resolveValue: (ref: ConnectionRef) => Effect.Effect<string | null, StorageFailure>;
  };

  /** Registered credential backends — for discovery (browse a backend's items). */
  readonly providers: {
    readonly list: () => Effect.Effect<readonly ProviderKey[]>;
    readonly items: (
      provider: ProviderKey,
    ) => Effect.Effect<readonly ProviderEntry[], StorageFailure>;
  };

  /** Shared OAuth service. */
  readonly oauth: OAuthService;

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
  /** The catalog record (public projection) whose connection is being resolved. */
  readonly integration: Integration;
  /** The plugin's stored opaque config for that integration. */
  readonly config: IntegrationConfig;
  /** The plugin's typed store — the same instance the extension ctx sees.
   *  Lets spec-derived plugins load build artifacts kept behind the storage
   *  facades (e.g. a content-addressed spec blob) instead of inlining them
   *  in `config`. */
  readonly storage: TStore;
  /** The connection whose tools are being resolved. */
  readonly connection: ConnectionRef;
  /** Which of the integration's declared auth methods the connection binds
   *  (`connection.template`), so multi-method integrations render the right
   *  one during discovery. `null` when the connection row isn't persisted yet. */
  readonly template: AuthTemplateSlug | null;
  /** Lazily resolve the connection's credential value via its provider — only
   *  the kinds that actually call out (mcp) pay for it. */
  readonly getValue: () => Effect.Effect<string | null, StorageFailure>;
  /** Lazily resolve every credential input (`variable → value`) — the
   *  multi-input analog of `getValue`, for methods whose placements reference
   *  more than one variable. Empty map when the connection isn't persisted. */
  readonly getValues: () => Effect.Effect<Record<string, string | null>, StorageFailure>;
}

export interface ResolveToolsResult {
  readonly tools: readonly ToolDef[];
  /** Shared JSON-schema `$defs` reachable from the tools' `$ref`s. */
  readonly definitions?: Record<string, unknown>;
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
}

// ---------------------------------------------------------------------------
// Static tool / source declarations. Unchanged from v1 except the ctx shape.
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

export interface StaticSourceDecl<TStore = unknown> {
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
}

/** Called when the executor removes / refreshes a connection owned by this
 *  plugin's integration — plugin-side cleanup or re-resolution only; the
 *  executor handles the core tool rows. */
export interface ConnectionLifecycleInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  readonly integration: IntegrationSlug;
  readonly connection: ConnectionRef;
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
  readonly transport?: "remote" | "stdio";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

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
   *  `self` passed to `staticSources`. Field order matters: `extension` MUST
   *  appear before `staticSources`. */
  readonly extension?: (ctx: PluginCtx<TStore>) => TExtension;

  /** Static sources contributed by this plugin with inline tool handlers. */
  readonly staticSources?: (self: NoInfer<TExtension>) => readonly StaticSourceDecl<TStore>[];

  /** HttpApiGroup contributed by this plugin. */
  readonly routes?: () => TGroup;

  /** Handlers Layer for this plugin's group. */
  readonly handlers?: () => THandlersLayer;

  /** Service tag the plugin's `handlers` layer requires. */
  readonly extensionService?: TExtensionService;

  /** Produce a connection's tools (and shared $defs). The v2 successor to
   *  registering per-source tools — called by the executor at connection
   *  create / refresh / oauth.complete; the result is stamped with addresses
   *  and persisted per-connection. Omit for plugins with no dynamic tools. */
  readonly resolveTools?: (
    input: ResolveToolsInput<TStore>,
  ) => Effect.Effect<ResolveToolsResult, StorageFailure>;

  /** Invoke a dynamic tool. Called when the static-handler map doesn't have the
   *  address. The plugin applies `input.credential` to the outbound request. */
  readonly invokeTool?: (input: InvokeToolInput<TStore>) => Effect.Effect<unknown, unknown>;

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
