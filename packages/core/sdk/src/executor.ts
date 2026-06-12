import { Effect, Inspectable, Layer, Option, Predicate, Schema } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { fumadb } from "@executor-js/fumadb";
import { memoryAdapter } from "@executor-js/fumadb/adapters/memory";
import { withQueryContext, type Condition, type ConditionBuilder } from "@executor-js/fumadb/query";
import { schema as fumaSchema, type RelationsMap } from "@executor-js/fumadb/schema";
import type { AnyColumn } from "@executor-js/fumadb/schema";
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
import { makeFumaBlobStore, pluginBlobStore, type BlobStore, type OwnerPartitions } from "./blob";
import { coreToolsPlugin } from "./core-tools";
import type {
  Connection,
  ConnectionInputOrigin,
  ConnectionRef,
  CreateConnectionInput,
  ConnectionValueInput,
} from "./connection";
import {
  coreSchema,
  isToolPolicyAction,
  TOOL_INVOCATION_COLUMNS,
  type ConnectionRow,
  type CoreSchema,
  type IntegrationRow,
  type OAuthClientRow,
  type ToolInvocationRow,
  type ToolRow,
  type ToolPolicyRow,
} from "./core-schema";
import {
  ElicitationDeclinedError,
  ElicitationResponse,
  FormElicitation,
  type ElicitationHandler,
  type ElicitationRequest,
  type OnElicitation,
  type InvokeOptions,
} from "./elicitation";

export type { OnElicitation, InvokeOptions } from "./elicitation";
import {
  ConnectionNotFoundError,
  CredentialProviderNotRegisteredError,
  CredentialResolutionError,
  IntegrationNotFoundError,
  InvalidConnectionInputError,
  IntegrationRemovalNotAllowedError,
  NoHandlerError,
  PluginNotLoadedError,
  ToolBlockedError,
  ToolInvocationError,
  ToolNotFoundError,
  type ExecuteError,
} from "./errors";
import {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
  NO_AUTH_TEMPLATE,
  OAuthClientSlug,
  Owner,
  PolicyId,
  ProviderItemId,
  ProviderKey,
  Subject,
  Tenant,
  ToolAddress,
  ToolName,
} from "./ids";
import type {
  AuthMethodDescriptor,
  Integration,
  IntegrationConfig,
  RegisterIntegrationInput,
} from "./integration";
import { makeOAuthService, type MintOAuthConnectionInput } from "./oauth-service";
import type { OAuthService } from "./oauth-client";
import {
  comparePolicyRow,
  isValidPattern,
  resolveEffectivePolicy,
  rowToToolPolicy,
  type CreateToolPolicyInput,
  type EffectivePolicy,
  type RemoveToolPolicyInput,
  type ToolPolicy,
  type UpdateToolPolicyInput,
} from "./policies";
import type { CredentialProvider, ProviderEntry } from "./provider";
import type {
  AnyPlugin,
  Elicit,
  IntegrationConfigureSchema,
  IntegrationPresetCatalogEntry,
  IntegrationRecord,
  OwnerBinding,
  PluginCtx,
  PluginExtensions,
  ResolveToolsResult,
  StaticSourceDecl,
  StaticToolDecl,
  StorageDeps,
  ToolInvocationCredential,
} from "./plugin";
import {
  pluginStorageId,
  type PluginStorageCollectionData,
  type PluginStorageCollectionDefinition,
  type PluginStorageCollectionQueryInput,
  type PluginStorageEntry,
  type PluginStorageFacade,
  type PluginStorageRuntimeCollectionDefinition,
  type PluginStorageRuntimeIndexSpec,
} from "./plugin-storage";
import {
  assertExecutorOwnerPolicyTable,
  ORG_SUBJECT,
  type ExecutorOwnerPolicyContext,
} from "./owner-policy";
import { ToolSchemaView, type IntegrationDetectionResult } from "./types";
import { type Tool, type ToolAnnotations, type ToolDef, type ToolListFilter } from "./tool";
import { buildToolTypeScriptPreview } from "./schema-types";
import { collectReferencedDefinitions } from "./schema-refs";
import {
  refreshAccessToken,
  exchangeClientCredentials,
  shouldRefreshToken,
  type OAuthEndpointUrlPolicy,
} from "./oauth-helpers";
import { connectionIdentifier } from "./connection-name-identifier";
import { annotateToolResultOutcome } from "./tool-result";

const PLUGIN_STORAGE_DELETE_KEY_BATCH_SIZE = 90;
const MAX_APPROVAL_ARGUMENT_PREVIEW_CHARS = 4_000;

// ---------------------------------------------------------------------------
// Elicitation handler — resolved once at `createExecutor({ onElicitation })`
// and overridable per `execute`. A tool that requests user input mid-execution
// suspends the fiber and the handler decides how to respond. The "accept-all"
// sentinel auto-accepts (tests / non-interactive hosts).
// ---------------------------------------------------------------------------

const acceptAllHandler: ElicitationHandler = () =>
  Effect.succeed(ElicitationResponse.make({ action: "accept" }));

const resolveElicitationHandler = (onElicitation: OnElicitation): ElicitationHandler =>
  onElicitation === "accept-all" ? acceptAllHandler : onElicitation;

// ---------------------------------------------------------------------------
// Address scheme — `tools.<integration>.<owner>.<connection>.<tool>`.
// ---------------------------------------------------------------------------

const ADDRESS_PREFIX = "tools";

export interface ParsedToolAddress {
  readonly integration: IntegrationSlug;
  readonly owner: Owner;
  readonly connection: ConnectionName;
  readonly tool: ToolName;
}

const isOwner = (value: string): value is Owner => value === "org" || value === "user";

/** Parse a callable address; null when it's not a well-formed
 *  `tools.<integration>.<owner>.<connection>.<tool>`.
 *
 *  The four leading segments (prefix, integration, owner, connection) are
 *  slug-like and never contain a `.`; the `<tool>` segment is the *entire*
 *  remainder after the 4th dot, so it may itself contain dots. That lets a tool
 *  whose name is a structured `group.leaf` path (e.g. an OpenAPI
 *  `aliases.deleteAlias`) address naturally as
 *  `tools.<integration>.<owner>.<connection>.aliases.deleteAlias` — the same
 *  dotted nesting the sandbox `tools` proxy produces from property access. */
export const parseToolAddress = (address: string): ParsedToolAddress | null => {
  // Walk to the 4th dot; everything past it is the tool (dots and all).
  let cut = -1;
  for (let i = 0; i < 4; i++) {
    cut = address.indexOf(".", cut + 1);
    if (cut === -1) return null;
  }
  const [prefix, integration, owner, connection] = address.slice(0, cut).split(".") as [
    string,
    string,
    string,
    string,
  ];
  const tool = address.slice(cut + 1);
  if (prefix !== ADDRESS_PREFIX) return null;
  if (!isOwner(owner)) return null;
  if (integration.length === 0 || connection.length === 0 || tool.length === 0) {
    return null;
  }
  return {
    integration: IntegrationSlug.make(integration),
    owner,
    connection: ConnectionName.make(connection),
    tool: ToolName.make(tool),
  };
};

export const connectionAddress = (
  owner: Owner,
  integration: IntegrationSlug,
  connection: ConnectionName,
): ConnectionAddress =>
  ConnectionAddress.make(`${ADDRESS_PREFIX}.${integration}.${owner}.${connection}`);

export const toolAddress = (
  owner: Owner,
  integration: IntegrationSlug,
  connection: ConnectionName,
  tool: ToolName,
): ToolAddress =>
  ToolAddress.make(`${ADDRESS_PREFIX}.${integration}.${owner}.${connection}.${tool}`);

// ---------------------------------------------------------------------------
// Owner key helpers — every owned-row write stamps `tenant`, `owner`,
// `subject` (org → subject="").
// ---------------------------------------------------------------------------

interface OwnedKeys {
  readonly tenant: string;
  readonly owner: Owner;
  readonly subject: string;
}

// ---------------------------------------------------------------------------
// Executor — public surface. Every list/execute/schema call is a direct
// core-table query unioned with the in-memory static pool.
// ---------------------------------------------------------------------------

export type Executor<TPlugins extends readonly AnyPlugin[] = readonly []> = {
  readonly integrations: {
    readonly list: () => Effect.Effect<readonly Integration[], StorageFailure>;
    readonly get: (slug: IntegrationSlug) => Effect.Effect<Integration | null, StorageFailure>;
    readonly update: (
      slug: IntegrationSlug,
      patch: { readonly description?: string },
    ) => Effect.Effect<void, IntegrationNotFoundError | StorageFailure>;
    readonly remove: (
      slug: IntegrationSlug,
    ) => Effect.Effect<void, IntegrationRemovalNotAllowedError | StorageFailure>;
    readonly detect: (
      url: string,
    ) => Effect.Effect<readonly IntegrationDetectionResult[], StorageFailure>;
  };

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
    readonly remove: (
      ref: ConnectionRef,
    ) => Effect.Effect<void, ConnectionNotFoundError | StorageFailure>;
    readonly refresh: (
      ref: ConnectionRef,
    ) => Effect.Effect<
      readonly Tool[],
      ConnectionNotFoundError | IntegrationNotFoundError | StorageFailure
    >;
  };

  /** Shared OAuth service. Hosts use this through the core HTTP OAuth group;
   *  plugins see the same service as `ctx.oauth`. */
  readonly oauth: OAuthService;

  readonly tools: {
    readonly list: (filter?: ToolListFilter) => Effect.Effect<readonly Tool[], StorageFailure>;
    readonly schema: (address: ToolAddress) => Effect.Effect<ToolSchemaView | null, StorageFailure>;
  };

  readonly providers: {
    readonly list: () => Effect.Effect<readonly ProviderKey[]>;
    readonly items: (key: ProviderKey) => Effect.Effect<readonly ProviderEntry[], StorageFailure>;
  };

  readonly policies: {
    readonly list: () => Effect.Effect<readonly ToolPolicy[], StorageFailure>;
    readonly create: (input: CreateToolPolicyInput) => Effect.Effect<ToolPolicy, StorageFailure>;
    readonly update: (input: UpdateToolPolicyInput) => Effect.Effect<ToolPolicy, StorageFailure>;
    readonly remove: (input: RemoveToolPolicyInput) => Effect.Effect<void, StorageFailure>;
    readonly resolve: (address: ToolAddress) => Effect.Effect<EffectivePolicy, StorageFailure>;
  };

  readonly execute: (
    address: ToolAddress,
    args: unknown,
    options?: InvokeOptions,
  ) => Effect.Effect<unknown, ExecuteError>;

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
  /** The org / workspace this executor is bound to. `owner: "org"` rows file
   *  here. */
  readonly tenant: Tenant;
  /** The acting member, or omit for a pure-org executor (no `owner:"user"`). */
  readonly subject?: Subject;
  readonly db?: ExecutorDbInput | ExecutorDbFactory;
  /**
   * Backend for the plugin blob seam (`StorageDeps.blobs`). Defaults to the
   * FumaDB `blob` table over `db`. Hosts with an object store hand one in
   * (e.g. the R2 store in `@executor-js/cloudflare/blob-store`) so multi-MB
   * values stay out of the relational tier.
   */
  readonly blobs?: BlobStore;
  readonly plugins?: TPlugins;
  /** Config-level credential providers, merged with every
   *  `plugin.credentialProviders`. Config providers register first, so the
   *  default (first writable) store is selected from them when present. */
  readonly providers?: readonly CredentialProvider[];
  /**
   * How to respond when a tool requests user input mid-invocation. Pass
   * `"accept-all"` for tests / non-interactive hosts, or a handler.
   */
  readonly onElicitation: OnElicitation;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  /**
   * The OAuth callback URL (`${webBaseUrl}/oauth/callback`) the host serves and
   * sends to providers. There is NO localhost default: omit it (or pass
   * undefined) only for executors that never run interactive OAuth — the
   * redirect-requiring flows then fail loudly instead of guessing a callback.
   * Hosts serving OAuth derive this from the request origin / web base URL.
   */
  readonly redirectUri?: string;
  readonly oauthEndpointUrlPolicy?: OAuthEndpointUrlPolicy;
  /**
   * Enable the built-in `core-tools` plugin which contributes agent-facing
   * static tools over the v2 surface (integrations / connections / policies).
   */
  readonly coreTools?: {
    readonly webBaseUrl?: string;
    readonly includeProviders?: boolean;
  };
}

// ---------------------------------------------------------------------------
// collectTables — return the executor-owned Fuma table set. Plugins persist
// through host-owned facades (`pluginStorage`, `blobs`) instead of contributing
// table definitions, so the schema is fixed and plugin-independent.
// ---------------------------------------------------------------------------

export const collectTables = (): FumaTables => {
  validateExecutorOwnerPolicyTables(coreSchema);
  return { ...coreSchema };
};

const validateExecutorOwnerPolicyTables = (tables: FumaTables): void => {
  for (const [tableKey, tableDef] of Object.entries(tables)) {
    assertExecutorOwnerPolicyTable(tableDef, tableKey);
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

  // oxlint-disable-next-line executor/no-double-cast -- boundary: fumadb's generic ORM client type doesn't structurally match the FumaDb facade
  const db = factory.client(memoryAdapter()).orm(version) as unknown as FumaDb;
  return { db };
};

// ---------------------------------------------------------------------------
// JSON helpers + row → public projection conversions
// ---------------------------------------------------------------------------

const decodeJsonFromString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

const decodeJsonColumn = (value: unknown): unknown => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return value;
  return decodeJsonFromString(value).pipe(Option.getOrElse(() => value));
};

const rowToIntegration = (
  row: IntegrationRow,
  authMethods: readonly AuthMethodDescriptor[] = [],
  displayUrl?: string,
): Integration => ({
  slug: IntegrationSlug.make(row.slug),
  description: row.description,
  kind: row.plugin_id,
  canRemove: Boolean(row.can_remove),
  canRefresh: Boolean(row.can_refresh),
  authMethods,
  ...(displayUrl ? { displayUrl } : {}),
});

const rowToIntegrationRecord = (
  row: IntegrationRow,
  authMethods: readonly AuthMethodDescriptor[] = [],
): IntegrationRecord => ({
  ...rowToIntegration(row, authMethods),
  config: decodeJsonColumn(row.config),
});

const rowToConnection = (row: ConnectionRow): Connection => {
  const owner = row.owner as Owner;
  const integration = IntegrationSlug.make(row.integration);
  const name = ConnectionName.make(row.name);
  return {
    owner,
    name,
    integration,
    template: AuthTemplateSlug.make(row.template),
    provider: ProviderKey.make(row.provider),
    address: connectionAddress(owner, integration, name),
    identityLabel: row.identity_label ?? null,
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    oauthClient: row.oauth_client == null ? null : OAuthClientSlug.make(String(row.oauth_client)),
    oauthClientOwner:
      row.oauth_client_owner == null ? null : (String(row.oauth_client_owner) as Owner),
    oauthScope: row.oauth_scope == null ? null : String(row.oauth_scope),
  };
};

/** The canonical credential variable for a single-secret connection. OAuth tokens
 *  and the primary apiKey value resolve through it. */
const PRIMARY_INPUT_VARIABLE = "token";

interface NormalizedConnectionInput {
  readonly variable: string;
  readonly origin: ConnectionInputOrigin;
}

/** Flatten any `ConnectionValueInput` form (single `value`/`from` sugar, pasted
 *  `values` map, or the canonical per-variable `inputs` map) into a uniform list
 *  of named origins. */
const normalizeConnectionInputs = (
  input: ConnectionValueInput,
): readonly NormalizedConnectionInput[] => {
  if ("inputs" in input) {
    return Object.entries(input.inputs).map(([variable, origin]) => ({ variable, origin }));
  }
  if ("values" in input) {
    return Object.entries(input.values).map(([variable, value]) => ({
      variable,
      origin: { value },
    }));
  }
  if ("from" in input) {
    return [{ variable: PRIMARY_INPUT_VARIABLE, origin: { from: input.from } }];
  }
  return [{ variable: PRIMARY_INPUT_VARIABLE, origin: { value: input.value } }];
};

/** Decode a connection row's `item_ids` JSON map (`variable → provider item id`).
 *  Tolerates the historically-single shape by returning `{}` for anything that
 *  isn't an object. */
const connectionItemIds = (row: ConnectionRow): Record<string, string> => {
  const decoded = decodeJsonColumn(row.item_ids);
  if (decoded == null || typeof decoded !== "object") return {};
  return decoded as Record<string, string>;
};

// Accepts a projected row (the invoke/list paths select away the heavy
// schema columns); `Tool.inputSchema`/`outputSchema` are optional and stay
// absent for those callers — `tools.schema` is the schema-bearing surface.
const rowToTool = (
  row: ToolInvocationRow & Partial<Pick<ToolRow, "input_schema" | "output_schema">>,
  annotations?: ToolAnnotations,
): Tool => {
  const owner = row.owner as Owner;
  const integration = IntegrationSlug.make(row.integration);
  const connection = ConnectionName.make(row.connection);
  const name = ToolName.make(row.name);
  return {
    address: toolAddress(owner, integration, connection, name),
    owner,
    integration,
    connection,
    name,
    pluginId: row.plugin_id,
    description: row.description,
    inputSchema: decodeJsonColumn(row.input_schema),
    outputSchema: decodeJsonColumn(row.output_schema),
    annotations: annotations ?? (decodeJsonColumn(row.annotations) as ToolAnnotations | undefined),
  };
};

// ---------------------------------------------------------------------------
// Condition builders
// ---------------------------------------------------------------------------

type AnyCb = ConditionBuilder<Record<string, AnyColumn>>;
type CoreTableName = keyof CoreSchema & string;
type CoreRow<TName extends CoreTableName> = FumaRow<CoreSchema[TName]>;
type CoreColumn<TName extends CoreTableName> = keyof CoreRow<TName> & string;
type CoreWhere = (b: AnyCb) => Condition | boolean;
type CoreFindManyOptions<TName extends CoreTableName = CoreTableName> = {
  readonly where?: CoreWhere;
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?:
    | readonly [string, "asc" | "desc"]
    | readonly (readonly [string, "asc" | "desc"])[];
  /** Column projection (fumadb `select`). Omit for all columns. Use on hot
   *  paths whose rows carry heavy JSON columns the caller discards — e.g. a
   *  tool row is ~KBs of schemas but invoke routing needs only the names. */
  readonly select?: readonly CoreColumn<TName>[];
};
type CoreFindFirstOptions<TName extends CoreTableName = CoreTableName> = Omit<
  CoreFindManyOptions<TName>,
  "limit" | "offset"
>;
/** The narrowed row a projected query returns: the selected columns keep
 *  their types, everything else is absent. */
type CoreProjectedRow<TName extends CoreTableName, TSelect> = TSelect extends readonly (infer K)[]
  ? Pick<CoreRow<TName>, Extract<K, keyof CoreRow<TName>>>
  : CoreRow<TName>;

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
    options?: { readonly where?: CoreWhere },
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
    options: { readonly where?: CoreWhere } = {},
  ): Effect.Effect<void, StorageFailure> =>
    fuma.use(`${tableName}.deleteMany`, (db) =>
      asLooseStorageDb(db).deleteMany(tableName, options),
    ),
  findFirst: <TName extends CoreTableName, const TOptions extends CoreFindFirstOptions<TName>>(
    tableName: TName,
    options: TOptions,
  ): Effect.Effect<CoreProjectedRow<TName, TOptions["select"]> | null, StorageFailure> =>
    fuma.use(`${tableName}.findFirst`, (db) =>
      asLooseStorageDb(db).findFirst(tableName, options),
    ) as Effect.Effect<CoreProjectedRow<TName, TOptions["select"]> | null, StorageFailure>,
  findMany: <TName extends CoreTableName, const TOptions extends CoreFindManyOptions<TName>>(
    tableName: TName,
    options: TOptions = {} as TOptions,
  ): Effect.Effect<readonly CoreProjectedRow<TName, TOptions["select"]>[], StorageFailure> =>
    fuma.use(`${tableName}.findMany`, (db) =>
      asLooseStorageDb(db).findMany(tableName, options),
    ) as Effect.Effect<readonly CoreProjectedRow<TName, TOptions["select"]>[], StorageFailure>,
  updateMany: <TName extends CoreTableName>(
    tableName: TName,
    options: {
      readonly where?: CoreWhere;
      readonly set: Record<string, unknown>;
    },
  ): Effect.Effect<void, StorageFailure> =>
    fuma.use(`${tableName}.updateMany`, (db) =>
      asLooseStorageDb(db).updateMany(tableName, options),
    ),
});

type CoreDb = ReturnType<typeof makeCoreDb>;

// ---------------------------------------------------------------------------
// Plugin storage facade — owner-scoped (was scope-keyed). Reads fall through
// [user, org]; writes/deletes name an explicit owner.
// ---------------------------------------------------------------------------

const pluginStorageEntryFromRow = <T>(row: CoreRow<"plugin_storage">): PluginStorageEntry<T> => ({
  id: pluginStorageId({
    pluginId: row.plugin_id,
    collection: row.collection,
    key: row.key,
  }),
  owner: row.owner as Owner,
  pluginId: row.plugin_id,
  collection: row.collection,
  key: row.key,
  data: row.data as T,
  createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
});

const pluginStorageIndexSpecFields = (spec: PluginStorageRuntimeIndexSpec): readonly string[] =>
  typeof spec === "string" ? [spec] : spec;

const pluginStorageCollectionIndexedFields = (
  definition: PluginStorageRuntimeCollectionDefinition,
): ReadonlySet<string> =>
  new Set(definition.indexes.flatMap((spec) => pluginStorageIndexSpecFields(spec)));

const pluginStorageQueryValidationError = (
  definition: PluginStorageRuntimeCollectionDefinition,
  query: PluginStorageCollectionQueryInput<PluginStorageCollectionDefinition> | undefined,
): StorageError | null => {
  if (!query) return null;
  const indexedFields = pluginStorageCollectionIndexedFields(definition);
  const fields = new Set<string>([
    ...Object.keys(query.where ?? {}),
    ...(query.orderBy ?? []).map((order) => order.field),
  ]);
  for (const field of fields) {
    if (!indexedFields.has(field)) {
      return new StorageError({
        message: `Plugin storage collection "${definition.name}" cannot query field "${field}" because it is not declared as an index`,
        cause: undefined,
      });
    }
  }
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 0)) {
    return new StorageError({
      message: `Plugin storage collection "${definition.name}" received an invalid query limit`,
      cause: undefined,
    });
  }
  if (query.offset !== undefined && (!Number.isInteger(query.offset) || query.offset < 0)) {
    return new StorageError({
      message: `Plugin storage collection "${definition.name}" received an invalid query offset`,
      cause: undefined,
    });
  }
  return null;
};

const isPluginStorageRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const pluginStorageWhereOperators = ["eq", "in", "gt", "gte", "lt", "lte"] as const;

const isPluginStorageWhereFilter = (value: unknown): value is Readonly<Record<string, unknown>> =>
  isPluginStorageRecord(value) && pluginStorageWhereOperators.some((operator) => operator in value);

const pluginStorageComparableValue = (value: unknown): string | number | boolean | null => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (value == null) return null;
  return JSON.stringify(value);
};

const comparePluginStorageValues = (left: unknown, right: unknown): number => {
  const leftValue = pluginStorageComparableValue(left);
  const rightValue = pluginStorageComparableValue(right);
  if (leftValue === rightValue) return 0;
  if (leftValue === null) return -1;
  if (rightValue === null) return 1;
  return leftValue < rightValue ? -1 : 1;
};

const pluginStorageDataField = (data: unknown, field: string): unknown =>
  isPluginStorageRecord(data) ? data[field] : undefined;

const matchesWhereOperator = (operator: string, value: unknown, operand: unknown): boolean => {
  if (operator === "eq") return comparePluginStorageValues(value, operand) === 0;
  if (operator === "in") {
    return (
      Array.isArray(operand) &&
      operand.some((item) => comparePluginStorageValues(value, item) === 0)
    );
  }
  if (operator === "gt") return comparePluginStorageValues(value, operand) > 0;
  if (operator === "gte") return comparePluginStorageValues(value, operand) >= 0;
  if (operator === "lt") return comparePluginStorageValues(value, operand) < 0;
  if (operator === "lte") return comparePluginStorageValues(value, operand) <= 0;
  return false;
};

const matchesWhereOperators = (
  value: unknown,
  filter: Readonly<Record<string, unknown>>,
): boolean => {
  for (const [operator, operand] of Object.entries(filter)) {
    if (!matchesWhereOperator(operator, value, operand)) return false;
  }
  return true;
};

const rowMatchesPluginStorageWhere = (
  row: CoreRow<"plugin_storage">,
  where: Readonly<Record<string, unknown>> | undefined,
): boolean => {
  if (!where) return true;
  for (const [field, condition] of Object.entries(where)) {
    const value = pluginStorageDataField(row.data, field);
    if (isPluginStorageWhereFilter(condition)) {
      if (!matchesWhereOperators(value, condition)) return false;
    } else if (comparePluginStorageValues(value, condition) !== 0) {
      return false;
    }
  }
  return true;
};

const makePluginStorageFacade = (input: {
  readonly core: CoreDb;
  readonly pluginId: string;
  readonly owner: OwnerBinding;
}): PluginStorageFacade => {
  // Owner partitions: org always, plus this subject's user partition.
  const readOwners: readonly Owner[] = input.owner.subject == null ? ["org"] : ["user", "org"];

  const ownerSubject = (owner: Owner): { owner: Owner; subject: string } | null => {
    if (owner === "org") return { owner: "org", subject: ORG_SUBJECT };
    if (input.owner.subject == null) return null;
    return { owner: "user", subject: String(input.owner.subject) };
  };

  const tenant = String(input.owner.tenant);

  const whereFor =
    (collection: string, key?: string): CoreWhere =>
    (b: AnyCb) =>
      b.and(
        b("plugin_id", "=", input.pluginId),
        b("collection", "=", collection),
        key === undefined ? true : b("key", "=", key),
      );

  const whereOwner = (owner: Owner, collection: string, key: string): CoreWhere => {
    const os = ownerSubject(owner);
    return (b: AnyCb) =>
      b.and(
        b("plugin_id", "=", input.pluginId),
        b("collection", "=", collection),
        b("key", "=", key),
        b("owner", "=", owner),
        b("subject", "=", os ? os.subject : ORG_SUBJECT),
      );
  };

  const ownerRank = (owner: Owner): number => readOwners.indexOf(owner);

  const sortByOwnerPrecedence = (rows: readonly CoreRow<"plugin_storage">[]) =>
    [...rows].sort((left, right) => {
      const l = ownerRank(left.owner as Owner);
      const r = ownerRank(right.owner as Owner);
      return l - r || left.key.localeCompare(right.key);
    });

  const getVisible = <T>(collection: string, key: string) =>
    input.core.findMany("plugin_storage", { where: whereFor(collection, key) }).pipe(
      Effect.map((rows) => sortByOwnerPrecedence(rows)[0] ?? null),
      Effect.map((row) => (row ? pluginStorageEntryFromRow<T>(row) : null)),
    );

  const getForOwnerImpl = <T>(owner: Owner, collection: string, key: string) =>
    input.core
      .findFirst("plugin_storage", {
        where: whereOwner(owner, collection, key),
      })
      .pipe(Effect.map((row) => (row ? pluginStorageEntryFromRow<T>(row) : null)));

  const putImpl = <T>(owner: Owner, collection: string, key: string, data: unknown) =>
    Effect.gen(function* () {
      const os = ownerSubject(owner);
      if (!os) {
        return yield* new StorageError({
          message: `Cannot write plugin storage for owner "user": executor has no subject.`,
          cause: undefined,
        });
      }
      const existing = yield* input.core.findFirst("plugin_storage", {
        where: whereOwner(owner, collection, key),
      });
      const now = new Date();
      if (existing) {
        yield* input.core.updateMany("plugin_storage", {
          where: whereOwner(owner, collection, key),
          set: { data, updated_at: now },
        });
        return pluginStorageEntryFromRow<T>({
          ...existing,
          data,
          updated_at: now,
        });
      }
      const created = yield* input.core.create("plugin_storage", {
        tenant,
        owner: os.owner,
        subject: os.subject,
        plugin_id: input.pluginId,
        collection,
        key,
        data,
        created_at: now,
        updated_at: now,
      });
      return pluginStorageEntryFromRow<T>(created);
    });

  const removeImpl = (owner: Owner, collection: string, key: string) =>
    Effect.gen(function* () {
      const os = ownerSubject(owner);
      if (!os) {
        return yield* new StorageError({
          message: `Cannot delete plugin storage for owner "user": executor has no subject.`,
          cause: undefined,
        });
      }
      yield* input.core.deleteMany("plugin_storage", {
        where: whereOwner(owner, collection, key),
      });
    });

  const keysByCollection = (
    entries: readonly { readonly collection: string; readonly key: string }[],
  ) => {
    const grouped = new Map<string, Set<string>>();
    for (const entry of entries) {
      const keys = grouped.get(entry.collection);
      if (keys) {
        keys.add(entry.key);
      } else {
        grouped.set(entry.collection, new Set([entry.key]));
      }
    }
    return grouped;
  };

  const deleteManyImpl = (
    owner: Owner,
    subject: string,
    entries: readonly { readonly collection: string; readonly key: string }[],
  ) =>
    Effect.gen(function* () {
      for (const [collection, keys] of keysByCollection(entries)) {
        const uniqueKeys = [...keys];
        for (
          let offset = 0;
          offset < uniqueKeys.length;
          offset += PLUGIN_STORAGE_DELETE_KEY_BATCH_SIZE
        ) {
          const batchKeys = uniqueKeys.slice(offset, offset + PLUGIN_STORAGE_DELETE_KEY_BATCH_SIZE);
          yield* input.core.deleteMany("plugin_storage", {
            where: (b) =>
              b.and(
                b("plugin_id", "=", input.pluginId),
                b("collection", "=", collection),
                b("key", "in", batchKeys),
                b("owner", "=", owner),
                b("subject", "=", subject),
              ),
          });
        }
      }
    });

  const putManyImpl = (
    owner: Owner,
    entries: readonly {
      readonly collection: string;
      readonly key: string;
      readonly data: unknown;
    }[],
  ) =>
    Effect.gen(function* () {
      const os = ownerSubject(owner);
      if (!os) {
        return yield* new StorageError({
          message: `Cannot write plugin storage for owner "user": executor has no subject.`,
          cause: undefined,
        });
      }
      const entriesById = new Map(
        entries.map((entry) => [
          pluginStorageId({
            pluginId: input.pluginId,
            collection: entry.collection,
            key: entry.key,
          }),
          entry,
        ]),
      );
      const uniqueEntries = [...entriesById.values()];
      if (uniqueEntries.length === 0) return;

      yield* deleteManyImpl(owner, os.subject, uniqueEntries);

      const now = new Date();
      yield* input.core.createMany(
        "plugin_storage",
        uniqueEntries.map((entry) => ({
          tenant,
          owner: os.owner,
          subject: os.subject,
          plugin_id: input.pluginId,
          collection: entry.collection,
          key: entry.key,
          data: entry.data,
          created_at: now,
          updated_at: now,
        })),
      );
    });

  const removeManyImpl = (
    owner: Owner,
    entries: readonly { readonly collection: string; readonly key: string }[],
  ) =>
    Effect.gen(function* () {
      const os = ownerSubject(owner);
      if (!os) {
        return yield* new StorageError({
          message: `Cannot delete plugin storage for owner "user": executor has no subject.`,
          cause: undefined,
        });
      }
      yield* deleteManyImpl(owner, os.subject, entries);
    });

  const queryCollection = <TDefinition extends PluginStorageCollectionDefinition>(
    definition: TDefinition,
    queryInput?: PluginStorageCollectionQueryInput<TDefinition>,
  ) =>
    Effect.gen(function* () {
      const validationError = pluginStorageQueryValidationError(
        definition,
        queryInput as
          | PluginStorageCollectionQueryInput<PluginStorageCollectionDefinition>
          | undefined,
      );
      if (validationError) return yield* validationError;

      const rows = yield* input.core.findMany("plugin_storage", {
        where: whereFor(definition.name),
      });
      const filtered = sortByOwnerPrecedence(rows)
        .filter((row) =>
          queryInput?.keyPrefix === undefined ? true : row.key.startsWith(queryInput.keyPrefix),
        )
        .filter((row) =>
          rowMatchesPluginStorageWhere(
            row,
            queryInput?.where as Readonly<Record<string, unknown>> | undefined,
          ),
        );

      const sorted =
        queryInput?.orderBy && queryInput.orderBy.length > 0
          ? [...filtered].sort((left, right) => {
              for (const order of queryInput.orderBy ?? []) {
                const direction = order.direction === "desc" ? -1 : 1;
                const compared =
                  comparePluginStorageValues(
                    pluginStorageDataField(left.data, order.field),
                    pluginStorageDataField(right.data, order.field),
                  ) * direction;
                if (compared !== 0) return compared;
              }
              return (
                ownerRank(left.owner as Owner) - ownerRank(right.owner as Owner) ||
                left.key.localeCompare(right.key)
              );
            })
          : filtered;

      const offset = queryInput?.offset ?? 0;
      const limited =
        queryInput?.limit === undefined
          ? sorted.slice(offset)
          : sorted.slice(offset, offset + queryInput.limit);
      return limited.map((row) =>
        pluginStorageEntryFromRow<PluginStorageCollectionData<TDefinition>>(row),
      );
    });

  return {
    collection: (definition) => ({
      get: (storageInput) =>
        getVisible(definition.name, storageInput.key) as Effect.Effect<
          PluginStorageEntry<PluginStorageCollectionData<typeof definition>> | null,
          StorageFailure
        >,
      getForOwner: (storageInput) =>
        getForOwnerImpl(storageInput.owner, definition.name, storageInput.key) as Effect.Effect<
          PluginStorageEntry<PluginStorageCollectionData<typeof definition>> | null,
          StorageFailure
        >,
      list: (storageInput) => queryCollection(definition, { keyPrefix: storageInput?.keyPrefix }),
      put: (storageInput) =>
        putImpl(
          storageInput.owner,
          definition.name,
          storageInput.key,
          storageInput.data,
        ) as Effect.Effect<
          PluginStorageEntry<PluginStorageCollectionData<typeof definition>>,
          StorageFailure
        >,
      query: (storageInput) => queryCollection(definition, storageInput),
      count: (storageInput) =>
        queryCollection(definition, storageInput).pipe(Effect.map((rows) => rows.length)),
      remove: (storageInput) => removeImpl(storageInput.owner, definition.name, storageInput.key),
    }),
    get: (storageInput) => getVisible(storageInput.collection, storageInput.key),
    getForOwner: (storageInput) =>
      getForOwnerImpl(storageInput.owner, storageInput.collection, storageInput.key),
    list: (storageInput) =>
      Effect.gen(function* () {
        const rows = yield* input.core.findMany("plugin_storage", {
          where: whereFor(storageInput.collection),
        });
        return sortByOwnerPrecedence(rows)
          .filter((row) =>
            storageInput.keyPrefix === undefined
              ? true
              : row.key.startsWith(storageInput.keyPrefix),
          )
          .map((row) => pluginStorageEntryFromRow(row));
      }),
    put: (storageInput) =>
      putImpl(storageInput.owner, storageInput.collection, storageInput.key, storageInput.data),
    putMany: (storageInput) => putManyImpl(storageInput.owner, storageInput.entries),
    remove: (storageInput) =>
      removeImpl(storageInput.owner, storageInput.collection, storageInput.key),
    removeMany: (storageInput) => removeManyImpl(storageInput.owner, storageInput.entries),
  };
};

// ---------------------------------------------------------------------------
// Approval argument preview
// ---------------------------------------------------------------------------

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

interface PluginRuntime {
  readonly plugin: AnyPlugin;
  readonly storage: unknown;
  readonly ctx: PluginCtx<unknown>;
}

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

const isReadonlyRecord = (value: unknown): value is Readonly<Record<PropertyKey, unknown>> =>
  typeof value === "object" && value !== null;

type StandardJsonSchemaSide = "input" | "output";
type StandardJsonSchemaFns = {
  readonly input?: (options: { readonly target: "draft-07" }) => unknown;
  readonly output?: (options: { readonly target: "draft-07" }) => unknown;
};

const staticToolSchemaRoot = (
  schema: StaticToolDecl["inputSchema"] | StaticToolDecl["outputSchema"],
  side: StandardJsonSchemaSide,
): unknown | undefined => {
  if (!schema) return undefined;
  const standard = isReadonlyRecord(schema) ? schema["~standard"] : undefined;
  if (!isReadonlyRecord(standard)) return schema;
  const jsonSchema = standard["jsonSchema"];
  if (!isReadonlyRecord(jsonSchema)) return schema;
  const materialize = (jsonSchema as StandardJsonSchemaFns)[side];
  return typeof materialize === "function" ? materialize({ target: "draft-07" }) : jsonSchema;
};

export const createExecutor = <const TPlugins extends readonly AnyPlugin[] = readonly []>(
  config: ExecutorConfig<TPlugins>,
): Effect.Effect<Executor<TPlugins>, StorageFailure> =>
  Effect.gen(function* () {
    const defaultPlugins = (): TPlugins => {
      const empty: readonly AnyPlugin[] = [];
      return empty as TPlugins;
    };
    const { plugins: userPlugins = defaultPlugins() } = config;

    const tenant = String(config.tenant);
    const subject = config.subject != null ? String(config.subject) : null;

    const ownerBinding: OwnerBinding = {
      tenant: config.tenant,
      subject: config.subject ?? null,
    };

    const ownedKeys = (owner: Owner): OwnedKeys => {
      if (owner === "org") return { tenant, owner, subject: ORG_SUBJECT };
      if (subject == null) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: programmer error caught and surfaced as StorageError below by callers
        throw new StorageError({
          message: `Cannot target owner "user": executor has no subject.`,
          cause: undefined,
        });
      }
      return { tenant, owner, subject };
    };

    const requireUserSubject = (owner: Owner): Effect.Effect<void, StorageFailure> =>
      owner === "user" && subject == null
        ? Effect.fail(
            new StorageError({
              message: `Cannot target owner "user": executor has no subject.`,
              cause: undefined,
            }),
          )
        : Effect.void;

    // Built-in core-tools plugin: agent-facing static tools over the v2 surface.
    const plugins: readonly AnyPlugin[] = config.coreTools
      ? ([
          coreToolsPlugin({
            webBaseUrl: config.coreTools.webBaseUrl,
            includeProviders: config.coreTools.includeProviders,
          }),
          ...userPlugins,
        ] as readonly AnyPlugin[])
      : (userPlugins as readonly AnyPlugin[]);

    const tables = yield* Effect.try({
      try: () => collectTables(),
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
        validateExecutorOwnerPolicyTables(rootDbUntyped.internal.tables);
      },
      catch: (cause) => storageFailureFromUnknown("Failed to validate executor tables", cause),
    });

    const ownerContext: ExecutorOwnerPolicyContext = { tenant, subject };
    const rootDb = withQueryContext(rootDbUntyped, ownerContext);
    const fuma = makeFumaClient(rootDb);
    const core = makeCoreDb(fuma);
    const blobs = config.blobs ?? makeFumaBlobStore(fuma);
    const transaction = <A, E>(effect: Effect.Effect<A, E>) => fuma.transaction(effect);

    // Populated once, never mutated after startup.
    const staticTools = new Map<string, StaticTools>();
    const runtimes = new Map<string, PluginRuntime>();
    // Credential providers keyed by `provider.key`, in registration order.
    const credentialProviders = new Map<string, CredentialProvider>();
    const credentialProviderOrder: string[] = [];

    const staticToolOwner = (): Owner => (subject == null ? "org" : "user");
    const staticToolConnection = (source: StaticSourceDecl): ConnectionName =>
      ConnectionName.make(source.id === EXECUTOR_SOURCE_ID ? "coreTools" : "static");

    const staticSources = (): readonly StaticSourceDecl[] => {
      const byId = new Map<string, StaticSourceDecl>();
      for (const entry of staticTools.values()) {
        if (!byId.has(entry.source.id)) byId.set(entry.source.id, entry.source);
      }
      return [...byId.values()];
    };

    const staticSourceToIntegration = (source: StaticSourceDecl): Integration => ({
      slug: IntegrationSlug.make(source.id),
      description: source.name,
      kind: source.kind,
      canRemove: source.canRemove ?? false,
      canRefresh: source.canRefresh ?? false,
      authMethods: [],
    });

    const staticToolToTool = (entry: StaticTools): Tool => ({
      address: ToolAddress.make(`${entry.source.id}.${entry.tool.name}`),
      owner: staticToolOwner(),
      integration: IntegrationSlug.make(entry.source.id),
      connection: staticToolConnection(entry.source),
      name: ToolName.make(entry.tool.name),
      pluginId: entry.pluginId,
      description: entry.tool.description,
      inputSchema: staticToolSchemaRoot(entry.tool.inputSchema, "input"),
      outputSchema: staticToolSchemaRoot(entry.tool.outputSchema, "output"),
      annotations: entry.tool.annotations,
      static: true,
    });

    const registerCredentialProvider = (
      provider: CredentialProvider,
      sourceLabel: string,
    ): Effect.Effect<void, StorageFailure> => {
      const key = String(provider.key);
      if (credentialProviders.has(key)) {
        return Effect.fail(
          new StorageError({
            message: `Duplicate credential provider key: ${key} (from ${sourceLabel})`,
            cause: undefined,
          }),
        );
      }
      credentialProviders.set(key, provider);
      credentialProviderOrder.push(key);
      return Effect.void;
    };

    // Config-level providers register first so the default store prefers them.
    for (const provider of config.providers ?? []) {
      yield* registerCredentialProvider(provider, "config");
    }

    const defaultWritableProvider = (): CredentialProvider | null => {
      for (const key of credentialProviderOrder) {
        const provider = credentialProviders.get(key);
        if (provider?.writable) return provider;
      }
      return null;
    };

    const extensions: Record<string, object> = {};

    // ------------------------------------------------------------------
    // Owner condition builders. The owner policy already restricts reads to
    // (tenant, org|this-subject); `byOwner` narrows to one explicit owner.
    // ------------------------------------------------------------------

    const byOwner =
      (owner: Owner): CoreWhere =>
      (b: AnyCb) => {
        const keys = owner === "org" ? ORG_SUBJECT : (subject ?? "__none__");
        return b.and(b("owner", "=", owner), b("subject", "=", keys));
      };

    // ------------------------------------------------------------------
    // Credential resolution
    // ------------------------------------------------------------------

    const findConnectionRow = (
      ref: ConnectionRef,
    ): Effect.Effect<ConnectionRow | null, StorageFailure> =>
      core.findFirst("connection", {
        where: (b: AnyCb) =>
          b.and(
            byOwner(ref.owner)(b),
            b("integration", "=", String(ref.integration)),
            b("name", "=", String(ref.name)),
          ),
      });

    // In-flight refresh gate — concurrent resolves of the same connection share
    // one refresh (mirrors v1's refresh deferred-map) so we never fire two
    // refresh-token grants for the same connection in parallel (the AS rotates
    // the refresh token; the second request would race on a consumed token).
    const refreshInFlight = new Map<
      string,
      Effect.Effect<string | null, StorageFailure | CredentialResolutionError>
    >();

    const connectionKey = (row: ConnectionRow): string =>
      `${row.owner}:${row.subject}:${row.integration}:${row.name}`;

    const loadOAuthClientRow = (
      owner: Owner,
      slug: string,
    ): Effect.Effect<OAuthClientRow | null, StorageFailure> =>
      core.findFirst("oauth_client", {
        where: (b: AnyCb) => b.and(byOwner(owner)(b), b("slug", "=", slug)),
      });

    // Perform the actual refresh-token grant and persist the rotated material.
    const performTokenRefresh = (
      row: ConnectionRow,
      provider: CredentialProvider,
    ): Effect.Effect<string | null, StorageFailure | CredentialResolutionError> =>
      Effect.gen(function* () {
        const owner = row.owner as Owner;
        const reauth = (message: string): CredentialResolutionError =>
          new CredentialResolutionError({
            owner,
            integration: IntegrationSlug.make(row.integration),
            name: ConnectionName.make(row.name),
            message,
            reauthRequired: true,
          });

        // Load the backing app by the owner STORED on the connection (a Personal
        // connection may be backed by a shared Workspace app) — no derivation.
        const clientOwner = (row.oauth_client_owner ?? row.owner) as Owner;
        const clientRow = yield* loadOAuthClientRow(clientOwner, String(row.oauth_client));
        if (!clientRow) {
          return yield* reauth(`OAuth client "${row.oauth_client}" is no longer registered.`);
        }

        // The secret is stored in the provider (a vault item id), not inline.
        const clientSecret = clientRow.client_secret_item_id
          ? ((yield* provider.get(ProviderItemId.make(String(clientRow.client_secret_item_id)))) ??
            "")
          : "";
        // Re-request the scopes this connection was GRANTED (RFC 6749 §6: a
        // refresh must not exceed the originally-granted scope). Empty → omit
        // the param, which the AS treats as "same scopes as granted".
        const grantedScopes = row.oauth_scope
          ? String(row.oauth_scope).split(/\s+/).filter(Boolean)
          : [];

        // client_credentials (machine-to-machine) has NO refresh token — the
        // token is RE-MINTED from the client id/secret. The authorization_code
        // path below needs a stored refresh token. Branching on grant here is
        // what keeps a client_credentials connection (e.g. DealCloud) from
        // demanding a re-auth on a credential that has no human to re-auth.
        const token =
          String(clientRow.grant) === "client_credentials"
            ? yield* exchangeClientCredentials({
                tokenUrl: String(clientRow.token_url),
                clientId: String(clientRow.client_id),
                clientSecret,
                scopes: grantedScopes,
                resource: clientRow.resource ? String(clientRow.resource) : undefined,
                endpointUrlPolicy: config.oauthEndpointUrlPolicy,
              }).pipe(
                // A client_credentials failure is never a rotated-refresh-token
                // problem, so do NOT map invalid_grant → reauth. Surface as a
                // StorageError; the in-flight gate clears on settle, so the next
                // invoke retries (handles transient AS/network blips).
                Effect.mapError(
                  (cause) =>
                    new StorageError({
                      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuth2Error carries a typed `message`
                      message: `Client-credentials token request failed: ${cause.message}`,
                      cause,
                    }),
                ),
              )
            : yield* Effect.gen(function* () {
                if (!row.refresh_item_id) {
                  return yield* reauth("No refresh token is stored for this connection.");
                }
                const refreshToken = yield* provider.get(ProviderItemId.make(row.refresh_item_id));
                if (!refreshToken) {
                  return yield* reauth("Stored refresh token could not be resolved.");
                }
                return yield* refreshAccessToken({
                  tokenUrl: String(clientRow.token_url),
                  clientId: String(clientRow.client_id),
                  clientSecret,
                  refreshToken,
                  scopes: grantedScopes,
                  // RFC 8707: keep the re-minted token bound to the same resource
                  // (MCP servers require this on refresh).
                  resource: clientRow.resource ? String(clientRow.resource) : undefined,
                  endpointUrlPolicy: config.oauthEndpointUrlPolicy,
                }).pipe(
                  Effect.mapError((cause) =>
                    cause.error === "invalid_grant"
                      ? reauth(
                          // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuth2Error carries a typed `message`
                          `OAuth token refresh was rejected (invalid_grant): ${cause.message}`,
                        )
                      : new StorageError({
                          // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuth2Error carries a typed `message`
                          message: `OAuth token refresh failed: ${cause.message}`,
                          cause,
                        }),
                  ),
                );
              });

        if (provider.set) {
          // OAuth is always single-input: the access token lives in the `token`
          // item. Fall back to a deterministic id if the map is somehow empty.
          const tokenItemId =
            connectionItemIds(row)[PRIMARY_INPUT_VARIABLE] ??
            `connection:${row.owner}:${row.integration}:${row.name}:${PRIMARY_INPUT_VARIABLE}`;
          yield* provider.set(ProviderItemId.make(tokenItemId), token.access_token);
          if (token.refresh_token && row.refresh_item_id) {
            yield* provider.set(ProviderItemId.make(row.refresh_item_id), token.refresh_token);
          }
        }

        const nextExpiresAt =
          typeof token.expires_in === "number" ? Date.now() + token.expires_in * 1000 : null;
        const set: Record<string, unknown> = {
          expires_at: nextExpiresAt,
          updated_at: new Date(),
        };
        if (token.scope !== undefined) set.oauth_scope = token.scope;
        yield* core.updateMany("connection", {
          where: (b: AnyCb) =>
            b.and(
              byOwner(owner)(b),
              b("integration", "=", String(row.integration)),
              b("name", "=", String(row.name)),
            ),
          set,
        });

        return token.access_token;
      });

    const refreshConnectionToken = (
      row: ConnectionRow,
      provider: CredentialProvider,
    ): Effect.Effect<string | null, StorageFailure | CredentialResolutionError> =>
      // Share a single refresh per connection so concurrent resolves of the same
      // connection all await one refresh-token grant (the AS rotates the refresh
      // token; parallel grants would race on a consumed token — v1's refresh
      // deferred-map). The gate is cleared once the refresh settles so a later
      // expiry can refresh again.
      Effect.gen(function* () {
        const key = connectionKey(row);
        const existing = refreshInFlight.get(key);
        if (existing) return yield* existing;
        // `Effect.cached` memoizes the grant onto a deferred: it runs once and
        // replays to every awaiter sharing this entry.
        const memoized = yield* Effect.cached(performTokenRefresh(row, provider));
        const gated = memoized.pipe(
          Effect.ensuring(Effect.sync(() => refreshInFlight.delete(key))),
        );
        // Re-check after building (a peer fiber may have registered first while
        // we built ours) so everyone converges on the same shared grant.
        const winner = refreshInFlight.get(key) ?? gated;
        if (winner === gated) refreshInFlight.set(key, gated);
        return yield* winner;
      });

    // Resolve every named input of a connection (`variable → value`). A
    // single-secret connection yields `{ token: <value> }`; an apiKey method with
    // two distinct inputs yields one entry per variable. OAuth connections refresh
    // first (always single-input → `{ token: <access> }`).
    const resolveConnectionValues = (
      row: ConnectionRow,
    ): Effect.Effect<Record<string, string | null>, StorageFailure | CredentialResolutionError> =>
      Effect.gen(function* () {
        const provider = credentialProviders.get(row.provider);
        if (!provider) {
          return yield* new CredentialProviderNotRegisteredError({
            provider: ProviderKey.make(row.provider),
          });
        }
        // OAuth connections refresh their access token before resolving when
        // it has expired (or is within the skew window).
        const expiresAt = row.expires_at == null ? null : Number(row.expires_at);
        if (row.oauth_client != null && shouldRefreshToken({ expiresAt })) {
          const access = yield* refreshConnectionToken(row, provider);
          return { [PRIMARY_INPUT_VARIABLE]: access };
        }
        const out: Record<string, string | null> = {};
        for (const [variable, itemId] of Object.entries(connectionItemIds(row))) {
          out[variable] = yield* provider.get(ProviderItemId.make(itemId));
        }
        return out;
      }).pipe(
        // CredentialProviderNotRegisteredError is part of CredentialResolution
        // for ctx.connections.resolveValue's StorageFailure channel — fold it.
        Effect.catchTag("CredentialProviderNotRegisteredError", (err) =>
          Effect.fail(
            new StorageError({
              message: `Credential provider "${err.provider}" is not registered.`,
              cause: err,
            }),
          ),
        ),
      );

    /** The primary (`token`) value — the public seam for OAuth + single-input
     *  callers that only ever need one value. */
    const resolveConnectionValue = (
      row: ConnectionRow,
    ): Effect.Effect<string | null, StorageFailure | CredentialResolutionError> =>
      resolveConnectionValues(row).pipe(
        Effect.map((values) => values[PRIMARY_INPUT_VARIABLE] ?? null),
      );

    // The plugin-facing contract (`ctx.connections.resolveValue`, `getValue`,
    // `getValues`) is `StorageFailure`-typed; fold a reauth-required resolution
    // failure into a StorageError so the public surface stays stable.
    const foldResolutionFailure = <A>(
      effect: Effect.Effect<A, StorageFailure | CredentialResolutionError>,
    ): Effect.Effect<A, StorageFailure> =>
      effect.pipe(
        Effect.catchTag("CredentialResolutionError", (err) =>
          Effect.fail(
            new StorageError({
              // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: CredentialResolutionError carries a typed `message` field
              message: err.message,
              cause: err,
            }),
          ),
        ),
      );

    const resolveConnectionValueByRef = (
      ref: ConnectionRef,
    ): Effect.Effect<string | null, StorageFailure> =>
      foldResolutionFailure(
        Effect.gen(function* () {
          const row = yield* findConnectionRow(ref);
          if (!row) return null;
          return yield* resolveConnectionValue(row);
        }),
      );

    const resolveConnectionValuesByRef = (
      ref: ConnectionRef,
    ): Effect.Effect<Record<string, string | null>, StorageFailure> =>
      foldResolutionFailure(
        Effect.gen(function* () {
          const row = yield* findConnectionRow(ref);
          if (!row) return {};
          return yield* resolveConnectionValues(row);
        }),
      );

    // ------------------------------------------------------------------
    // Integrations
    // ------------------------------------------------------------------

    const findIntegrationRow = (
      slug: IntegrationSlug,
    ): Effect.Effect<IntegrationRow | null, StorageFailure> =>
      core.findFirst("integration", {
        where: (b: AnyCb) => b("slug", "=", String(slug)),
      });

    // Project a row's stored config into declared auth methods via the owning
    // plugin's `describeAuthMethods` hook. The hook is plugin-authored, so a
    // throw (malformed config it didn't guard) degrades to `[]` rather than
    // failing the catalog read.
    const describeAuthMethodsForRow = (row: IntegrationRow): readonly AuthMethodDescriptor[] => {
      const runtime = runtimes.get(row.plugin_id);
      const describe = runtime?.plugin.describeAuthMethods;
      if (!describe) return [];
      const record = rowToIntegrationRecord(row);
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: plugin-authored projector must never fail the catalog read
      try {
        return describe(record);
      } catch {
        return [];
      }
    };

    const describeDisplayUrlForRow = (row: IntegrationRow): string | undefined => {
      const runtime = runtimes.get(row.plugin_id);
      const describe = runtime?.plugin.describeIntegrationDisplay;
      if (!describe) return undefined;
      const record = rowToIntegrationRecord(row);
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: plugin-authored projector must never fail the catalog read
      try {
        const display = describe(record);
        return display.url && display.url.length > 0 ? display.url : undefined;
      } catch {
        return undefined;
      }
    };

    const integrationsList = (): Effect.Effect<readonly Integration[], StorageFailure> =>
      core
        .findMany("integration", {})
        .pipe(
          Effect.map((rows) => [
            ...staticSources().map(staticSourceToIntegration),
            ...rows.map((row) =>
              rowToIntegration(row, describeAuthMethodsForRow(row), describeDisplayUrlForRow(row)),
            ),
          ]),
        );

    const integrationsGet = (
      slug: IntegrationSlug,
    ): Effect.Effect<Integration | null, StorageFailure> =>
      Effect.gen(function* () {
        const staticSource = staticSources().find((source) => source.id === String(slug));
        if (staticSource) return staticSourceToIntegration(staticSource);
        const row = yield* findIntegrationRow(slug);
        return row
          ? rowToIntegration(row, describeAuthMethodsForRow(row), describeDisplayUrlForRow(row))
          : null;
      });

    const integrationsGetRecord = (
      slug: IntegrationSlug,
    ): Effect.Effect<IntegrationRecord | null, StorageFailure> =>
      findIntegrationRow(slug).pipe(
        Effect.map((row) =>
          row ? rowToIntegrationRecord(row, describeAuthMethodsForRow(row)) : null,
        ),
      );

    const integrationsRegister = (
      pluginId: string,
      input: RegisterIntegrationInput,
    ): Effect.Effect<void, StorageFailure> =>
      transaction(
        Effect.gen(function* () {
          const now = new Date();
          const existing = yield* findIntegrationRow(input.slug);
          const config = input.config === undefined ? null : input.config;
          if (existing) {
            yield* core.updateMany("integration", {
              where: (b: AnyCb) => b("slug", "=", String(input.slug)),
              set: {
                plugin_id: pluginId,
                description: input.description,
                config,
                can_remove: input.canRemove ?? Boolean(existing.can_remove),
                can_refresh: input.canRefresh ?? Boolean(existing.can_refresh),
                updated_at: now,
              },
            });
            return;
          }
          yield* core.create("integration", {
            tenant,
            slug: String(input.slug),
            plugin_id: pluginId,
            description: input.description,
            config,
            can_remove: input.canRemove ?? true,
            can_refresh: input.canRefresh ?? false,
            created_at: now,
            updated_at: now,
          });
        }),
      );

    const integrationsUpdate = (
      slug: IntegrationSlug,
      patch: {
        readonly description?: string;
        readonly config?: IntegrationConfig;
      },
    ): Effect.Effect<void, StorageFailure> =>
      Effect.gen(function* () {
        const set: Record<string, unknown> = { updated_at: new Date() };
        if (patch.description !== undefined) set.description = patch.description;
        if (patch.config !== undefined) set.config = patch.config;
        yield* core.updateMany("integration", {
          where: (b: AnyCb) => b("slug", "=", String(slug)),
          set,
        });
      });

    const integrationsUpdatePublic = (
      slug: IntegrationSlug,
      patch: { readonly description?: string },
    ): Effect.Effect<void, IntegrationNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const existing = yield* findIntegrationRow(slug);
        if (!existing) return yield* new IntegrationNotFoundError({ slug });
        yield* integrationsUpdate(slug, patch);
      });

    const integrationsRemove = (
      slug: IntegrationSlug,
    ): Effect.Effect<void, IntegrationRemovalNotAllowedError | StorageFailure> =>
      transaction(
        Effect.gen(function* () {
          const existing = yield* findIntegrationRow(slug);
          if (!existing) return;
          if (!existing.can_remove) {
            return yield* new IntegrationRemovalNotAllowedError({ slug });
          }
          // Drop owned connections / tools / definitions for this integration.
          const where = (b: AnyCb) => b("integration", "=", String(slug));
          yield* core.deleteMany("tool", { where });
          yield* core.deleteMany("definition", { where });
          yield* core.deleteMany("connection", { where });
          yield* core.deleteMany("integration", {
            where: (b: AnyCb) => b("slug", "=", String(slug)),
          });
        }),
      );

    const integrationsDetect = (
      url: string,
    ): Effect.Effect<readonly IntegrationDetectionResult[], StorageFailure> =>
      Effect.gen(function* () {
        const results: IntegrationDetectionResult[] = [];
        for (const runtime of runtimes.values()) {
          if (!runtime.plugin.detect) continue;
          const result = yield* runtime.plugin
            .detect({ ctx: runtime.ctx, url })
            .pipe(
              Effect.mapError((cause) => pluginStorageFailure(runtime.plugin.id, "detect", cause)),
            );
          if (result) results.push(result);
        }
        return results;
      });

    // ------------------------------------------------------------------
    // Per-connection tool production
    // ------------------------------------------------------------------

    const produceConnectionTools = (
      integrationRow: IntegrationRow,
      ref: ConnectionRef,
    ): Effect.Effect<readonly Tool[], IntegrationNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const runtime = runtimes.get(integrationRow.plugin_id);
        const keys = yield* Effect.try({
          try: () => ownedKeys(ref.owner),
          catch: (cause) => storageFailureFromUnknown("invalid owner", cause),
        });
        const owner = ref.owner;
        const where = (b: AnyCb) =>
          b.and(
            byOwner(owner)(b),
            b("integration", "=", String(ref.integration)),
            b("connection", "=", String(ref.name)),
          );

        // Defense in depth (and cleanup for rows created before the create-time
        // guard, or emptied by an external edit): a credentialed non-OAuth
        // connection with no bound credential inputs can never resolve a value,
        // so never advertise tools for it — every call would fail with
        // `connection_value_missing`. OAuth connections resolve via refresh and
        // carry their token outside `item_ids`; no-auth (`"none"` template)
        // connections legitimately bind nothing (an empty `item_ids` is their
        // canonical shape) — both are exempt.
        const existingRow = yield* findConnectionRow(ref);
        if (
          existingRow &&
          existingRow.oauth_client == null &&
          existingRow.template !== String(NO_AUTH_TEMPLATE) &&
          Object.keys(connectionItemIds(existingRow)).length === 0
        ) {
          yield* transaction(
            Effect.gen(function* () {
              yield* core.deleteMany("tool", { where });
              yield* core.deleteMany("definition", { where });
            }),
          );
          return [];
        }

        if (!runtime?.plugin.resolveTools) {
          // No dynamic tools — clear any existing rows and return empty.
          yield* transaction(
            Effect.gen(function* () {
              yield* core.deleteMany("tool", { where });
              yield* core.deleteMany("definition", { where });
            }),
          );
          return [];
        }

        const result: ResolveToolsResult = yield* runtime.plugin
          .resolveTools({
            integration: rowToIntegration(integrationRow),
            config: decodeJsonColumn(integrationRow.config),
            connection: ref,
            template: existingRow ? AuthTemplateSlug.make(existingRow.template) : null,
            storage: runtime.storage,
            getValue: () => resolveConnectionValueByRef(ref),
            getValues: () => resolveConnectionValuesByRef(ref),
          })
          .pipe(
            Effect.mapError((cause) =>
              pluginStorageFailure(integrationRow.plugin_id, "resolveTools", cause),
            ),
          );

        const now = new Date();
        const toolRows = result.tools.map((tool: ToolDef) => ({
          tenant: keys.tenant,
          owner: keys.owner,
          subject: keys.subject,
          integration: String(ref.integration),
          connection: String(ref.name),
          plugin_id: integrationRow.plugin_id,
          name: String(tool.name),
          description: tool.description ?? "",
          input_schema: tool.inputSchema ?? null,
          output_schema: tool.outputSchema ?? null,
          annotations: tool.annotations ?? null,
          created_at: now,
          updated_at: now,
        }));

        const definitionRows = Object.entries(result.definitions ?? {}).map(([name, schema]) => ({
          tenant: keys.tenant,
          owner: keys.owner,
          subject: keys.subject,
          integration: String(ref.integration),
          connection: String(ref.name),
          plugin_id: integrationRow.plugin_id,
          name,
          schema,
          created_at: now,
        }));

        yield* transaction(
          Effect.gen(function* () {
            yield* core.deleteMany("tool", { where });
            yield* core.deleteMany("definition", { where });
            yield* core.createMany("tool", toolRows);
            yield* core.createMany("definition", definitionRows);
          }),
        );

        return result.tools.map((tool: ToolDef) =>
          rowToTool(
            {
              tenant: keys.tenant,
              owner: keys.owner,
              subject: keys.subject,
              integration: String(ref.integration),
              connection: String(ref.name),
              plugin_id: integrationRow.plugin_id,
              name: String(tool.name),
              description: tool.description ?? "",
              input_schema: tool.inputSchema ?? null,
              output_schema: tool.outputSchema ?? null,
              annotations: tool.annotations ?? null,
              created_at: now,
              updated_at: now,
            } as ConnectionToolRow,
            tool.annotations,
          ),
        );
      });

    // ------------------------------------------------------------------
    // Connections
    // ------------------------------------------------------------------

    const connectionsCreate = (
      input: CreateConnectionInput,
    ): Effect.Effect<
      Connection,
      | IntegrationNotFoundError
      | CredentialProviderNotRegisteredError
      | InvalidConnectionInputError
      | StorageFailure
    > =>
      Effect.gen(function* () {
        const name = connectionIdentifier(String(input.name));
        // Typed (not StorageError) so the HTTP edge can answer 400 with the
        // reason instead of an opaque 500 — callers can act on it.
        if (input.owner === "user" && subject == null) {
          return yield* new InvalidConnectionInputError({
            message:
              'Cannot create a personal connection: this context has no user subject. Create it with owner "org", or connect as a signed-in user.',
          });
        }
        const integrationRow = yield* findIntegrationRow(input.integration);
        if (!integrationRow) {
          return yield* new IntegrationNotFoundError({
            slug: input.integration,
          });
        }

        // Resolve the value origin(s) → one provider + an item_ids map (one entry
        // per named input). All of a connection's inputs share a single provider:
        // pasted inputs go to the default writable store, external `from` inputs to
        // their provider. Mixing pasted + external, or two external providers, is
        // rejected (the connection row carries one `provider`).
        const inputs = normalizeConnectionInputs(input);
        const pasted = inputs.filter((i) => "value" in i.origin);
        const external = inputs.filter((i) => "from" in i.origin);
        // A credentialed connection is born wired: it must reference at least
        // one credential input. An empty binding (no inputs at all — e.g. an
        // empty `values`/`inputs` map) is a credential with no credential: it
        // would persist, produce a full tool catalog, and then fail every
        // invocation with `connection_value_missing`. Reject it here — EXCEPT
        // for the no-auth template ("none"), where zero inputs and an empty
        // `item_ids` map are the canonical shape (public MCP servers; the UI
        // submits `values: {}` for them). OAuth connections are minted via
        // `mintOAuthConnection`, not this path; an external `from` reference
        // may resolve to null and is surfaced at invoke time, not here.
        const isNoAuth = String(input.template) === String(NO_AUTH_TEMPLATE);
        if (inputs.length === 0 && !isNoAuth) {
          return yield* new InvalidConnectionInputError({
            message: "A connection must supply at least one credential input.",
          });
        }
        let providerKey: string;
        const itemIds: Record<string, string> = {};
        if (external.length > 0 && pasted.length > 0) {
          return yield* new InvalidConnectionInputError({
            message: "A connection cannot mix pasted and external-provider inputs.",
          });
        }
        if (external.length > 0) {
          const providers = new Set(
            external.map((i) => ("from" in i.origin ? String(i.origin.from.provider) : "")),
          );
          if (providers.size > 1) {
            return yield* new InvalidConnectionInputError({
              message: "A connection's inputs must all use the same external provider.",
            });
          }
          const [only] = [...providers];
          const provider = credentialProviders.get(only ?? "");
          if (!provider) {
            return yield* new CredentialProviderNotRegisteredError({
              provider: ProviderKey.make(only ?? ""),
            });
          }
          providerKey = only ?? "";
          for (const i of external) {
            if ("from" in i.origin) itemIds[i.variable] = String(i.origin.from.id);
          }
        } else {
          const provider = defaultWritableProvider();
          if (!provider) {
            return yield* new CredentialProviderNotRegisteredError({
              provider: ProviderKey.make("default"),
            });
          }
          providerKey = String(provider.key);
          for (const i of pasted) {
            const itemId = `connection:${input.owner}:${input.integration}:${name}:${i.variable}`;
            if ("value" in i.origin && provider.set) {
              yield* provider.set(ProviderItemId.make(itemId), i.origin.value);
            }
            itemIds[i.variable] = itemId;
          }
        }

        const keys = yield* Effect.try({
          try: () => ownedKeys(input.owner),
          catch: (cause) => storageFailureFromUnknown("invalid owner", cause),
        });
        const now = new Date();
        yield* transaction(
          Effect.gen(function* () {
            const existing = yield* findConnectionRow({
              owner: input.owner,
              integration: input.integration,
              name,
            });
            const set: Record<string, unknown> = {
              template: String(input.template),
              provider: providerKey,
              item_ids: itemIds,
              identity_label: input.identityLabel ?? null,
              updated_at: now,
            };
            if (existing) {
              yield* core.updateMany("connection", {
                where: (b: AnyCb) =>
                  b.and(
                    byOwner(input.owner)(b),
                    b("integration", "=", String(input.integration)),
                    b("name", "=", String(name)),
                  ),
                set,
              });
            } else {
              yield* core.create("connection", {
                tenant: keys.tenant,
                owner: keys.owner,
                subject: keys.subject,
                integration: String(input.integration),
                name: String(name),
                template: String(input.template),
                provider: providerKey,
                item_ids: itemIds,
                identity_label: input.identityLabel ?? null,
                oauth_client: null,
                refresh_item_id: null,
                expires_at: null,
                oauth_scope: null,
                provider_state: null,
                created_at: now,
                updated_at: now,
              });
            }
          }),
        );

        const ref: ConnectionRef = {
          owner: input.owner,
          integration: input.integration,
          name,
        };
        // Produce + persist tools for the new connection.
        yield* produceConnectionTools(integrationRow, ref).pipe(
          Effect.catchTag("IntegrationNotFoundError", () => Effect.succeed([] as readonly Tool[])),
        );

        const row = yield* findConnectionRow(ref);
        return row
          ? rowToConnection(row)
          : rowToConnection({
              tenant: keys.tenant,
              owner: keys.owner,
              subject: keys.subject,
              integration: String(input.integration),
              name: String(name),
              template: String(input.template),
              provider: providerKey,
              item_ids: itemIds,
              identity_label: input.identityLabel ?? null,
              oauth_client: null,
              refresh_item_id: null,
              expires_at: null,
              oauth_scope: null,
              provider_state: null,
              created_at: now,
              updated_at: now,
            } as ConnectionRow);
      });

    // Mint (or re-mint) an OAuth connection: write the connection row with its
    // OAuth lifecycle fields (the access token is already stored in the provider
    // by the OAuth service) + produce the connection's tools. Mirrors
    // `connectionsCreate`'s upsert + tool-production, stamping the OAuth columns.
    const mintOAuthConnection = (
      input: MintOAuthConnectionInput,
    ): Effect.Effect<Connection, StorageFailure> =>
      Effect.gen(function* () {
        const name = connectionIdentifier(String(input.name));
        yield* requireUserSubject(input.owner);
        const integrationRow = yield* findIntegrationRow(input.integration);
        if (!integrationRow) {
          return yield* new StorageError({
            message: `Integration not found: ${input.integration}`,
            cause: undefined,
          });
        }
        const keys = yield* Effect.try({
          try: () => ownedKeys(input.owner),
          catch: (cause) => storageFailureFromUnknown("invalid owner", cause),
        });
        const now = new Date();
        const ref: ConnectionRef = {
          owner: input.owner,
          integration: input.integration,
          name,
        };
        yield* transaction(
          Effect.gen(function* () {
            const existing = yield* findConnectionRow(ref);
            const set: Record<string, unknown> = {
              template: String(input.template),
              provider: input.provider,
              item_ids: { [PRIMARY_INPUT_VARIABLE]: input.itemId },
              identity_label: input.identityLabel ?? null,
              oauth_client: String(input.oauthClient),
              oauth_client_owner: input.oauthClientOwner,
              refresh_item_id: input.refreshItemId,
              expires_at: input.expiresAt,
              oauth_scope: input.oauthScope,
              updated_at: now,
            };
            if (existing) {
              yield* core.updateMany("connection", {
                where: (b: AnyCb) =>
                  b.and(
                    byOwner(input.owner)(b),
                    b("integration", "=", String(input.integration)),
                    b("name", "=", String(name)),
                  ),
                set,
              });
            } else {
              yield* core.create("connection", {
                tenant: keys.tenant,
                owner: keys.owner,
                subject: keys.subject,
                integration: String(input.integration),
                name: String(name),
                template: String(input.template),
                provider: input.provider,
                item_ids: { [PRIMARY_INPUT_VARIABLE]: input.itemId },
                identity_label: input.identityLabel ?? null,
                oauth_client: String(input.oauthClient),
                oauth_client_owner: input.oauthClientOwner,
                refresh_item_id: input.refreshItemId,
                expires_at: input.expiresAt,
                oauth_scope: input.oauthScope,
                provider_state: null,
                created_at: now,
                updated_at: now,
              });
            }
          }),
        );

        // Produce + persist tools for the minted connection (same path
        // connections.create uses).
        yield* produceConnectionTools(integrationRow, ref).pipe(
          Effect.catchTag("IntegrationNotFoundError", () => Effect.succeed([] as readonly Tool[])),
        );

        const row = yield* findConnectionRow(ref);
        return row
          ? rowToConnection(row)
          : rowToConnection({
              tenant: keys.tenant,
              owner: keys.owner,
              subject: keys.subject,
              integration: String(input.integration),
              name: String(name),
              template: String(input.template),
              provider: input.provider,
              item_ids: { [PRIMARY_INPUT_VARIABLE]: input.itemId },
              identity_label: input.identityLabel ?? null,
              oauth_client: String(input.oauthClient),
              oauth_client_owner: input.oauthClientOwner,
              refresh_item_id: input.refreshItemId,
              expires_at: input.expiresAt,
              oauth_scope: input.oauthScope,
              provider_state: null,
              created_at: now,
              updated_at: now,
            } as ConnectionRow);
      });

    const connectionsList = (filter?: {
      readonly integration?: IntegrationSlug;
      readonly owner?: Owner;
    }): Effect.Effect<readonly Connection[], StorageFailure> =>
      core
        .findMany("connection", {
          where: (b: AnyCb) =>
            b.and(
              filter?.integration === undefined
                ? true
                : b("integration", "=", String(filter.integration)),
              filter?.owner === undefined ? true : b("owner", "=", filter.owner),
            ),
        })
        .pipe(Effect.map((rows) => rows.map(rowToConnection)));

    const connectionsGet = (ref: ConnectionRef): Effect.Effect<Connection | null, StorageFailure> =>
      findConnectionRow(ref).pipe(Effect.map((row) => (row ? rowToConnection(row) : null)));

    const connectionsRemove = (
      ref: ConnectionRef,
    ): Effect.Effect<void, ConnectionNotFoundError | StorageFailure> =>
      transaction(
        Effect.gen(function* () {
          const row = yield* findConnectionRow(ref);
          if (!row) {
            return yield* new ConnectionNotFoundError({
              owner: ref.owner,
              integration: ref.integration,
              name: ref.name,
            });
          }
          const integrationRow = yield* findIntegrationRow(ref.integration);
          const runtime = integrationRow ? runtimes.get(integrationRow.plugin_id) : undefined;
          if (integrationRow && runtime?.plugin.removeConnection) {
            yield* runtime.plugin
              .removeConnection({
                ctx: runtime.ctx,
                integration: ref.integration,
                connection: ref,
              })
              .pipe(
                Effect.mapError((cause) =>
                  pluginStorageFailure(integrationRow.plugin_id, "removeConnection", cause),
                ),
              );
          }
          const where = (b: AnyCb) =>
            b.and(
              byOwner(ref.owner)(b),
              b("integration", "=", String(ref.integration)),
              b("connection", "=", String(ref.name)),
            );
          yield* core.deleteMany("tool", { where });
          yield* core.deleteMany("definition", { where });
          yield* core.deleteMany("connection", {
            where: (b: AnyCb) =>
              b.and(
                byOwner(ref.owner)(b),
                b("integration", "=", String(ref.integration)),
                b("name", "=", String(ref.name)),
              ),
          });
        }),
      );

    const connectionsRefresh = (
      ref: ConnectionRef,
    ): Effect.Effect<
      readonly Tool[],
      ConnectionNotFoundError | IntegrationNotFoundError | StorageFailure
    > =>
      Effect.gen(function* () {
        const row = yield* findConnectionRow(ref);
        if (!row) {
          return yield* new ConnectionNotFoundError({
            owner: ref.owner,
            integration: ref.integration,
            name: ref.name,
          });
        }
        const integrationRow = yield* findIntegrationRow(ref.integration);
        if (!integrationRow) {
          return yield* new IntegrationNotFoundError({ slug: ref.integration });
        }
        return yield* produceConnectionTools(integrationRow, ref);
      });

    // ------------------------------------------------------------------
    // Tools (read surface)
    // ------------------------------------------------------------------

    const matchesToolFilter = (tool: Tool, filter: ToolListFilter | undefined): boolean => {
      if (!filter) return true;
      if (filter.integration !== undefined && tool.integration !== filter.integration) return false;
      if (filter.owner !== undefined && tool.owner !== filter.owner) return false;
      if (filter.connection !== undefined && tool.connection !== filter.connection) return false;
      if (filter.query !== undefined) {
        const q = filter.query.toLowerCase();
        const hay = `${tool.name} ${tool.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    };

    const toolsList = (filter?: ToolListFilter): Effect.Effect<readonly Tool[], StorageFailure> =>
      Effect.gen(function* () {
        // Projected: the list surface is metadata (address, description,
        // annotations) — loading every tool's input/output schema JSON made
        // an unbounded list scale with schema bytes, not tool count.
        const rows = yield* core.findMany("tool", {
          where: (b: AnyCb) =>
            b.and(
              filter?.integration === undefined
                ? true
                : b("integration", "=", String(filter.integration)),
              filter?.owner === undefined ? true : b("owner", "=", filter.owner),
              filter?.connection === undefined
                ? true
                : b("connection", "=", String(filter.connection)),
            ),
          select: TOOL_INVOCATION_COLUMNS,
        });
        const includeBlocked = filter?.includeBlocked ?? false;
        const policyRows = yield* core.findMany("tool_policy", {});
        const tools: Tool[] = [];
        for (const row of rows) {
          const tool = rowToTool(row);
          if (!matchesToolFilter(tool, filter)) continue;
          if (!includeBlocked) {
            const effective = resolveEffectivePolicy(
              normalizedPolicyId(tool),
              policyRows,
              ownerRankForRow,
              tool.annotations?.requiresApproval,
            );
            if (effective.action === "block") continue;
          }
          tools.push(tool);
        }
        for (const entry of staticTools.values()) {
          const tool = staticToolToTool(entry);
          if (!matchesToolFilter(tool, filter)) continue;
          if (!includeBlocked) {
            const effective = resolveEffectivePolicy(
              normalizedPolicyId(tool),
              policyRows,
              ownerRankForRow,
              tool.annotations?.requiresApproval,
            );
            if (effective.action === "block") continue;
          }
          tools.push(tool);
        }
        return tools;
      });

    const toolSchema = (
      address: ToolAddress,
    ): Effect.Effect<ToolSchemaView | null, StorageFailure> =>
      Effect.gen(function* () {
        const staticEntry = staticTools.get(String(address));
        if (staticEntry) {
          const tool = staticToolToTool(staticEntry);
          const preview = yield* Effect.tryPromise({
            try: () =>
              buildToolTypeScriptPreview({
                inputSchema: tool.inputSchema,
                outputSchema: tool.outputSchema,
                defs: new Map(),
              }),
            catch: (cause) =>
              storageFailureFromUnknown("Failed to build static tool TypeScript preview", cause),
          }).pipe(Effect.option);
          return ToolSchemaView.make({
            address,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            inputTypeScript: Option.getOrUndefined(preview)?.inputTypeScript,
            outputTypeScript: Option.getOrUndefined(preview)?.outputTypeScript,
            typeScriptDefinitions: Option.getOrUndefined(preview)?.typeScriptDefinitions,
          });
        }

        const parsed = parseToolAddress(String(address));
        if (!parsed) return null;
        const row = yield* core.findFirst("tool", {
          where: (b: AnyCb) =>
            b.and(
              byOwner(parsed.owner)(b),
              b("integration", "=", String(parsed.integration)),
              b("connection", "=", String(parsed.connection)),
              b("name", "=", String(parsed.tool)),
            ),
        });
        if (!row) return null;
        const tool = rowToTool(row);

        const definitionRows = yield* core.findMany("definition", {
          where: (b: AnyCb) =>
            b.and(
              byOwner(parsed.owner)(b),
              b("integration", "=", String(parsed.integration)),
              b("connection", "=", String(parsed.connection)),
            ),
        });
        const defs = new Map<string, unknown>();
        for (const def of definitionRows) defs.set(def.name, decodeJsonColumn(def.schema));

        const referenced = collectReferencedDefinitions(
          [tool.inputSchema, tool.outputSchema],
          defs,
        );
        const preview = yield* Effect.tryPromise({
          try: () =>
            buildToolTypeScriptPreview({
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
              defs,
            }),
          catch: (cause) =>
            storageFailureFromUnknown("Failed to build tool TypeScript preview", cause),
        }).pipe(Effect.option);

        const view = preview;
        return ToolSchemaView.make({
          address,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          schemaDefinitions:
            Object.keys(referenced).length > 0
              ? (referenced as Record<string, unknown>)
              : undefined,
          inputTypeScript: Option.getOrUndefined(view)?.inputTypeScript,
          outputTypeScript: Option.getOrUndefined(view)?.outputTypeScript,
          typeScriptDefinitions: Option.getOrUndefined(view)?.typeScriptDefinitions,
        });
      });

    // ------------------------------------------------------------------
    // Providers
    // ------------------------------------------------------------------

    const providersList = (): Effect.Effect<readonly ProviderKey[]> =>
      Effect.sync(() => credentialProviderOrder.map((key) => ProviderKey.make(key)));

    const providersItems = (
      key: ProviderKey,
    ): Effect.Effect<readonly ProviderEntry[], StorageFailure> =>
      Effect.gen(function* () {
        const provider = credentialProviders.get(String(key));
        if (!provider || !provider.list) return [];
        return yield* provider.list();
      });

    // ------------------------------------------------------------------
    // Policies — owner-ranked (user=0 inner, org=1 outer).
    // ------------------------------------------------------------------

    const ownerRankForRow = (row: { readonly owner: string }): number =>
      row.owner === "user" ? 0 : 1;

    // Tool policies gate by tool identity (`<integration>.<tool>`), independent of
    // which connection serves it; the org/user split is handled by owner-scoped
    // policy rows + ownerRank, not the match pattern.
    const normalizedPolicyId = (tool: Tool): string =>
      tool.static
        ? String(tool.address)
        : `${tool.integration}.${tool.owner}.${tool.connection}.${tool.name}`;

    const policiesList = (): Effect.Effect<readonly ToolPolicy[], StorageFailure> =>
      core
        .findMany("tool_policy", {})
        .pipe(
          Effect.map((rows) =>
            [...rows]
              .sort((a, b) => ownerRankForRow(a) - ownerRankForRow(b) || comparePolicyRow(a, b))
              .map(rowToToolPolicy),
          ),
        );

    const policiesCreate = (
      input: CreateToolPolicyInput,
    ): Effect.Effect<ToolPolicy, StorageFailure> =>
      Effect.gen(function* () {
        if (!isValidPattern(input.pattern)) {
          return yield* new StorageError({
            message: `Invalid tool policy pattern: ${input.pattern}`,
            cause: undefined,
          });
        }
        if (!isToolPolicyAction(input.action)) {
          return yield* new StorageError({
            message: `Invalid tool policy action: ${String(input.action)}`,
            cause: undefined,
          });
        }
        yield* requireUserSubject(input.owner);
        const keys = yield* Effect.try({
          try: () => ownedKeys(input.owner),
          catch: (cause) => storageFailureFromUnknown("invalid owner", cause),
        });
        const existing = yield* core.findMany("tool_policy", {
          where: byOwner(input.owner),
        });
        const minPosition = existing
          .map((row) => row.position)
          .sort()
          .at(0);
        const position = input.position ?? generateKeyBetween(null, minPosition ?? null);
        const id = PolicyId.make(
          `pol_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
        );
        const now = new Date();
        const created = yield* core.create("tool_policy", {
          tenant: keys.tenant,
          owner: keys.owner,
          subject: keys.subject,
          id: String(id),
          pattern: input.pattern,
          action: input.action,
          position,
          created_at: now,
          updated_at: now,
        });
        return rowToToolPolicy(created);
      });

    const policiesUpdate = (
      input: UpdateToolPolicyInput,
    ): Effect.Effect<ToolPolicy, StorageFailure> =>
      Effect.gen(function* () {
        if (input.pattern !== undefined && !isValidPattern(input.pattern)) {
          return yield* new StorageError({
            message: `Invalid tool policy pattern: ${input.pattern}`,
            cause: undefined,
          });
        }
        const where = (b: AnyCb) => b.and(byOwner(input.owner)(b), b("id", "=", input.id));
        const existing = yield* core.findFirst("tool_policy", { where });
        if (!existing) {
          return yield* new StorageError({
            message: `Tool policy not found: ${input.id}`,
            cause: undefined,
          });
        }
        const set: Record<string, unknown> = { updated_at: new Date() };
        if (input.pattern !== undefined) set.pattern = input.pattern;
        if (input.action !== undefined) set.action = input.action;
        if (input.position !== undefined) set.position = input.position;
        yield* core.updateMany("tool_policy", { where, set });
        const updated = yield* core.findFirst("tool_policy", { where });
        return rowToToolPolicy(updated ?? ({ ...existing, ...set } as ToolPolicyRow));
      });

    const policiesRemove = (input: RemoveToolPolicyInput): Effect.Effect<void, StorageFailure> =>
      core.deleteMany("tool_policy", {
        where: (b: AnyCb) => b.and(byOwner(input.owner)(b), b("id", "=", input.id)),
      });

    const policiesResolve = (
      address: ToolAddress,
    ): Effect.Effect<EffectivePolicy, StorageFailure> =>
      Effect.gen(function* () {
        const parsed = parseToolAddress(String(address));
        const policyRows = yield* core.findMany("tool_policy", {});
        const toolId = parsed
          ? `${parsed.integration}.${parsed.owner}.${parsed.connection}.${parsed.tool}`
          : String(address);
        // Find the tool to read its default approval annotation.
        let requiresApproval: boolean | undefined;
        if (parsed) {
          const row = yield* core.findFirst("tool", {
            where: (b: AnyCb) =>
              b.and(
                byOwner(parsed.owner)(b),
                b("integration", "=", String(parsed.integration)),
                b("connection", "=", String(parsed.connection)),
                b("name", "=", String(parsed.tool)),
              ),
          });
          if (row) {
            const annotations = decodeJsonColumn(row.annotations) as ToolAnnotations | undefined;
            requiresApproval = annotations?.requiresApproval;
          }
        }
        return resolveEffectivePolicy(toolId, policyRows, ownerRankForRow, requiresApproval);
      });

    // ------------------------------------------------------------------
    // Elicitation
    // ------------------------------------------------------------------

    const defaultElicitationHandler = resolveElicitationHandler(config.onElicitation);

    const pickHandler = (options: InvokeOptions | undefined): ElicitationHandler =>
      options?.onElicitation
        ? resolveElicitationHandler(options.onElicitation)
        : defaultElicitationHandler;

    const buildElicit = (
      address: ToolAddress,
      args: unknown,
      handler: ElicitationHandler,
    ): Elicit => {
      return (request: ElicitationRequest) =>
        Effect.gen(function* () {
          const response: ElicitationResponse = yield* handler({
            address,
            args,
            request,
          });
          if (response.action !== "accept") {
            return yield* new ElicitationDeclinedError({
              address,
              action: response.action,
            });
          }
          return response;
        });
    };

    const enforceApproval = (
      annotations: ToolAnnotations | undefined,
      address: ToolAddress,
      args: unknown,
      policy: EffectivePolicy,
      handler: ElicitationHandler,
    ) =>
      Effect.gen(function* () {
        if (policy.action === "approve") return;
        const policyForcesApproval = policy.action === "require_approval";
        if (!policyForcesApproval && !annotations?.requiresApproval) return;
        const message = annotations?.approvalDescription
          ? annotations.approvalDescription
          : policyForcesApproval && policy.pattern
            ? `Approve ${address}? (matched policy: ${policy.pattern})`
            : `Approve ${address}?`;
        const request = FormElicitation.make({
          message: `${message}\n\nArguments:\n${approvalArgumentPreview(args)}`,
          requestedSchema: { type: "object", properties: {} },
        });
        const response = yield* handler({ address, args, request });
        if (response.action !== "accept") {
          return yield* new ElicitationDeclinedError({
            address,
            action: response.action,
          });
        }
      });

    // ------------------------------------------------------------------
    // execute — the invoke path.
    // ------------------------------------------------------------------

    const TOOL_SUGGESTION_LIMIT = 5;

    const toolSuggestions = (rows: readonly ToolInvocationRow[]): readonly ToolAddress[] =>
      rows.map((row) => rowToTool(row).address);

    const toolRowsForConnectionWhere = (parsed: ParsedToolAddress) => (b: AnyCb) =>
      b.and(
        byOwner(parsed.owner)(b),
        b("integration", "=", String(parsed.integration)),
        b("connection", "=", String(parsed.connection)),
      );

    const searchToolRowsForConnection = (
      parsed: ParsedToolAddress,
    ): Effect.Effect<readonly ToolInvocationRow[], StorageFailure> =>
      core.findMany("tool", {
        where: (b: AnyCb) =>
          b.and(
            toolRowsForConnectionWhere(parsed)(b),
            b.or(
              b("name", "contains", String(parsed.tool)),
              b("description", "contains", String(parsed.tool)),
            ),
          ),
        orderBy: ["name", "asc"],
        limit: TOOL_SUGGESTION_LIMIT,
        select: TOOL_INVOCATION_COLUMNS,
      });

    const findToolRowsForConnection = (
      parsed: ParsedToolAddress,
    ): Effect.Effect<readonly ToolInvocationRow[], StorageFailure> =>
      core.findMany("tool", {
        where: toolRowsForConnectionWhere(parsed),
        orderBy: ["name", "asc"],
        limit: TOOL_SUGGESTION_LIMIT,
        select: TOOL_INVOCATION_COLUMNS,
      });

    const execute = (
      address: ToolAddress,
      args: unknown,
      options?: InvokeOptions,
    ): Effect.Effect<unknown, ExecuteError> => {
      const handler = pickHandler(options);
      return Effect.gen(function* () {
        // oxlint-disable executor/no-instanceof-error, executor/no-unknown-error-message, executor/no-manual-tag-check -- boundary: normalize arbitrary unknown plugin failures into a human-readable message for ToolInvocationError/telemetry
        const formatInvocationCauseMessage = (cause: unknown): string => {
          if (cause instanceof Error && cause.message.length > 0) return cause.message;
          // Non-Error / empty-message causes: `String(plainObject)` renders
          // "[object Object]", which is what telemetry then shows as the only
          // label for the failure. Prefer the tag, else stringify structurally.
          if (typeof cause === "object" && cause !== null) {
            const tag = (cause as { readonly _tag?: unknown })._tag;
            if (typeof tag === "string") return tag;
            return Inspectable.toStringUnknown(cause, 0);
          }
          return String(cause);
        };
        // oxlint-enable executor/no-instanceof-error, executor/no-unknown-error-message, executor/no-manual-tag-check
        const wrapInvocationError = <A, E>(
          effect: Effect.Effect<A, E>,
        ): Effect.Effect<A, ToolInvocationError> =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new ToolInvocationError({
                  address,
                  message: formatInvocationCauseMessage(cause),
                  cause,
                }),
            ),
          );

        // Static path — O(1) map lookup for plugin-contributed static tools
        // (core-tools, plugin executor namespaces). Addressed by their fqid,
        // not the 5-segment dynamic form.
        const staticEntry = staticTools.get(String(address));
        if (staticEntry) {
          const policyRows = yield* core.findMany("tool_policy", {});
          const policy = resolveEffectivePolicy(
            String(address),
            policyRows,
            ownerRankForRow,
            staticEntry.tool.annotations?.requiresApproval,
          );
          if (policy.action === "block") {
            return yield* new ToolBlockedError({
              address,
              pattern: policy.pattern ?? "*",
            });
          }
          yield* enforceApproval(staticEntry.tool.annotations, address, args, policy, handler);
          return yield* wrapInvocationError(
            staticEntry.tool.handler({
              ctx: staticEntry.ctx,
              args,
              elicit: buildElicit(address, args, handler),
            }),
          );
        }

        const parsed = parseToolAddress(String(address));
        if (!parsed) {
          return yield* new ToolNotFoundError({ address });
        }

        // Find the tool row — projected: invoke needs routing/policy fields
        // only, never the multi-KB input/output schema JSON (`tools.schema`
        // is the schema-bearing surface).
        const row = yield* core.findFirst("tool", {
          where: (b: AnyCb) =>
            b.and(
              byOwner(parsed.owner)(b),
              b("integration", "=", String(parsed.integration)),
              b("connection", "=", String(parsed.connection)),
              b("name", "=", String(parsed.tool)),
            ),
          select: TOOL_INVOCATION_COLUMNS,
        });
        if (!row) {
          const searchMatches = yield* searchToolRowsForConnection(parsed);
          const connectionTools =
            searchMatches.length > 0 ? searchMatches : yield* findToolRowsForConnection(parsed);
          return yield* new ToolNotFoundError({
            address,
            suggestions: toolSuggestions(connectionTools),
          });
        }

        // Resolve policy (owner-ranked).
        const toolForPolicy = rowToTool(row);
        const policyRows = yield* core.findMany("tool_policy", {});
        const annotations = decodeJsonColumn(row.annotations) as ToolAnnotations | undefined;
        const policy = resolveEffectivePolicy(
          normalizedPolicyId(toolForPolicy),
          policyRows,
          ownerRankForRow,
          annotations?.requiresApproval,
        );
        if (policy.action === "block") {
          return yield* new ToolBlockedError({
            address,
            pattern: policy.pattern ?? "*",
          });
        }

        const runtime = runtimes.get(row.plugin_id);
        if (!runtime) {
          return yield* new PluginNotLoadedError({
            address,
            pluginId: row.plugin_id,
          });
        }
        if (!runtime.plugin.invokeTool) {
          return yield* new NoHandlerError({
            address,
            pluginId: row.plugin_id,
          });
        }

        // Find the connection row.
        const connectionRow = yield* findConnectionRow({
          owner: parsed.owner,
          integration: parsed.integration,
          name: parsed.connection,
        });
        if (!connectionRow) {
          return yield* new ConnectionNotFoundError({
            owner: parsed.owner,
            integration: parsed.integration,
            name: parsed.connection,
          });
        }

        // Resolve annotations + enforce approval.
        let resolvedAnnotations = annotations;
        if (policy.action !== "approve" && runtime.plugin.resolveAnnotations) {
          const map = yield* runtime.plugin
            .resolveAnnotations({
              ctx: runtime.ctx,
              integration: parsed.integration,
              connection: parsed.connection,
              toolRows: [row],
            })
            .pipe(wrapInvocationError);
          resolvedAnnotations = map[String(parsed.tool)] ?? annotations;
        }
        yield* enforceApproval(resolvedAnnotations, address, args, policy, handler);

        // Resolve every named credential input (`variable → value`); `value` is
        // the primary `token` for single-input + OAuth callers.
        const values = yield* resolveConnectionValues(connectionRow);
        const integrationRow = yield* findIntegrationRow(parsed.integration);
        const credential: ToolInvocationCredential = {
          owner: parsed.owner,
          integration: parsed.integration,
          connection: parsed.connection,
          template: AuthTemplateSlug.make(connectionRow.template),
          value: values[PRIMARY_INPUT_VARIABLE] ?? null,
          values,
          config: integrationRow ? decodeJsonColumn(integrationRow.config) : undefined,
        };

        return yield* wrapInvocationError(
          runtime.plugin.invokeTool({
            ctx: runtime.ctx,
            toolRow: row,
            credential,
            args,
            elicit: buildElicit(address, args, handler),
          }),
        );
      }).pipe(
        // Expected tool failures (`ToolResult.fail`) resolve through the
        // success channel, so the tracer alone would record them as healthy
        // spans. Stamp the outcome + error code so telemetry can distinguish
        // "tool ran fine" from "user hit an upstream error / auth wall"
        // without parsing response bodies.
        Effect.tap(annotateToolResultOutcome),
        Effect.withSpan("executor.tool.execute", {
          attributes: {
            "mcp.tool.name": String(address),
            "executor.tenant": tenant,
            ...(subject != null ? { "executor.subject": subject } : {}),
          },
        }),
      );
    };

    // ------------------------------------------------------------------
    // OAuth service seam.
    // ------------------------------------------------------------------

    const oauth = makeOAuthService({
      fuma,
      owner: ownerBinding,
      tenant,
      subject,
      ownedKeys: (owner: Owner) => ownedKeys(owner),
      defaultWritableProvider,
      mintOAuthConnection: (input: MintOAuthConnectionInput) => mintOAuthConnection(input),
      // Resolve the integration's DECLARED oauth scopes for a (integration,
      // template): load the row, run the owning plugin's auth-method projector,
      // and return the matching oauth method's declared `oauth.scopes`. Drives
      // the union-with-client-scopes request in `oauth.start` so reusing a narrow
      // client on a broad integration still requests the integration's full
      // scope set. Empty (no row / no oauth method / no declared scopes) ⇒ the
      // union collapses to the client's scopes (current behavior).
      resolveDeclaredOAuthScopes: (integration: IntegrationSlug, template: AuthTemplateSlug) =>
        findIntegrationRow(integration).pipe(
          Effect.map((row): readonly string[] => {
            if (!row) return [];
            const methods = describeAuthMethodsForRow(row);
            const match =
              methods.find(
                (m: AuthMethodDescriptor) => m.kind === "oauth" && m.template === String(template),
              ) ?? methods.find((m: AuthMethodDescriptor) => m.kind === "oauth");
            return match?.oauth?.scopes ?? [];
          }),
        ),
      httpClientLayer: config.httpClientLayer,
      endpointUrlPolicy: config.oauthEndpointUrlPolicy,
      // EXPLICIT — no localhost default. When a caller omits `redirectUri` the
      // OAuth service receives `null` and redirect-requiring flows fail loudly
      // instead of silently using `http://127.0.0.1/callback`. Hosts that serve
      // OAuth (cloud, self-host) derive a real `${webBaseUrl}/oauth/callback`.
      redirectUri: config.redirectUri ?? null,
    });

    // ------------------------------------------------------------------
    // Plugin wiring — build ctx, run extension, populate static pools,
    // register credential providers.
    // ------------------------------------------------------------------

    const blobPartitions: OwnerPartitions = {
      org: `o:${tenant}`,
      user: subject != null ? `u:${tenant}:${subject}` : null,
    };

    for (const plugin of plugins) {
      if (runtimes.has(plugin.id)) {
        return yield* new StorageError({
          message: `Duplicate plugin id: ${plugin.id}`,
          cause: undefined,
        });
      }

      const pluginStorage = makePluginStorageFacade({
        core,
        pluginId: plugin.id,
        owner: ownerBinding,
      });
      const storageDeps: StorageDeps = {
        owner: ownerBinding,
        blobs: pluginBlobStore(blobs, blobPartitions, plugin.id),
        pluginStorage,
      };
      const storage = plugin.storage(storageDeps);

      const ctx: PluginCtx<unknown> = {
        owner: ownerBinding,
        storage,
        pluginStorage,
        httpClientLayer: config.httpClientLayer ?? FetchHttpClient.layer,
        core: {
          integrations: {
            register: (input: RegisterIntegrationInput) => integrationsRegister(plugin.id, input),
            update: (slug, patch) => integrationsUpdate(slug, patch),
            list: () => integrationsList(),
            get: (slug) => integrationsGetRecord(slug),
            remove: (slug) => integrationsRemove(slug),
            detect: (url) => integrationsDetect(url),
            configureSchemas: (): readonly IntegrationConfigureSchema[] =>
              Array.from(runtimes.values())
                .map(({ plugin }) =>
                  plugin.integrationConfigure
                    ? {
                        pluginId: plugin.id,
                        type: plugin.integrationConfigure.type,
                        schema: undefined,
                      }
                    : undefined,
                )
                .filter(Predicate.isNotUndefined),
            presets: (): readonly IntegrationPresetCatalogEntry[] =>
              Array.from(runtimes.values()).flatMap(({ plugin }) =>
                (plugin.integrationPresets ?? []).map((preset) => ({
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
        },
        connections: {
          create: (input) => connectionsCreate(input),
          list: (filter) => connectionsList(filter),
          get: (ref) => connectionsGet(ref),
          remove: (ref) => connectionsRemove(ref),
          refresh: (ref) => connectionsRefresh(ref),
          resolveValue: (ref) => resolveConnectionValueByRef(ref),
        },
        providers: {
          list: () => providersList(),
          items: (key) => providersItems(key),
        },
        oauth,
        transaction: <A, E>(effect: Effect.Effect<A, E>) => transaction(effect),
      };

      // Build extension FIRST so it's available as `self` for staticSources.
      const extension: object = plugin.extension ? plugin.extension(ctx) : {};
      if (plugin.extension) {
        extensions[plugin.id] = extension;
      }

      const decls = plugin.staticSources ? plugin.staticSources(extension) : [];
      for (const source of decls) {
        const mountUnderExecutor = source.kind === "executor";
        const mountedSource = mountUnderExecutor ? EXECUTOR_SOURCE : source;
        for (const tool of source.tools) {
          const mountedTool = mountUnderExecutor
            ? { ...tool, name: `${source.id}.${tool.name}` }
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

      if (plugin.credentialProviders) {
        const raw =
          typeof plugin.credentialProviders === "function"
            ? plugin.credentialProviders(ctx)
            : plugin.credentialProviders;
        const providers = Effect.isEffect(raw)
          ? yield* raw.pipe(
              Effect.mapError((cause) =>
                pluginStorageFailure(plugin.id, "credentialProviders", cause),
              ),
            )
          : raw;
        for (const provider of providers) {
          yield* registerCredentialProvider(provider, `plugin ${plugin.id}`);
        }
      }
    }

    // ------------------------------------------------------------------
    // close
    // ------------------------------------------------------------------

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

    const base = {
      integrations: {
        list: integrationsList,
        get: integrationsGet,
        update: integrationsUpdatePublic,
        remove: integrationsRemove,
        detect: integrationsDetect,
      },
      connections: {
        create: connectionsCreate,
        list: connectionsList,
        get: connectionsGet,
        remove: connectionsRemove,
        refresh: connectionsRefresh,
      },
      oauth,
      tools: {
        list: toolsList,
        schema: toolSchema,
      },
      providers: {
        list: providersList,
        items: providersItems,
      },
      policies: {
        list: policiesList,
        create: policiesCreate,
        update: policiesUpdate,
        remove: policiesRemove,
        resolve: policiesResolve,
      },
      execute,
      close,
    };

    const toExecutor = (value: unknown): Executor<TPlugins> => value as Executor<TPlugins>;
    return toExecutor(Object.assign(base, extensions));
  });

// Helper alias so the inline literal used for the optimistic projection in
// `produceConnectionTools` satisfies the ToolRow shape.
type ConnectionToolRow = ToolRow;
