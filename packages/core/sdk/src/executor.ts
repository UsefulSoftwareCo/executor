import {
  Deferred,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Result,
  Schema,
  Semaphore,
} from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { fumadb } from "fumadb";
import { memoryAdapter } from "fumadb/adapters/memory";
import { withQueryContext, type Condition, type ConditionBuilder } from "fumadb/query";
import { schema as fumaSchema, type RelationsMap } from "fumadb/schema";
import type { AnyColumn } from "fumadb/schema";
import type { OAuthEndpointUrlPolicy } from "./oauth-helpers";
import { generateKeyBetween } from "fractional-indexing";
import {
  StorageError,
  isStorageFailure,
  makeFumaClient,
  type FumaDb,
  type FumaRow,
  type FumaTables,
  type StorageFailure,
} from "./fuma-runtime";

import { makeFumaBlobStore, pluginBlobStore } from "./blob";
import { coreToolsPlugin } from "./core-tools";
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
  type RemoveSourceCredentialBindingInput,
  type ReplaceCredentialBindingsInput,
  type ReplaceSourceCredentialBindingsInput,
  ResolvedCredentialSlot,
  type SetPluginCredentialBindingInput,
  type SetSourceCredentialBindingInput,
  type SourceCredentialBindingSlotInput,
  type SourceCredentialBindingSourceInput,
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
  SourceConfigureSchema,
  StaticSourceDecl,
  StaticToolDecl,
  StaticToolSchema,
  StorageDeps,
} from "./plugin";
import {
  pluginStorageId,
  type PluginStorageEntry,
  type PluginStorageFacade,
} from "./plugin-storage";
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
import { buildToolTypeScriptPreview, type ToolTypeScriptPreview } from "./schema-types";
import { collectReferencedDefinitions } from "./schema-refs";
import { assertExecutorScopePolicyTable, type ExecutorScopePolicyContext } from "./scope-policy";
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
  Effect.succeed(ElicitationResponse.make({ action: "accept" }));

const resolveElicitationHandler = (onElicitation: OnElicitation): ElicitationHandler =>
  onElicitation === "accept-all" ? acceptAllHandler : onElicitation;

// ---------------------------------------------------------------------------
// Executor — public surface. Every list/invoke/schema call is a direct
// core-table query (for dynamic rows) unioned with the in-memory static
// pool. No ToolRegistry, no SourceRegistry, no SecretStore services.
// ---------------------------------------------------------------------------

export type Executor<TPlugins extends readonly AnyPlugin[] = readonly []> = {
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
    /** Fetch a tool's schema view: JSON schemas with `$defs`
     *  attached from the core `definition` table, plus TypeScript
     *  preview strings. Returns `null` for unknown tool ids. */
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
    readonly configure: (input: {
      readonly source: {
        readonly id: string;
        readonly scope: ScopeId | string;
      };
      readonly scope: ScopeId | string;
      readonly type?: string;
      readonly config: unknown;
    }) => Effect.Effect<unknown, StorageFailure>;
    readonly listBindings: (
      input: SourceCredentialBindingSourceInput,
    ) => Effect.Effect<readonly CredentialBindingRef[], StorageFailure>;
    readonly resolveBinding: (
      input: SourceCredentialBindingSlotInput,
    ) => Effect.Effect<CredentialBindingRef | null, StorageFailure>;
    readonly setBinding: (
      input: SetSourceCredentialBindingInput,
    ) => Effect.Effect<CredentialBindingRef, StorageFailure>;
    readonly removeBinding: (
      input: RemoveSourceCredentialBindingInput,
    ) => Effect.Effect<void, StorageFailure>;
    readonly replaceBindings: (
      input: ReplaceSourceCredentialBindingsInput,
    ) => Effect.Effect<readonly CredentialBindingRef[], StorageFailure>;
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

export interface ExecutorDb {
  readonly db: FumaDb<any>;
  readonly close?: () => Effect.Effect<void, StorageFailure> | Promise<void> | void;
}

export type ExecutorDbInput = FumaDb<any> | ExecutorDb;

export type ExecutorDbFactory = (config: {
  readonly tables: FumaTables;
}) => ExecutorDbInput | Effect.Effect<ExecutorDbInput, StorageFailure>;

export interface ExecutorConfig<TPlugins extends readonly AnyPlugin[] = readonly []> {
  /**
   * Precedence-ordered scope stack. Innermost first; typical shape is
   * `[userInOrgScope, orgScope]`. Reads on scoped tables walk the
   * stack (first hit wins for shadow-by-id consumers like secrets and
   * blobs); writes require callers to name an explicit target scope.
   * Must be non-empty.
   */
  readonly scopes: readonly Scope[];
  readonly db?: ExecutorDbInput | ExecutorDbFactory;
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
  /**
   * Enable the built-in `core-tools` plugin which contributes
   * agent-facing static tools (`scopes.list`, `secrets.list`,
   * `secrets.create`). The `webBaseUrl` is where the executor's web
   * UI lives; `secrets.create` builds a URL elicitation that points
   * the user at `${webBaseUrl}/secrets?...` so the plaintext value
   * never crosses the agent.
   *
   * Omit to skip registration (tests, MCP-only hosts that don't
   * surface a web UI, etc.).
   */
  readonly coreTools?: {
    readonly webBaseUrl: string;
  };
}

// ---------------------------------------------------------------------------
// collectTables — merge core tables with every plugin's declared Fuma table.
// Hosts pass the result to FumaDB when constructing the database client.
// ---------------------------------------------------------------------------

export const collectTables = (plugins: readonly AnyPlugin[]): FumaTables => {
  const merged: FumaTables = { ...coreSchema };
  for (const plugin of plugins) {
    if (!plugin.schema) continue;
    for (const [tableKey, tableDef] of Object.entries(plugin.schema)) {
      if (merged[tableKey]) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: collectTables is a synchronous configuration API
        throw new StorageError({
          message:
            `Duplicate storage table "${tableKey}" contributed by plugin "${plugin.id}"` +
            ` (reserved by core or another plugin)`,
          cause: undefined,
        });
      }
      merged[tableKey] = tableDef as FumaTables[string];
    }
  }

  validateExecutorScopePolicyTables(merged);

  return merged;
};

const validateExecutorScopePolicyTables = (tables: FumaTables): void => {
  for (const [tableKey, tableDef] of Object.entries(tables)) {
    assertExecutorScopePolicyTable(tableDef, tableKey);
  }
};

const validateExecutorDbTables = (required: FumaTables, actual: FumaTables): void => {
  const missing = Object.keys(required)
    .filter((tableName) => !actual[tableName])
    .sort();
  if (missing.length === 0) return;

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: synchronous startup validation before Executor services are built
  throw new StorageError({
    message: `Executor database is missing required table definitions: ${missing.join(", ")}`,
    cause: {
      missing,
      available: Object.keys(actual).sort(),
    },
  });
};

const storageFailureFromUnknown = (message: string, cause: unknown): StorageFailure =>
  isStorageFailure(cause) ? cause : new StorageError({ message, cause });

const pluginStorageFailure = (pluginId: string, hook: string, cause: unknown): StorageFailure =>
  storageFailureFromUnknown(`${hook} failed for plugin ${pluginId}`, cause);

const createDefaultMemoryDb = (tables: FumaTables): ExecutorDb => {
  const version = "1.0.0";
  const latestSchema = fumaSchema<string, FumaTables, RelationsMap<FumaTables>>({
    version,
    tables,
  });
  const factory = fumadb({
    namespace: "executor_memory",
    schemas: [latestSchema],
  });

  // oxlint-disable-next-line executor/no-double-cast -- boundary: dynamic plugin table map is known only after collectTables()
  const db = factory.client(memoryAdapter()).orm(version) as unknown as FumaDb;
  return {
    db,
  };
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
  inputSchema: toToolJsonSchema(tool.inputSchema),
  outputSchema: toToolJsonSchema(tool.outputSchema, "output"),
  annotations: tool.annotations,
});

const toToolJsonSchema = (
  schema: StaticToolSchema | undefined,
  direction: "input" | "output" = "input",
): unknown => {
  if (schema == null) return undefined;
  return schema["~standard"].jsonSchema[direction]({
    target: "draft-2020-12",
  });
};

const toConfigureJsonSchema = (
  schema: StaticToolSchema | Schema.Decoder<unknown, never> | undefined,
): unknown => {
  if (schema == null) return undefined;
  const standard = schema as {
    readonly "~standard"?: {
      readonly validate?: unknown;
      readonly jsonSchema?: StaticToolSchema["~standard"]["jsonSchema"];
    };
  };
  if (typeof standard["~standard"]?.validate !== "function") {
    const jsonSchema = Schema.toStandardSchemaV1(
      Schema.toStandardJSONSchemaV1(schema as Schema.Decoder<unknown, never>) as never,
    ) as StaticToolSchema;
    return toToolJsonSchema(jsonSchema);
  }
  return standard["~standard"].jsonSchema?.input({
    target: "draft-2020-12",
  });
};

const decodeConfigureInput = (
  schema: StaticToolSchema | Schema.Decoder<unknown, never> | undefined,
  input: unknown,
): Effect.Effect<unknown, unknown> => {
  if (schema == null) return Effect.succeed(input);
  const standard = schema as {
    readonly "~standard"?: { readonly validate?: unknown };
  };
  if (standard["~standard"] === undefined || typeof standard["~standard"].validate !== "function") {
    return Schema.decodeUnknownEffect(schema as Schema.Decoder<unknown, never>)(input);
  }
  return Effect.promise(() =>
    Promise.resolve((standard["~standard"]!.validate as (input: unknown) => unknown)(input)),
  ).pipe(
    Effect.flatMap((result) => {
      const validationResult = result as { readonly value?: unknown };
      return "value" in validationResult
        ? Effect.succeed(validationResult.value)
        : Effect.fail(result);
    }),
  );
};

const sourceConfigureSchemaView = (
  pluginId: string,
  configure: NonNullable<AnyPlugin["sourceConfigure"]>,
): SourceConfigureSchema => ({
  pluginId,
  type: configure.type,
  schema: toConfigureJsonSchema(configure.schema),
});

const EXECUTOR_SOURCE_ID = "executor";
const EXECUTOR_SOURCE: StaticSourceDecl = {
  id: EXECUTOR_SOURCE_ID,
  kind: "built-in",
  name: "Executor",
  canRemove: false,
  canRefresh: false,
  canEdit: false,
  tools: [],
};

const scopeFilter =
  (scopes: readonly string[]) =>
  (b: ConditionBuilder<Record<string, AnyColumn>>): Condition =>
    scopes.length === 1 ? b("scope_id", "=", scopes[0]!) : b("scope_id", "in", [...scopes]);

const scopedWhere =
  (
    scopes: readonly string[],
    where?: (b: ConditionBuilder<Record<string, AnyColumn>>) => Condition | boolean,
  ) =>
  (b: ConditionBuilder<Record<string, AnyColumn>>): Condition | boolean =>
    b.and(scopeFilter(scopes)(b), where ? where(b) : true);

const byId =
  (id: string) =>
  (b: ConditionBuilder<Record<string, AnyColumn>>): Condition =>
    b("id", "=", id);

const byScopedId =
  (scope: string, id: string) =>
  (b: ConditionBuilder<Record<string, AnyColumn>>): Condition =>
    b.and(b("scope_id", "=", scope), b("id", "=", id)) as Condition;

const toolSourceId = (toolId: string): string | null => {
  const dot = toolId.indexOf(".");
  return dot === -1 ? null : toolId.slice(0, dot);
};

const levenshteinDistance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);
  for (let i = 0; i < left.length; i++) {
    current[0] = i + 1;
    for (let j = 0; j < right.length; j++) {
      current[j + 1] =
        left[i] === right[j]
          ? previous[j]!
          : Math.min(previous[j]!, previous[j + 1]!, current[j]!) + 1;
    }
    for (let j = 0; j < previous.length; j++) previous[j] = current[j]!;
  }
  return previous[right.length]!;
};

const missingToolSuggestionScore = (query: string, candidate: string): number => {
  const normalizedQuery = query.toLowerCase();
  const normalizedCandidate = candidate.toLowerCase();
  if (normalizedCandidate === normalizedQuery) return 0;
  if (normalizedCandidate.startsWith(normalizedQuery)) return 1;
  if (normalizedQuery.startsWith(normalizedCandidate)) return 2;
  if (normalizedCandidate.includes(normalizedQuery)) return 3;
  const queryLeaf = normalizedQuery.split(".").at(-1) ?? normalizedQuery;
  const candidateLeaf = normalizedCandidate.split(".").at(-1) ?? normalizedCandidate;
  if (candidateLeaf.startsWith(queryLeaf) || queryLeaf.startsWith(candidateLeaf)) return 4;
  return 10 + levenshteinDistance(normalizedQuery, normalizedCandidate);
};

const missingToolSuggestions = (
  toolId: string,
  rows: readonly { readonly id: string }[],
): readonly ToolId[] =>
  rows
    .map((row) => ({ id: row.id, score: missingToolSuggestionScore(toolId, row.id) }))
    .sort((left, right) => left.score - right.score || left.id.localeCompare(right.id))
    .slice(0, 5)
    .map((item) => ToolId.make(item.id));

type CoreTableName = keyof CoreSchema & string;
type CoreRow<TName extends CoreTableName> = FumaRow<CoreSchema[TName]>;
type CoreWhere<_TName extends CoreTableName> = (
  b: ConditionBuilder<Record<string, AnyColumn>>,
) => Condition | boolean;
type CoreFindManyOptions<TName extends CoreTableName> = {
  readonly where?: CoreWhere<TName>;
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?:
    | readonly [string, "asc" | "desc"]
    | readonly (readonly [string, "asc" | "desc"])[];
};
type CoreFindFirstOptions<TName extends CoreTableName> = Omit<
  CoreFindManyOptions<TName>,
  "limit" | "offset"
>;

type LooseStorageDb = {
  readonly count: (tableName: string, options?: unknown) => Promise<number>;
  readonly create: (
    tableName: string,
    row: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  readonly createMany: (
    tableName: string,
    rows: readonly Record<string, unknown>[],
  ) => Promise<readonly unknown[]>;
  readonly deleteMany: (tableName: string, options?: unknown) => Promise<void>;
  readonly findFirst: (
    tableName: string,
    options?: unknown,
  ) => Promise<Record<string, unknown> | null>;
  readonly findMany: (
    tableName: string,
    options?: unknown,
  ) => Promise<readonly Record<string, unknown>[]>;
  readonly updateMany: (tableName: string, options: unknown) => Promise<void>;
};

const asLooseStorageDb = (db: unknown): LooseStorageDb => db as LooseStorageDb;

const makeCoreDb = (fuma: ReturnType<typeof makeFumaClient>) => ({
  count: <TName extends CoreTableName>(
    tableName: TName,
    options?: { readonly where?: CoreWhere<TName> },
  ): Effect.Effect<number, StorageFailure> =>
    fuma.use(`${tableName}.count`, (db) => asLooseStorageDb(db).count(tableName, options)),
  create: <TName extends CoreTableName>(
    tableName: TName,
    row: Record<string, unknown>,
  ): Effect.Effect<CoreRow<TName>, StorageFailure> =>
    fuma.use(`${tableName}.create`, (db) =>
      asLooseStorageDb(db).create(tableName, row),
    ) as Effect.Effect<CoreRow<TName>, StorageFailure>,
  createMany: <TName extends CoreTableName>(
    tableName: TName,
    rows: readonly Record<string, unknown>[],
  ): Effect.Effect<void, StorageFailure> =>
    rows.length === 0
      ? Effect.void
      : fuma
          .use(`${tableName}.createMany`, (db) => asLooseStorageDb(db).createMany(tableName, rows))
          .pipe(Effect.asVoid),
  deleteMany: <TName extends CoreTableName>(
    tableName: TName,
    options: { readonly where?: CoreWhere<TName> } = {},
  ): Effect.Effect<void, StorageFailure> =>
    fuma.use(`${tableName}.deleteMany`, (db) =>
      asLooseStorageDb(db).deleteMany(tableName, options),
    ),
  findFirst: <TName extends CoreTableName>(
    tableName: TName,
    options: CoreFindFirstOptions<TName>,
  ): Effect.Effect<CoreRow<TName> | null, StorageFailure> =>
    fuma.use(`${tableName}.findFirst`, (db) =>
      asLooseStorageDb(db).findFirst(tableName, options),
    ) as Effect.Effect<CoreRow<TName> | null, StorageFailure>,
  findMany: <TName extends CoreTableName>(
    tableName: TName,
    options: CoreFindManyOptions<TName> = {},
  ): Effect.Effect<readonly CoreRow<TName>[], StorageFailure> =>
    fuma.use(`${tableName}.findMany`, (db) =>
      asLooseStorageDb(db).findMany(tableName, options),
    ) as Effect.Effect<readonly CoreRow<TName>[], StorageFailure>,
  updateMany: <TName extends CoreTableName>(
    tableName: TName,
    options: {
      readonly where?: CoreWhere<TName>;
      readonly set: Record<string, unknown>;
    },
  ): Effect.Effect<void, StorageFailure> =>
    fuma.use(`${tableName}.updateMany`, (db) =>
      asLooseStorageDb(db).updateMany(tableName, options),
    ),
});

const pluginStorageEntryFromRow = <T>(row: CoreRow<"plugin_storage">): PluginStorageEntry<T> => ({
  id: row.id,
  scopeId: ScopeId.make(row.scope_id),
  pluginId: row.plugin_id,
  collection: row.collection,
  key: row.key,
  data: row.data as T,
  createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
});

const makePluginStorageFacade = (input: {
  readonly core: ReturnType<typeof makeCoreDb>;
  readonly pluginId: string;
  readonly scopeIds: readonly string[];
}): PluginStorageFacade => {
  const whereFor = (collection: string, key?: string) =>
    scopedWhere(input.scopeIds, (b) =>
      b.and(
        b("plugin_id", "=", input.pluginId),
        b("collection", "=", collection),
        key === undefined ? true : b("key", "=", key),
      ),
    );

  const sortByScopePrecedence = (rows: readonly CoreRow<"plugin_storage">[]) =>
    [...rows].sort((left, right) => {
      const leftIndex = input.scopeIds.indexOf(left.scope_id);
      const rightIndex = input.scopeIds.indexOf(right.scope_id);
      return leftIndex - rightIndex || left.key.localeCompare(right.key);
    });

  const getVisible = <T>(collection: string, key: string) =>
    input.core
      .findMany("plugin_storage", { where: whereFor(collection, key) })
      .pipe(Effect.map((rows) => sortByScopePrecedence(rows)[0] ?? null))
      .pipe(Effect.map((row) => (row ? pluginStorageEntryFromRow<T>(row) : null)));

  return {
    get: (storageInput) => getVisible(storageInput.collection, storageInput.key),
    getAtScope: (storageInput) =>
      input.core
        .findFirst("plugin_storage", {
          where: byScopedId(
            storageInput.scope,
            pluginStorageId({
              pluginId: input.pluginId,
              collection: storageInput.collection,
              key: storageInput.key,
            }),
          ),
        })
        .pipe(Effect.map((row) => (row ? pluginStorageEntryFromRow(row) : null))),
    list: (storageInput) =>
      input.core.findMany("plugin_storage", { where: whereFor(storageInput.collection) }).pipe(
        Effect.map((rows) =>
          sortByScopePrecedence(rows)
            .filter((row) =>
              storageInput.keyPrefix === undefined
                ? true
                : row.key.startsWith(storageInput.keyPrefix),
            )
            .map((row) => pluginStorageEntryFromRow(row)),
        ),
      ),
    put: (storageInput) =>
      Effect.gen(function* () {
        if (!input.scopeIds.includes(storageInput.scope)) {
          return yield* new StorageError({
            message: `Unknown plugin storage target scope: ${storageInput.scope}`,
            cause: undefined,
          });
        }
        const id = pluginStorageId({
          pluginId: input.pluginId,
          collection: storageInput.collection,
          key: storageInput.key,
        });
        const existing = yield* input.core.findFirst("plugin_storage", {
          where: byScopedId(storageInput.scope, id),
        });
        const now = new Date();
        if (existing) {
          yield* input.core.updateMany("plugin_storage", {
            where: byScopedId(storageInput.scope, id),
            set: {
              data: storageInput.data,
              updated_at: now,
            },
          });
          return pluginStorageEntryFromRow({
            ...existing,
            data: storageInput.data,
            updated_at: now,
          });
        }
        const row = yield* input.core.create("plugin_storage", {
          id,
          scope_id: storageInput.scope,
          plugin_id: input.pluginId,
          collection: storageInput.collection,
          key: storageInput.key,
          data: storageInput.data,
          created_at: now,
          updated_at: now,
        });
        return pluginStorageEntryFromRow(row);
      }),
    remove: (storageInput) =>
      input.core.deleteMany("plugin_storage", {
        where: byScopedId(
          storageInput.scope,
          pluginStorageId({
            pluginId: input.pluginId,
            collection: storageInput.collection,
            key: storageInput.key,
          }),
        ),
      }),
  };
};

// ---------------------------------------------------------------------------
// Dynamic-row writers — used by ctx.core.sources.register. Static sources
// never touch these functions.
// ---------------------------------------------------------------------------

// Upsert shape: delete any existing source + tools + definitions for
// `input.id` before creating fresh rows. Keeps replayable — boot-time
// sync from executor.jsonc can call register() on rows that already
// exist without tripping a UNIQUE constraint.
const writeSourceInput = (
  core: ReturnType<typeof makeCoreDb>,
  pluginId: string,
  input: SourceInput,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    yield* deleteSourceById(core, input.id, input.scope);

    const now = new Date();
    yield* core.create("source", {
      id: input.id,
      scope_id: input.scope,
      plugin_id: pluginId,
      kind: input.kind,
      name: input.name,
      url: input.url ?? null,
      can_remove: input.canRemove ?? true,
      can_refresh: input.canRefresh ?? false,
      can_edit: input.canEdit ?? false,
      created_at: now,
      updated_at: now,
    });

    const toolsById = new Map<string, (typeof input.tools)[number]>();
    for (const tool of input.tools) {
      toolsById.set(`${input.id}.${tool.name}`, tool);
    }
    const tools = [...toolsById.entries()];

    if (tools.length > 0) {
      yield* core.createMany(
        "tool",
        tools.map(([id, tool]) => ({
          id,
          scope_id: input.scope,
          source_id: input.id,
          plugin_id: pluginId,
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema ?? null,
          output_schema: tool.outputSchema ?? null,
          created_at: now,
          updated_at: now,
        })),
      );
    }
  });

// Delete a source and its tools + definitions at ONE specific scope.
// The helper pins `scope_id = scopeId` so it never widens into a stack-wide
// wipe; a bystander scope's rows with a colliding `source_id` must survive.
const deleteSourceById = (
  core: ReturnType<typeof makeCoreDb>,
  sourceId: string,
  scopeId: string,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    yield* core.deleteMany("tool", {
      where: (b) => b.and(b("source_id", "=", sourceId), b("scope_id", "=", scopeId)),
    });
    yield* core.deleteMany("definition", {
      where: (b) => b.and(b("source_id", "=", sourceId), b("scope_id", "=", scopeId)),
    });
    yield* core.deleteMany("source", {
      where: byScopedId(scopeId, sourceId),
    });
  });

const writeDefinitions = (
  core: ReturnType<typeof makeCoreDb>,
  pluginId: string,
  input: DefinitionsInput,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    // Pin the delete to `input.scope` so an inner-scope writer cannot remove
    // outer-scope definitions for the same source id.
    yield* core.deleteMany("definition", {
      where: (b) => b.and(b("source_id", "=", input.sourceId), b("scope_id", "=", input.scope)),
    });
    const entries = Object.entries(input.definitions);
    if (entries.length === 0) return;
    const now = new Date();
    yield* core.createMany(
      "definition",
      entries.map(([name, schema]) => ({
        id: `${input.sourceId}.${name}`,
        scope_id: input.scope,
        source_id: input.sourceId,
        plugin_id: pluginId,
        name,
        schema: schema as Record<string, unknown>,
        created_at: now,
      })),
    );
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

const approvalArgumentPreview = (args: unknown): string => {
  const text = JSON.stringify(args ?? {}, null, 2) ?? "null";
  return text.length > MAX_APPROVAL_ARGUMENT_PREVIEW_CHARS
    ? `${text.slice(0, MAX_APPROVAL_ARGUMENT_PREVIEW_CHARS)}...`
    : text;
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

export const createExecutor = <const TPlugins extends readonly AnyPlugin[] = readonly []>(
  config: ExecutorConfig<TPlugins>,
): Effect.Effect<Executor<TPlugins>, StorageFailure> =>
  Effect.gen(function* () {
    const defaultPlugins = (): TPlugins => {
      const empty: readonly AnyPlugin[] = [];
      return empty as TPlugins;
    };
    const { scopes, plugins: userPlugins = defaultPlugins() } = config;

    if (scopes.length === 0) {
      return yield* new StorageError({
        message: "createExecutor requires a non-empty scopes array",
        cause: undefined,
      });
    }

    // Built-in core-tools plugin: contributes scopes.list / secrets.list /
    // secrets.create static tools so agents can manage executor primitives
    // without the host wiring it explicitly. Opt-in via `coreTools` config.
    const plugins: readonly AnyPlugin[] = config.coreTools
      ? ([
          coreToolsPlugin({ webBaseUrl: config.coreTools.webBaseUrl }),
          ...userPlugins,
        ] as readonly AnyPlugin[])
      : (userPlugins as readonly AnyPlugin[]);

    const tables = yield* Effect.try({
      try: () => collectTables(plugins),
      catch: (cause) => storageFailureFromUnknown("Failed to collect executor tables", cause),
    });
    const dbInput = yield* Effect.suspend(() => {
      if (!config.db) return Effect.succeed(createDefaultMemoryDb(tables));
      if (typeof config.db !== "function") return Effect.succeed(config.db);
      const out = config.db({ tables });
      return Effect.isEffect(out) ? out : Effect.succeed(out);
    });
    const rootDbUntyped = "db" in dbInput ? dbInput.db : dbInput;
    const closeDb = "db" in dbInput ? dbInput.close : undefined;
    yield* Effect.try({
      try: () => {
        validateExecutorDbTables(tables, rootDbUntyped.internal.tables);
        validateExecutorScopePolicyTables(rootDbUntyped.internal.tables);
      },
      catch: (cause) => storageFailureFromUnknown("Failed to validate executor tables", cause),
    });
    const scopeIds = scopes.map((s) => String(s.id));
    const rootDb = withQueryContext(rootDbUntyped, {
      allowedScopeIds: new Set(scopeIds),
    } satisfies ExecutorScopePolicyContext);
    const fuma = makeFumaClient(rootDb);
    const core = makeCoreDb(fuma);
    const blobs = makeFumaBlobStore(fuma);
    const transaction = <A, E>(effect: Effect.Effect<A, E>) => fuma.transaction(effect);

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
    // should only arrive through explicit scope predicates, but guarding here
    // means a stray row can't silently win).
    const rowScopeId = (row: { readonly scope_id: unknown }) =>
      typeof row.scope_id === "string" ? row.scope_id : null;
    const scopeRank = (row: { readonly scope_id: unknown }) => {
      const scopeId = rowScopeId(row);
      return scopeId === null ? Infinity : (scopePrecedence.get(scopeId) ?? Infinity);
    };

    // Pick the innermost-scope row from a scoped Fuma query. Callers that
    // need one logical row query the whole visible scope stack and resolve
    // shadowing here.
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
      core.findMany("secret", { where: scopedWhere(scopeIds, byId(id)) }) as Effect.Effect<
        readonly SecretRow[],
        StorageFailure
      >;

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
        // Connection-owned token rows are internal plumbing; public secret
        // resolution must not expose them even if a token secret id is leaked.
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
        // Validate the write target before we touch the provider.
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
        // so a personal override never deletes an org-wide secret with
        // the same id.
        const now = new Date();
        yield* core.deleteMany("secret", {
          where: byScopedId(input.scope, input.id),
        });
        yield* core.create("secret", {
          id: input.id,
          scope_id: input.scope,
          name: input.name,
          provider: target.key,
          owned_by_connection_id: null,
          created_at: now,
        });

        return SecretRef.make({
          id: input.id,
          scopeId: input.scope,
          name: input.name,
          provider: target.key,
          createdAt: now,
        });
      });

    // Fan out across every plugin that contributes `usagesForSecret`. Each
    // plugin queries its own normalized columns with explicit scope filters.
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
        const rows = yield* core.findMany("secret", {
          where: scopedWhere(scopeIds, byId(id)),
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
          yield* core.deleteMany("secret", {
            where: byScopedId(targetScope, id),
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
    // Multi-scope: core rows from any scope in the stack show up, each
    // tagged with its own `scope_id`. When the same id appears in multiple scopes, the
    // innermost wins — same rule as `secretsGet`. Provider-enumerated
    // entries don't know what scope they belong to and are attributed
    // to the innermost scope as a display default.
    const secretsList = (): Effect.Effect<readonly SecretRef[], StorageFailure> =>
      Effect.gen(function* () {
        const byId = new Map<string, SecretRef>();

        // Core routing rows first. Resolve collisions using the caller's
        // precedence order (innermost first). Rows owned by a connection
        // are filtered out — the user sees the Connection entry, not its
        // backing token secrets. Their ids go in a deny-set so provider
        // `list()` results for the same id can't leak them back in below.
        const allRows = yield* core.findMany("secret", { where: scopedWhere(scopeIds) });
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
            SecretRef.make({
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
                SecretRef.make({
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
        const allRows = yield* core.findMany("secret", { where: scopedWhere(scopeIds) });
        const coreIds = new Set<string>();
        const refs: SecretRef[] = [];

        for (const row of allRows) {
          coreIds.add(row.id);
          if (row.owned_by_connection_id) continue;
          const hasBackingValue = yield* secretRouteHasBackingValue(row);
          if (!hasBackingValue) continue;
          refs.push(
            SecretRef.make({
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
          scopeId: ref.scopeId,
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
            if (input.providerState !== undefined)
              patch.provider_state = input.providerState ?? null;
            if (input.identityLabel !== undefined)
              patch.identity_label = input.identityLabel ?? null;
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
        return yield* core.findFirst("source", {
          where: (b) =>
            b.and(
              b("plugin_id", "=", input.pluginId),
              b("id", "=", input.sourceId),
              b("scope_id", "=", input.sourceScope),
            ),
        });
      });

    const findSourceOwnerRowAtScope = (input: {
      readonly sourceId: string;
      readonly sourceScope: string;
    }): Effect.Effect<SourceRow | null, StorageFailure> =>
      Effect.gen(function* () {
        if (!scopeIds.includes(input.sourceScope)) return null;
        return yield* core.findFirst("source", {
          where: byScopedId(input.sourceScope, input.sourceId),
        });
      });

    const findSecretRowAtScope = (input: {
      readonly secretId: string;
      readonly scopeId: string;
    }): Effect.Effect<SecretRow | null, StorageFailure> =>
      Effect.gen(function* () {
        if (!scopeIds.includes(input.scopeId)) return null;
        return yield* core.findFirst("secret", {
          where: byScopedId(input.scopeId, input.secretId),
        });
      });

    const findConnectionRowAtScope = (input: {
      readonly connectionId: string;
      readonly scopeId: string;
    }): Effect.Effect<ConnectionRow | null, StorageFailure> =>
      Effect.gen(function* () {
        if (!scopeIds.includes(input.scopeId)) return null;
        return yield* core.findFirst("connection", {
          where: byScopedId(input.scopeId, input.connectionId),
        });
      });

    const credentialBindingRowsForSource = (
      input: CredentialBindingSourceInput,
    ): Effect.Effect<readonly CredentialBindingRow[], StorageFailure> =>
      scopeIds.includes(input.sourceScope)
        ? (core
            .findMany("credential_binding", {
              where: scopedWhere(scopeIds, (b) =>
                b.and(
                  b("plugin_id", "=", input.pluginId),
                  b("source_id", "=", input.sourceId),
                  b("source_scope_id", "=", input.sourceScope),
                ),
              ),
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
            .findMany("credential_binding", {
              where: scopedWhere(scopeIds, (b) =>
                b.and(
                  b("plugin_id", "=", input.pluginId),
                  b("source_id", "=", input.sourceId),
                  b("source_scope_id", "=", input.sourceScope),
                  b("slot_key", "=", input.slotKey),
                ),
              ),
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

    const credentialBindingSet = (input: SetPluginCredentialBindingInput) =>
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
              yield* core.create("secret", {
                id: secretId,
                scope_id: secretScope,
                name,
                provider: key,
                owned_by_connection_id: null,
                created_at: now,
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
        yield* core.deleteMany("credential_binding", {
          where: (b) =>
            b.and(
              b("scope_id", "=", input.targetScope),
              b("plugin_id", "=", input.pluginId),
              b("source_id", "=", input.sourceId),
              b("source_scope_id", "=", input.sourceScope),
              b("slot_key", "=", input.slotKey),
            ),
        });
        yield* core.create("credential_binding", {
          id,
          scope_id: input.targetScope,
          plugin_id: input.pluginId,
          source_id: input.sourceId,
          source_scope_id: input.sourceScope,
          slot_key: input.slotKey,
          kind: input.value.kind,
          text_value: input.value.kind === "text" ? input.value.text : null,
          secret_id: input.value.kind === "secret" ? input.value.secretId : null,
          secret_scope_id:
            input.value.kind === "secret" ? (input.value.secretScopeId ?? input.targetScope) : null,
          connection_id: input.value.kind === "connection" ? input.value.connectionId : null,
          created_at: now,
          updated_at: now,
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

        yield* core.deleteMany("credential_binding", {
          where: (b) =>
            b.and(
              b("scope_id", "=", input.targetScope),
              b("plugin_id", "=", input.pluginId),
              b("source_id", "=", input.sourceId),
              b("source_scope_id", "=", input.sourceScope),
              b("slot_key", "=", input.slotKey),
            ),
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
        const existing = yield* core.findMany("credential_binding", {
          where: (b) =>
            b.and(
              b("scope_id", "=", input.targetScope),
              b("plugin_id", "=", input.pluginId),
              b("source_id", "=", input.sourceId),
              b("source_scope_id", "=", input.sourceScope),
            ),
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
        // are not in the source owner's current stack.
        yield* core.deleteMany("credential_binding", {
          where: (b) =>
            b.and(
              b("plugin_id", "=", input.pluginId),
              b("source_id", "=", input.sourceId),
              b("source_scope_id", "=", input.sourceScope),
            ),
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

    const credentialBindingResolveBinding = (input: CredentialBindingSlotInput) =>
      Effect.gen(function* () {
        const rows = yield* credentialBindingRowsForSlot(input);
        const row = findInnermost(rows);
        return row ? credentialBindingRowToRef(row) : null;
      });

    const credentialBindingResolve = (input: CredentialBindingSlotInput) =>
      Effect.gen(function* () {
        const rows = yield* credentialBindingRowsForSlot(input);
        const row = findInnermost(rows);
        if (!row) {
          return ResolvedCredentialSlot.make({
            pluginId: input.pluginId,
            sourceId: input.sourceId,
            sourceScopeId: input.sourceScope,
            slotKey: input.slotKey,
            bindingScopeId: null,
            kind: null,
            status: "missing" as const,
          });
        }
        return ResolvedCredentialSlot.make({
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
        const sourceRows = yield* core.findMany("source", {
          where: scopedWhere(scopeIds, (b) => b("id", "in", sourceIds)),
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
        return rows.map((row) =>
          Usage.make({
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
        const rows = yield* core.findMany("credential_binding", {
          where: scopedWhere(scopeIds, (b) => b("secret_id", "=", id)),
        });
        return yield* credentialBindingRowsToUsages(rows as readonly CredentialBindingRow[]);
      });

    const credentialBindingUsagesForConnection = (
      id: string,
    ): Effect.Effect<readonly Usage[], StorageFailure> =>
      Effect.gen(function* () {
        const rows = yield* core.findMany("credential_binding", {
          where: scopedWhere(scopeIds, (b) => b("connection_id", "=", id)),
        });
        return yield* credentialBindingRowsToUsages(rows as readonly CredentialBindingRow[]);
      });

    const credentialBindings: CredentialBindingsFacade = {
      listForSource: credentialBindingListForSource,
      resolveBinding: credentialBindingResolveBinding,
      resolve: credentialBindingResolve,
      set: credentialBindingSet,
      remove: credentialBindingRemove,
      replaceForSource: credentialBindingReplaceForSource,
      removeForSource: credentialBindingRemoveForSource,
      usagesForSecret: credentialBindingUsagesForSecret,
      usagesForConnection: credentialBindingUsagesForConnection,
    };

    const credentialBindingInputForSource = (input: SourceCredentialBindingSourceInput) =>
      Effect.gen(function* () {
        const source = yield* findSourceOwnerRowAtScope({
          sourceId: input.source.id,
          sourceScope: input.source.scope,
        });
        return source
          ? ({
              pluginId: source.plugin_id,
              sourceId: input.source.id,
              sourceScope: input.source.scope,
            } satisfies CredentialBindingSourceInput)
          : null;
      });

    const sourceBindingList = (input: SourceCredentialBindingSourceInput) =>
      Effect.gen(function* () {
        const bindingInput = yield* credentialBindingInputForSource(input);
        return bindingInput ? yield* credentialBindingListForSource(bindingInput) : [];
      });

    const sourceBindingResolve = (input: SourceCredentialBindingSlotInput) =>
      Effect.gen(function* () {
        const bindingInput = yield* credentialBindingInputForSource(input);
        return bindingInput
          ? yield* credentialBindingResolveBinding({
              ...bindingInput,
              slotKey: input.slotKey,
            })
          : null;
      });

    const sourceBindingSet = (input: SetSourceCredentialBindingInput) =>
      Effect.gen(function* () {
        const bindingInput = yield* credentialBindingInputForSource(input);
        if (!bindingInput) {
          return yield* new StorageError({
            message:
              `Cannot set credential binding for source "${input.source.id}" ` +
              `at scope "${input.source.scope}": source is not visible.`,
            cause: undefined,
          });
        }
        return yield* credentialBindingSet({
          ...bindingInput,
          targetScope: input.scope,
          slotKey: input.slotKey,
          value: input.value,
        });
      });

    const sourceBindingRemove = (input: RemoveSourceCredentialBindingInput) =>
      Effect.gen(function* () {
        const bindingInput = yield* credentialBindingInputForSource(input);
        if (!bindingInput) {
          return yield* new StorageError({
            message:
              `Cannot remove credential binding for source "${input.source.id}" ` +
              `at scope "${input.source.scope}": source is not visible.`,
            cause: undefined,
          });
        }
        yield* credentialBindingRemove({
          ...bindingInput,
          targetScope: input.scope,
          slotKey: input.slotKey,
        });
      });

    const sourceBindingReplace = (input: ReplaceSourceCredentialBindingsInput) =>
      Effect.gen(function* () {
        const bindingInput = yield* credentialBindingInputForSource(input);
        if (!bindingInput) {
          return yield* new StorageError({
            message:
              `Cannot replace credential bindings for source "${input.source.id}" ` +
              `at scope "${input.source.scope}": source is not visible.`,
            cause: undefined,
          });
        }
        return yield* credentialBindingReplaceForSource({
          ...bindingInput,
          targetScope: input.scope,
          slotPrefixes: input.slotPrefixes,
          bindings: input.bindings,
        });
      });

    const sourceConfigure = (input: {
      readonly source: {
        readonly id: string;
        readonly scope: ScopeId | string;
      };
      readonly scope: ScopeId | string;
      readonly type?: string;
      readonly config: unknown;
    }) =>
      Effect.gen(function* () {
        yield* assertScopeInStack("source configure source scope", input.source.scope);
        yield* assertScopeInStack("source configure target scope", input.scope);

        const source = yield* core.findFirst("source", {
          where: byScopedId(input.source.scope, input.source.id),
        });
        if (!source) {
          return yield* new StorageError({
            message:
              `Cannot configure source "${input.source.id}" at scope ` +
              `"${input.source.scope}": source is not visible.`,
            cause: undefined,
          });
        }

        const runtime = runtimes.get(source.plugin_id);
        const configure = runtime?.plugin.sourceConfigure;
        if (!runtime || !configure) {
          return yield* new StorageError({
            message: `Plugin "${source.plugin_id}" does not support source.configure.`,
            cause: undefined,
          });
        }
        if (input.type !== undefined && input.type !== configure.type) {
          return yield* new StorageError({
            message:
              `Source configure type mismatch for plugin "${source.plugin_id}": ` +
              `expected "${configure.type}", received "${input.type}".`,
            cause: undefined,
          });
        }

        const decoded = yield* decodeConfigureInput(configure.schema, input.config).pipe(
          Effect.mapError((cause) =>
            storageFailureFromUnknown(
              `Invalid source.configure payload for ${configure.type}`,
              cause,
            ),
          ),
        );

        return yield* configure
          .configure({
            ctx: runtime.ctx,
            sourceId: input.source.id,
            sourceScope: input.source.scope,
            targetScope: input.scope,
            config: decoded,
          })
          .pipe(
            Effect.mapError((cause) =>
              pluginStorageFailure(source.plugin_id, "sourceConfigure", cause),
            ),
          );
      });

    const oauthBundle = makeOAuth2Service({
      fuma,
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
      connectionsGet: (id) => connectionsGet(id),
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

      const pluginFuma = makeFumaClient(
        rootDb,
        plugin.schema ? { tables: new Set(Object.keys(plugin.schema)) } : { tables: new Set() },
      );
      const pluginStorage = makePluginStorageFacade({
        core,
        pluginId: plugin.id,
        scopeIds,
      });
      const storageDeps: StorageDeps = {
        scopes,
        fuma: pluginFuma,
        // Blob keys are namespaced by `<scope>/<plugin>` so two tenants
        // sharing a backing BlobStore can't collide or leak on the
        // same `(plugin, key)` pair. The store's `get`/`has` walk the
        // scope stack (innermost first); `put`/`delete` require the
        // plugin to name a target scope explicitly.
        blobs: pluginBlobStore(blobs, scopeIds, plugin.id),
        pluginStorage,
      };
      const storage = plugin.storage(storageDeps);

      const ctx: PluginCtx<unknown> = {
        scopes,
        storage,
        pluginStorage,
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
                yield* transaction(writeSourceInput(core, plugin.id, input));
              }),
            unregister: (input: RemoveSourceInput) =>
              // `unregister` is scoped to a caller-named source row. The
              // plugin already knows which source owner it is updating,
              // so the core path must not infer an innermost target.
              transaction(
                Effect.gen(function* () {
                  yield* assertScopeInStack("source unregister targetScope", input.targetScope);
                  const row = yield* core.findFirst("source", {
                    where: byScopedId(input.targetScope, input.id),
                  });
                  if (!row) return;
                  yield* deleteSourceById(core, input.id, input.targetScope);
                }),
              ),
            update: (input) =>
              core
                .updateMany("source", {
                  where: byScopedId(input.scope, input.id),
                  set: {
                    ...(input.name !== undefined ? { name: input.name } : {}),
                    ...(input.url !== undefined ? { url: input.url ?? null } : {}),
                    updated_at: new Date(),
                  },
                })
                .pipe(Effect.asVoid),
            list: () => listSources(),
            remove: (input) => removeSource(input),
            refresh: (input) => refreshSource(input),
            detect: (url) => detectSource(url),
            configure: (input) => sourceConfigure(input),
            listBindings: (input) => sourceBindingList(input),
            resolveBinding: (input) => sourceBindingResolve(input),
            setBinding: (input) => sourceBindingSet(input),
            removeBinding: (input) => sourceBindingRemove(input),
            configureSchemas: () =>
              Array.from(runtimes.values())
                .map(({ plugin }) =>
                  plugin.sourceConfigure
                    ? sourceConfigureSchemaView(plugin.id, plugin.sourceConfigure)
                    : undefined,
                )
                .filter(Predicate.isNotUndefined),
            presets: () =>
              Array.from(runtimes.values()).flatMap(({ plugin }) =>
                (plugin.sourcePresets ?? []).map((preset) => ({
                  ...preset,
                  pluginId: plugin.id,
                })),
              ),
          },
          policies: {
            list: () => policiesList(),
            create: (input) => policiesCreate(input),
            update: (input) => policiesUpdate(input),
            remove: (input) => policiesRemove(input),
          },
          definitions: {
            register: (input: DefinitionsInput) =>
              transaction(writeDefinitions(core, plugin.id, input)),
          },
        },
        secrets: {
          get: (id) => secretsGet(id),
          getAtScope: (id, scope) => secretsGetAtScope(id, scope),
          list: () => secretsListForCtx(),
          status: (id) => secretsStatus(id),
          usages: (id) => secretsUsages(id),
          providers: () =>
            Effect.sync(() => Array.from(secretProviders.keys()) as readonly string[]),
          set: (input) => secretsSet(input),
          remove: (input) => secretsRemove(input),
        },
        connections: {
          get: (id) => connectionsGet(id),
          getAtScope: (id, scope) => connectionsGetAtScope(id, scope),
          list: () => connectionsListForCtx(),
          usages: (id) => connectionsUsages(id),
          providers: () =>
            Effect.sync(() => Array.from(connectionProviders.keys()) as readonly string[]),
          create: (input) => connectionsCreate(input),
          updateTokens: (input) => connectionsUpdateTokens(input),
          setIdentityLabel: (id, label) => connectionsSetIdentityLabel(id, label),
          accessToken: (id) => connectionsAccessToken(id),
          accessTokenAtScope: (id, scope) => connectionsAccessTokenAtScope(id, scope),
          remove: (input) => connectionsRemove(input),
        },
        credentialBindings,
        oauth: oauthBundle.service,
        transaction: <A, E>(effect: Effect.Effect<A, E>) => transaction(effect),
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
      // Plugin-owned executor tools are intentionally mounted under the
      // single `executor` namespace so source inventory is about configured
      // integrations, not plugin management surfaces. The static source id
      // becomes the path segment, so plugins can expose TypeScript-friendly
      // management namespaces without changing their persisted plugin ids:
      //   openapi.addSource -> executor.openapi.addSource
      //   googleDiscovery.addSource -> executor.googleDiscovery.addSource
      const decls = plugin.staticSources ? plugin.staticSources(extension) : [];
      for (const source of decls) {
        const mountUnderExecutor = source.kind === "executor";
        const mountedSource = mountUnderExecutor ? EXECUTOR_SOURCE : source;

        if (mountUnderExecutor) {
          if (!staticSources.has(EXECUTOR_SOURCE_ID)) {
            staticSources.set(EXECUTOR_SOURCE_ID, {
              source: EXECUTOR_SOURCE,
              pluginId: EXECUTOR_SOURCE_ID,
            });
          }
        } else {
          if (staticSources.has(source.id)) {
            return yield* new StorageError({
              message: `Duplicate static source id: ${source.id} (plugin ${plugin.id})`,
              cause: undefined,
            });
          }
          staticSources.set(source.id, { source, pluginId: plugin.id });
        }

        for (const tool of source.tools) {
          const mountedTool = mountUnderExecutor
            ? {
                ...tool,
                name: `${source.id}.${tool.name}`,
              }
            : tool;
          const fqid = `${mountedSource.id}.${mountedTool.name}`;
          if (staticTools.has(fqid)) {
            return yield* new StorageError({
              message: `Duplicate static tool id: ${fqid} (plugin ${plugin.id})`,
              cause: undefined,
            });
          }
          staticTools.set(fqid, {
            source: mountedSource,
            tool: mountedTool,
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
        const providers = Effect.isEffect(raw)
          ? yield* raw.pipe(
              Effect.mapError((cause) => pluginStorageFailure(plugin.id, "secretProviders", cause)),
            )
          : raw;
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
        const providers = Effect.isEffect(raw)
          ? yield* raw.pipe(
              Effect.mapError((cause) =>
                pluginStorageFailure(plugin.id, "connectionProviders", cause),
              ),
            )
          : raw;
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
        const dynamic = yield* core.findMany("source", { where: scopedWhere(scopeIds) });
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
              return yield* runtime.plugin
                .resolveAnnotations({
                  ctx: runtime.ctx,
                  sourceId,
                  toolRows: groupRows,
                })
                .pipe(
                  Effect.mapError((cause) =>
                    pluginStorageFailure(pluginId, "resolveAnnotations", cause),
                  ),
                );
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
        const dynamic = yield* core.findMany("tool", {
          where: scopedWhere(
            scopeIds,
            filter?.sourceId ? (b) => b("source_id", "=", filter.sourceId!) : undefined,
          ),
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
        const defRows = yield* core.findMany("definition", {
          where: scopedWhere(scopeIds, (b) => b("source_id", "=", sourceId)),
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

    // Render the ToolSchema view for a tool. Raw JSON schema roots stay small,
    // while source-level definitions are returned once for the UI schema
    // explorer and passed separately to the TypeScript preview compiler.
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

        const sourceDefsMap = new Map<string, unknown>(Object.entries(defs));
        const schemaDefinitions = collectReferencedDefinitions(
          [opts.rawInput, opts.rawOutput],
          sourceDefsMap,
        );
        const schemaDefsMap = new Map<string, unknown>(Object.entries(schemaDefinitions));
        const preview: ToolTypeScriptPreview = yield* Effect.promise(() =>
          buildToolTypeScriptPreview({
            inputSchema: opts.rawInput,
            outputSchema: opts.rawOutput,
            defs: schemaDefsMap,
          }),
        ).pipe(
          Effect.withSpan("schema.compile.preview", {
            attributes: {
              "schema.kind": "tool.preview",
              "schema.has_input": opts.rawInput !== undefined,
              "schema.has_output": opts.rawOutput !== undefined,
              "schema.def_count": schemaDefsMap.size,
              "schema.source_def_count": sourceDefsMap.size,
            },
          }),
        );

        return ToolSchema.make({
          id: ToolId.make(opts.toolId),
          name: opts.name,
          description: opts.description,
          inputSchema: opts.rawInput,
          outputSchema: opts.rawOutput,
          schemaDefinitions:
            Object.keys(schemaDefinitions).length > 0 ? schemaDefinitions : undefined,
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
            rawInput: toToolJsonSchema(staticEntry.tool.inputSchema),
            rawOutput: toToolJsonSchema(staticEntry.tool.outputSchema, "output"),
          });
        }
        // Innermost-wins lookup across every visible scope.
        const rows = yield* core
          .findMany("tool", {
            where: scopedWhere(scopeIds, byId(toolId)),
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
        const rows = yield* core.findMany("definition", { where: scopedWhere(scopeIds) });
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

    const loadAllPolicies = () => core.findMany("tool_policy", { where: scopedWhere(scopeIds) });

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
        const request = FormElicitation.make({
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
        const wrapInvocationError =
          (resolvedToolId: string) =>
          <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, ToolInvocationError> =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ToolInvocationError({
                    toolId: ToolId.make(resolvedToolId),
                    message: formatInvocationCauseMessage(cause),
                    cause,
                  }),
              ),
            );

        // Static path — O(1) map lookup, no DB hit.
        const staticEntry = staticTools.get(toolId);
        if (staticEntry) {
          // Resolve the user-authored policy before static plugin code
          // runs. Dynamic tools resolve policy after canonicalizing the
          // stored tool id so casing aliases cannot bypass rules.
          const policy = yield* resolveToolPolicyForId(toolId).pipe(
            Effect.withSpan("executor.tool.resolve_policy"),
          );
          if (policy?.action === "block") {
            return yield* new ToolBlockedError({
              toolId: ToolId.make(toolId),
              pattern: policy.pattern,
            });
          }
          yield* Effect.annotateCurrentSpan({
            "executor.tool.dispatch_path": "static",
            "executor.source_id": staticEntry.source.id,
            "executor.source_kind": staticEntry.source.kind,
            "executor.plugin_id": staticEntry.pluginId,
          });
          yield* enforceApproval(staticEntry.tool.annotations, toolId, args, policy, handler).pipe(
            Effect.withSpan("executor.tool.enforce_approval"),
          );
          return yield* wrapInvocationError(toolId)(
            staticEntry.tool.handler({
              ctx: staticEntry.ctx,
              args,
              elicit: buildElicit(toolId, args, handler),
            }),
          ).pipe(Effect.withSpan("executor.tool.handler"));
        }

        // Dynamic path — DB lookup + delegate to owning plugin. Walk the
        // whole scope stack and pick the innermost-scope row so a user's
        // shadow of an outer tool actually wins on invoke.
        let toolRows = yield* core
          .findMany("tool", {
            where: scopedWhere(scopeIds, byId(toolId)),
          })
          .pipe(Effect.withSpan("executor.tool.resolve"));
        let row = findInnermost(toolRows);
        let resolvedToolId = toolId;
        let suggestionRows: readonly CoreRow<"tool">[] = toolRows;
        if (!row) {
          suggestionRows = yield* core
            .findMany("tool", {
              where: scopedWhere(scopeIds),
            })
            .pipe(Effect.withSpan("executor.tool.resolve_suggestions"));
          const sourceId = toolSourceId(toolId);
          if (sourceId) {
            const normalizedToolId = toolId.toLowerCase();
            row = findInnermost(
              suggestionRows.filter(
                (toolRow) =>
                  toolRow.source_id === sourceId && toolRow.id.toLowerCase() === normalizedToolId,
              ),
            );
            if (row) resolvedToolId = row.id;
          }
        }
        if (!row) {
          return yield* new ToolNotFoundError({
            toolId: ToolId.make(toolId),
            suggestions: missingToolSuggestions(toolId, suggestionRows),
          });
        }
        yield* Effect.annotateCurrentSpan({
          "executor.tool.dispatch_path": "dynamic",
          "executor.source_id": row.source_id,
          "executor.plugin_id": row.plugin_id,
          "executor.tool.resolved_id": resolvedToolId,
        });
        const policy = yield* resolveToolPolicyForId(resolvedToolId).pipe(
          Effect.withSpan("executor.tool.resolve_policy"),
        );
        if (policy?.action === "block") {
          return yield* new ToolBlockedError({
            toolId: ToolId.make(resolvedToolId),
            pattern: policy.pattern,
          });
        }
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
            .pipe(wrapInvocationError(resolvedToolId))
            .pipe(Effect.withSpan("executor.tool.resolve_annotations"));
          annotations = map[resolvedToolId];
        }
        yield* enforceApproval(annotations, resolvedToolId, args, policy, handler).pipe(
          Effect.withSpan("executor.tool.enforce_approval"),
        );

        return yield* wrapInvocationError(resolvedToolId)(
          runtime.plugin.invokeTool({
            ctx: runtime.ctx,
            toolRow: row,
            args,
            elicit: buildElicit(resolvedToolId, args, handler),
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
        const sourceRow = yield* core.findFirst("source", {
          where: byScopedId(input.targetScope, sourceId),
        });
        if (!sourceRow) return;
        if (!sourceRow.can_remove) {
          return yield* new SourceRemovalNotAllowedError({ sourceId });
        }
        const runtime = runtimes.get(sourceRow.plugin_id);
        // Group the plugin's own cleanup + the core row delete into one
        // Fuma transaction so removeSource never leaves orphan rows on failure.
        yield* transaction(
          Effect.gen(function* () {
            if (runtime?.plugin.removeSource) {
              yield* runtime.plugin
                .removeSource({
                  ctx: runtime.ctx,
                  sourceId,
                  scope: input.targetScope,
                })
                .pipe(
                  Effect.mapError((cause) =>
                    pluginStorageFailure(runtime.plugin.id, "removeSource", cause),
                  ),
                );
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
        const sourceRow = yield* core.findFirst("source", {
          where: byScopedId(input.targetScope, sourceId),
        });
        if (!sourceRow) return;
        const runtime = runtimes.get(sourceRow.plugin_id);
        if (runtime?.plugin.refreshSource) {
          yield* runtime.plugin
            .refreshSource({
              ctx: runtime.ctx,
              sourceId,
              scope: input.targetScope,
            })
            .pipe(
              Effect.mapError((cause) =>
                pluginStorageFailure(runtime.plugin.id, "refreshSource", cause),
              ),
            );
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
    const detectionConfidenceScore = (confidence: SourceDetectionResult["confidence"]) =>
      Match.value(confidence).pipe(
        Match.when("high", () => 3),
        Match.when("medium", () => 2),
        Match.when("low", () => 1),
        Match.exhaustive,
      );

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
        yield* assertScopeInStack("tool policy targetScope", input.targetScope);
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
          const existing = yield* core.findMany("tool_policy", {
            where: (b) => b("scope_id", "=", input.targetScope),
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
        yield* core.create("tool_policy", {
          id,
          scope_id: input.targetScope,
          pattern: input.pattern,
          action: input.action,
          position,
          created_at: now,
          updated_at: now,
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
        yield* assertScopeInStack("tool policy targetScope", input.targetScope);
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

        const rows = yield* core.findMany("tool_policy", {
          where: byScopedId(input.targetScope, input.id),
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
        yield* core.updateMany("tool_policy", {
          where: byScopedId(input.targetScope, input.id),
          set: {
            pattern: updated.pattern,
            action: updated.action,
            position: updated.position,
            updated_at: updated.updated_at,
          },
        });
        return rowToToolPolicy(updated);
      }).pipe(Effect.withSpan("executor.policies.update"));

    const policiesRemove = (input: RemoveToolPolicyInput) =>
      Effect.gen(function* () {
        yield* assertScopeInStack("tool policy targetScope", input.targetScope);
        yield* core.deleteMany("tool_policy", {
          where: byScopedId(input.targetScope, input.id),
        });
      }).pipe(Effect.withSpan("executor.policies.remove"));

    const policiesResolve = (toolId: string) =>
      resolveToolPolicyForId(toolId).pipe(Effect.withSpan("executor.policies.resolve"));

    const close = () =>
      Effect.gen(function* () {
        for (const runtime of runtimes.values()) {
          if (runtime.plugin.close) {
            yield* runtime.plugin
              .close()
              .pipe(
                Effect.mapError((cause) => pluginStorageFailure(runtime.plugin.id, "close", cause)),
              );
          }
        }
        if (closeDb) {
          const out = closeDb();
          if (Effect.isEffect(out)) {
            yield* out;
          } else if (out instanceof Promise) {
            yield* Effect.tryPromise({
              try: () => out,
              catch: (cause) =>
                new StorageError({
                  message: "Executor database close failed",
                  cause,
                }),
            });
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
        configure: sourceConfigure,
        listBindings: sourceBindingList,
        resolveBinding: sourceBindingResolve,
        setBinding: sourceBindingSet,
        removeBinding: sourceBindingRemove,
        replaceBindings: sourceBindingReplace,
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

    // Plugin extension keys are known from the generic plugin tuple,
    // while runtime registration builds the same shape dynamically.
    const toExecutor = (value: unknown): Executor<TPlugins> => value as Executor<TPlugins>;
    return toExecutor(Object.assign(base, extensions));
  });
