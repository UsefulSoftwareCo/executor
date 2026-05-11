import {
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
  Semaphore,
} from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import type { OAuthEndpointUrlPolicy } from "./oauth-helpers";
import { generateKeyBetween } from "fractional-indexing";
import {
  StorageError,
  typedAdapter,
  type DBAdapter,
  type DBSchema,
  type DBTransactionAdapter,
  type StorageFailure,
  type TypedAdapter,
} from "@executor-js/storage-core";

import { pluginBlobStore, type BlobStore } from "./blob";
import {
  ConnectionProviderState,
  ConnectionRef,
  ConnectionRefreshError,
  type ConnectionProvider,
  type ConnectionRefreshResult,
  type CreateConnectionInput,
  type RemoveConnectionInput,
  type UpdateConnectionTokensInput,
} from "./connections";
import {
  credentialBindingId,
  credentialBindingRowToRef,
  type CredentialBindingRef,
  type CredentialBindingsFacade,
  type CredentialBindingSlotInput,
  type CredentialBindingSourceInput,
  type RemoveCredentialBindingInput,
  type ReplaceCredentialBindingsInput,
  ResolvedCredentialSlot,
  type SetCredentialBindingInput,
} from "./credential-bindings";
import {
  coreSchema,
  isToolPolicyAction,
  type ConnectionRow,
  type CredentialBindingRow,
  type CoreSchema,
  type DefinitionsInput,
  type SecretRow,
  type SourceInput,
  type SourceRow,
  type ToolAnnotations,
  type ToolPolicyRow,
  type ToolRow,
} from "./core-schema";
import {
  ElicitationDeclinedError,
  ElicitationResponse,
  FormElicitation,
  type ElicitationHandler,
  type ElicitationRequest,
} from "./elicitation";
import {
  ConnectionInUseError,
  ConnectionNotFoundError,
  ConnectionProviderNotRegisteredError,
  ConnectionReauthRequiredError,
  ConnectionRefreshNotSupportedError,
  NoHandlerError,
  PluginNotLoadedError,
  SecretInUseError,
  SecretOwnedByConnectionError,
  SourceRemovalNotAllowedError,
  ToolBlockedError,
  ToolInvocationError,
  ToolNotFoundError,
} from "./errors";
import { ConnectionId, ScopeId, SecretId, ToolId } from "./ids";
import { makeOAuth2Service } from "./oauth-service";
import type { OAuthService } from "./oauth";
import {
  comparePolicyRow,
  isValidPattern,
  resolveToolPolicy,
  rowToToolPolicy,
  type CreateToolPolicyInput,
  type PolicyMatch,
  type RemoveToolPolicyInput,
  type ToolPolicy,
  type UpdateToolPolicyInput,
} from "./policies";
import type {
  AnyPlugin,
  Elicit,
  PluginCtx,
  PluginExtensions,
  StaticSourceDecl,
  StaticToolDecl,
  StorageDeps,
} from "./plugin";
import type { Scope } from "./scope";
import { RemoveSecretInput, SecretRef, SetSecretInput, type SecretProvider } from "./secrets";
import { Usage } from "./usages";
import {
  ToolSchema,
  type RefreshSourceInput,
  type RemoveSourceInput,
  type Source,
  type SourceDetectionResult,
  type Tool,
  type ToolListFilter,
} from "./types";
import { buildToolTypeScriptPreview } from "./schema-types";
import {
  scopedTypedAdapter,
  scopeAdapter,
  scopeTransactionAdapter,
  type ScopeContext,
  type ScopedDBAdapter,
} from "./scoped-adapter";
import { validateHostedOutboundUrl } from "./hosted-http-client";

const MAX_ANNOTATION_GROUPS = 64;
const MAX_APPROVAL_ARGUMENT_PREVIEW_CHARS = 4_000;

// ---------------------------------------------------------------------------
// Elicitation handler — set once at `createExecutor({ onElicitation })`
// and threaded into every tool invocation. A tool that requests user
// input mid-execution suspends the fiber and the handler decides how to
// respond. Tools that never elicit simply don't trigger the handler.
//
// The "accept-all" sentinel is convenient for tests and CLI automation —
// every elicitation request gets auto-accepted with an empty content
// payload. For real interactive hosts, pass a real handler.
//
// Required at the executor level rather than per-invoke, so the
// "what if a caller forgot to pass a handler" branch is structurally
// impossible. Higher layers that need per-invocation handler control
// (an MCP server bridging different per-client handlers, the execution
// engine threading agent-loop callbacks) can pass an override via
// `tools.invoke(id, args, { onElicitation })` — the executor-level
// handler is the fallback, never null.
// ---------------------------------------------------------------------------

export type OnElicitation = ElicitationHandler | "accept-all";

export interface InvokeOptions {
  /** Override the executor-level handler for this single call. */
  readonly onElicitation?: OnElicitation;
}

const acceptAllHandler: ElicitationHandler = () =>
  Effect.succeed(new ElicitationResponse({ action: "accept" }));

const resolveElicitationHandler = (onElicitation: OnElicitation): ElicitationHandler =>
  onElicitation === "accept-all" ? acceptAllHandler : onElicitation;

// ---------------------------------------------------------------------------
// Executor — public surface. Every list/invoke/schema call is a direct
// core-table query (for dynamic rows) unioned with the in-memory static
// pool. No ToolRegistry, no SourceRegistry, no SecretStore services.
// ---------------------------------------------------------------------------

export type Executor<TPlugins extends readonly AnyPlugin[] = []> = {
  /**
   * Precedence-ordered scope stack this executor was configured with.
   * Innermost first. Consumers that need "the display scope" typically
   * pick `scopes.at(-1)` (outermost, e.g. the organization) or
   * `scopes[0]` (innermost, e.g. the current user-in-org) depending on
   * what they're rendering.
   */
  readonly scopes: readonly Scope[];

  readonly tools: {
    readonly list: (filter?: ToolListFilter) => Effect.Effect<readonly Tool[], StorageFailure>;
    /** Fetch a tool's full schema view: JSON schemas with `$defs`
     *  attached from the core `definition` table, plus TypeScript
     *  preview strings rendered from them. Returns `null` for unknown
     *  tool ids. */
    readonly schema: (toolId: string) => Effect.Effect<ToolSchema | null, StorageFailure>;
    /** Every `$defs` entry across every source, grouped by source id.
     *  Used for bulk schema export and downstream TypeScript rendering. */
    readonly definitions: () => Effect.Effect<
      Record<string, Record<string, unknown>>,
      StorageFailure
    >;
    readonly invoke: (
      toolId: string,
      args: unknown,
      options?: InvokeOptions,
    ) => Effect.Effect<
      unknown,
      | ToolNotFoundError
      | ToolBlockedError
      | PluginNotLoadedError
      | NoHandlerError
      | ToolInvocationError
      | ElicitationDeclinedError
      | StorageFailure
    >;
  };

  readonly sources: {
    readonly list: () => Effect.Effect<readonly Source[], StorageFailure>;
    readonly remove: (
      input: RemoveSourceInput,
    ) => Effect.Effect<void, SourceRemovalNotAllowedError | StorageFailure>;
    readonly refresh: (input: RefreshSourceInput) => Effect.Effect<void, StorageFailure>;
    /** URL autodetection — fans out to every plugin's `detect` hook
     *  (if declared), returns every high/medium/low-confidence match.
     *  UI picks a winner from the list. */
    readonly detect: (
      url: string,
    ) => Effect.Effect<readonly SourceDetectionResult[], StorageFailure>;
    /** All `$defs` registered for a single source, keyed by def name. */
    readonly definitions: (
      sourceId: string,
    ) => Effect.Effect<Record<string, unknown>, StorageFailure>;
  };

  readonly secrets: {
    readonly get: (
      id: string,
    ) => Effect.Effect<string | null, SecretOwnedByConnectionError | StorageFailure>;
    readonly getAtScope: (
      id: string,
      scope: string,
    ) => Effect.Effect<string | null, SecretOwnedByConnectionError | StorageFailure>;
    /** Fast-path existence check — hits the core `secret` routing table
     *  only, never calls the provider. Use this for UI state ("secret
     *  missing, prompt to add") to avoid keychain permission prompts
     *  or 1password IPC roundtrips on a pre-flight check. */
    readonly status: (id: string) => Effect.Effect<"resolved" | "missing", StorageFailure>;
    readonly set: (input: SetSecretInput) => Effect.Effect<SecretRef, StorageFailure>;
    /** Delete a bare (non-connection-owned) secret. Connection-owned
     *  secrets are rejected with `SecretOwnedByConnectionError` — use
     *  `connections.remove` instead. Refuses with `SecretInUseError`
     *  if any plugin reports the secret as in use; the caller should
     *  show the `usages(id)` list and ask the user to detach first. */
    readonly remove: (
      input: RemoveSecretInput,
    ) => Effect.Effect<void, SecretOwnedByConnectionError | SecretInUseError | StorageFailure>;
    readonly list: () => Effect.Effect<readonly SecretRef[], StorageFailure>;
    /** Management view of visible secret rows. Unlike `list`, this does
     *  not collapse same-id rows across scopes, so UI that writes exact
     *  credential targets can show both personal and shared rows. */
    readonly listAll: () => Effect.Effect<readonly SecretRef[], StorageFailure>;
    /** All places this secret is referenced — fans out across every
     *  plugin's `usagesForSecret`. Used by the Secrets-tab "Used by"
     *  list and by `remove` for its RESTRICT check. */
    readonly usages: (id: string) => Effect.Effect<readonly Usage[], StorageFailure>;
    readonly providers: () => Effect.Effect<readonly string[]>;
  };

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
     *  connection as in use. */
    readonly remove: (
      input: RemoveConnectionInput,
    ) => Effect.Effect<void, ConnectionInUseError | StorageFailure>;
    /** All places this connection is referenced — fans out across every
     *  plugin's `usagesForConnection`. */
    readonly usages: (id: string) => Effect.Effect<readonly Usage[], StorageFailure>;
    readonly providers: () => Effect.Effect<readonly string[]>;
  };

  /** Shared credential slot bindings. Plugins decide what slot keys mean;
   *  core owns scoped storage, resolution status, and usage visibility. */
  readonly credentialBindings: CredentialBindingsFacade;

  /** Shared OAuth service. Hosts use this through the core HTTP OAuth group;
   *  plugins see the same service as `ctx.oauth`. */
  readonly oauth: OAuthService;

  readonly policies: {
    /** All policies visible across the executor's scope stack, sorted
     *  by (innermost-scope-first, position ascending) — i.e. the order
     *  in which they're evaluated by first-match-wins. */
    readonly list: () => Effect.Effect<readonly ToolPolicy[], StorageFailure>;
    /** Create a new policy. Defaults to the top of the target scope's
     *  list (highest precedence) when `position` is omitted. */
    readonly create: (input: CreateToolPolicyInput) => Effect.Effect<ToolPolicy, StorageFailure>;
    readonly update: (input: UpdateToolPolicyInput) => Effect.Effect<ToolPolicy, StorageFailure>;
    readonly remove: (input: RemoveToolPolicyInput) => Effect.Effect<void, StorageFailure>;
    /** Resolve the effective policy for a tool id by walking the scope-
     *  stacked policy list with first-match-wins semantics. Returns
     *  `undefined` when no rule matches (caller falls back to the
     *  plugin's `resolveAnnotations` output). */
    readonly resolve: (toolId: string) => Effect.Effect<PolicyMatch | undefined, StorageFailure>;
  };

  readonly close: () => Effect.Effect<void, StorageFailure>;
} & PluginExtensions<TPlugins>;

export interface ExecutorConfig<TPlugins extends readonly AnyPlugin[] = []> {
  /**
   * Precedence-ordered scope stack. Innermost first; typical shape is
   * `[userInOrgScope, orgScope]`. Reads on scoped tables walk the
   * stack (first hit wins for shadow-by-id consumers like secrets and
   * blobs); writes require callers to name an explicit target scope.
   * Must be non-empty.
   */
  readonly scopes: readonly Scope[];
  readonly adapter: DBAdapter;
  readonly blobs: BlobStore;
  readonly plugins?: TPlugins;
  /**
   * How to respond when a tool requests user input mid-invocation. Pass
   * `"accept-all"` for tests / non-interactive hosts, or a handler
   * `(ctx) => Effect<ElicitationResponse>` for interactive ones.
   * Required at construction so per-invoke calls don't have to thread
   * an options arg.
   */
  readonly onElicitation: OnElicitation;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly oauthEndpointUrlPolicy?: OAuthEndpointUrlPolicy;
  readonly sourceDetection?: {
    readonly maxUrlLength?: number;
    readonly maxDetectors?: number;
    readonly maxResults?: number;
    readonly timeout?: Duration.Input;
    readonly hostedOutboundPolicy?: boolean;
  };
}

// ---------------------------------------------------------------------------
// collectSchemas — merge coreSchema with every plugin's declared schema.
// Hosts call this and pass the result to the migration runner (or to
// the adapter factory for backends that auto-migrate from a schema
// manifest) before constructing the executor.
// ---------------------------------------------------------------------------

export const collectSchemas = (plugins: readonly AnyPlugin[]): DBSchema => {
  const merged: Record<string, DBSchema[string]> = { ...coreSchema };
  for (const plugin of plugins) {
    if (!plugin.schema) continue;
    for (const [modelKey, model] of Object.entries(plugin.schema)) {
      if (merged[modelKey]) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: collectSchemas is a synchronous configuration API
        throw new StorageError({
          message:
            `Duplicate model "${modelKey}" contributed by plugin "${plugin.id}"` +
            ` (reserved by core or another plugin)`,
          cause: undefined,
        });
      }
      merged[modelKey] = model as DBSchema[string];
    }
  }
  return merged;
};

// ---------------------------------------------------------------------------
// Row → public projection conversions
// ---------------------------------------------------------------------------

const rowToSource = (row: SourceRow): Source => ({
  id: row.id,
  scopeId: row.scope_id,
  kind: row.kind,
  name: row.name,
  url: row.url ?? undefined,
  pluginId: row.plugin_id,
  canRemove: Boolean(row.can_remove),
  canRefresh: Boolean(row.can_refresh),
  canEdit: Boolean(row.can_edit),
  runtime: false,
});

const staticDeclToSource = (decl: StaticSourceDecl, pluginId: string): Source => ({
  id: decl.id,
  scopeId: undefined,
  kind: decl.kind,
  name: decl.name,
  url: decl.url,
  pluginId,
  canRemove: decl.canRemove ?? false,
  canRefresh: decl.canRefresh ?? false,
  canEdit: decl.canEdit ?? false,
  runtime: true,
});

const decodeJsonFromString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

const decodeJsonColumn = (value: unknown): unknown => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return value;
  return decodeJsonFromString(value).pipe(Option.getOrElse(() => value));
};

const decodeProviderState = Schema.decodeUnknownOption(ConnectionProviderState);

const rowToTool = (row: ToolRow, annotations?: ToolAnnotations): Tool => ({
  id: row.id,
  sourceId: row.source_id,
  pluginId: row.plugin_id,
  name: row.name,
  description: row.description,
  inputSchema: decodeJsonColumn(row.input_schema),
  outputSchema: decodeJsonColumn(row.output_schema),
  annotations,
});

const staticDeclToTool = (
  source: StaticSourceDecl,
  tool: StaticToolDecl,
  pluginId: string,
): Tool => ({
  id: `${source.id}.${tool.name}`,
  sourceId: source.id,
  pluginId,
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  outputSchema: tool.outputSchema,
  annotations: tool.annotations,
});

// ---------------------------------------------------------------------------
// Dynamic-row writers — used by ctx.core.sources.register. Static sources
// never touch these functions.
// ---------------------------------------------------------------------------

// Upsert shape: delete any existing source + tools + definitions for
// `input.id` before creating fresh rows. Keeps replayable — boot-time
// sync from executor.jsonc can call register() on rows that already
// exist without tripping a UNIQUE constraint.
const writeSourceInput = (
  core: TypedAdapter<CoreSchema>,
  pluginId: string,
  input: SourceInput,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    yield* deleteSourceById(core, input.id, input.scope);

    const now = new Date();
    yield* core.create({
      model: "source",
      data: {
        id: input.id,
        scope_id: input.scope,
        plugin_id: pluginId,
        kind: input.kind,
        name: input.name,
        url: input.url ?? undefined,
        can_remove: input.canRemove ?? true,
        can_refresh: input.canRefresh ?? false,
        can_edit: input.canEdit ?? false,
        created_at: now,
        updated_at: now,
      },
      forceAllowId: true,
    });

    const toolsById = new Map<string, (typeof input.tools)[number]>();
    for (const tool of input.tools) {
      toolsById.set(`${input.id}.${tool.name}`, tool);
    }
    const tools = [...toolsById.entries()];

    if (tools.length > 0) {
      yield* core.createMany({
        model: "tool",
        data: tools.map(([id, tool]) => ({
          id,
          scope_id: input.scope,
          source_id: input.id,
          plugin_id: pluginId,
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema ?? undefined,
          output_schema: tool.outputSchema ?? undefined,
          created_at: now,
          updated_at: now,
        })),
        forceAllowId: true,
      });
    }
  });

// Delete a source and its tools + definitions at ONE specific scope.
// The scoped adapter already narrows reads/writes to the executor's
// stack via `scope_id IN (...)`, but we pin `scope_id = scopeId` here
// so this helper never widens into a stack-wide wipe — a bystander
// scope's rows with a colliding `source_id` must survive.
const deleteSourceById = (
  core: TypedAdapter<CoreSchema>,
  sourceId: string,
  scopeId: string,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    yield* core.deleteMany({
      model: "tool",
      where: [
        { field: "source_id", value: sourceId },
        { field: "scope_id", value: scopeId },
      ],
    });
    yield* core.deleteMany({
      model: "definition",
      where: [
        { field: "source_id", value: sourceId },
        { field: "scope_id", value: scopeId },
      ],
    });
    yield* core.delete({
      model: "source",
      where: [
        { field: "id", value: sourceId },
        { field: "scope_id", value: scopeId },
      ],
    });
  });

const writeDefinitions = (
  core: TypedAdapter<CoreSchema>,
  pluginId: string,
  input: DefinitionsInput,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    // Pin the delete to `input.scope` — without this, the scoped
    // adapter's `scope_id IN (stack)` injection would nuke definitions
    // at outer scopes whenever an inner-scope writer re-registers
    // definitions for the same source id.
    yield* core.deleteMany({
      model: "definition",
      where: [
        { field: "source_id", value: input.sourceId },
        { field: "scope_id", value: input.scope },
      ],
    });
    const entries = Object.entries(input.definitions);
    if (entries.length === 0) return;
    const now = new Date();
    yield* core.createMany({
      model: "definition",
      data: entries.map(([name, schema]) => ({
        id: `${input.sourceId}.${name}`,
        scope_id: input.scope,
        source_id: input.sourceId,
        plugin_id: pluginId,
        name,
        schema: schema as Record<string, unknown>,
        created_at: now,
      })),
      forceAllowId: true,
    });
  });

// ---------------------------------------------------------------------------
// Filtering — shared between dynamic (DB) and static (in-memory) pools
// so `tools.list({ query, sourceId })` matches across both.
// ---------------------------------------------------------------------------

const toolMatchesFilter = (tool: Tool, filter: ToolListFilter): boolean => {
  if (filter.sourceId && tool.sourceId !== filter.sourceId) return false;
  if (filter.query) {
    const q = filter.query.toLowerCase();
    const hay = `${tool.name} ${tool.description}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Active-adapter FiberRef. Nested plugin writes read this ref so that
// `ctx.transaction` can swap in a tx-bound adapter handle without changing
// the ctx shape — the root adapter returned by `buildAdapterRouter` below
// resolves its target per call, so any Effect running inside
// `Effect.locally(_, activeAdapterRef, trx)` automatically routes every
// query through the same sql.begin connection. This is what makes nested
// writes atomic on postgres + Hyperdrive without deadlocking a pool of 1.
// ---------------------------------------------------------------------------
const activeAdapterRef = Context.Reference<DBTransactionAdapter | null>("executor/ActiveAdapter", {
  defaultValue: () => null,
});
const activeRawAdapterRef = Context.Reference<DBTransactionAdapter | null>(
  "executor/ActiveRawAdapter",
  {
    defaultValue: () => null,
  },
);

const approvalArgumentPreview = (args: unknown): string => {
  const text = JSON.stringify(args ?? {}, null, 2) ?? "null";
  return text.length > MAX_APPROVAL_ARGUMENT_PREVIEW_CHARS
    ? `${text.slice(0, MAX_APPROVAL_ARGUMENT_PREVIEW_CHARS)}...`
    : text;
};

// A `DBAdapter` whose methods dispatch to the active adapter (tx handle or
// root) on every call. Stable identity for consumers (plugin storage,
// `typedAdapter`, etc.) — they see one adapter object, but the routing is
// decided at call time via the FiberRef above.
const buildAdapterRouter = (
  root: ScopedDBAdapter,
  rawRoot: DBAdapter,
  scopeCtx: ScopeContext,
  schema: DBSchema,
): ScopedDBAdapter => {
  const pick = <A, E>(
    use: (active: DBTransactionAdapter) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.flatMap(Effect.service(activeAdapterRef), (active) =>
      use(active ?? (root as DBTransactionAdapter)),
    );

  return {
    id: root.id,
    create: (data) => pick((a) => a.create(data)),
    createMany: (data) => pick((a) => a.createMany(data)),
    findOne: (data) => pick((a) => a.findOne(data)),
    findMany: (data) => pick((a) => a.findMany(data)),
    count: (data) => pick((a) => a.count(data)),
    update: (data) => pick((a) => a.update(data)),
    updateMany: (data) => pick((a) => a.updateMany(data)),
    delete: (data) => pick((a) => a.delete(data)),
    deleteMany: (data) => pick((a) => a.deleteMany(data)),
    // transaction() always opens a real boundary on the ROOT adapter so the
    // tx uses one real connection from the pool. If we're already inside a
    // parent tx (FiberRef set), skip opening a nested sql.begin — that's
    // the postgres.js + Hyperdrive deadlock path — and just run the
    // callback with the existing tx handle. In both cases the callback
    // sees a FiberRef-substituted adapter so further nested writes thread
    // through.
    transaction: (callback) =>
      Effect.flatMap(Effect.service(activeAdapterRef), (active) =>
        Effect.flatMap(Effect.service(activeRawAdapterRef), (activeRaw) => {
          if (active && activeRaw) return callback(active);
          return rawRoot.transaction((rawTrx) => {
            const scopedTrx = scopeTransactionAdapter(rawTrx, scopeCtx, schema);
            return callback(scopedTrx).pipe(
              Effect.provideService(activeAdapterRef, scopedTrx),
              Effect.provideService(activeRawAdapterRef, rawTrx),
            );
          });
        }),
      ),
  } as ScopedDBAdapter;
};

const buildRawAdapterRouter = (root: DBAdapter): DBAdapter => {
  const pick = <A, E>(
    use: (active: DBTransactionAdapter) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.flatMap(Effect.service(activeRawAdapterRef), (active) =>
      use(active ?? (root as DBTransactionAdapter)),
    );

  return {
    ...root,
    create: (data) => pick((a) => a.create(data)),
    createMany: (data) => pick((a) => a.createMany(data)),
    findOne: (data) => pick((a) => a.findOne(data)),
    findMany: (data) => pick((a) => a.findMany(data)),
    count: (data) => pick((a) => a.count(data)),
    update: (data) => pick((a) => a.update(data)),
    updateMany: (data) => pick((a) => a.updateMany(data)),
    delete: (data) => pick((a) => a.delete(data)),
    deleteMany: (data) => pick((a) => a.deleteMany(data)),
    transaction: (callback) =>
      Effect.flatMap(Effect.service(activeRawAdapterRef), (active) => {
        if (active) return callback(active);
        return root.transaction((rawTrx) =>
          Effect.provideService(callback(rawTrx), activeRawAdapterRef, rawTrx),
        );
      }),
  };
};

// ---------------------------------------------------------------------------
// createExecutor
// ---------------------------------------------------------------------------

interface StaticTools {
  readonly source: StaticSourceDecl;
  readonly tool: StaticToolDecl;
  readonly pluginId: string;
  readonly ctx: PluginCtx<unknown>;
}

interface StaticSources {
  readonly source: StaticSourceDecl;
  readonly pluginId: string;
}

interface PluginRuntime {
  readonly plugin: AnyPlugin;
  readonly storage: unknown;
  readonly ctx: PluginCtx<unknown>;
}

export const createExecutor = <const TPlugins extends readonly AnyPlugin[] = []>(
  config: ExecutorConfig<TPlugins>,
): Effect.Effect<Executor<TPlugins>, StorageFailure> =>
  Effect.gen(function* () {
    const defaultPlugins = (): TPlugins => {
      const empty: readonly AnyPlugin[] = [];
      return empty as TPlugins;
    };
    const { scopes, adapter: rootAdapter, blobs, plugins = defaultPlugins() } = config;

    if (scopes.length === 0) {
      return yield* new StorageError({
        message: "createExecutor requires a non-empty scopes array",
        cause: undefined,
      });
    }

    // Scope-wrap the root adapter so every read on a tenant-scoped
    // table filters by `scope_id IN (scopes)` and every write's
    // `scope_id` payload is validated to be in the stack. Reads walk
    // the scope array in order at the consumer layer (secrets,
    // blobs) — the adapter itself just bounds the set of rows
    // visible. Only tables whose schema declares `scope_id` are
    // scoped.
    const schema = collectSchemas(plugins);
    const scopeIds = scopes.map((s) => String(s.id));
    const scopeCtx = { scopes: scopeIds };
    const scopedRoot = scopeAdapter(rootAdapter, scopeCtx, schema);
    const adapter = buildAdapterRouter(scopedRoot, rootAdapter, scopeCtx, schema);
    const rawAdapter = buildRawAdapterRouter(rootAdapter);
    const core = scopedTypedAdapter<CoreSchema>(adapter);
    const rawCore = typedAdapter<CoreSchema>(rawAdapter);

    // Populated once, never mutated after startup.
    const staticTools = new Map<string, StaticTools>();
    const staticSources = new Map<string, StaticSources>();

    // Per-plugin runtime state.
    const runtimes = new Map<string, PluginRuntime>();
    // Secret providers keyed by `provider.key`.
    const secretProviders = new Map<string, SecretProvider>();
    // Connection providers keyed by `provider.key` — drive the refresh
    // lifecycle for connection-owned tokens.
    const connectionProviders = new Map<string, ConnectionProvider>();
    const resolveConnectionProvider = (key: string): ConnectionProvider | undefined =>
      connectionProviders.get(key);
    // In-flight refresh dedup. `connectionsAccessToken` stamps a
    // `Deferred` here before calling the provider's `refresh`; parallel
    // callers that walk in while a refresh is still running observe
    // the same Deferred and await its resolution instead of hitting
    // the AS a second time. The map is mutated under a semaphore so
    // check-or-register is atomic under fiber interleavings.
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
    const extensions: Record<string, object> = {};

    // ------------------------------------------------------------------
    // Secrets facade — fast path is the core `secret` routing table
    // (explicit set()s, keychain entries, etc). Fallback is a walk
    // across providers that implement `list()`, because those are the
    // providers that own their own inventories (1password, file-secrets,
    // workos-vault, env) and enumerate-without-register. Providers
    // without a list() implementation (keychain) never hit the fallback
    // walk because their secrets must be registered through set() to
    // be known at all.
    //
    // Multi-scope behavior: the routing-table lookup pulls every row
    // for this id across the scope stack in a single `IN (...)` query,
    // then sorts innermost-first so a secret registered in a deeper
    // scope shadows one with the same id at a shallower scope (e.g. a
    // user's personal OAuth token wins over an org-wide one). Provider
    // calls stay sequential — scope-partitioning providers (workos-vault,
    // 1password-per-vault) have to be asked per scope because the object
    // name includes the scope — but they're bounded by the number of
    // registered rows for this id, not by scope-stack depth. The
    // provider-enumeration fallback is scope-agnostic: providers like
    // env or 1password don't partition their inventory by executor scope.
    const scopePrecedence = new Map<string, number>();
    scopeIds.forEach((s, i) => scopePrecedence.set(s, i));

    // Rank a row by how close its `scope_id` sits to the innermost scope.
    // Rows whose scope isn't in the stack get pushed to the end (they
    // shouldn't reach us — the adapter filters by `scope_id IN (stack)` —
    // but guarding here means a stray row can't silently win).
    const rowScopeId = (row: { readonly scope_id: unknown }) =>
      typeof row.scope_id === "string" ? row.scope_id : null;
    const scopeRank = (row: { readonly scope_id: unknown }) => {
      const scopeId = rowScopeId(row);
      return scopeId === null ? Infinity : (scopePrecedence.get(scopeId) ?? Infinity);
    };

    // Pick the innermost-scope row on a findOne-by-id against a scoped
    // model. The scope-wrapped adapter returns rows from every scope in
    // the stack, so a bare `findOne({ id })` picks whichever one the
    // storage backend iterates first — non-deterministic across backends,
    // and wrong when a user has shadowed an outer default. Callers that
    // need a single logical row (invoke, tool schema, source removal)
    // must go through this path so the innermost write always wins.
    const findInnermost = <T extends { scope_id: unknown }>(rows: readonly T[]): T | null => {
      if (rows.length === 0) return null;
      let winner: T | undefined;
      let best = Infinity;
      for (const row of rows) {
        const rank = scopeRank(row);
        if (rank < best) {
          best = rank;
          winner = row;
        }
      }
      return winner ?? null;
    };

    const filterUsagesToScopeStack = (usages: readonly Usage[]): readonly Usage[] =>
      usages.filter((usage) => scopeIds.includes(usage.scopeId));

    const secretRowsForId = (id: string): Effect.Effect<readonly SecretRow[], StorageFailure> =>
      core.findMany({
        model: "secret",
        where: [{ field: "id", value: id }],
      }) as Effect.Effect<readonly SecretRow[], StorageFailure>;

    const resolveSecretValueFromRows = (
      id: string,
      rows: readonly SecretRow[],
    ): Effect.Effect<string | null, StorageFailure> =>
      Effect.gen(function* () {
        const ordered = [...rows].sort((a, b) => scopeRank(a) - scopeRank(b));
        for (const row of ordered) {
          const provider = secretProviders.get(row.provider);
          if (!provider) continue;
          const value = yield* provider.get(id, row.scope_id);
          if (value !== null) return value;
        }

        // Fallback: ask enumerating providers in registration order. First
        // non-null wins. Providers that throw
        // are treated as "don't have it" so one flaky provider can't
        // block resolution via others. Scope-partitioning providers
        // get asked at the innermost scope as a display default — the
        // enumeration fallback doesn't know which scope the value
        // lives in; flat providers ignore the arg.
        const fallbackScope = scopeIds[0]!;
        const candidates = [...secretProviders.values()].filter(
          (p) => p.list && p.allowFallback !== false,
        );
        for (const provider of candidates) {
          const value = yield* provider
            .get(id, fallbackScope)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (value !== null) return value;
        }
        return null;
      });

    const secretsGet = (
      id: string,
    ): Effect.Effect<string | null, SecretOwnedByConnectionError | StorageFailure> =>
      Effect.gen(function* () {
        // The scope-wrapped adapter injects `scope_id IN (scopeIds)`
        // automatically, so we only filter by id here. Connection-owned
        // token rows are internal plumbing; public secret resolution
        // must not expose them even if a token secret id is leaked.
        const rows = yield* secretRowsForId(id);
        const owned = rows.find((row) => row.owned_by_connection_id);
        const ownedByConnectionId = owned?.owned_by_connection_id;
        if (ownedByConnectionId) {
          return yield* new SecretOwnedByConnectionError({
            secretId: SecretId.make(id),
            connectionId: ConnectionId.make(ownedByConnectionId),
          });
        }
        return yield* resolveSecretValueFromRows(id, rows);
      });

    const secretsGetResolved = (
      id: string,
    ): Effect.Effect<
      { readonly value: string; readonly scopeId: string | null } | null,
      StorageFailure
    > =>
      Effect.gen(function* () {
        const rows = yield* secretRowsForId(id);
        const ordered = [...rows].sort((a, b) => scopeRank(a) - scopeRank(b));
        for (const row of ordered) {
          if (row.owned_by_connection_id) continue;
          const value = yield* resolveSecretValueAtScope(row, id);
          if (value !== null) return { value, scopeId: row.scope_id };
        }
        const value = yield* resolveSecretValueFromRows(id, []);
        return value === null ? null : { value, scopeId: null };
      });

    const resolveSecretValueAtScope = (
      row: SecretRow | null,
      id: string,
    ): Effect.Effect<string | null, StorageFailure> =>
      Effect.gen(function* () {
        if (!row) return null;
        const provider = secretProviders.get(row.provider);
        if (!provider) return null;
        return yield* provider.get(id, row.scope_id);
      });

    const secretsGetAtScope = (
      id: string,
      scope: string,
    ): Effect.Effect<string | null, SecretOwnedByConnectionError | StorageFailure> =>
      Effect.gen(function* () {
        yield* assertScopeInStack("secret get scope", scope);
        const row = yield* findSecretRowAtScope({
          secretId: id,
          scopeId: scope,
        });
        if (row?.owned_by_connection_id) {
          return yield* new SecretOwnedByConnectionError({
            secretId: SecretId.make(id),
            connectionId: ConnectionId.make(row.owned_by_connection_id),
          });
        }
        return yield* resolveSecretValueAtScope(row, id);
      });

    const connectionSecretGetAtScope = (
      id: string,
      scope: string,
    ): Effect.Effect<string | null, StorageFailure> =>
      Effect.gen(function* () {
        yield* assertScopeInStack("connection secret get scope", scope);
        const row = yield* findSecretRowAtScope({
          secretId: id,
          scopeId: scope,
        });
        return yield* resolveSecretValueAtScope(row, id);
      });

    const secretRouteHasBackingValue = (row: SecretRow) => {
      const provider = secretProviders.get(row.provider);
      if (!provider?.has) return Effect.succeed(true);
      return provider.has(row.id, row.scope_id).pipe(Effect.catch(() => Effect.succeed(false)));
    };

    const secretsSet = (input: SetSecretInput): Effect.Effect<SecretRef, StorageFailure> =>
      Effect.gen(function* () {
        // Validate the write target up front. The adapter would reject
        // an out-of-stack scope too, but catching it here gives a
        // clearer error before we touch the provider.
        if (!scopeIds.includes(input.scope)) {
          return yield* new StorageError({
            message:
              `secrets.set targets scope "${input.scope}" which is not ` +
              `in the executor's scope stack [${scopeIds.join(", ")}].`,
            cause: undefined,
          });
        }

        // Pick provider: explicit or first-writable. Misconfiguration
        // (unknown provider, no writable provider, read-only provider)
        // is a host setup bug — surface as `StorageError` so it lands
        // as a captured InternalError(traceId) at the SDK boundary.
        let target: SecretProvider | undefined;
        if (input.provider) {
          target = secretProviders.get(input.provider);
          if (!target) {
            return yield* new StorageError({
              message: `Unknown secret provider: ${input.provider}`,
              cause: undefined,
            });
          }
        } else {
          for (const provider of secretProviders.values()) {
            if (provider.writable && provider.set) {
              target = provider;
              break;
            }
          }
          if (!target) {
            return yield* new StorageError({
              message: "No writable secret providers registered",
              cause: undefined,
            });
          }
        }
        if (!target.writable || !target.set) {
          return yield* new StorageError({
            message: `Secret provider "${target.key}" is read-only`,
            cause: undefined,
          });
        }

        yield* target.set(input.id, input.value, input.scope);

        // Upsert metadata row in the core `secret` table at the
        // caller-named scope. Pin the delete to `scope_id = input.scope`
        // — without it, the scoped adapter's `scope_id IN (stack)`
        // injection would wipe rows at outer scopes too, so any member
        // writing a personal override could delete admin-written
        // org-wide secrets with the same id.
        const now = new Date();
        yield* core.delete({
          model: "secret",
          where: [
            { field: "id", value: input.id },
            { field: "scope_id", value: input.scope },
          ],
        });
        yield* core.create({
          model: "secret",
          data: {
            id: input.id,
            scope_id: input.scope,
            name: input.name,
            provider: target.key,
            created_at: now,
          },
          forceAllowId: true,
        });

        return new SecretRef({
          id: input.id,
          scopeId: input.scope,
          name: input.name,
          provider: target.key,
          createdAt: now,
        });
      });

    // Fan out across every plugin that contributes `usagesForSecret`. Each
    // plugin queries its own normalized columns through its scoped adapter,
    // so scope filtering is automatic.
    //
    // The display path (`secretsUsages` / `connectionsUsages` from the API)
    // calls `*Lenient`: per-plugin errors become a logWarning so one buggy
    // plugin can't break the UI footer. The delete RESTRICT path
    // (`secretsRemove` / `connectionsRemove`) calls `*Strict`: per-plugin
    // errors fail the whole call so a transient plugin failure can't be
    // mistaken for "no usages" and let through a delete that creates
    // dangling refs.
    const secretsUsagesStrict = (id: string): Effect.Effect<readonly Usage[], StorageFailure> =>
      Effect.gen(function* () {
        const secretId = SecretId.make(id);
        const coreUsages = yield* credentialBindingUsagesForSecret(id);
        const perPlugin = yield* Effect.all(
          [...runtimes.values()]
            .filter((r) => r.plugin.usagesForSecret)
            .map((r) =>
              r.plugin.usagesForSecret!({
                ctx: r.ctx,
                args: { secretId },
              }).pipe(
                Effect.mapError(
                  (cause): StorageFailure =>
                    new StorageError({
                      message: `usagesForSecret failed for plugin ${r.plugin.id}`,
                      cause,
                    }),
                ),
              ),
            ),
          { concurrency: "unbounded" },
        );
        return filterUsagesToScopeStack([...coreUsages, ...perPlugin.flat()]);
      });

    const secretsUsages = (id: string): Effect.Effect<readonly Usage[], StorageFailure> =>
      Effect.gen(function* () {
        const secretId = SecretId.make(id);
        const coreUsages = yield* credentialBindingUsagesForSecret(id);
        const perPlugin = yield* Effect.all(
          [...runtimes.values()]
            .filter((r) => r.plugin.usagesForSecret)
            .map((r) =>
              r.plugin.usagesForSecret!({
                ctx: r.ctx,
                args: { secretId },
              }).pipe(
                Effect.catchCause((cause: unknown) =>
                  Effect.logWarning(`usagesForSecret failed for plugin ${r.plugin.id}`, cause).pipe(
                    Effect.as([] as readonly Usage[]),
                  ),
                ),
              ),
            ),
          { concurrency: "unbounded" },
        );
        return filterUsagesToScopeStack([...coreUsages, ...perPlugin.flat()]);
      });

    const connectionsUsagesStrict = (id: string): Effect.Effect<readonly Usage[], StorageFailure> =>
      Effect.gen(function* () {
        const connectionId = ConnectionId.make(id);
        const coreUsages = yield* credentialBindingUsagesForConnection(id);
        const perPlugin = yield* Effect.all(
          [...runtimes.values()]
            .filter((r) => r.plugin.usagesForConnection)
            .map((r) =>
              r.plugin.usagesForConnection!({
                ctx: r.ctx,
                args: { connectionId },
              }).pipe(
                Effect.mapError(
                  (cause): StorageFailure =>
                    new StorageError({
                      message: `usagesForConnection failed for plugin ${r.plugin.id}`,
                      cause,
                    }),
                ),
              ),
            ),
          { concurrency: "unbounded" },
        );
        return filterUsagesToScopeStack([...coreUsages, ...perPlugin.flat()]);
      });

    const connectionsUsages = (id: string): Effect.Effect<readonly Usage[], StorageFailure> =>
      Effect.gen(function* () {
        const connectionId = ConnectionId.make(id);
        const coreUsages = yield* credentialBindingUsagesForConnection(id);
        const perPlugin = yield* Effect.all(
          [...runtimes.values()]
            .filter((r) => r.plugin.usagesForConnection)
            .map((r) =>
              r.plugin.usagesForConnection!({
                ctx: r.ctx,
                args: { connectionId },
              }).pipe(
                Effect.catchCause((cause: unknown) =>
                  Effect.logWarning(
                    `usagesForConnection failed for plugin ${r.plugin.id}`,
                    cause,
                  ).pipe(Effect.as([] as readonly Usage[])),
                ),
              ),
            ),
          { concurrency: "unbounded" },
        );
        return filterUsagesToScopeStack([...coreUsages, ...perPlugin.flat()]);
      });

    const secretsRemove = (
      input: RemoveSecretInput,
    ): Effect.Effect<void, SecretOwnedByConnectionError | SecretInUseError | StorageFailure> =>
      Effect.gen(function* () {
        const id = input.id;
        const targetScope = input.targetScope;
        if (!scopeIds.includes(targetScope)) {
          return yield* new StorageError({
            message:
              `secret remove targetScope "${targetScope}" is not in the executor's scope stack ` +
              `[${scopeIds.join(", ")}].`,
            cause: undefined,
          });
        }

        // Remove is target-scope aware: drop only the explicitly named
        // scope row. Removing a user-scope override on a secret that also
        // has an org-scope default should reveal the org default, not wipe
        // it. If no core row exists at the target scope, provider cleanup
        // is still scoped to the explicit target for provider-enumerated
        // secrets, but core metadata never falls through to an outer row.
        const rows = yield* core.findMany({
          model: "secret",
          where: [{ field: "id", value: id }],
        });
        const target = rows.find((row) => row.scope_id === targetScope);
        // Refuse to delete connection-owned secrets. The connection owns
        // the lifecycle — callers must go through connections.remove.
        if (target && target.owned_by_connection_id) {
          return yield* new SecretOwnedByConnectionError({
            secretId: SecretId.make(id),
            connectionId: ConnectionId.make(target.owned_by_connection_id),
          });
        }
        // RESTRICT: source/binding rows are pinned to the credential row's
        // scope. A same-id row in an outer scope does not satisfy a binding
        // written at the target scope, so the delete gate filters usages to
        // the exact row being removed.
        if (target) {
          const usages = (yield* secretsUsagesStrict(id)).filter(
            (usage) => usage.scopeId === targetScope,
          );
          if (usages.length > 0) {
            return yield* new SecretInUseError({
              secretId: SecretId.make(id),
              usageCount: usages.length,
            });
          }
        }

        const deleters = [...secretProviders.values()].filter(
          (p): p is typeof p & { delete: NonNullable<typeof p.delete> } =>
            !!(p.writable && p.delete),
        );
        yield* Effect.all(
          deleters.map((p) => p.delete(id, targetScope)),
          { concurrency: "unbounded" },
        );

        if (target) {
          yield* core.delete({
            model: "secret",
            where: [
              { field: "id", value: id },
              { field: "scope_id", value: targetScope },
            ],
          });
        }
      });

    // List is a union of two sources of truth:
    //
    //   1. Core `secret` rows — secrets explicitly registered via
    //      executor.secrets.set(...). These carry their pinned provider
    //      and are authoritative for routing (get() uses them).
    //   2. Each provider's own `list()` — for read-only or
    //      already-populated providers (1password, file-secrets,
    //      workos-vault, env), the provider enumerates what's actually
    //      in its backend. These show up in the list even if the user
    //      never called set() through the executor.
    //
    // Dedupe by secret id; core rows win over provider-enumerated ones
    // so that routing information in the core table is authoritative.
    // Providers without a list() method (e.g. keychain) contribute
    // only via the core table path.
    //
    // Multi-scope: core rows from any scope in the stack show up
    // (adapter filters by `scope_id IN`), each tagged with its own
    // `scope_id`. When the same id appears in multiple scopes, the
    // innermost wins — same rule as `secretsGet`. Provider-enumerated
    // entries don't know what scope they belong to and are attributed
    // to the innermost scope as a display default.
    const secretsList = (): Effect.Effect<readonly SecretRef[], StorageFailure> =>
      Effect.gen(function* () {
        const byId = new Map<string, SecretRef>();

        // Core routing rows first. Adapter returns rows from every
        // scope in the stack; resolve collisions using the caller's
        // precedence order (innermost first). Rows owned by a
        // connection are filtered out — the user sees the Connection
        // entry, not its backing token secrets. Their ids go in a
        // deny-set so provider `list()` results for the same id can't
        // leak them back in below.
        const allRows = yield* core.findMany({ model: "secret" });
        const rows = allRows.filter((r) => !r.owned_by_connection_id);
        const pick = (row: (typeof rows)[number]) => {
          const existing = byId.get(row.id);
          const incomingScope = row.scope_id;
          const incomingRank = scopeRank(row);
          if (existing) {
            const existingRank = scopePrecedence.get(existing.scopeId) ?? Infinity;
            if (existingRank <= incomingRank) return;
          }
          byId.set(
            row.id,
            new SecretRef({
              id: SecretId.make(row.id),
              scopeId: ScopeId.make(incomingScope),
              name: row.name,
              provider: row.provider,
              createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
            }),
          );
        };
        for (const row of rows) {
          const hasBackingValue = yield* secretRouteHasBackingValue(row);
          if (hasBackingValue) pick(row);
        }

        // Don't let provider-enumerated entries resurrect ids that
        // belong to a connection-owned core row.
        const connectionOwnedIds = new Set(
          allRows.filter((r) => r.owned_by_connection_id).map((r) => r.id),
        );
        // Attribute provider-listed entries to the innermost scope as
        // a display default — providers like 1password and env don't
        // partition their inventory by executor scope.
        const innermostScopeId = scopeIds[0];
        if (innermostScopeId !== undefined) {
          for (const [key, provider] of secretProviders) {
            if (!provider.list) continue;
            const entries = yield* provider
              .list()
              .pipe(Effect.catch(() => Effect.succeed([] as const)));
            for (const entry of entries) {
              if (byId.has(entry.id)) continue;
              if (connectionOwnedIds.has(entry.id)) continue;
              byId.set(
                entry.id,
                new SecretRef({
                  id: SecretId.make(entry.id),
                  scopeId: ScopeId.make(innermostScopeId),
                  name: entry.name,
                  provider: key,
                  createdAt: new Date(0),
                }),
              );
            }
          }
        }

        return Array.from(byId.values());
      });

    const secretsListAll = (): Effect.Effect<readonly SecretRef[], StorageFailure> =>
      Effect.gen(function* () {
        const allRows = yield* core.findMany({ model: "secret" });
        const coreIds = new Set<string>();
        const refs: SecretRef[] = [];

        for (const row of allRows) {
          coreIds.add(row.id);
          if (row.owned_by_connection_id) continue;
          const hasBackingValue = yield* secretRouteHasBackingValue(row);
          if (!hasBackingValue) continue;
          refs.push(
            new SecretRef({
              id: SecretId.make(row.id),
              scopeId: ScopeId.make(row.scope_id),
              name: row.name,
              provider: row.provider,
              createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
            }),
          );
        }

        return refs.sort((a, b) => {
          const rank =
            (scopePrecedence.get(a.scopeId) ?? Infinity) -
            (scopePrecedence.get(b.scopeId) ?? Infinity);
          if (rank !== 0) return rank;
          const name = a.name.localeCompare(b.name);
          return name === 0 ? String(a.id).localeCompare(String(b.id)) : name;
        });
      });

    // Same union shape as secretsList but projected to the leaner
    // SecretListEntry shape that plugins get via ctx.secrets.list().
    const secretsListForCtx = () =>
      Effect.gen(function* () {
        const list = yield* secretsList();
        return list.map((ref) => ({
          id: String(ref.id),
          name: ref.name,
          provider: ref.provider,
        }));
      });

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
      new ConnectionRef({
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
        const rows = yield* core.findMany({
          model: "connection",
          where: [{ field: "id", value: id }],
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
        const rows = yield* core.findMany({ model: "connection" });
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
        yield* core.delete({
          model: "secret",
          where: [
            { field: "id", value: params.id },
            { field: "scope_id", value: params.scope },
          ],
        });
        yield* core.create({
          model: "secret",
          data: {
            id: params.id,
            scope_id: params.scope,
            name: params.name,
            provider: target.key,
            owned_by_connection_id: params.ownedByConnectionId,
            created_at: now,
          },
          forceAllowId: true,
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

        return yield* adapter.transaction(() =>
          Effect.gen(function* () {
            // Drop any existing connection row at this scope first so a
            // re-auth replaces cleanly. Owned-secret rows for the old
            // connection are removed by the cascade below (we delete
            // both old + new token secret ids explicitly).
            yield* core.delete({
              model: "connection",
              where: [
                { field: "id", value: input.id },
                { field: "scope_id", value: input.scope },
              ],
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

            yield* core.create({
              model: "connection",
              data: {
                id: input.id,
                scope_id: input.scope,
                provider: input.provider,
                identity_label: input.identityLabel ?? undefined,
                access_token_secret_id: input.accessToken.secretId,
                refresh_token_secret_id: input.refreshToken?.secretId ?? undefined,
                expires_at: input.expiresAt ?? undefined,
                scope: input.oauthScope ?? undefined,
                provider_state: input.providerState ?? undefined,
                created_at: now,
                updated_at: now,
              },
              forceAllowId: true,
            });

            return new ConnectionRef({
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

        return yield* adapter.transaction(() =>
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
            if (input.expiresAt !== undefined) patch.expires_at = input.expiresAt ?? undefined;
            if (input.oauthScope !== undefined) patch.scope = input.oauthScope ?? undefined;
            if (input.providerState !== undefined)
              patch.provider_state = input.providerState ?? undefined;
            if (input.identityLabel !== undefined)
              patch.identity_label = input.identityLabel ?? undefined;
            yield* core.update({
              model: "connection",
              where: [
                { field: "id", value: row.id },
                { field: "scope_id", value: row.scope_id },
              ],
              update: patch,
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
        yield* core.update({
          model: "connection",
          where: [
            { field: "id", value: id },
            { field: "scope_id", value: row.scope_id },
          ],
          update: {
            identity_label: label ?? undefined,
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
        const allRows = yield* core.findMany({
          model: "connection",
          where: [{ field: "id", value: id }],
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
        yield* adapter.transaction(() =>
          Effect.gen(function* () {
            // Find every owned secret at this scope and drop through
            // its provider + the core row. We look up by
            // `owned_by_connection_id` rather than just the two ids on
            // the connection row so any accidentally-orphaned siblings
            // get cleaned up too.
            const owned = yield* core.findMany({
              model: "secret",
              where: [
                { field: "owned_by_connection_id", value: id },
                { field: "scope_id", value: scope },
              ],
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
            yield* core.deleteMany({
              model: "secret",
              where: [
                { field: "owned_by_connection_id", value: id },
                { field: "scope_id", value: scope },
              ],
            });
            yield* core.delete({
              model: "connection",
              where: [
                { field: "id", value: id },
                { field: "scope_id", value: scope },
              ],
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

    const scopeListLabel = () => `[${scopeIds.join(", ")}]`;

    const assertScopeInStack = (
      label: string,
      scopeId: string,
    ): Effect.Effect<void, StorageError> =>
      scopeIds.includes(scopeId)
        ? Effect.void
        : Effect.fail(
            new StorageError({
              message: `${label} "${scopeId}" is not in the executor's scope stack ${scopeListLabel()}.`,
              cause: undefined,
            }),
          );

    const findSourceRowAtScope = (input: {
      readonly pluginId: string;
      readonly sourceId: string;
      readonly sourceScope: string;
    }): Effect.Effect<SourceRow | null, StorageFailure> =>
      Effect.gen(function* () {
        if (!scopeIds.includes(input.sourceScope)) return null;
        return yield* core.findOne({
          model: "source",
          where: [
            { field: "plugin_id", value: input.pluginId },
            { field: "id", value: input.sourceId },
            { field: "scope_id", value: input.sourceScope },
          ],
        });
      });

    const findSecretRowAtScope = (input: {
      readonly secretId: string;
      readonly scopeId: string;
    }): Effect.Effect<SecretRow | null, StorageFailure> =>
      Effect.gen(function* () {
        if (!scopeIds.includes(input.scopeId)) return null;
        return yield* core.findOne({
          model: "secret",
          where: [
            { field: "id", value: input.secretId },
            { field: "scope_id", value: input.scopeId },
          ],
        });
      });

    const findConnectionRowAtScope = (input: {
      readonly connectionId: string;
      readonly scopeId: string;
    }): Effect.Effect<ConnectionRow | null, StorageFailure> =>
      Effect.gen(function* () {
        if (!scopeIds.includes(input.scopeId)) return null;
        return yield* core.findOne({
          model: "connection",
          where: [
            { field: "id", value: input.connectionId },
            { field: "scope_id", value: input.scopeId },
          ],
        });
      });

    const credentialBindingRowsForSource = (
      input: CredentialBindingSourceInput,
    ): Effect.Effect<readonly CredentialBindingRow[], StorageFailure> =>
      scopeIds.includes(input.sourceScope)
        ? (core
            .findMany({
              model: "credential_binding",
              where: [
                { field: "plugin_id", value: input.pluginId },
                { field: "source_id", value: input.sourceId },
                { field: "source_scope_id", value: input.sourceScope },
              ],
            })
            .pipe(
              Effect.map((rows) => {
                const sourceSourceRank = scopePrecedence.get(input.sourceScope) ?? Infinity;
                return (rows as readonly CredentialBindingRow[]).filter(
                  (row) => scopeRank(row) <= sourceSourceRank,
                );
              }),
            ) as Effect.Effect<readonly CredentialBindingRow[], StorageFailure>)
        : Effect.succeed([]);

    const credentialBindingRowsForSlot = (
      input: CredentialBindingSlotInput,
    ): Effect.Effect<readonly CredentialBindingRow[], StorageFailure> =>
      scopeIds.includes(input.sourceScope)
        ? (core
            .findMany({
              model: "credential_binding",
              where: [
                { field: "plugin_id", value: input.pluginId },
                { field: "source_id", value: input.sourceId },
                { field: "source_scope_id", value: input.sourceScope },
                { field: "slot_key", value: input.slotKey },
              ],
            })
            .pipe(
              Effect.map((rows) => {
                const sourceSourceRank = scopePrecedence.get(input.sourceScope) ?? Infinity;
                return (rows as readonly CredentialBindingRow[]).filter(
                  (row) => scopeRank(row) <= sourceSourceRank,
                );
              }),
            ) as Effect.Effect<readonly CredentialBindingRow[], StorageFailure>)
        : Effect.succeed([]);

    const assertCredentialBindingTargetNotOuter = (input: {
      readonly label: string;
      readonly targetScope: string;
      readonly sourceScope: string;
      readonly sourceId: string;
    }): Effect.Effect<void, StorageFailure> =>
      Effect.gen(function* () {
        const sourceSourceRank = scopePrecedence.get(input.sourceScope) ?? Infinity;
        const targetRank = scopePrecedence.get(input.targetScope) ?? Infinity;
        if (targetRank > sourceSourceRank) {
          return yield* new StorageError({
            message:
              `${input.label} for source "${input.sourceId}" cannot target outer scope ` +
              `"${input.targetScope}" because the source lives at scope "${input.sourceScope}".`,
            cause: undefined,
          });
        }
      });

    const credentialBindingListForSource = (input: CredentialBindingSourceInput) =>
      Effect.gen(function* () {
        const rows = yield* credentialBindingRowsForSource(input);
        return rows
          .slice()
          .sort((a, b) => {
            const slot = a.slot_key.localeCompare(b.slot_key);
            return slot === 0 ? scopeRank(a) - scopeRank(b) : slot;
          })
          .map(credentialBindingRowToRef);
      });

    const credentialBindingSet = (input: SetCredentialBindingInput) =>
      Effect.gen(function* () {
        yield* assertScopeInStack("credential binding targetScope", input.targetScope);
        yield* assertScopeInStack("credential binding sourceScope", input.sourceScope);
        yield* assertCredentialBindingTargetNotOuter({
          label: "credential binding",
          targetScope: input.targetScope,
          sourceScope: input.sourceScope,
          sourceId: input.sourceId,
        });

        const source = yield* findSourceRowAtScope({
          pluginId: input.pluginId,
          sourceId: input.sourceId,
          sourceScope: input.sourceScope,
        });
        if (!source) {
          return yield* new StorageError({
            message:
              `Cannot set credential binding for source "${input.sourceId}" ` +
              `at scope "${input.sourceScope}": source is not visible.`,
            cause: undefined,
          });
        }

        if (input.value.kind === "secret") {
          const secretId = input.value.secretId;
          const secretScope = input.value.secretScopeId ?? input.targetScope;
          yield* assertScopeInStack("credential binding secretScope", secretScope);
          if (scopePrecedence.get(secretScope)! < scopePrecedence.get(input.targetScope)!) {
            return yield* new StorageError({
              message:
                `Cannot bind secret "${secretId}" from scope "${secretScope}" ` +
                `to target scope "${input.targetScope}": shared bindings cannot reference inner-scope secrets.`,
              cause: undefined,
            });
          }
          const secret = yield* findSecretRowAtScope({
            secretId,
            scopeId: secretScope,
          });
          if (!secret) {
            // No core routing row at this scope yet. Read-only providers
            // (1password, env, …) own items that never get a row via
            // `secrets.set()`, so a config-sync referencing one of those
            // ids by value otherwise fails here. Walk providers that can
            // enumerate, and if any owns the id, materialize a routing row
            // pointing at that provider so resolution finds it.
            let materialized = false;
            for (const [key, provider] of secretProviders) {
              let name: string | undefined;
              if (provider.list) {
                const entries = yield* provider
                  .list()
                  .pipe(Effect.catch(() => Effect.succeed([] as const)));
                const found = entries.find((e) => e.id === secretId);
                if (found) name = found.name;
              }
              if (name === undefined) {
                // Provider didn't enumerate the id (slow list(), failed list,
                // or no list() at all). Probe with get() — cheap for most
                // backends — and use the id as the display name.
                const value = yield* provider
                  .get(secretId, secretScope)
                  .pipe(Effect.catch(() => Effect.succeed(null as string | null)));
                if (value !== null) name = secretId;
              }
              if (name === undefined) continue;
              const now = new Date();
              yield* core.create({
                model: "secret",
                data: {
                  id: secretId,
                  scope_id: secretScope,
                  name,
                  provider: key,
                  created_at: now,
                },
                forceAllowId: true,
              });
              materialized = true;
              break;
            }
            if (!materialized) {
              const providerKeys = [...secretProviders.keys()];
              return yield* new StorageError({
                message:
                  `Cannot bind secret "${secretId}" at scope "${secretScope}": ` +
                  `no registered secret provider has an item with this id ` +
                  `(checked: ${providerKeys.join(", ") || "none"}). ` +
                  `If this id points to a 1Password item, the item may have been deleted, ` +
                  `renamed, or live in a different vault than the one configured for this scope.`,
                cause: undefined,
              });
            }
          }
        }

        if (input.value.kind === "connection") {
          const connection = yield* findConnectionRowAtScope({
            connectionId: input.value.connectionId,
            scopeId: input.targetScope,
          });
          if (!connection) {
            return yield* new StorageError({
              message:
                `Cannot bind connection "${input.value.connectionId}" at scope "${input.targetScope}": ` +
                `the connection must be owned by the same scope as the binding.`,
              cause: undefined,
            });
          }
        }

        const id = credentialBindingId(input);
        const now = new Date();
        yield* core.deleteMany({
          model: "credential_binding",
          where: [
            { field: "scope_id", value: input.targetScope },
            { field: "plugin_id", value: input.pluginId },
            { field: "source_id", value: input.sourceId },
            { field: "source_scope_id", value: input.sourceScope },
            { field: "slot_key", value: input.slotKey },
          ],
        });
        yield* core.create({
          model: "credential_binding",
          data: {
            id,
            scope_id: input.targetScope,
            plugin_id: input.pluginId,
            source_id: input.sourceId,
            source_scope_id: input.sourceScope,
            slot_key: input.slotKey,
            kind: input.value.kind,
            text_value: input.value.kind === "text" ? input.value.text : undefined,
            secret_id: input.value.kind === "secret" ? input.value.secretId : undefined,
            secret_scope_id:
              input.value.kind === "secret"
                ? (input.value.secretScopeId ?? input.targetScope)
                : undefined,
            connection_id: input.value.kind === "connection" ? input.value.connectionId : undefined,
            created_at: now,
            updated_at: now,
          },
          forceAllowId: true,
        });
        return credentialBindingRowToRef({
          id,
          scope_id: input.targetScope,
          plugin_id: input.pluginId,
          source_id: input.sourceId,
          source_scope_id: input.sourceScope,
          slot_key: input.slotKey,
          kind: input.value.kind,
          text_value: input.value.kind === "text" ? input.value.text : undefined,
          secret_id: input.value.kind === "secret" ? input.value.secretId : undefined,
          secret_scope_id:
            input.value.kind === "secret"
              ? (input.value.secretScopeId ?? input.targetScope)
              : undefined,
          connection_id: input.value.kind === "connection" ? input.value.connectionId : undefined,
          created_at: now,
          updated_at: now,
        } as CredentialBindingRow);
      });

    const credentialBindingRemove = (input: RemoveCredentialBindingInput) =>
      Effect.gen(function* () {
        yield* assertScopeInStack("credential binding targetScope", input.targetScope);
        yield* assertScopeInStack("credential binding sourceScope", input.sourceScope);
        yield* assertCredentialBindingTargetNotOuter({
          label: "credential binding removal",
          targetScope: input.targetScope,
          sourceScope: input.sourceScope,
          sourceId: input.sourceId,
        });

        const source = yield* findSourceRowAtScope({
          pluginId: input.pluginId,
          sourceId: input.sourceId,
          sourceScope: input.sourceScope,
        });
        if (!source) {
          return yield* new StorageError({
            message:
              `Cannot remove credential binding for source "${input.sourceId}" ` +
              `at scope "${input.sourceScope}": source is not visible.`,
            cause: undefined,
          });
        }

        yield* core.deleteMany({
          model: "credential_binding",
          where: [
            { field: "scope_id", value: input.targetScope },
            { field: "plugin_id", value: input.pluginId },
            { field: "source_id", value: input.sourceId },
            { field: "source_scope_id", value: input.sourceScope },
            { field: "slot_key", value: input.slotKey },
          ],
        });
      });

    const credentialBindingReplaceForSource = (input: ReplaceCredentialBindingsInput) =>
      Effect.gen(function* () {
        yield* assertScopeInStack("credential binding targetScope", input.targetScope);
        yield* assertScopeInStack("credential binding sourceScope", input.sourceScope);
        yield* assertCredentialBindingTargetNotOuter({
          label: "credential binding replacement",
          targetScope: input.targetScope,
          sourceScope: input.sourceScope,
          sourceId: input.sourceId,
        });

        const source = yield* findSourceRowAtScope({
          pluginId: input.pluginId,
          sourceId: input.sourceId,
          sourceScope: input.sourceScope,
        });
        if (!source) {
          return yield* new StorageError({
            message:
              `Cannot replace credential bindings for source "${input.sourceId}" ` +
              `at scope "${input.sourceScope}": source is not visible.`,
            cause: undefined,
          });
        }

        const nextSlots = new Set(input.bindings.map((binding) => binding.slotKey));
        const existing = yield* core.findMany({
          model: "credential_binding",
          where: [
            { field: "scope_id", value: input.targetScope },
            { field: "plugin_id", value: input.pluginId },
            { field: "source_id", value: input.sourceId },
            { field: "source_scope_id", value: input.sourceScope },
          ],
        });
        for (const row of existing as readonly CredentialBindingRow[]) {
          const shouldOwnSlot = input.slotPrefixes.some((prefix) =>
            row.slot_key.startsWith(prefix),
          );
          if (shouldOwnSlot && !nextSlots.has(row.slot_key)) {
            yield* credentialBindingRemove({
              targetScope: input.targetScope,
              pluginId: input.pluginId,
              sourceId: input.sourceId,
              sourceScope: input.sourceScope,
              slotKey: row.slot_key,
            });
          }
        }

        const refs: CredentialBindingRef[] = [];
        for (const binding of input.bindings) {
          refs.push(
            yield* credentialBindingSet({
              targetScope: input.targetScope,
              pluginId: input.pluginId,
              sourceId: input.sourceId,
              sourceScope: input.sourceScope,
              slotKey: binding.slotKey,
              value: binding.value,
            }),
          );
        }
        return refs;
      });

    const credentialBindingRemoveForSource = (input: CredentialBindingSourceInput) =>
      Effect.gen(function* () {
        yield* assertScopeInStack("credential binding sourceScope", input.sourceScope);
        const source = yield* findSourceRowAtScope(input);
        if (!source) return;

        // Source-owner cleanup is intentionally broader than a normal scoped
        // binding delete. Removing a shared source must detach all credential
        // rows for that source identity, including user-owned bindings that
        // are not in the source owner's current stack. Normal list/resolve/
        // remove paths stay behind the scoped adapter.
        yield* rawCore.deleteMany({
          model: "credential_binding",
          where: [
            { field: "plugin_id", value: input.pluginId },
            { field: "source_id", value: input.sourceId },
            { field: "source_scope_id", value: input.sourceScope },
          ],
        });
      });

    const credentialBindingResolutionStatus = (
      row: CredentialBindingRow,
    ): Effect.Effect<"resolved" | "missing", StorageFailure> =>
      Effect.gen(function* () {
        if (row.kind === "text") return typeof row.text_value === "string" ? "resolved" : "missing";
        if (row.kind === "secret") {
          if (!row.secret_id) return "missing";
          const secret = yield* findSecretRowAtScope({
            secretId: row.secret_id,
            scopeId: row.secret_scope_id ?? row.scope_id,
          });
          if (!secret) return "missing";
          return (yield* secretRouteHasBackingValue(secret)) ? "resolved" : "missing";
        }
        if (row.kind === "connection") {
          if (!row.connection_id) return "missing";
          const connection = yield* findConnectionRowAtScope({
            connectionId: row.connection_id,
            scopeId: row.scope_id,
          });
          return connection ? "resolved" : "missing";
        }
        return "missing";
      });

    const credentialBindingResolve = (input: CredentialBindingSlotInput) =>
      Effect.gen(function* () {
        const rows = yield* credentialBindingRowsForSlot(input);
        const row = findInnermost(rows);
        if (!row) {
          return new ResolvedCredentialSlot({
            pluginId: input.pluginId,
            sourceId: input.sourceId,
            sourceScopeId: input.sourceScope,
            slotKey: input.slotKey,
            bindingScopeId: null,
            kind: null,
            status: "missing" as const,
          });
        }
        return new ResolvedCredentialSlot({
          pluginId: input.pluginId,
          sourceId: input.sourceId,
          sourceScopeId: input.sourceScope,
          slotKey: input.slotKey,
          bindingScopeId: ScopeId.make(row.scope_id),
          kind:
            row.kind === "text" || row.kind === "secret" || row.kind === "connection"
              ? row.kind
              : null,
          status: yield* credentialBindingResolutionStatus(row),
        });
      });

    const sourceNamesForCredentialBindings = (
      rows: readonly CredentialBindingRow[],
    ): Effect.Effect<Map<string, string>, StorageFailure> =>
      Effect.gen(function* () {
        const sourceIds = [...new Set(rows.map((row) => row.source_id))];
        if (sourceIds.length === 0) return new Map<string, string>();
        const sourceRows = yield* core.findMany({
          model: "source",
          where: [{ field: "id", value: sourceIds, operator: "in" }],
        });
        return new Map(
          sourceRows.map((row) => [`${row.scope_id}\u0000${row.id}`, row.name] as const),
        );
      });

    const credentialBindingRowsToUsages = (
      rows: readonly CredentialBindingRow[],
    ): Effect.Effect<readonly Usage[], StorageFailure> =>
      Effect.gen(function* () {
        const names = yield* sourceNamesForCredentialBindings(rows);
        return rows.map(
          (row) =>
            new Usage({
              pluginId: row.plugin_id,
              scopeId: ScopeId.make(
                row.kind === "secret" ? (row.secret_scope_id ?? row.scope_id) : row.scope_id,
              ),
              ownerKind: "credential-binding",
              ownerId: row.source_id,
              ownerName: names.get(`${row.source_scope_id}\u0000${row.source_id}`) ?? null,
              slot: row.slot_key,
            }),
        );
      });

    const credentialBindingUsagesForSecret = (
      id: string,
    ): Effect.Effect<readonly Usage[], StorageFailure> =>
      Effect.gen(function* () {
        const rows = yield* core.findMany({
          model: "credential_binding",
          where: [{ field: "secret_id", value: id }],
        });
        return yield* credentialBindingRowsToUsages(rows as readonly CredentialBindingRow[]);
      });

    const credentialBindingUsagesForConnection = (
      id: string,
    ): Effect.Effect<readonly Usage[], StorageFailure> =>
      Effect.gen(function* () {
        const rows = yield* core.findMany({
          model: "credential_binding",
          where: [{ field: "connection_id", value: id }],
        });
        return yield* credentialBindingRowsToUsages(rows as readonly CredentialBindingRow[]);
      });

    const credentialBindings: CredentialBindingsFacade = {
      listForSource: credentialBindingListForSource,
      resolve: credentialBindingResolve,
      set: credentialBindingSet,
      remove: credentialBindingRemove,
      replaceForSource: credentialBindingReplaceForSource,
      removeForSource: credentialBindingRemoveForSource,
      usagesForSecret: credentialBindingUsagesForSecret,
      usagesForConnection: credentialBindingUsagesForConnection,
    };

    const oauthBundle = makeOAuth2Service({
      adapter: core,
      rawAdapter: adapter,
      secretsGet: (id) =>
        secretsGet(id).pipe(
          Effect.catchTag("SecretOwnedByConnectionError", () => Effect.succeed(null)),
        ),
      secretsGetResolved: (id) => secretsGetResolved(id),
      secretsGetAtScope: (id, scope) =>
        secretsGetAtScope(id, scope).pipe(
          Effect.catchTag("SecretOwnedByConnectionError", () => Effect.succeed(null)),
        ),
      secretsSet: (input) => secretsSet(input),
      connectionsCreate: (input) => connectionsCreate(input),
      httpClientLayer: config.httpClientLayer,
      endpointUrlPolicy: config.oauthEndpointUrlPolicy,
    });
    connectionProviders.set(oauthBundle.connectionProvider.key, oauthBundle.connectionProvider);

    // ------------------------------------------------------------------
    // Plugin wiring — build ctx, run extension, populate static pools,
    // register secret providers. No adapter reads here.
    // ------------------------------------------------------------------
    for (const plugin of plugins) {
      if (runtimes.has(plugin.id)) {
        return yield* new StorageError({
          message: `Duplicate plugin id: ${plugin.id}`,
          cause: undefined,
        });
      }

      // Plugin-facing typed view. `StorageError` and `UniqueViolationError`
      // flow through the typed channel unchanged — plugins can
      // `catchTag("UniqueViolationError", …)` to translate to their own
      // user-facing errors; the HTTP edge (see @executor-js/api
      // `withCapture`) is responsible for translating any
      // `StorageError` that still escapes into the opaque InternalError.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const storageDeps: StorageDeps<any> = {
        scopes,
        adapter: plugin.schema ? scopedTypedAdapter(adapter) : adapter,
        // Blob keys are namespaced by `<scope>/<plugin>` so two tenants
        // sharing a backing BlobStore can't collide or leak on the
        // same `(plugin, key)` pair. The store's `get`/`has` walk the
        // scope stack (innermost first); `put`/`delete` require the
        // plugin to name a target scope explicitly.
        blobs: pluginBlobStore(blobs, scopeIds, plugin.id),
      };
      const storage = plugin.storage(storageDeps);

      const ctx: PluginCtx<unknown> = {
        scopes,
        storage,
        httpClientLayer: config.httpClientLayer ?? FetchHttpClient.layer,
        core: {
          sources: {
            register: (input: SourceInput) =>
              Effect.gen(function* () {
                // Guard: reject a dynamic source whose id collides with
                // a static source id, or any of whose would-be tool ids
                // collide with a static tool id. Tool ids are
                // `${source_id}.${tool.name}` — static and dynamic
                // share the same string space. Fails as `StorageError`
                // so the HTTP edge surfaces it as `InternalError(traceId)`.
                if (staticSources.has(input.id)) {
                  return yield* new StorageError({
                    message: `Source id "${input.id}" collides with a static source`,
                    cause: undefined,
                  });
                }
                for (const tool of input.tools) {
                  const fqid = `${input.id}.${tool.name}`;
                  if (staticTools.has(fqid)) {
                    return yield* new StorageError({
                      message: `Tool id "${fqid}" collides with a static tool`,
                      cause: undefined,
                    });
                  }
                }
                // Wrap in adapter.transaction so a standalone register()
                // call is atomic (source create + tools createMany group
                // together). When already inside a parent ctx.transaction,
                // the router short-circuits to the active tx handle
                // instead of opening a nested sql.begin — that nested
                // sql.begin is the postgres.js + pool=1 deadlock path.
                yield* adapter.transaction(() => writeSourceInput(core, plugin.id, input));
              }),
            unregister: (input: RemoveSourceInput) =>
              // `unregister` is scoped to a caller-named source row. The
              // plugin already knows which source owner it is updating,
              // so the core path must not infer an innermost target.
              adapter.transaction(() =>
                Effect.gen(function* () {
                  yield* assertScopeInStack("source unregister targetScope", input.targetScope);
                  const row = yield* core.findOne({
                    model: "source",
                    where: [
                      { field: "id", value: input.id },
                      { field: "scope_id", value: input.targetScope },
                    ],
                  });
                  if (!row) return;
                  yield* deleteSourceById(core, input.id, input.targetScope);
                }),
              ),
            update: (input) =>
              core
                .update({
                  model: "source",
                  where: [
                    { field: "id", value: input.id },
                    { field: "scope_id", value: input.scope },
                  ],
                  update: {
                    ...(input.name !== undefined ? { name: input.name } : {}),
                    ...(input.url !== undefined ? { url: input.url ?? undefined } : {}),
                    updated_at: new Date(),
                  },
                })
                .pipe(Effect.asVoid),
          },
          definitions: {
            register: (input: DefinitionsInput) =>
              adapter.transaction(() => writeDefinitions(core, plugin.id, input)),
          },
        },
        secrets: {
          get: (id) => secretsGet(id),
          getAtScope: (id, scope) => secretsGetAtScope(id, scope),
          list: () => secretsListForCtx(),
          set: (input) => secretsSet(input),
          remove: (input) => secretsRemove(input),
        },
        connections: {
          get: (id) => connectionsGet(id),
          getAtScope: (id, scope) => connectionsGetAtScope(id, scope),
          list: () => connectionsListForCtx(),
          create: (input) => connectionsCreate(input),
          updateTokens: (input) => connectionsUpdateTokens(input),
          setIdentityLabel: (id, label) => connectionsSetIdentityLabel(id, label),
          accessToken: (id) => connectionsAccessToken(id),
          accessTokenAtScope: (id, scope) => connectionsAccessTokenAtScope(id, scope),
          remove: (input) => connectionsRemove(input),
        },
        credentialBindings,
        oauth: oauthBundle.service,
        // Open one real tx boundary and route every nested write inside
        // `effect` through that same handle via the activeAdapterRef —
        // see buildAdapterRouter above. Caller-typed errors (`E`)
        // propagate unchanged; storage failures also stay typed
        // (`StorageFailure`) so the HTTP edge wrapper can translate them.
        transaction: <A, E>(effect: Effect.Effect<A, E>) =>
          adapter.transaction(() => effect) as Effect.Effect<A, E | StorageFailure>,
      };

      // Build extension FIRST so it's available as `self` when resolving
      // staticSources. Field ordering in the plugin spec matters — TS
      // infers TExtension from `extension`'s return type, then NoInfer
      // locks `self` to that inferred type on `staticSources`.
      const extension: object = plugin.extension ? plugin.extension(ctx) : {};
      if (plugin.extension) {
        extensions[plugin.id] = extension;
      }

      // Resolve static declarations to the in-memory pools. NO DB WRITES.
      const decls = plugin.staticSources ? plugin.staticSources(extension) : [];
      for (const source of decls) {
        if (staticSources.has(source.id)) {
          return yield* new StorageError({
            message: `Duplicate static source id: ${source.id} (plugin ${plugin.id})`,
            cause: undefined,
          });
        }
        staticSources.set(source.id, { source, pluginId: plugin.id });

        for (const tool of source.tools) {
          const fqid = `${source.id}.${tool.name}`;
          if (staticTools.has(fqid)) {
            return yield* new StorageError({
              message: `Duplicate static tool id: ${fqid} (plugin ${plugin.id})`,
              cause: undefined,
            });
          }
          staticTools.set(fqid, {
            source,
            tool,
            pluginId: plugin.id,
            ctx,
          });
        }
      }

      runtimes.set(plugin.id, { plugin, storage, ctx });

      if (plugin.secretProviders) {
        const raw =
          typeof plugin.secretProviders === "function"
            ? plugin.secretProviders(ctx)
            : plugin.secretProviders;
        const providers = Effect.isEffect(raw) ? yield* raw : raw;
        for (const provider of providers) {
          if (secretProviders.has(provider.key)) {
            return yield* new StorageError({
              message: `Duplicate secret provider key: ${provider.key} (from plugin ${plugin.id})`,
              cause: undefined,
            });
          }
          secretProviders.set(provider.key, provider);
        }
      }

      if (plugin.connectionProviders) {
        const raw =
          typeof plugin.connectionProviders === "function"
            ? plugin.connectionProviders(ctx)
            : plugin.connectionProviders;
        const providers = Effect.isEffect(raw) ? yield* raw : raw;
        for (const provider of providers) {
          if (connectionProviders.has(provider.key)) {
            return yield* new StorageError({
              message: `Duplicate connection provider key: ${provider.key} (from plugin ${plugin.id})`,
              cause: undefined,
            });
          }
          connectionProviders.set(provider.key, provider);
        }
      }
    }

    // ------------------------------------------------------------------
    // Executor surface
    // ------------------------------------------------------------------
    const listSources = () =>
      Effect.gen(function* () {
        const dynamic = yield* core.findMany({ model: "source" });
        // Dedup by id with innermost scope winning. Without this, a user
        // who shadowed an org-wide source at their inner scope would see
        // two rows — their override and the outer default — which is
        // inconsistent with how `secrets.list` and every other list
        // surface dedup shadowed entries.
        const byId = new Map<string, (typeof dynamic)[number]>();
        const byIdRank = new Map<string, number>();
        for (const row of dynamic) {
          const rank = scopeRank(row);
          const existing = byIdRank.get(row.id);
          if (existing === undefined || rank < existing) {
            byId.set(row.id, row);
            byIdRank.set(row.id, rank);
          }
        }
        const dynamicDeduped = [...byId.values()];
        const staticList: Source[] = [];
        for (const { source, pluginId } of staticSources.values()) {
          staticList.push(staticDeclToSource(source, pluginId));
        }
        const merged = [...staticList, ...dynamicDeduped.map(rowToSource)];
        yield* Effect.annotateCurrentSpan({
          "executor.sources.static_count": staticList.length,
          "executor.sources.dynamic_count": dynamicDeduped.length,
        });
        return merged;
      }).pipe(Effect.withSpan("executor.sources.list"));

    // Bulk-resolve annotations across a set of dynamic tool rows by
    // grouping them under their owning plugin's resolveAnnotations
    // callback. One plugin call per (plugin_id, source_id) pair, not
    // per row. Plugins without a resolver simply contribute no
    // annotations for their rows.
    const resolveAnnotationsFor = (rows: readonly ToolRow[]) =>
      Effect.gen(function* () {
        const result = new Map<string, ToolAnnotations>();
        if (rows.length === 0) return result;

        // Group by (plugin_id, source_id)
        const groups = new Map<string, ToolRow[]>();
        for (const row of rows) {
          const key = `${row.plugin_id}\u0000${row.source_id}`;
          const bucket = groups.get(key);
          if (bucket) bucket.push(row);
          else groups.set(key, [row]);
        }

        // Each (plugin_id, source_id) group is an independent DB read,
        // so fan them out concurrently. Yielding them serially stacks
        // ~200-300ms storage round-trips end-to-end and dominates the
        // `executor.tools.list.annotations` span.
        const maps = yield* Effect.forEach(
          [...groups].slice(0, MAX_ANNOTATION_GROUPS),
          ([key, groupRows]) =>
            Effect.gen(function* () {
              const [pluginId, sourceId] = key.split("\u0000") as [string, string];
              const runtime = runtimes.get(pluginId);
              if (!runtime?.plugin.resolveAnnotations) return undefined;
              return yield* runtime.plugin.resolveAnnotations({
                ctx: runtime.ctx,
                sourceId,
                toolRows: groupRows,
              });
            }),
          { concurrency: "unbounded" },
        );
        for (const map of maps) {
          if (!map) continue;
          for (const [toolId, annotations] of Object.entries(map)) {
            result.set(toolId, annotations);
          }
        }
        return result;
      });

    const listTools = (filter?: ToolListFilter) =>
      Effect.gen(function* () {
        const dynamic = yield* core.findMany({
          model: "tool",
          where: filter?.sourceId ? [{ field: "source_id", value: filter.sourceId }] : undefined,
        });
        // Dedup by tool id, innermost scope winning — same reason as
        // `listSources` above: a shadowed id must surface as one entry
        // (the inner one), not two.
        const byId = new Map<string, (typeof dynamic)[number]>();
        const byIdRank = new Map<string, number>();
        for (const row of dynamic) {
          const rank = scopeRank(row);
          const existing = byIdRank.get(row.id);
          if (existing === undefined || rank < existing) {
            byId.set(row.id, row);
            byIdRank.set(row.id, rank);
          }
        }
        const dynamicDeduped = [...byId.values()];
        const annotations =
          filter?.includeAnnotations === false
            ? new Map<string, ToolAnnotations>()
            : yield* resolveAnnotationsFor(dynamicDeduped).pipe(
                Effect.withSpan("executor.tools.list.annotations"),
              );

        const out: Tool[] = [];
        // Static tools — annotations from the declaration, not a resolver.
        for (const entry of staticTools.values()) {
          out.push(staticDeclToTool(entry.source, entry.tool, entry.pluginId));
        }
        for (const row of dynamicDeduped) {
          out.push(rowToTool(row, annotations.get(row.id)));
        }
        const filtered = filter ? out.filter((t) => toolMatchesFilter(t, filter)) : out;

        // Drop tools blocked by user policy unless the caller explicitly
        // asked to see them (the settings UI does, agent surfaces don't).
        // One findMany covers the entire scope stack; resolution per
        // tool is in-memory.
        let result = filtered;
        let blockedCount = 0;
        if (filter?.includeBlocked !== true) {
          const policies = yield* loadAllPolicies();
          if (policies.length > 0) {
            const kept: Tool[] = [];
            for (const tool of filtered) {
              const match = resolveToolPolicy(tool.id, policies, scopeRank);
              if (match?.action === "block") {
                blockedCount++;
                continue;
              }
              kept.push(tool);
            }
            result = kept;
          }
        }

        yield* Effect.annotateCurrentSpan({
          "executor.tools.static_count": staticTools.size,
          "executor.tools.dynamic_count": dynamicDeduped.length,
          "executor.tools.result_count": result.length,
          "executor.tools.blocked_count": blockedCount,
        });
        return result;
      }).pipe(Effect.withSpan("executor.tools.list"));

    // Load all definitions for a single source as a plain map. Defs
    // for the same name can exist at multiple scopes (an admin registers
    // a default, a user overrides one entry with a tighter schema) —
    // dedup by name keeping the innermost-scope row.
    const loadDefinitionsForSource = (sourceId: string) =>
      Effect.gen(function* () {
        const defRows = yield* core.findMany({
          model: "definition",
          where: [{ field: "source_id", value: sourceId }],
        });
        const winners = new Map<string, { row: (typeof defRows)[number]; rank: number }>();
        for (const row of defRows) {
          const rank = scopeRank(row);
          const existing = winners.get(row.name);
          if (!existing || rank < existing.rank) {
            winners.set(row.name, { row, rank });
          }
        }
        const out: Record<string, unknown> = {};
        for (const [name, { row }] of winners) out[name] = row.schema;
        return out;
      });

    // Render the ToolSchema view for a tool — wraps the raw JSON schemas
    // with attached `$defs` and runs them through the TypeScript preview
    // helpers so the UI gets ready-to-display code samples.
    const buildToolSchemaView = (opts: {
      toolId: string;
      name?: string;
      description?: string;
      sourceId: string | undefined;
      rawInput: unknown;
      rawOutput: unknown;
    }) =>
      Effect.gen(function* () {
        const defs: Record<string, unknown> = opts.sourceId
          ? yield* loadDefinitionsForSource(opts.sourceId).pipe(
              Effect.withSpan("executor.tool.schema.load_defs"),
            )
          : {};

        const attachDefs = (schema: unknown): unknown => {
          if (schema == null || typeof schema !== "object") return schema;
          if (Object.keys(defs).length === 0) return schema;
          return { ...(schema as Record<string, unknown>), $defs: defs };
        };

        const inputSchema = attachDefs(opts.rawInput);
        const outputSchema = attachDefs(opts.rawOutput);

        const defsMap = new Map<string, unknown>(Object.entries(defs));
        const preview = yield* Effect.sync(() =>
          buildToolTypeScriptPreview({
            inputSchema,
            outputSchema,
            defs: defsMap,
          }),
        ).pipe(
          Effect.withSpan("schema.compile.preview", {
            attributes: {
              "schema.kind": "tool.preview",
              "schema.has_input": inputSchema !== undefined,
              "schema.has_output": outputSchema !== undefined,
              "schema.def_count": defsMap.size,
            },
          }),
        );

        return new ToolSchema({
          id: ToolId.make(opts.toolId),
          name: opts.name,
          description: opts.description,
          inputSchema,
          outputSchema,
          inputTypeScript: preview.inputTypeScript ?? undefined,
          outputTypeScript: preview.outputTypeScript ?? undefined,
          typeScriptDefinitions: preview.typeScriptDefinitions ?? undefined,
        });
      });

    const toolSchema = (toolId: string) =>
      Effect.gen(function* () {
        // Static pool first — static tools have no source in the DB so
        // no `$defs` attach; just wrap the declared schemas.
        const staticEntry = staticTools.get(toolId);
        if (staticEntry) {
          yield* Effect.annotateCurrentSpan({
            "executor.tool.dispatch_path": "static",
            "executor.source_id": staticEntry.source.id,
            "executor.source_kind": staticEntry.source.kind,
          });
          return yield* buildToolSchemaView({
            toolId,
            name: staticEntry.tool.name,
            description: staticEntry.tool.description,
            sourceId: undefined,
            rawInput: staticEntry.tool.inputSchema,
            rawOutput: staticEntry.tool.outputSchema,
          });
        }
        // Innermost-wins lookup: the scope-wrapped adapter returns rows
        // from every scope in the stack, so a bare findOne would pick the
        // first row the backend iterates. That's wrong when a user has
        // shadowed an outer-scope tool — they'd get the outer schema
        // back instead of their override.
        const rows = yield* core
          .findMany({
            model: "tool",
            where: [{ field: "id", value: toolId }],
          })
          .pipe(Effect.withSpan("executor.tool.resolve"));
        const row = findInnermost(rows);
        if (!row) return null;
        yield* Effect.annotateCurrentSpan({
          "executor.tool.dispatch_path": "dynamic",
          "executor.source_id": row.source_id,
          "executor.plugin_id": row.plugin_id,
        });
        return yield* buildToolSchemaView({
          toolId,
          name: row.name,
          description: row.description,
          sourceId: row.source_id,
          rawInput: decodeJsonColumn(row.input_schema),
          rawOutput: decodeJsonColumn(row.output_schema),
        });
      }).pipe(
        Effect.withSpan("executor.tool.schema", {
          attributes: { "mcp.tool.name": toolId },
        }),
      );

    // Bulk definitions accessor — every source's $defs, grouped by
    // source id. One query against the definition table, plus an
    // in-memory group-by with innermost-scope dedup: if the same
    // (source_id, name) pair exists at multiple scopes, the inner
    // scope's schema wins.
    const toolsDefinitions = () =>
      Effect.gen(function* () {
        const rows = yield* core.findMany({ model: "definition" });
        const winners = new Map<string, { row: (typeof rows)[number]; rank: number }>();
        for (const row of rows) {
          const key = `${row.source_id}\u0000${row.name}`;
          const rank = scopeRank(row);
          const existing = winners.get(key);
          if (!existing || rank < existing.rank) {
            winners.set(key, { row, rank });
          }
        }
        const out: Record<string, Record<string, unknown>> = {};
        for (const { row } of winners.values()) {
          let bucket = out[row.source_id];
          if (!bucket) {
            bucket = {};
            out[row.source_id] = bucket;
          }
          bucket[row.name] = row.schema;
        }
        return out;
      });

    const defaultElicitationHandler = resolveElicitationHandler(config.onElicitation);
    const pickHandler = (options: InvokeOptions | undefined): ElicitationHandler =>
      options?.onElicitation
        ? resolveElicitationHandler(options.onElicitation)
        : defaultElicitationHandler;

    const buildElicit = (toolId: string, args: unknown, handler: ElicitationHandler): Elicit => {
      return (request: ElicitationRequest) =>
        Effect.gen(function* () {
          const tid = ToolId.make(toolId);
          const response: ElicitationResponse = yield* handler({
            toolId: tid,
            args,
            request,
          });
          if (response.action !== "accept") {
            return yield* new ElicitationDeclinedError({
              toolId: tid,
              action: response.action,
            });
          }
          return response;
        });
    };

    // ------------------------------------------------------------------
    // Tool policies — user-authored overrides of the plugin-derived
    // approval annotations. Resolution walks the scope-stacked policy
    // table with first-match-wins ordering (innermost scope first, then
    // `position` ascending). The result either short-circuits invoke
    // (`block`), forces approval (`require_approval`), skips approval
    // (`approve`), or returns `undefined` so the plugin annotation is
    // used as today.
    // ------------------------------------------------------------------

    const loadAllPolicies = () => core.findMany({ model: "tool_policy" });

    const resolveToolPolicyForId = (toolId: string) =>
      Effect.gen(function* () {
        const policies = yield* loadAllPolicies();
        return resolveToolPolicy(toolId, policies, scopeRank);
      });

    const enforceApproval = (
      annotations: ToolAnnotations | undefined,
      toolId: string,
      args: unknown,
      policy: PolicyMatch | undefined,
      handler: ElicitationHandler,
    ) =>
      Effect.gen(function* () {
        // approve → never prompt regardless of plugin annotation.
        if (policy?.action === "approve") return;

        // require_approval → always prompt. If the plugin already had a
        // description, prefer it; otherwise show the matched pattern so
        // the user can see *why* the prompt fired.
        const policyForcesApproval = policy?.action === "require_approval";
        if (!policyForcesApproval && !annotations?.requiresApproval) return;

        const tid = ToolId.make(toolId);
        const message = annotations?.approvalDescription
          ? annotations.approvalDescription
          : policyForcesApproval && policy
            ? `Approve ${toolId}? (matched policy: ${policy.pattern})`
            : `Approve ${toolId}?`;
        const request = new FormElicitation({
          message: `${message}\n\nArguments:\n${approvalArgumentPreview(args)}`,
          requestedSchema: {
            type: "object",
            properties: {},
          },
        });
        const response = yield* handler({ toolId: tid, args, request });
        if (response.action !== "accept") {
          return yield* new ElicitationDeclinedError({
            toolId: tid,
            action: response.action,
          });
        }
      });

    const invokeTool = (toolId: string, args: unknown, options?: InvokeOptions) => {
      const handler = pickHandler(options);
      return Effect.gen(function* () {
        const formatInvocationCauseMessage = (cause: unknown): string => {
          // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: preserve public invoke error message wrapping for unknown plugin failures
          return cause instanceof Error ? cause.message : String(cause);
        };
        const wrapInvocationError = <A, E>(
          effect: Effect.Effect<A, E>,
        ): Effect.Effect<A, ToolInvocationError> =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new ToolInvocationError({
                  toolId: ToolId.make(toolId),
                  message: formatInvocationCauseMessage(cause),
                  cause,
                }),
            ),
          );

        // Resolve the user-authored policy first. A `block` rule
        // short-circuits both the static and dynamic paths before any
        // plugin code runs.
        const policy = yield* resolveToolPolicyForId(toolId).pipe(
          Effect.withSpan("executor.tool.resolve_policy"),
        );
        if (policy?.action === "block") {
          return yield* new ToolBlockedError({
            toolId: ToolId.make(toolId),
            pattern: policy.pattern,
          });
        }

        // Static path — O(1) map lookup, no DB hit.
        const staticEntry = staticTools.get(toolId);
        if (staticEntry) {
          yield* Effect.annotateCurrentSpan({
            "executor.tool.dispatch_path": "static",
            "executor.source_id": staticEntry.source.id,
            "executor.source_kind": staticEntry.source.kind,
            "executor.plugin_id": staticEntry.pluginId,
          });
          yield* enforceApproval(staticEntry.tool.annotations, toolId, args, policy, handler).pipe(
            Effect.withSpan("executor.tool.enforce_approval"),
          );
          return yield* wrapInvocationError(
            staticEntry.tool.handler({
              ctx: staticEntry.ctx,
              args,
              elicit: buildElicit(toolId, args, handler),
            }),
          ).pipe(Effect.withSpan("executor.tool.handler"));
        }

        // Dynamic path — DB lookup + delegate to owning plugin. Walk
        // the whole scope stack and pick the innermost-scope row so a
        // user's shadow of an outer tool actually wins on invoke (a bare
        // findOne would pick whatever row the backend iterated first).
        const toolRows = yield* core
          .findMany({
            model: "tool",
            where: [{ field: "id", value: toolId }],
          })
          .pipe(Effect.withSpan("executor.tool.resolve"));
        const row = findInnermost(toolRows);
        if (!row) {
          return yield* new ToolNotFoundError({
            toolId: ToolId.make(toolId),
          });
        }
        yield* Effect.annotateCurrentSpan({
          "executor.tool.dispatch_path": "dynamic",
          "executor.source_id": row.source_id,
          "executor.plugin_id": row.plugin_id,
        });
        const runtime = runtimes.get(row.plugin_id);
        if (!runtime) {
          return yield* new PluginNotLoadedError({
            pluginId: row.plugin_id,
            toolId: ToolId.make(toolId),
          });
        }
        if (!runtime.plugin.invokeTool) {
          return yield* new NoHandlerError({
            toolId: ToolId.make(toolId),
            pluginId: row.plugin_id,
          });
        }

        // Ask the plugin to derive annotations for this one row, if it
        // has a resolver. Cheap because the plugin typically already
        // needs to load its enrichment data to invoke the tool —
        // implementations should structure their resolver + invokeTool
        // around a single storage read. Skipped entirely when the user
        // policy is `approve` — the prompt is going to be skipped no
        // matter what the plugin says, so don't pay for the lookup.
        let annotations: ToolAnnotations | undefined;
        if (policy?.action !== "approve" && runtime.plugin.resolveAnnotations) {
          const map = yield* runtime.plugin
            .resolveAnnotations({
              ctx: runtime.ctx,
              sourceId: row.source_id,
              toolRows: [row],
            })
            .pipe(Effect.withSpan("executor.tool.resolve_annotations"));
          annotations = map[toolId];
        }
        yield* enforceApproval(annotations, toolId, args, policy, handler).pipe(
          Effect.withSpan("executor.tool.enforce_approval"),
        );

        return yield* wrapInvocationError(
          runtime.plugin.invokeTool({
            ctx: runtime.ctx,
            toolRow: row,
            args,
            elicit: buildElicit(toolId, args, handler),
          }),
        ).pipe(Effect.withSpan("executor.tool.handler"));
      }).pipe(
        Effect.withSpan("executor.tool.invoke", {
          attributes: {
            "mcp.tool.name": toolId,
          },
        }),
      );
    };

    const removeSource = (input: RemoveSourceInput) =>
      Effect.gen(function* () {
        yield* assertScopeInStack("source remove targetScope", input.targetScope);
        const sourceId = input.id;
        // Block removal of static sources structurally.
        if (staticSources.has(sourceId)) {
          return yield* new SourceRemovalNotAllowedError({ sourceId });
        }
        const sourceRow = yield* core.findOne({
          model: "source",
          where: [
            { field: "id", value: sourceId },
            { field: "scope_id", value: input.targetScope },
          ],
        });
        if (!sourceRow) return;
        if (!sourceRow.can_remove) {
          return yield* new SourceRemovalNotAllowedError({ sourceId });
        }
        const runtime = runtimes.get(sourceRow.plugin_id);
        // Group the plugin's own cleanup + the core row delete into one
        // tx so a removeSource never leaves orphan rows on failure. The
        // router short-circuits on nested calls when the caller is
        // already inside a parent ctx.transaction.
        yield* adapter.transaction(() =>
          Effect.gen(function* () {
            if (runtime?.plugin.removeSource) {
              yield* runtime.plugin.removeSource({
                ctx: runtime.ctx,
                sourceId,
                scope: input.targetScope,
              });
            }
            yield* deleteSourceById(core, sourceId, input.targetScope);
          }),
        );
      });

    const refreshSource = (input: RefreshSourceInput) =>
      Effect.gen(function* () {
        yield* assertScopeInStack("source refresh targetScope", input.targetScope);
        const sourceId = input.id;
        if (staticSources.has(sourceId)) return;
        const sourceRow = yield* core.findOne({
          model: "source",
          where: [
            { field: "id", value: sourceId },
            { field: "scope_id", value: input.targetScope },
          ],
        });
        if (!sourceRow) return;
        const runtime = runtimes.get(sourceRow.plugin_id);
        if (runtime?.plugin.refreshSource) {
          yield* runtime.plugin.refreshSource({
            ctx: runtime.ctx,
            sourceId,
            scope: input.targetScope,
          });
        }
      });

    const sourceDetectionMaxUrlLength = config.sourceDetection?.maxUrlLength ?? 2_048;
    const sourceDetectionMaxDetectors = config.sourceDetection?.maxDetectors ?? 6;
    const sourceDetectionMaxResults = config.sourceDetection?.maxResults ?? 4;
    const sourceDetectionTimeout = config.sourceDetection?.timeout ?? "60 seconds";
    const sourceDetectionHostedOutboundPolicy =
      config.sourceDetection?.hostedOutboundPolicy ?? config.httpClientLayer !== undefined;

    // URL autodetection — fan out across a bounded set of plugins that
    // declared a `detect` hook. Collect non-null results up to the
    // configured cap. Plugin-level detect implementations should
    // swallow fetch errors and return null, so one flaky plugin doesn't
    // block the whole dispatch.
    const detectionConfidenceScore = (confidence: SourceDetectionResult["confidence"]) => {
      switch (confidence) {
        case "high":
          return 3;
        case "medium":
          return 2;
        case "low":
          return 1;
      }
    };

    const detectSource = (url: string) =>
      Effect.gen(function* () {
        const trimmed = url.trim();
        if (trimmed.length === 0 || trimmed.length > sourceDetectionMaxUrlLength) return [];
        const parsed = yield* Effect.try({
          try: () => new URL(trimmed),
          catch: (error) => error,
        }).pipe(Effect.option);
        if (Option.isNone(parsed)) return [];
        if (parsed.value.protocol !== "http:" && parsed.value.protocol !== "https:") return [];
        if (sourceDetectionHostedOutboundPolicy) {
          const allowed = yield* validateHostedOutboundUrl(trimmed).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
          if (!allowed) return [];
        }

        const results: SourceDetectionResult[] = [];
        let detectorCount = 0;
        for (const runtime of runtimes.values()) {
          if (!runtime.plugin.detect) continue;
          if (detectorCount >= sourceDetectionMaxDetectors) break;
          detectorCount++;
          const result = yield* runtime.plugin
            .detect({ ctx: runtime.ctx, url: trimmed })
            .pipe(Effect.timeout(sourceDetectionTimeout))
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (result) results.push(result);
        }
        return results
          .sort(
            (a, b) =>
              detectionConfidenceScore(b.confidence) - detectionConfidenceScore(a.confidence),
          )
          .slice(0, sourceDetectionMaxResults);
      });

    // Per-source definitions accessor — one query, one mapping pass.
    const sourceDefinitions = (sourceId: string) => loadDefinitionsForSource(sourceId);

    // Existence check for user-facing secret pickers. Core `secret`
    // rows are routing metadata; when a provider can answer `has()`,
    // confirm the backing value still exists. Providers without `has()`
    // remain conservative so keychain/1password don't need to return
    // the value or prompt just to populate picker/status UI.
    const secretsStatus = (id: string): Effect.Effect<"resolved" | "missing", StorageFailure> =>
      Effect.gen(function* () {
        const rows = yield* secretRowsForId(id);
        if (rows.some((row) => row.owned_by_connection_id)) return "missing";
        for (const row of rows) {
          if (yield* secretRouteHasBackingValue(row)) return "resolved";
        }

        return "missing";
      });

    // ------------------------------------------------------------------
    // Policies — CRUD surface backed by the `tool_policy` core table.
    // The cloud settings UI is one consumer; plugins call the same API
    // when they programmatically manage policies.
    //
    // `list` orders rows innermost scope first, then position ascending.
    // Resolution then takes the first local match per scope and applies
    // the most restrictive action across scopes.
    // ------------------------------------------------------------------
    const policiesList = () =>
      Effect.gen(function* () {
        const rows = yield* loadAllPolicies();
        const sorted = [...rows].sort((a, b) => {
          const sa = scopeRank(a);
          const sb = scopeRank(b);
          if (sa !== sb) return sa - sb;
          return comparePolicyRow(a, b);
        });
        return sorted.map((row) => rowToToolPolicy(row));
      }).pipe(Effect.withSpan("executor.policies.list"));

    const policiesCreate = (input: CreateToolPolicyInput) =>
      Effect.gen(function* () {
        if (!isValidPattern(input.pattern)) {
          return yield* new StorageError({
            message:
              `Invalid tool policy pattern "${input.pattern}". ` +
              `Patterns must be "*" (every tool), an exact tool id ("a.b.c"), ` +
              `or a trailing wildcard ("a.b.*"). Leading "*" prefixes ` +
              `("*foo", "*.foo") and "**" are not supported.`,
            cause: undefined,
          });
        }
        if (!isToolPolicyAction(input.action)) {
          return yield* new StorageError({
            message:
              `Invalid tool policy action "${String(input.action)}". ` +
              `Expected "approve" | "require_approval" | "block".`,
            cause: undefined,
          });
        }

        // Default position: a fractional-indexing key above the
        // current minimum. Lets newly-created rules win against
        // existing ones, which matches the v1 design — users typically
        // add a rule to override behavior they're seeing right now,
        // not as a background fallback.
        let position = input.position;
        if (position === undefined) {
          const existing = yield* core.findMany({
            model: "tool_policy",
            where: [{ field: "scope_id", value: input.targetScope }],
          });
          let min: string | null = null;
          for (const row of existing) {
            const p = row.position;
            if (min === null || p < min) min = p;
          }
          position = generateKeyBetween(null, min);
        }

        const id = `pol_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
        const now = new Date();
        yield* core.create({
          model: "tool_policy",
          data: {
            id,
            scope_id: input.targetScope,
            pattern: input.pattern,
            action: input.action,
            position,
            created_at: now,
            updated_at: now,
          },
          forceAllowId: true,
        });
        return rowToToolPolicy({
          id,
          scope_id: input.targetScope,
          pattern: input.pattern,
          action: input.action,
          position,
          created_at: now,
          updated_at: now,
        } as ToolPolicyRow);
      }).pipe(Effect.withSpan("executor.policies.create"));

    const policiesUpdate = (input: UpdateToolPolicyInput) =>
      Effect.gen(function* () {
        if (input.pattern !== undefined && !isValidPattern(input.pattern)) {
          return yield* new StorageError({
            message: `Invalid tool policy pattern "${input.pattern}".`,
            cause: undefined,
          });
        }
        if (input.action !== undefined && !isToolPolicyAction(input.action)) {
          return yield* new StorageError({
            message: `Invalid tool policy action "${String(input.action)}".`,
            cause: undefined,
          });
        }

        const rows = yield* core.findMany({
          model: "tool_policy",
          where: [
            { field: "id", value: input.id },
            { field: "scope_id", value: input.targetScope },
          ],
        });
        const row = rows[0] ?? null;
        if (!row) {
          return yield* new StorageError({
            message: `Tool policy "${input.id}" not found in scope "${input.targetScope}".`,
            cause: undefined,
          });
        }

        const updated: ToolPolicyRow = {
          ...row,
          pattern: input.pattern ?? row.pattern,
          action: input.action ?? row.action,
          position: input.position ?? row.position,
          updated_at: new Date(),
        };
        yield* core.update({
          model: "tool_policy",
          where: [
            { field: "id", value: input.id },
            { field: "scope_id", value: input.targetScope },
          ],
          update: {
            pattern: updated.pattern,
            action: updated.action,
            position: updated.position,
            updated_at: updated.updated_at,
          },
        });
        return rowToToolPolicy(updated);
      }).pipe(Effect.withSpan("executor.policies.update"));

    const policiesRemove = (input: RemoveToolPolicyInput) =>
      core
        .deleteMany({
          model: "tool_policy",
          where: [
            { field: "id", value: input.id },
            { field: "scope_id", value: input.targetScope },
          ],
        })
        .pipe(Effect.asVoid, Effect.withSpan("executor.policies.remove"));

    const policiesResolve = (toolId: string) =>
      resolveToolPolicyForId(toolId).pipe(Effect.withSpan("executor.policies.resolve"));

    const close = () =>
      Effect.gen(function* () {
        for (const runtime of runtimes.values()) {
          if (runtime.plugin.close) {
            yield* runtime.plugin.close();
          }
        }
      });

    // Public Executor surface — storage-backed methods surface
    // `StorageFailure` (StorageError | UniqueViolationError) raw. The
    // HTTP edge wraps this surface with `withCapture` to
    // translate `StorageError` → `InternalError({ traceId })`; non-HTTP
    // consumers (CLI, Promise SDK, tests) see the raw typed channel.
    const base = {
      scopes,
      tools: {
        list: listTools,
        schema: toolSchema,
        definitions: toolsDefinitions,
        invoke: invokeTool,
      },
      sources: {
        list: listSources,
        remove: removeSource,
        refresh: refreshSource,
        detect: detectSource,
        definitions: sourceDefinitions,
      },
      secrets: {
        get: secretsGet,
        getAtScope: secretsGetAtScope,
        status: secretsStatus,
        set: secretsSet,
        remove: secretsRemove,
        list: secretsList,
        listAll: secretsListAll,
        usages: secretsUsages,
        providers: () => Effect.sync(() => Array.from(secretProviders.keys()) as readonly string[]),
      },
      connections: {
        get: connectionsGet,
        getAtScope: connectionsGetAtScope,
        list: connectionsList,
        create: connectionsCreate,
        updateTokens: connectionsUpdateTokens,
        setIdentityLabel: connectionsSetIdentityLabel,
        accessToken: connectionsAccessToken,
        accessTokenAtScope: connectionsAccessTokenAtScope,
        remove: connectionsRemove,
        usages: connectionsUsages,
        providers: () =>
          Effect.sync(() => Array.from(connectionProviders.keys()) as readonly string[]),
      },
      credentialBindings,
      oauth: oauthBundle.service,
      policies: {
        list: policiesList,
        create: policiesCreate,
        update: policiesUpdate,
        remove: policiesRemove,
        resolve: policiesResolve,
      },
      close,
    };

    // Cast through `unknown` because the impl effects can include
    // `Error` from plugin-supplied callbacks (resolveAnnotations etc.) —
    // those leak via the helper functions and won't be cleaned until
    // every plugin tightens its surface to typed errors. The runtime
    // shape matches `Executor<TPlugins>`.
    const toExecutor = (value: unknown): Executor<TPlugins> => value as Executor<TPlugins>;
    return toExecutor(Object.assign(base, extensions));
  });
