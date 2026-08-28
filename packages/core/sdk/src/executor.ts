import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Inspectable,
  Layer,
  Option,
  Predicate,
  Schema,
  Semaphore,
} from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { fumadb } from "@executor-js/fumadb";
import { memoryAdapter } from "@executor-js/fumadb/adapters/memory";
import { withQueryContext, type Condition, type ConditionBuilder } from "@executor-js/fumadb/query";
import { schema as fumaSchema, type RelationsMap } from "@executor-js/fumadb/schema";
import type { AnyColumn } from "@executor-js/fumadb/schema";
import {
  StorageError,
  afterCommit,
  isStorageFailure,
  makeFumaClient,
  type FumaDb,
  type FumaRow,
  type FumaTables,
  type StorageFailure,
} from "./fuma-runtime";
import { makeFumaBlobStore, pluginBlobStore, type BlobStore, type OwnerPartitions } from "./blob";
import { makePendingApprovalStore, type PendingApprovalStore } from "./pending-approval";
import { coreToolsPlugin } from "./core-tools";
import type {
  Connection,
  ConnectionInputOrigin,
  ConnectionRef,
  CreateConnectionInput,
  ConnectionValueInput,
  UpdateConnectionInput,
  ValidateConnectionInput,
} from "./connection";
import { HealthCheckResult, HealthCheckSpec } from "./health-check";
import type { HealthCheckCandidate } from "./health-check";
import {
  ARTIFACT_SUMMARY_COLUMNS,
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
  rowToArtifact,
  rowToArtifactSummary,
  type Artifact,
  type ArtifactSummary,
  type RemoveArtifactInput,
  type RenameArtifactInput,
  type SaveArtifactInput,
  type SetArtifactPreviewInput,
} from "./artifact";
import {
  ArtifactNotFoundError,
  ConnectionAlreadyExistsError,
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
  ArtifactId,
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
  IntegrationChangeEvent,
  IntegrationConfig,
  IntegrationDisplayDescriptor,
  RegisterIntegrationInput,
} from "./integration";
import {
  makeOAuthService,
  STORE_WRITABILITY_PROBE_VALUE,
  storeWritabilityProbeItemIdFor,
  type MintOAuthConnectionInput,
  type OAuthScopePolicy,
} from "./oauth-service";
import { isFirstPartyOAuthClientSlug, type OAuthService } from "./oauth-client";
import type { FirstPartyOAuthClientConfig } from "./oauth-client";
import {
  comparePolicyRow,
  isValidPattern,
  matchPattern,
  positionForNewPattern,
  resolveEffectivePolicy,
  rowToToolPolicy,
  type CreateToolPolicyInput,
  type EffectivePolicy,
  type RemoveToolPolicyInput,
  type ToolPolicy,
  type UpdateToolPolicyInput,
} from "./policies";
import type { CredentialProvider, ProviderEntry } from "./provider";
import { touchSubject } from "./subject-registry";
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
  StaticIntegrationDecl,
  StaticToolDecl,
  StorageDeps,
  ToolPolicyProvider,
  ToolPolicyProviderRule,
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
  isPermanentTokenRejection,
  isUnusableSuccessTokenResponse,
  shouldRefreshToken,
  type OAuth2TokenResponse,
  type OAuthEndpointUrlPolicy,
} from "./oauth-helpers";
import {
  ENTERPRISE_MANAGED_PROVIDER_STATE_KEY,
  enterpriseManagedStateFrom,
  mintEnterpriseManagedAccessToken,
  type EnterpriseManagedMintError,
  type EnterpriseManagedRollout,
} from "./oauth-ema";
import { connectionIdentifier } from "./connection-name-identifier";
import { annotateToolResultOutcome, isToolResult } from "./tool-result";
import { makeShapeMemory, observedShapeToJsonSchema, SHAPE_MEMORY_PLUGIN_ID } from "./shape-memory";
import { isUnauthorizedToolFailure } from "./auth-tool-failure";

const PLUGIN_STORAGE_DELETE_KEY_BATCH_SIZE = 90;
const PLUGIN_STORAGE_CREATE_ROW_BATCH_SIZE = 90;
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
      patch: { readonly name?: string; readonly description?: string },
    ) => Effect.Effect<void, IntegrationNotFoundError | StorageFailure>;
    readonly remove: (
      slug: IntegrationSlug,
    ) => Effect.Effect<void, IntegrationRemovalNotAllowedError | StorageFailure>;
    readonly detect: (
      url: string,
    ) => Effect.Effect<readonly IntegrationDetectionResult[], StorageFailure>;
    /** The integration's declared health check: which authenticated operation a
     *  connection runs to prove its credential is alive and surface whose
     *  account it is. Configured by the user the same way auth methods are. */
    readonly healthCheck: {
      /** The currently declared check, or null when none is configured (or the
       *  owning plugin has no health-check capability). */
      readonly get: (
        slug: IntegrationSlug,
      ) => Effect.Effect<HealthCheckSpec | null, StorageFailure>;
      /** The operations a user can pick from, ranked non-destructive-first then
       *  fewest required arguments. Empty when the plugin has no candidates. */
      readonly candidates: (
        slug: IntegrationSlug,
      ) => Effect.Effect<
        readonly HealthCheckCandidate[],
        IntegrationNotFoundError | StorageFailure
      >;
      /** Declare (or clear, with `null`) the health check for the integration. */
      readonly set: (
        slug: IntegrationSlug,
        spec: HealthCheckSpec | null,
      ) => Effect.Effect<void, IntegrationNotFoundError | StorageFailure>;
    };
  };

  readonly connections: {
    readonly create: (
      input: CreateConnectionInput,
    ) => Effect.Effect<
      Connection,
      | IntegrationNotFoundError
      | ConnectionAlreadyExistsError
      | CredentialProviderNotRegisteredError
      | InvalidConnectionInputError
      | StorageFailure
    >;
    readonly list: (filter?: {
      readonly integration?: IntegrationSlug;
      readonly owner?: Owner;
    }) => Effect.Effect<readonly Connection[], StorageFailure>;
    readonly get: (ref: ConnectionRef) => Effect.Effect<Connection | null, StorageFailure>;
    /** Edit user-curated metadata (description, identityLabel). Credentials and
     *  OAuth lifecycle fields are not editable here. */
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
    /** Run the integration's declared health check against a saved connection:
     *  classify the credential (healthy / expired / degraded / unknown) and
     *  extract its identity for display. Never throws on an auth wall or upstream
     *  error: those come back as a `HealthCheckResult` with the matching status. */
    readonly checkHealth: (
      ref: ConnectionRef,
      options?: {
        /** Return the persisted verdict when younger than this; probe
         *  otherwise. Omit to always probe. */
        readonly ifStaleMs?: number;
      },
    ) => Effect.Effect<
      HealthCheckResult,
      ConnectionNotFoundError | IntegrationNotFoundError | StorageFailure
    >;
    /** Validate an in-flight credential WITHOUT saving it (key-first connect):
     *  resolve the pasted value(s), run the health check, and return the result
     *  so the caller can confirm the key works and derive a name from the
     *  identity before creating the connection. */
    readonly validate: (
      input: ValidateConnectionInput,
    ) => Effect.Effect<HealthCheckResult, IntegrationNotFoundError | StorageFailure>;
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

  /**
   * The PLATFORM VIEW: read-only, tenant-wide reads across every subject.
   * Present only when the executor was built with `platformView: true`
   * (default off) — every other surface on this executor stays bound to the
   * single `{ tenant, subject }` product view and is unaffected by this one.
   * Internal admin surface; the public HTTP shape is a separate concern.
   */
  readonly admin?: ExecutorAdmin;
  /** Saved generative-UI artifacts, visible to the bound owner scope. */
  readonly artifacts: {
    /** Newest first, without the JSX source — lists stay light. */
    readonly list: () => Effect.Effect<readonly ArtifactSummary[], StorageFailure>;
    readonly get: (id: string) => Effect.Effect<Artifact, ArtifactNotFoundError | StorageFailure>;
    /** Create, or overwrite an existing artifact in place when `id` is given. */
    readonly save: (
      input: SaveArtifactInput,
    ) => Effect.Effect<Artifact, ArtifactNotFoundError | StorageFailure>;
    readonly rename: (
      input: RenameArtifactInput,
    ) => Effect.Effect<Artifact, ArtifactNotFoundError | StorageFailure>;
    readonly remove: (input: RemoveArtifactInput) => Effect.Effect<void, StorageFailure>;
    /** Upgrade the stored preview to a snapshot of a settled render. Touches
     *  only `preview`, and never `updated_at`. */
    readonly setPreview: (
      input: SetArtifactPreviewInput,
    ) => Effect.Effect<void, ArtifactNotFoundError | StorageFailure>;
  };

  /**
   * Approvals recorded for artifact-originated calls that paused on a human.
   *
   * Scoped to this executor's owner, so a record is only readable by the caller
   * who created it — the ownership check on resume is the same read that fetches
   * it. See `pending-approval.ts` for why an artifact pause is reconstructible
   * when a general codemode pause is not.
   */
  readonly pendingApprovals: PendingApprovalStore;

  readonly execute: (
    address: ToolAddress,
    args: unknown,
    options?: InvokeOptions,
  ) => Effect.Effect<unknown, ExecuteError>;

  readonly close: () => Effect.Effect<void, StorageFailure>;
} & PluginExtensions<TPlugins>;

// ---------------------------------------------------------------------------
// The platform view — internal admin reads.
//
// Everything else on the executor is the PRODUCT view: bound to one
// { tenant, subject }. This is the read-only escape hatch beside it, reading
// the same store through a `reach: "tenant"` context so it can answer
// "who exists under this tenant, and what have they connected".
//
// Vocabulary note: internal code says subject/tenant/reach. Anything
// public-facing says users/owners — the translation happens at the HTTP edge,
// not here.
//
// FIELD DISCIPLINE: these shapes are a hand-picked allowlist, not a projection
// of the row. Nothing secret-bearing may appear — no `item_ids`, no
// `refresh_item_id`, no oauth client secrets, no credential material of any
// kind. Adding a field here is a deliberate act.
// ---------------------------------------------------------------------------

/** One principal seen under the tenant (a row of the `subject` table). */
export interface AdminSubject {
  /** The host-auth principal id. Opaque — it also carries host sentinels
   *  like "local", so nothing may parse it. */
  readonly externalId: string;
  readonly createdAt: Date;
  /** Epoch ms of the last sighting on the request path; null when never seen
   *  (a subject can be created at connection-create before any sighting). */
  readonly lastSeenAt: number | null;
  readonly status: string | null;
}

/** A connection as the platform view sees it: enough to answer "what has this
 *  user connected and is it healthy", and nothing that could resolve a
 *  credential. */
export interface AdminConnection {
  readonly owner: Owner;
  /** The owning principal — `null` for org-owned connections, which belong to
   *  the tenant rather than to any one user. */
  readonly subject: string | null;
  readonly integration: IntegrationSlug;
  readonly name: ConnectionName;
  /** The scope set the provider actually granted, space-delimited as recorded
   *  at connect/refresh. Null for static credentials. A summary of ACCESS —
   *  never a token. */
  readonly oauthScope: string | null;
  readonly lastHealth: HealthCheckResult | null;
}

/** A subject together with every connection it owns in the tenant. */
export interface AdminSubjectWithConnections extends AdminSubject {
  readonly connections: readonly AdminConnection[];
}

export interface AdminListSubjectsOptions {
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Page size applied when a caller names none. Every admin list is BOUNDED:
 * `listSubjects()` with no arguments is the obvious call, and unbounded it
 * returns every subject in the tenant — an unbounded row count to build,
 * serialize, and ship, and an unbounded `in` predicate for the joined read to
 * carry. A default is what keeps the no-args call honest; a caller who wants
 * more asks for more, up to {@link ADMIN_MAX_PAGE_SIZE}.
 *
 * 100 rather than the maximum: large enough that no realistic operator UI pages
 * twice for a first screen, small enough that one response stays a bounded
 * amount of work even at its worst.
 */
export const ADMIN_DEFAULT_PAGE_SIZE = 100;

/** Hard ceiling on an admin page, matching the HTTP contract's `limit` maximum.
 *  A larger `limit` is clamped rather than honored. */
export const ADMIN_MAX_PAGE_SIZE = 500;

/**
 * Normalize paging for every admin list.
 *
 * THREE things happen here, each fixing a real failure:
 *   - a `limit` is ALWAYS produced. Drizzle's SQLite dialect emits OFFSET only
 *     alongside LIMIT, and SQLite rejects a bare OFFSET, so `{ offset: 25 }`
 *     was a syntax error on every SQLite host (local, self-host, D1).
 *   - the limit is clamped to `[1, ADMIN_MAX_PAGE_SIZE]`, so no caller can ask
 *     for an unbounded scan.
 *   - both values are floored to integers. The HTTP contract rejects a
 *     fractional `?limit=` outright (a 400, not a coerced value); this is the
 *     SDK-level backstop so no driver ever receives a fraction and answers with
 *     `datatype mismatch`.
 */
const normalizeAdminPaging = (
  options: AdminListSubjectsOptions | undefined,
): { readonly limit: number; readonly offset: number } => {
  const requested = options?.limit ?? ADMIN_DEFAULT_PAGE_SIZE;
  const limit = Math.min(Math.max(Math.floor(requested), 1), ADMIN_MAX_PAGE_SIZE);
  const offset = Math.max(Math.floor(options?.offset ?? 0), 0);
  return { limit, offset };
};

export interface ExecutorAdmin {
  /** One page of subjects under the tenant, oldest first (stable: ties break on
   *  `external_id`). ALWAYS bounded: no arguments means
   *  {@link ADMIN_DEFAULT_PAGE_SIZE} rows from offset 0, and `limit` is clamped
   *  to {@link ADMIN_MAX_PAGE_SIZE}. There is no way to ask for every subject
   *  in one call. */
  readonly listSubjects: (
    options?: AdminListSubjectsOptions,
  ) => Effect.Effect<readonly AdminSubject[], StorageFailure>;
  /**
   * One subject by its `external_id`, or `null` when the tenant has no such
   * row. A keyed read on the `(tenant, external_id)` unique index rather than
   * a filtered `listSubjects`, because the caller asking for ONE principal
   * must not pay for a tenant-wide scan — this is the read behind a per-user
   * check that runs far more often than the bulk list.
   *
   * `null` is a normal answer, not a failure: it means "this tenant has never
   * recorded that principal". Distinguishing that from a storage fault is the
   * whole point of the nullable return.
   */
  readonly getSubject: (externalId: string) => Effect.Effect<AdminSubject | null, StorageFailure>;
  /** Every connection in the tenant owned by `externalId`. Org-owned
   *  connections are NOT attributed to a user and are excluded. */
  readonly listSubjectConnections: (
    externalId: string,
  ) => Effect.Effect<readonly AdminConnection[], StorageFailure>;
  /** `listSubjects` joined with each subject's connections in TWO queries —
   *  the page of subjects, then one batched connection read over that page.
   *  The cost does not scale with page size, so {@link ADMIN_DEFAULT_PAGE_SIZE}
   *  and {@link ADMIN_MAX_PAGE_SIZE} bound the ROWS returned rather than the
   *  round trips taken. A subject with no connections reports an empty array;
   *  it is never dropped from the page. */
  readonly listSubjectsWithConnections: (
    options?: AdminListSubjectsOptions,
  ) => Effect.Effect<readonly AdminSubjectWithConnections[], StorageFailure>;
  /** `getSubject` joined with that subject's connections, in ONE call — the
   *  shape a per-user check needs. `null` on the same terms as `getSubject`,
   *  and no connection read is issued when the subject row is absent. */
  readonly getSubjectWithConnections: (
    externalId: string,
  ) => Effect.Effect<AdminSubjectWithConnections | null, StorageFailure>;
}

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
   * Fetch API implementation for dependencies that cannot consume `httpClientLayer`.
   * Prefer `httpClientLayer` for normal SDK and plugin HTTP.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * The OAuth callback URL (`${webBaseUrl}/oauth/callback`) the host serves and
   * sends to providers. There is NO localhost default: omit it (or pass
   * undefined) only for executors that never run interactive OAuth — the
   * redirect-requiring flows then fail loudly instead of guessing a callback.
   * Hosts serving OAuth derive this from the request origin / web base URL.
   */
  readonly redirectUri?: string;
  /** Optional URL selected organization slug to carry inside OAuth `state`. */
  readonly oauthCallbackStateOrgSlug?: string;
  readonly oauthEndpointUrlPolicy?: OAuthEndpointUrlPolicy;
  /**
   * Host-owned rollout gate for enterprise-managed authorization (the MCP EMA
   * profile). Core declares the port and depends on no feature-flag or
   * analytics vendor; a host that operates one supplies an implementation.
   *
   * ROLLOUT SEMANTIC: the gate decides only whether a NEW connect may attempt
   * the enterprise-managed path. It is consulted once per `oauth.start` on an
   * `id_jag` client, before discovery, and never after the identity provider
   * has ruled. The verdict is then frozen onto the connection's
   * `provider_state`, and the credential-refresh path
   * (`performEnterpriseManagedRefresh`) follows that stored state rather than
   * re-evaluating — so switching the flag off never strands or downgrades an
   * existing enterprise-managed connection, and no third-party network
   * dependency ever enters credential resolution.
   *
   * Omitted -> enterprise-managed authorization is attempted, which is exactly
   * what every host did before this seam existed.
   */
  readonly enterpriseManagedRollout?: EnterpriseManagedRollout;
  /**
   * Host-operated OAuth apps (the deployment's own registered GitHub/Google/…
   * apps), addressed as `first-party:<name>`. Users connect through them with
   * nothing to paste. Config-resolved — never persisted; secrets stay in host
   * env and are never written to a credential provider or returned over any
   * read surface. Minted connections and their tokens remain per-owner.
   */
  readonly firstPartyOAuthClients?: readonly FirstPartyOAuthClientConfig[];
  /**
   * Enable the built-in `core-tools` plugin which contributes agent-facing
   * static tools over the v2 surface (integrations / connections / policies).
   */
  readonly coreTools?: {
    readonly webBaseUrl?: string;
    readonly orgSlug?: string;
    readonly includeProviders?: boolean;
  };
  /**
   * How long a connection's persisted tool catalog stays fresh when its plugin
   * lists a live remote catalog (`plugin.remoteToolCatalog`, e.g. MCP servers,
   * whose tool sets change server-side with no executor-visible signal). Once
   * older than this, the catalog is re-listed on the next tools read. Defaults
   * to 15 minutes; pass `null` to disable time-based re-sync (stale-mark and
   * config-revision re-sync still apply).
   */
  readonly toolsSyncTtlMs?: number | null;
  /**
   * How long a tools read WAITS for stale-catalog rebuilds before answering
   * from the persisted rows. Rebuilds keep running past the deadline (see
   * `waitUntil`) and land on a later read; the read itself never pays more
   * than this for upstream listings it did not ask for. Defaults to 2
   * seconds; pass `null` to block until every rebuild finishes (the strict
   * mode: a read then always reflects a fully converged catalog).
   */
  readonly toolsSyncGraceMs?: number | null;
  /**
   * Host keep-alive for background work that outlives a request — the
   * platform `waitUntil` on Cloudflare Workers, where I/O started inside a
   * request is cancelled once the response settles unless a host holds the
   * context open. Long-lived processes (self-host, CLI, tests) omit it;
   * their detached fibers simply run to completion.
   */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Notified after a durable integration-catalog change commits (a row
   * created or removed). Best-effort observation only: the notification runs
   * AFTER the transaction, its failures are swallowed, and it cannot affect
   * the operation's outcome. Hosts use it for product analytics; core stays
   * analytics-agnostic.
   */
  readonly onIntegrationChange?: (event: IntegrationChangeEvent) => Effect.Effect<void>;
  /**
   * Opt into the PLATFORM VIEW: a read-only, tenant-wide `executor.admin`
   * surface that reads across every subject in the tenant (see
   * {@link ExecutorAdmin}). Default OFF — `admin` is simply absent, so the
   * escape hatch has to be asked for by a host that has authorized an
   * org-level caller.
   *
   * Enabling it makes the WHOLE executor read-only, not just `admin`: the base
   * owner context carries `writes: "denied"`, so `connections`, `policies`,
   * `integrations` and `oauth` refuse every create/update/delete at the storage
   * boundary. An executor built for an org-level caller is an observer, and
   * `admin` being its only tenant-wide surface is not the same as it being its
   * only guarded one.
   *
   * READS still differ by surface: only `admin` is tenant-wide. Every other
   * surface stays bound to `{ tenant, subject }` — widening them would expose
   * every subject's connection rows, credential item ids included.
   */
  readonly platformView?: boolean;
}

/** Default freshness window for remote-catalog connections (see
 *  `ExecutorConfig.toolsSyncTtlMs`). */
export const DEFAULT_TOOLS_SYNC_TTL_MS = 15 * 60 * 1000;

/** Default wait budget a tools read spends on stale-catalog rebuilds before
 *  answering from the persisted rows (see `ExecutorConfig.toolsSyncGraceMs`).
 *  Sized to cover a healthy upstream re-list (one handshake + one
 *  `tools/list`) while keeping a read gated on a slow or dead server bounded
 *  well under any per-connection network timeout. */
export const DEFAULT_TOOLS_SYNC_GRACE_MS = 2000;

/** How many stale connection catalogs are DISCOVERED at once on a tools read.
 *  Bounded so a host with a large stale set cannot open an unbounded number of
 *  upstream listings from a single read. Only the discovery phase runs at this
 *  width; each rebuild's catalog write is serialized behind a single permit. */
export const STALE_TOOLS_SYNC_CONCURRENCY = 10;

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

// oxlint-disable executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: render an arbitrary failure into one readable log field
/** One-line rendering of a failed rebuild, for the operator-facing warning.
 *  A `StorageError` carries the actionable detail in its `cause` (the plugin's
 *  own failure) while its own message only names the hook, and structural
 *  stringification drops a `cause` that is an `Error` — so unwrap one level and
 *  keep both halves. */
const describeSyncFailure = (error: unknown): string => {
  const base =
    error instanceof Error && error.message.length > 0
      ? error.message
      : Inspectable.toStringUnknown(error, 0);
  const cause = (error as { readonly cause?: unknown } | null | undefined)?.cause;
  if (cause instanceof Error && cause.message.length > 0) return `${base}: ${cause.message}`;
  return base;
};
// oxlint-enable executor/no-instanceof-error, executor/no-unknown-error-message

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
  display?: IntegrationDisplayDescriptor,
): Integration => ({
  slug: IntegrationSlug.make(row.slug),
  // Pre-split rows have no `name`; their description WAS the display name.
  name: row.name ?? row.description ?? row.slug,
  // `description` is now nullable (cleared where it only held a duplicated
  // title); present it as "" so the public Integration type stays a string.
  description: row.description ?? "",
  kind: row.plugin_id,
  canRemove: Boolean(row.can_remove),
  canRefresh: Boolean(row.can_refresh),
  authMethods,
  ...(display?.url ? { displayUrl: display.url } : {}),
  ...(display?.family ? { family: display.family } : {}),
});

const rowToIntegrationRecord = (
  row: IntegrationRow,
  authMethods: readonly AuthMethodDescriptor[] = [],
): IntegrationRecord => ({
  ...rowToIntegration(row, authMethods),
  config: decodeJsonColumn(row.config),
});

const decodeLastHealth = Schema.decodeUnknownOption(HealthCheckResult);
const decodeHealthCheckSpec = Schema.decodeUnknownOption(HealthCheckSpec);

const missingOAuthScopesFromProviderState = (value: unknown): readonly string[] => {
  const decoded = decodeJsonColumn(value);
  if (decoded == null || typeof decoded !== "object" || Array.isArray(decoded)) return [];
  const scopes = (decoded as Record<string, unknown>).missingOAuthScopes;
  return Array.isArray(scopes)
    ? scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
};

/** The definitive refresh rejection recorded on `provider_state`, or null.
 *  Set when the AS rejects the grant itself (RFC 6749 invalid_grant — retrying
 *  cannot change the verdict); cleared by the reconnect mint, which rewrites
 *  `provider_state` wholesale. While set, refresh attempts are skipped. */
const decodeOAuthReauthRequiredProviderState = Schema.decodeUnknownOption(
  Schema.Struct({
    oauthReauthRequiredAt: Schema.Number,
    oauthReauthRequiredDetail: Schema.optional(Schema.String),
  }),
);

const oauthReauthRequiredFromProviderState = (value: unknown) =>
  Option.getOrNull(decodeOAuthReauthRequiredProviderState(decodeJsonColumn(value)));

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
    description: row.description ?? null,
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    oauthClient: row.oauth_client == null ? null : OAuthClientSlug.make(String(row.oauth_client)),
    oauthClientOwner:
      row.oauth_client_owner == null ? null : (String(row.oauth_client_owner) as Owner),
    oauthScope: row.oauth_scope == null ? null : String(row.oauth_scope),
    missingOAuthScopes: missingOAuthScopesFromProviderState(row.provider_state),
    lastHealth: Option.getOrNull(decodeLastHealth(row.last_health)),
  };
};

/** Parse a connection row's `oauth_scope` (space-delimited, as echoed by the
 *  token endpoint) into the credential's `grantedScopes`. Undefined when the
 *  row carries none, so scope comparisons downstream fail open. */
const grantedScopesFromRow = (row: {
  readonly oauth_scope?: unknown;
}): readonly string[] | undefined => {
  if (row.oauth_scope == null) return undefined;
  const scopes = String(row.oauth_scope).split(/\s+/).filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
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
      for (
        let offset = 0;
        offset < uniqueEntries.length;
        offset += PLUGIN_STORAGE_CREATE_ROW_BATCH_SIZE
      ) {
        const batchEntries = uniqueEntries.slice(
          offset,
          offset + PLUGIN_STORAGE_CREATE_ROW_BATCH_SIZE,
        );
        yield* input.core.createMany(
          "plugin_storage",
          batchEntries.map((entry) => ({
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
      }
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
  readonly integration: StaticIntegrationDecl;
  readonly tool: StaticToolDecl;
  readonly pluginId: string;
  readonly ctx: PluginCtx<unknown>;
}

interface PluginRuntime {
  readonly plugin: AnyPlugin;
  readonly storage: unknown;
  readonly ctx: PluginCtx<unknown>;
}

const EXECUTOR_INTEGRATION_ID = "executor";
const EXECUTOR_INTEGRATION: StaticIntegrationDecl = {
  id: EXECUTOR_INTEGRATION_ID,
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
            orgSlug: config.coreTools.orgSlug,
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

    // The platform view is read-only ACROSS THE WHOLE EXECUTOR, not just on the
    // `admin` handle: `writes: "denied"` rides on the base context, so
    // `connections`, `policies`, `integrations` and `oauth` are guarded by the
    // owner policy too. Without it a platform executor is subject-less but
    // still bound to the tenant's ORG partition, and could create/update/delete
    // every `owner: "org"` row through those ordinary surfaces.
    //
    // Deliberately NOT `reach: "tenant"` here — that would widen this context's
    // reads to every subject's `connection` rows, credential item ids included.
    // Reach stays "bound"; only the write axis changes. See
    // `ExecutorOwnerPolicyContext.writes`.
    const ownerContext: ExecutorOwnerPolicyContext = {
      tenant,
      subject,
      ...(config.platformView === true ? { writes: "denied" as const } : {}),
    };
    const rootDb = withQueryContext(rootDbUntyped, ownerContext);
    const fuma = makeFumaClient(rootDb);
    const core = makeCoreDb(fuma);
    const blobs = config.blobs ?? makeFumaBlobStore(fuma);
    const transaction = <A, E>(effect: Effect.Effect<A, E>) => fuma.transaction(effect);

    // Runtime-observed output shapes ("muscle memory"): learned on the
    // execute success path, served by tools.schema when a tool declares no
    // output schema. Backed by plugin_storage under a reserved system id.
    const shapeMemory = makeShapeMemory(
      makePluginStorageFacade({ core, pluginId: SHAPE_MEMORY_PLUGIN_ID, owner: ownerBinding }),
    );

    // Populated once, never mutated after startup.
    const staticTools = new Map<string, StaticTools>();
    const runtimes = new Map<string, PluginRuntime>();
    let activeToolPolicyProvider: ToolPolicyProvider | null = null;
    // Credential providers keyed by `provider.key`, in registration order.
    const credentialProviders = new Map<string, CredentialProvider>();
    const credentialProviderOrder: string[] = [];

    const staticToolOwner = (): Owner => (subject == null ? "org" : "user");
    const staticToolConnection = (integration: StaticIntegrationDecl): ConnectionName =>
      ConnectionName.make(integration.id === EXECUTOR_INTEGRATION_ID ? "coreTools" : "static");

    const staticIntegrations = (): readonly StaticIntegrationDecl[] => {
      const byId = new Map<string, StaticIntegrationDecl>();
      for (const entry of staticTools.values()) {
        if (!byId.has(entry.integration.id)) byId.set(entry.integration.id, entry.integration);
      }
      return [...byId.values()];
    };

    const staticDeclToIntegration = (integration: StaticIntegrationDecl): Integration => ({
      slug: IntegrationSlug.make(integration.id),
      name: integration.name,
      description: integration.name,
      kind: integration.kind,
      canRemove: integration.canRemove ?? false,
      canRefresh: integration.canRefresh ?? false,
      authMethods: [],
    });

    const staticToolToTool = (entry: StaticTools): Tool => ({
      address: ToolAddress.make(`${entry.integration.id}.${entry.tool.name}`),
      owner: staticToolOwner(),
      integration: IntegrationSlug.make(entry.integration.id),
      connection: staticToolConnection(entry.integration),
      name: ToolName.make(entry.tool.name),
      pluginId: entry.pluginId,
      description: entry.tool.description,
      inputSchema: staticToolSchemaRoot(entry.tool.inputSchema, "input"),
      outputSchema: staticToolSchemaRoot(entry.tool.outputSchema, "output"),
      annotations: entry.tool.annotations,
      static: true,
    });

    /** How long a credential provider gets to answer one call.
     *
     *  A provider is frequently REMOTE — an HTTP secret store, or under sealed custody
     *  a vault that may live in another enclave — so "stopped answering" is one of its
     *  ordinary failure modes, not an exotic one. Without a bound, a vault that goes
     *  away does not fail a tool invocation, it hangs it, and nothing in the resulting
     *  silence names the provider.
     *
     *  Generous on purpose: this is a backstop against a dead dependency, not a latency
     *  budget. A store legitimately slower than this is better served by the operator
     *  hearing about it than by the request waiting indefinitely.
     *
     *  Executor already bounds its other remote calls this way — OAuth discovery, and
     *  the MCP plugin's probes. Credential resolution was the one that did not. */
    const CREDENTIAL_PROVIDER_TIMEOUT_MS = 30_000;

    /** Bound one provider call, failing with an error that names the provider and the
     *  operation — so the diagnostic points at the store rather than at whatever the
     *  caller happened to be doing. */
    const boundedCall = <A>(
      effect: Effect.Effect<A, StorageFailure>,
      key: string,
      operation: string,
    ): Effect.Effect<A, StorageFailure> =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(CREDENTIAL_PROVIDER_TIMEOUT_MS),
          orElse: () =>
            Effect.fail(
              new StorageError({
                message:
                  `Credential provider "${key}" did not answer ${operation} within ` +
                  `${CREDENTIAL_PROVIDER_TIMEOUT_MS}ms. The store is unreachable or not responding; ` +
                  `the credential was not resolved.`,
                cause: undefined,
              }),
            ),
        }),
      );

    /** Wrap a provider so every call it exposes is bounded.
     *
     *  Done once at the registration funnel rather than at each call site: every
     *  provider passes through here on its way in, rather than every call site
     *  remembering. The five methods `CredentialProvider` has today are named
     *  explicitly, so a sixth added to the interface must be added here too.
     *  Optional methods stay optional — a provider that cannot enumerate must not
     *  appear to. */
    const boundedProvider = (provider: CredentialProvider, key: string): CredentialProvider => {
      // Wrapping must change neither how the provider's methods are CALLED nor what the
      // object LOOKS like.
      //
      // Spreading would break the second: a spread copies only own ENUMERABLE properties, so
      // everything on a class's prototype — its methods, and accessors like `writable` — is
      // dropped silently. Nothing raises; the wrapper simply appears not to have the capability
      // and the caller takes a path the provider meant to own. `Object.create` keeps the whole
      // object reachable, including anything added to the interface later.
      //
      // Each bounded method is invoked ON the provider, which is the first half: a destructured
      // binding called bare loses `this`, and a class-based provider throws TypeError on its
      // first call. Every provider in this repo is an object literal and cannot notice either
      // problem, but "wrap any provider" is the whole point of this funnel.
      const bounded: Record<string, unknown> = {
        get: (id: ProviderItemId) => boundedCall(provider.get(id), key, "get"),
      };
      if (provider.has) {
        bounded.has = (id: ProviderItemId) => boundedCall(provider.has!(id), key, "has");
      }
      if (provider.set) {
        bounded.set = (id: ProviderItemId, value: string) =>
          boundedCall(provider.set!(id, value), key, "set");
      }
      if (provider.delete) {
        bounded.delete = (id: ProviderItemId) => boundedCall(provider.delete!(id), key, "delete");
      }
      if (provider.list) {
        bounded.list = () => boundedCall(provider.list!(), key, "list");
      }
      return Object.assign(Object.create(provider) as CredentialProvider, bounded);
    };

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
      credentialProviders.set(key, boundedProvider(provider, key));
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

    // Config-declared first-party apps, keyed by prefixed slug — the refresh
    // path's counterpart to the OAuth service's config-first resolution.
    const firstPartyOAuthBySlug = new Map(
      (config.firstPartyOAuthClients ?? []).map((client) => [`first-party:${client.name}`, client]),
    );

    /** The app identity a refresh runs against, uniformly resolved: a stored
     *  row's secret comes out of the credential provider by item id; a
     *  first-party app's comes from host config and never touches a provider. */
    interface RefreshClient {
      readonly clientId: string;
      readonly clientSecret: string;
      readonly tokenUrl: string;
      readonly grant: string;
      readonly resource: string | null;
    }

    /** What drove a refresh: the pre-call expiry check (`proactive`), or an
     *  upstream 401 on a token we believed was still valid (`reactive`). */
    type RefreshTrigger = "proactive" | "reactive";

    /** Record the AS's invalid_grant verdict on the row so later refreshes
     *  skip the doomed token request, and stamp `last_health` expired so the
     *  accounts list shows the dead connection at a glance instead of only
     *  after a manual probe. Merges into `provider_state` (preserving
     *  `missingOAuthScopes`); the reconnect mint rewrites the column wholesale,
     *  which is what re-arms refresh. Best-effort: a bookkeeping write failure
     *  must not mask the refresh failure being reported. */
    const markRefreshGrantDead = (
      row: ConnectionRow,
      detail: string,
    ): Effect.Effect<void, never> => {
      const existingState = decodeJsonColumn(row.provider_state);
      const mergedState =
        existingState != null && typeof existingState === "object" && !Array.isArray(existingState)
          ? (existingState as Record<string, unknown>)
          : {};
      const health: HealthCheckResult = {
        status: "expired",
        checkedAt: Date.now(),
        detail,
      };
      return core
        .updateMany("connection", {
          where: (b: AnyCb) =>
            b.and(
              byOwner(row.owner as Owner)(b),
              b("integration", "=", String(row.integration)),
              b("name", "=", String(row.name)),
            ),
          set: {
            provider_state: {
              ...mergedState,
              oauthReauthRequiredAt: Date.now(),
              oauthReauthRequiredDetail: detail,
            },
            last_health: health,
            updated_at: new Date(),
          },
        })
        .pipe(Effect.ignore);
    };

    /** Write a re-minted token back: a ROTATED refresh token into the refresh
     *  item, the access token into the connection's primary provider item, and
     *  the new expiry/scope onto the row. Shared by every grant so their
     *  persistence stays identical — the grants differ in how they mint, not in
     *  what a mint means.
     *
     *  The refresh token goes FIRST because the writes are not atomic and the
     *  two credentials are not equally replaceable. Minting rotated the refresh
     *  token, which spends the one we sent, so the new one is the only thing
     *  that can mint again; the access token is disposable and one more grant
     *  re-mints it. Persisting the access token first means a failure in
     *  between drops a single-use credential the authorization server has
     *  already consumed, and every later refresh comes back `invalid_grant` —
     *  a connection that silently disconnects itself.
     *
     *  `storedRefreshToken` is the value the store already held when the
     *  caller read it on the way in. Many authorization servers do NOT rotate
     *  on refresh and hand back the very same refresh token, so writing it
     *  again is a round trip that can only re-persist what is already there —
     *  and every write bumps the stored object's version, which is the
     *  contention this path spends retries fighting. Skip it when the value
     *  has not changed; a rotated token never matches, so the write that
     *  actually matters is never skipped. */
    const persistRefreshedToken = (
      row: ConnectionRow,
      provider: CredentialProvider,
      token: OAuth2TokenResponse,
      storedRefreshToken?: string | undefined,
    ): Effect.Effect<void, StorageFailure> =>
      Effect.gen(function* () {
        if (provider.set) {
          // OAuth is always single-input: the access token lives in the `token`
          // item. Fall back to a deterministic id if the map is somehow empty.
          const tokenItemId =
            connectionItemIds(row)[PRIMARY_INPUT_VARIABLE] ??
            `connection:${row.owner}:${row.integration}:${row.name}:${PRIMARY_INPUT_VARIABLE}`;
          if (
            token.refresh_token &&
            row.refresh_item_id &&
            token.refresh_token !== storedRefreshToken
          ) {
            yield* provider.set(ProviderItemId.make(row.refresh_item_id), token.refresh_token);
          }
          yield* provider.set(ProviderItemId.make(tokenItemId), token.access_token);
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
              byOwner(row.owner as Owner)(b),
              b("integration", "=", String(row.integration)),
              b("name", "=", String(row.name)),
            ),
          set,
        });
      });

    /** The rendered message of a typed enterprise-managed failure. */
    const enterpriseManagedMessage = (cause: EnterpriseManagedMintError): string =>
      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: every EMA error declares `message` as a getter over its own typed fields, so this is a projection of a typed failure, not a read off an unknown throwable
      cause.message;

    /** Re-mint an enterprise-managed access token: exchange the stored identity
     *  assertion for a fresh ID-JAG at the enterprise IdP, then redeem it at the
     *  MCP server's authorization server. Runs with no user interaction, which
     *  is the point of the profile.
     *
     *  The grant profile is NOT re-discovered here. It was confirmed when the
     *  connection was made and persisted as part of its enterprise state; a
     *  fresh discovery round trip on every renewal could only ever restate it.
     *
     *  Neither is the rollout gate (`ExecutorConfig.enterpriseManagedRollout`)
     *  re-consulted: this function does not receive it and must not. The flag
     *  gates whether a connection MAY BE MADE this way; a connection that
     *  already exists renews from its persisted state. Wiring the flag in here
     *  would mean an operator dialling the rollout back, or the flag service
     *  simply being unreachable, could strand or silently downgrade live
     *  credentials — and would put a third-party network dependency inside
     *  credential resolution, which is the last place one belongs. */
    const performEnterpriseManagedRefresh = (input: {
      readonly row: ConnectionRow;
      readonly provider: CredentialProvider;
      readonly client: RefreshClient;
      readonly tokenUrl: string;
      readonly scopes: readonly string[];
      readonly reauth: (message: string) => CredentialResolutionError;
    }): Effect.Effect<OAuth2TokenResponse, StorageFailure | CredentialResolutionError> =>
      Effect.gen(function* () {
        const { row, provider, client } = input;
        const owner = row.owner as Owner;
        const state = enterpriseManagedStateFrom(decodeJsonColumn(row.provider_state));
        if (state === null) {
          return yield* input.reauth(
            "This connection is missing its enterprise-managed authorization settings. Reconnect to continue.",
          );
        }
        const idpRow = yield* loadOAuthClientRow(state.idpClientOwner, state.idpClient);
        if (!idpRow) {
          return yield* input.reauth(
            `The enterprise identity provider OAuth app "${state.idpClient}" is no longer registered.`,
          );
        }
        if (!row.refresh_item_id) {
          return yield* input.reauth(
            "No enterprise identity assertion is stored for this connection.",
          );
        }
        const subjectToken = yield* provider.get(ProviderItemId.make(row.refresh_item_id));
        if (!subjectToken) {
          return yield* input.reauth(
            "The stored enterprise identity assertion could not be resolved.",
          );
        }
        const idpClientSecret = idpRow.client_secret_item_id
          ? ((yield* provider.get(ProviderItemId.make(String(idpRow.client_secret_item_id)))) ?? "")
          : "";

        const grant = yield* mintEnterpriseManagedAccessToken({
          idp: {
            tokenUrl: String(idpRow.token_url),
            clientId: String(idpRow.client_id),
            clientSecret: idpClientSecret,
          },
          resourceAuthorizationServer: {
            tokenUrl: input.tokenUrl,
            issuer: state.audience,
            clientId: client.clientId,
            clientSecret: client.clientSecret,
          },
          subjectToken,
          subjectTokenType: state.subjectTokenType,
          resource: client.resource,
          scopes: input.scopes,
          endpointUrlPolicy: config.oauthEndpointUrlPolicy,
          fetch: config.fetch,
        }).pipe(
          // A policy denial and a dead identity assertion are both definitive —
          // neither retries into success — but they are DIFFERENT products: one
          // is "your administrator has not allowed this", the other is "sign in
          // again". Only the transport failure stays a StorageError so the next
          // invoke retries it.
          Effect.catchTags({
            EmaPolicyDenied: (cause) =>
              Effect.fail(
                new CredentialResolutionError({
                  owner,
                  integration: IntegrationSlug.make(row.integration),
                  name: ConnectionName.make(row.name),
                  message: enterpriseManagedMessage(cause),
                  reauthRequired: true,
                  blockedByAdmin: true,
                  oauthErrorCode: cause.error,
                }),
              ),
            EmaSubjectTokenRejected: (cause) =>
              Effect.fail(
                new CredentialResolutionError({
                  owner,
                  integration: IntegrationSlug.make(row.integration),
                  name: ConnectionName.make(row.name),
                  message: enterpriseManagedMessage(cause),
                  reauthRequired: true,
                }),
              ),
            EmaRedemptionRejected: (cause) =>
              Effect.fail(
                new CredentialResolutionError({
                  owner,
                  integration: IntegrationSlug.make(row.integration),
                  name: ConnectionName.make(row.name),
                  message: enterpriseManagedMessage(cause),
                  reauthRequired: cause.error === "invalid_grant",
                  ...(cause.error === undefined ? {} : { oauthErrorCode: cause.error }),
                }),
              ),
            EmaUpstreamUnavailable: (cause) =>
              Effect.fail(new StorageError({ message: enterpriseManagedMessage(cause), cause })),
          }),
          Effect.tapError((error) =>
            Predicate.isTagged(error, "CredentialResolutionError") && error.reauthRequired === true
              ? // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: CredentialResolutionError carries a typed `message` field
                markRefreshGrantDead(row, error.message)
              : Effect.void,
          ),
        );

        // Draft §4.4.3: the Resource Authorization Server SHOULD NOT issue a
        // refresh token here. Drop one that arrives anyway — persisting it
        // would overwrite the identity assertion that shares that slot, and the
        // ID-JAG chain is already the renewal path.
        const { refresh_token: _unused, ...token } = grant.token;
        return {
          ...token,
          ...(grant.scope === null ? {} : { scope: grant.scope }),
        } satisfies OAuth2TokenResponse;
      });

    // Perform the actual refresh-token grant and persist the rotated material.
    const performTokenRefresh = (
      row: ConnectionRow,
      provider: CredentialProvider,
      trigger: RefreshTrigger,
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

        // A recorded invalid_grant is the AS's standing verdict on this grant:
        // re-sending it cannot succeed, so don't. Fail as reauth-required
        // without a token request — the reconnect mint rewrites
        // `provider_state` and thereby re-arms refresh. Without this gate a
        // dead connection re-sent its dead grant on every proactive cycle,
        // indefinitely (owner.com's Datadog connections: 100+ identical
        // rejections over two days, surfacing nothing).
        const reauthState = oauthReauthRequiredFromProviderState(row.provider_state);
        if (reauthState !== null) {
          yield* Effect.annotateCurrentSpan({ "executor.oauth.refresh.skipped_known_dead": true });
          const recordedHealth = Option.getOrNull(decodeLastHealth(row.last_health));
          const recordedDetail =
            reauthState.oauthReauthRequiredDetail ??
            (recordedHealth?.status === "expired" ? recordedHealth.detail : undefined);
          const detail =
            recordedDetail === undefined
              ? "The authorization server rejected this connection's refresh token (invalid_grant). Reconnect to continue."
              : recordedDetail.endsWith("Reconnect to continue.")
                ? recordedDetail
                : `${recordedDetail} Reconnect to continue.`;
          return yield* reauth(detail);
        }

        // Load the backing app. A `first-party:` slug resolves from host config
        // (deployment-owned identity, in-memory secret); a stored slug loads by
        // the owner STORED on the connection (a Personal connection may be
        // backed by a shared Workspace app) — no derivation — with its secret
        // resolved out of the credential provider by item id.
        const clientSlug = String(row.oauth_client);
        const clientRow: RefreshClient | null = yield* Effect.gen(function* () {
          if (isFirstPartyOAuthClientSlug(clientSlug)) {
            const firstParty = firstPartyOAuthBySlug.get(clientSlug);
            if (!firstParty) return null;
            return {
              clientId: firstParty.clientId,
              clientSecret: firstParty.clientSecret,
              tokenUrl: firstParty.tokenUrl,
              grant: "authorization_code",
              resource: null,
            } satisfies RefreshClient;
          }
          const clientOwner = (row.oauth_client_owner ?? row.owner) as Owner;
          const stored = yield* loadOAuthClientRow(clientOwner, clientSlug);
          if (!stored) return null;
          return {
            clientId: String(stored.client_id),
            clientSecret: stored.client_secret_item_id
              ? ((yield* provider.get(ProviderItemId.make(String(stored.client_secret_item_id)))) ??
                "")
              : "",
            tokenUrl: String(stored.token_url),
            grant: String(stored.grant),
            resource: stored.resource ? String(stored.resource) : null,
          } satisfies RefreshClient;
        });
        if (!clientRow) {
          return yield* reauth(`OAuth client "${row.oauth_client}" is no longer registered.`);
        }
        const clientSecret = clientRow.clientSecret;
        // Re-request the scopes this connection was GRANTED (RFC 6749 §6: a
        // refresh must not exceed the originally-granted scope). Empty → omit
        // the param, which the AS treats as "same scopes as granted".
        const grantedScopes = row.oauth_scope
          ? String(row.oauth_scope).split(/\s+/).filter(Boolean)
          : [];

        // Refresh against the region the code was redeemed at when one was
        // recorded at connect time (multi-site providers like Datadog), else
        // the oauth_client's configured token endpoint.
        const tokenUrl = row.oauth_token_url ? String(row.oauth_token_url) : clientRow.tokenUrl;

        // Enterprise-managed authorization (the ID-JAG grant profile) issues NO
        // refresh token by design — the identity assertion in `refresh_item_id`
        // is re-exchanged for a fresh ID-JAG and redeemed again. No user
        // interaction, so both the proactive and reactive triggers can run it.
        if (clientRow.grant === "id_jag") {
          const token = yield* performEnterpriseManagedRefresh({
            row,
            provider,
            client: clientRow,
            tokenUrl,
            scopes: grantedScopes,
            reauth,
          });
          yield* persistRefreshedToken(row, provider, token);
          return token.access_token;
        }

        // client_credentials (machine-to-machine) has NO refresh token — the
        // token is RE-MINTED from the client id/secret. The authorization_code
        // path below needs a stored refresh token. Branching on grant here is
        // what keeps a client_credentials connection (e.g. DealCloud) from
        // demanding a re-auth on a credential that has no human to re-auth.
        // What the credential store held for this connection when the grant
        // below was prepared, so the persist can tell a ROTATED refresh token
        // from one the authorization server simply handed back unchanged.
        // Only the authorization_code path has one; client_credentials and
        // id_jag carry no refresh token at all.
        let storedRefreshToken: string | undefined;
        const token =
          clientRow.grant === "client_credentials"
            ? yield* exchangeClientCredentials({
                tokenUrl,
                clientId: clientRow.clientId,
                clientSecret,
                scopes: grantedScopes,
                resource: clientRow.resource ?? undefined,
                endpointUrlPolicy: config.oauthEndpointUrlPolicy,
                fetch: config.fetch,
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
                // Prove the credential store is WRITABLE before consuming the
                // single-use refresh token. Ordering the persist correctly
                // (refresh token first) bounds the damage once a grant has
                // run, but it cannot help when the store is refusing writes
                // outright: the grant spends the stored token at the
                // authorization server, so a store that cannot accept the
                // rotated successor leaves the connection holding a token the
                // server has already revoked. Every later refresh then replays
                // it, gets invalid_grant, and a storage outage that healed in
                // minutes has cost the user a re-auth. Failing here instead
                // leaves the stored token valid, so the connection recovers on
                // its own when the store does.
                //
                // The probe writes its OWN item and never the refresh token's.
                // Rewriting the value just read would be one round trip
                // cheaper and is the trap: it is a read-then-write with no
                // compare-and-set, so a peer refresher on another instance
                // that spent this same token and stored its rotated successor
                // in between would have that successor overwritten by the
                // stale value — the exact dead connection this gate exists to
                // prevent, now caused by the gate. The probe item sits in the
                // same partition and holds a constant, so it proves what the
                // store will accept while no credential is ever at risk.
                if (provider.set) {
                  yield* provider.set(
                    ProviderItemId.make(storeWritabilityProbeItemIdFor(row.refresh_item_id)),
                    STORE_WRITABILITY_PROBE_VALUE,
                  );
                }
                storedRefreshToken = refreshToken;
                return yield* refreshAccessToken({
                  tokenUrl,
                  clientId: clientRow.clientId,
                  clientSecret,
                  refreshToken,
                  scopes: grantedScopes,
                  // RFC 8707: keep the re-minted token bound to the same resource
                  // (MCP servers require this on refresh).
                  resource: clientRow.resource ?? undefined,
                  endpointUrlPolicy: config.oauthEndpointUrlPolicy,
                  fetch: config.fetch,
                }).pipe(
                  Effect.mapError((cause) => {
                    // An RFC 6749 §5.2 error code is the AS's definitive
                    // verdict on this grant — retrying cannot change it.
                    // invalid_grant means the refresh token itself is dead
                    // (re-auth required); every other code must still reach
                    // the caller as an auth failure, because a StorageError
                    // is scrubbed to "Internal tool error [id]" at the
                    // sandbox boundary (a prod regression: the AS rejected
                    // refreshes with a non-invalid_grant 400 and callers saw
                    // only the opaque defect).
                    if (cause.error !== undefined) {
                      return new CredentialResolutionError({
                        owner,
                        integration: IntegrationSlug.make(row.integration),
                        name: ConnectionName.make(row.name),
                        // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuth2Error carries a typed `message`
                        message: `OAuth token refresh was rejected (${cause.error}): ${cause.message}`,
                        // A verdict delivered inside a response the endpoint
                        // called a SUCCESS is this grant's death certificate
                        // whatever the code spells (GitHub: HTTP 200
                        // `bad_refresh_token`). On a 4xx the code alone
                        // decides, so a rotated app secret (invalid_client —
                        // fleet-wide) is not mistaken for one user's dead
                        // grant.
                        reauthRequired:
                          cause.error === "invalid_grant" || isUnusableSuccessTokenResponse(cause),
                        oauthErrorCode: cause.error,
                      });
                    }
                    // No §5.2 code — but most real refusals carry none. A
                    // text/plain 400 ("your session has expired"), a 404, or a
                    // 200 with no access token are all the endpoint answering
                    // definitively, and re-sending the same grant cannot change
                    // any of them. Treating that as retryable is what put a
                    // dead grant back on the wire on every single use, forever.
                    if (isPermanentTokenRejection(cause)) {
                      return new CredentialResolutionError({
                        owner,
                        integration: IntegrationSlug.make(row.integration),
                        name: ConnectionName.make(row.name),
                        // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuth2Error carries a typed `message`
                        message: `OAuth token refresh was rejected: ${cause.message}`,
                        reauthRequired: true,
                      });
                    }
                    // What is left is genuinely transient — a 5xx or a
                    // transport failure — and stays a StorageError so the next
                    // invoke retries.
                    return new StorageError({
                      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OAuth2Error carries a typed `message`
                      message: `OAuth token refresh failed: ${cause.message}`,
                      cause,
                    });
                  }),
                  // Persist the definitive verdict so the NEXT refresh skips
                  // the doomed grant (see the known-dead gate above) and the
                  // connection shows `expired` without waiting for a probe.
                  Effect.tapError((error) =>
                    Predicate.isTagged(error, "CredentialResolutionError") &&
                    error.reauthRequired === true
                      ? // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: CredentialResolutionError carries a typed `message` field
                        markRefreshGrantDead(row, error.message)
                      : Effect.void,
                  ),
                );
              });

        yield* persistRefreshedToken(row, provider, token, storedRefreshToken);
        return token.access_token;
      }).pipe(
        // The refresh path was previously invisible to telemetry: no span, no
        // log, no metric. When a customer reported "my OAuth just died", there
        // was no way to answer "did a refresh even fire, and did it work?"
        // without a repro. Stamp the outcome, the failure KIND, and the AS's
        // own RFC 6749 §5.2 code (from the typed `oauthErrorCode` field, NOT
        // the message — the message embeds the token endpoint's response URL
        // and a body preview). Enumerable identifiers only, never user content
        // or token material. The code is the dimension that separates
        // invalid_client (a rotated app secret — fleet-wide, page someone)
        // from server_error (transient, the next invoke retries).
        Effect.tap(() => Effect.annotateCurrentSpan({ "executor.oauth.refresh.outcome": "ok" })),
        Effect.tapError((error: StorageFailure | CredentialResolutionError) =>
          Effect.annotateCurrentSpan({
            "executor.oauth.refresh.outcome": "fail",
            "executor.oauth.refresh.error": Predicate.isTagged(error, "CredentialResolutionError")
              ? "CredentialResolutionError"
              : "StorageFailure",
            // Whether the AS's refusal was definitive (RFC 6749 invalid_grant →
            // the refresh token itself is dead) or a transient failure the next
            // invoke can retry. The split is the actionable half of the signal.
            ...(Predicate.isTagged(error, "CredentialResolutionError")
              ? {
                  "executor.oauth.refresh.reauth_required": error.reauthRequired === true,
                  ...(error.oauthErrorCode !== undefined
                    ? { "executor.oauth.error_code": error.oauthErrorCode }
                    : {}),
                }
              : {}),
          }),
        ),
        Effect.withSpan("executor.oauth.refresh", {
          attributes: {
            // Tenant + subject make refresh outcomes answerable PER CUSTOMER
            // ("is org X's Datadog refresh healthy?") — without them the only
            // grouping dimensions were integration-wide. Opaque ids, never
            // emails or org names.
            "executor.tenant": tenant,
            ...(subject != null ? { "executor.subject": subject } : {}),
            "executor.integration": String(row.integration),
            "executor.connection": String(row.name),
            // Which path drove this refresh: the expiry check ahead of a call,
            // or an upstream 401 on a token we believed was still good. The
            // ratio is the health signal — a rising `reactive` share means
            // tokens are dying earlier than their advertised expiry.
            "executor.oauth.refresh.trigger": trigger,
          },
        }),
      );

    const refreshConnectionToken = (
      row: ConnectionRow,
      provider: CredentialProvider,
      trigger: RefreshTrigger = "proactive",
    ): Effect.Effect<string | null, StorageFailure | CredentialResolutionError> =>
      // Share a single refresh per connection so concurrent resolves of the same
      // connection all await one refresh-token grant (the AS rotates the refresh
      // token; parallel grants would race on a consumed token — v1's refresh
      // deferred-map). The gate is cleared once the refresh settles so a later
      // expiry can refresh again.
      Effect.gen(function* () {
        const key = connectionKey(row);
        // Joining an in-flight grant is correct for BOTH triggers: whatever
        // that peer mints is newer than the token this fiber just saw rejected,
        // which is exactly what a reactive retry wants. The gate is cleared on
        // settle, so a 401 arriving after a refresh completed starts a fresh
        // grant rather than replaying the stale memoized one.
        const existing = refreshInFlight.get(key);
        if (existing) return yield* existing;
        // `Effect.cached` memoizes the grant onto a deferred: it runs once and
        // replays to every awaiter sharing this entry.
        const memoized = yield* Effect.cached(performTokenRefresh(row, provider, trigger));
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

    /** Re-mint an OAuth connection's access token unconditionally, ignoring the
     *  stored expiry. Drives the reactive path: the upstream just rejected the
     *  token we sent, which is authoritative regardless of what `expires_at`
     *  claims (revoked server-side, an idle-timeout policy shorter than the
     *  advertised lifetime, or an expiry the AS never advertised at all).
     *
     *  Returns null when the connection can't be re-minted without a human —
     *  not OAuth-backed, or holding no refresh token — so the caller keeps the
     *  upstream's own auth failure instead of inventing one. */
    const forceRefreshConnectionValues = (
      row: ConnectionRow,
    ): Effect.Effect<
      Record<string, string | null> | null,
      StorageFailure | CredentialResolutionError
    > =>
      Effect.gen(function* () {
        if (row.oauth_client == null || row.refresh_item_id == null) return null;
        const provider = credentialProviders.get(row.provider);
        if (!provider) return null;
        const access = yield* refreshConnectionToken(row, provider, "reactive");
        return { [PRIMARY_INPUT_VARIABLE]: access };
      });

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

    const describeDisplayForRow = (row: IntegrationRow): IntegrationDisplayDescriptor => {
      const runtime = runtimes.get(row.plugin_id);
      const describe = runtime?.plugin.describeIntegrationDisplay;
      if (!describe) return {};
      const record = rowToIntegrationRecord(row);
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: plugin-authored projector must never fail the catalog read
      try {
        const display = describe(record);
        return {
          ...(display.url && display.url.length > 0 ? { url: display.url } : {}),
          ...(display.family && display.family.length > 0 ? { family: display.family } : {}),
        };
      } catch {
        return {};
      }
    };

    // The declared health check off the integration row's own column. CORE
    // owns this storage (never the plugin config blob), so a plugin config
    // rewrite can never strip it and no plugin schema has to declare it.
    const describeHealthCheckForRow = (row: IntegrationRow): HealthCheckSpec | null =>
      Option.getOrNull(decodeHealthCheckSpec(row.health_check));

    // The health-check hooks are typed `Effect<_, unknown>` at the PluginSpec
    // boundary (each plugin owns its own error shape). Fold that channel into a
    // StorageError so the public health-check surface stays StorageFailure-typed.
    // A genuine storage failure surfaces here; an auth wall or upstream error is
    // a SUCCESSFUL `HealthCheckResult` (status expired/degraded), not a failure.
    const foldPluginFailure = <A>(
      effect: Effect.Effect<A, unknown>,
      message: string,
    ): Effect.Effect<A, StorageFailure> =>
      effect.pipe(
        Effect.catch((cause: unknown) =>
          isStorageFailure(cause)
            ? Effect.fail(cause)
            : Effect.fail(new StorageError({ message, cause })),
        ),
      );

    const integrationsList = (): Effect.Effect<readonly Integration[], StorageFailure> =>
      Effect.gen(function* () {
        const rows = yield* core.findMany("integration", {});
        const staticIntegrationList = staticIntegrations().map(staticDeclToIntegration);
        const dbIntegrations = rows.map((row) =>
          rowToIntegration(row, describeAuthMethodsForRow(row), describeDisplayForRow(row)),
        );
        // A scoped toolkit must not advertise providers it grants no tools from
        // (mirrors `connectionsList`). Static integrations are system namespaces, not
        // user providers, so they stay; DB-backed integrations are filtered to
        // those that contribute at least one visible tool under the active policy.
        if (!activeToolPolicyProvider) return [...staticIntegrationList, ...dbIntegrations];
        const visibleTools = yield* toolsList({ includeAnnotations: false });
        const visibleIntegrationSlugs = new Set(
          visibleTools.filter((tool) => !tool.static).map((tool) => String(tool.integration)),
        );
        return [
          ...staticIntegrationList,
          ...dbIntegrations.filter((integration) =>
            visibleIntegrationSlugs.has(String(integration.slug)),
          ),
        ];
      });

    const integrationsGet = (
      slug: IntegrationSlug,
    ): Effect.Effect<Integration | null, StorageFailure> =>
      Effect.gen(function* () {
        const staticIntegration = staticIntegrations().find(
          (integration) => integration.id === String(slug),
        );
        if (staticIntegration) return staticDeclToIntegration(staticIntegration);
        const row = yield* findIntegrationRow(slug);
        return row
          ? rowToIntegration(row, describeAuthMethodsForRow(row), describeDisplayForRow(row))
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

    // Best-effort post-commit notification for `ExecutorConfig.onIntegrationChange`.
    // Routed through `afterCommit` so the observer sees only DURABLE changes:
    // when the write ran inside a (possibly plugin-owned outer) transaction the
    // notification is queued on the outermost commit and discarded on rollback.
    // Failures and defects are swallowed so a host's analytics can never fail a
    // catalog write.
    const notifyIntegrationChange = (event: IntegrationChangeEvent): Effect.Effect<void> =>
      config.onIntegrationChange ? afterCommit(config.onIntegrationChange(event)) : Effect.void;

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
                name: input.name ?? existing.name ?? null,
                description: input.description,
                config,
                can_remove: input.canRemove ?? Boolean(existing.can_remove),
                can_refresh: input.canRefresh ?? Boolean(existing.can_refresh),
                updated_at: now,
              },
            });
            return false;
          }
          yield* core.create("integration", {
            tenant,
            slug: String(input.slug),
            plugin_id: pluginId,
            name: input.name ?? null,
            description: input.description,
            config,
            can_remove: input.canRemove ?? true,
            can_refresh: input.canRefresh ?? false,
            created_at: now,
            updated_at: now,
          });
          return true;
        }),
      ).pipe(
        Effect.tap((created) =>
          created
            ? notifyIntegrationChange({ kind: "added", pluginKey: pluginId, slug: input.slug })
            : Effect.void,
        ),
        Effect.asVoid,
      );

    const integrationsUpdate = (
      slug: IntegrationSlug,
      patch: {
        readonly name?: string;
        readonly description?: string;
        readonly config?: IntegrationConfig;
      },
    ): Effect.Effect<void, StorageFailure> =>
      Effect.gen(function* () {
        const now = new Date();
        const set: Record<string, unknown> = { updated_at: now };
        if (patch.name !== undefined) set.name = patch.name;
        if (patch.description !== undefined) set.description = patch.description;
        if (patch.config !== undefined) {
          set.config = patch.config;
          // A config change can change the derived tools. The writer can only
          // rebuild catalogs in its own partition (owner policy), so revise
          // the integration: other subjects' connections compare this stamp
          // against their `tools_synced_at` and lazily rebuild on next read.
          set.config_revised_at = now.getTime();
        }
        yield* core.updateMany("integration", {
          where: (b: AnyCb) => b("slug", "=", String(slug)),
          set,
        });
      });

    const integrationsUpdatePublic = (
      slug: IntegrationSlug,
      patch: { readonly name?: string; readonly description?: string },
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
          if (!existing) return null;
          if (!existing.can_remove) {
            return yield* new IntegrationRemovalNotAllowedError({ slug });
          }
          const runtime = runtimes.get(existing.plugin_id);
          if (runtime?.plugin.removeIntegration) {
            yield* runtime.plugin
              .removeIntegration({
                ctx: runtime.ctx,
                integration: rowToIntegrationRecord(existing, describeAuthMethodsForRow(existing)),
              })
              .pipe(
                Effect.mapError((cause) =>
                  pluginStorageFailure(existing.plugin_id, "removeIntegration", cause),
                ),
              );
          }
          // Drop owned connections / tools / definitions for this integration.
          const where = (b: AnyCb) => b("integration", "=", String(slug));
          yield* core.deleteMany("tool", { where });
          yield* core.deleteMany("definition", { where });
          yield* core.deleteMany("connection", { where });
          yield* core.deleteMany("integration", {
            where: (b: AnyCb) => b("slug", "=", String(slug)),
          });
          return existing.plugin_id;
        }),
      ).pipe(
        Effect.tap((removedPluginId) =>
          removedPluginId !== null
            ? notifyIntegrationChange({ kind: "removed", pluginKey: removedPluginId, slug })
            : Effect.void,
        ),
        Effect.asVoid,
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
    // Health checks: dispatch to the owning plugin's hooks.
    // ------------------------------------------------------------------

    const integrationHealthCheckGet = (
      slug: IntegrationSlug,
    ): Effect.Effect<HealthCheckSpec | null, StorageFailure> =>
      findIntegrationRow(slug).pipe(
        Effect.map((row) => (row ? describeHealthCheckForRow(row) : null)),
      );

    const integrationHealthCheckCandidates = (
      slug: IntegrationSlug,
    ): Effect.Effect<readonly HealthCheckCandidate[], IntegrationNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const row = yield* findIntegrationRow(slug);
        if (!row) return yield* new IntegrationNotFoundError({ slug });
        const runtime = runtimes.get(row.plugin_id);
        const list = runtime?.plugin.listHealthCheckCandidates;
        if (!runtime || !list) return [];
        const record = rowToIntegrationRecord(row, describeAuthMethodsForRow(row));
        return yield* foldPluginFailure(
          list({ ctx: runtime.ctx, integration: record }),
          `Listing health-check candidates for "${slug}" failed.`,
        );
      });

    // Core-owned write: the spec lands in the integration row's own column.
    // No plugin hook, no config read-modify-write, nothing a plugin's own
    // config cycle can clobber.
    const integrationSetHealthCheck = (
      slug: IntegrationSlug,
      spec: HealthCheckSpec | null,
    ): Effect.Effect<void, IntegrationNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const row = yield* findIntegrationRow(slug);
        if (!row) return yield* new IntegrationNotFoundError({ slug });
        yield* core.updateMany("integration", {
          where: (b: AnyCb) => b("slug", "=", String(slug)),
          set: { health_check: spec, updated_at: new Date() },
        });
      });

    // ------------------------------------------------------------------
    // Per-connection tool production
    // ------------------------------------------------------------------

    const toolSyncHealthDetailPrefix = "Tool sync failing";

    const toolSyncHealth = (reason: string): HealthCheckResult => ({
      status: "degraded",
      checkedAt: Date.now(),
      detail: `${toolSyncHealthDetailPrefix}: ${reason}`,
    });

    const syncHealthReason = (result: ResolveToolsResult): string =>
      result.incompleteReason ?? "plugin returned an incomplete tool catalog";

    // Tool production has two phases with very different shapes: DISCOVERY (the
    // plugin's `resolveTools` — network, slow, independent per connection) and
    // PERSISTENCE (a short catalog-replacement transaction). Only discovery may
    // overlap. Self-host runs a single libSQL connection issuing raw
    // BEGIN/COMMIT, where a second transaction opened while one is live fails
    // outright with "cannot start a transaction within a transaction" — the
    // failure #1563 fixed for concurrent refreshes of the SAME connection via
    // the single-flight map below. Rebuilding several DIFFERENT connections
    // together (the stale-catalog fan-out) reopens the same hazard from the
    // other side, so the write phase takes a single permit: the fan-out's
    // discoveries still run together and their commits form a queue.
    //
    // Never take this permit while a transaction is already open on this fiber
    // — every caller of `persistCatalog` must be outside one, as all of the
    // `produceConnectionTools` call sites are.
    const catalogPersistLock = Semaphore.makeUnsafe(1);
    const persistCatalog = <A, E>(effect: Effect.Effect<A, E>) =>
      catalogPersistLock.withPermits(1)(transaction(effect));

    const produceConnectionToolsUnshared = (
      integrationRow: IntegrationRow,
      ref: ConnectionRef,
      mode: () => "explicit" | "background",
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
        const connectionWhere = (b: AnyCb) =>
          b.and(
            byOwner(owner)(b),
            b("integration", "=", String(ref.integration)),
            b("name", "=", String(ref.name)),
          );
        const isToolSyncHealth = (health: HealthCheckResult | null): boolean =>
          health?.detail?.startsWith(toolSyncHealthDetailPrefix) === true;
        const syncedSet = (row: ConnectionRow | null) => {
          const health = row ? Option.getOrNull(decodeLastHealth(row.last_health)) : null;
          return isToolSyncHealth(health)
            ? { tools_synced_at: Date.now(), last_health: null, updated_at: new Date() }
            : { tools_synced_at: Date.now() };
        };
        // Every exit stamps the sync time — including the cleanup paths that
        // produce zero tools — so the stale-catalog check (`config_revised_at`
        // vs `tools_synced_at`) doesn't re-attempt this connection per read.
        // Successful syncs also clear stale sync-failure health records, while
        // preserving genuine health-check outcomes.
        const stampSynced = (row: ConnectionRow | null) =>
          core.updateMany("connection", {
            where: connectionWhere,
            set: syncedSet(row),
          });
        const stampSyncedWithHealth = (reason: string) =>
          core.updateMany("connection", {
            where: connectionWhere,
            set: {
              tools_synced_at: Date.now(),
              last_health: toolSyncHealth(reason),
              updated_at: new Date(),
            },
          });

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
          yield* persistCatalog(
            Effect.gen(function* () {
              yield* core.deleteMany("tool", { where });
              yield* core.deleteMany("definition", { where });
              yield* stampSynced(existingRow);
            }),
          );
          return [];
        }

        if (!runtime?.plugin.resolveTools) {
          // No dynamic tools — clear any existing rows and return empty.
          yield* persistCatalog(
            Effect.gen(function* () {
              yield* core.deleteMany("tool", { where });
              yield* core.deleteMany("definition", { where });
              yield* stampSynced(existingRow);
            }),
          );
          return [];
        }

        const result: ResolveToolsResult = yield* runtime.plugin
          .resolveTools({
            ctx: runtime.ctx,
            integration: rowToIntegration(integrationRow),
            config: decodeJsonColumn(integrationRow.config),
            httpClientLayer: runtime.ctx.httpClientLayer,
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

        if (result.incomplete === true) {
          // Non-authoritative listing (integration unreachable, auth not ready).
          // Keep the existing catalog — replacing it would wipe working tools
          // over a transient outage — and stamp the sync time anyway so a down
          // server isn't re-dialed on every read; the freshness TTL re-attempts
          // later.
          const reason = syncHealthReason(result);
          yield* stampSyncedWithHealth(reason);
          yield* Effect.logWarning("executor tool sync preserved catalog", {
            reason,
            integration: String(ref.integration),
            connection: String(ref.name),
          });
          const keptRows = yield* core.findMany("tool", { where });
          return keptRows.map((row) => rowToTool(row as ConnectionToolRow));
        }

        if (
          mode() === "background" &&
          runtime.plugin.remoteToolCatalog === true &&
          result.tools.length === 0
        ) {
          const keptRows = yield* core.findMany("tool", { where });
          if (keptRows.length > 0) {
            const reason =
              "background tool sync produced an authoritative empty catalog for a connection with existing tools";
            yield* stampSyncedWithHealth(reason);
            yield* Effect.logWarning("executor tool sync preserved nonzero catalog", {
              reason,
              integration: String(ref.integration),
              connection: String(ref.name),
              existingToolCount: keptRows.length,
            });
            return keptRows.map((row) => rowToTool(row as ConnectionToolRow));
          }
        }

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

        yield* persistCatalog(
          Effect.gen(function* () {
            yield* core.deleteMany("tool", { where });
            yield* core.deleteMany("definition", { where });
            yield* core.createMany("tool", toolRows);
            yield* core.createMany("definition", definitionRows);
            yield* stampSynced(existingRow);
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

    type ToolProductionError = IntegrationNotFoundError | StorageFailure;
    interface ToolProductionInFlight {
      readonly deferred: Deferred.Deferred<readonly Tool[], ToolProductionError>;
      mode: "explicit" | "background";
    }
    const toolProductionInFlight = new Map<string, ToolProductionInFlight>();
    const produceConnectionTools = (
      integrationRow: IntegrationRow,
      ref: ConnectionRef,
      requestedMode: "explicit" | "background" = "explicit",
    ): Effect.Effect<readonly Tool[], ToolProductionError> =>
      Effect.suspend(() => {
        const key = `${ref.owner}:${String(ref.integration)}:${String(ref.name)}`;
        const existing = toolProductionInFlight.get(key);
        if (existing) {
          if (requestedMode === "explicit") existing.mode = "explicit";
          return Deferred.await(existing.deferred);
        }

        const entry: ToolProductionInFlight = {
          deferred: Deferred.makeUnsafe<readonly Tool[], ToolProductionError>(),
          mode: requestedMode,
        };
        toolProductionInFlight.set(key, entry);
        const run = produceConnectionToolsUnshared(integrationRow, ref, () => entry.mode).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(entry.deferred, exit)),
          Effect.ensuring(Effect.sync(() => void toolProductionInFlight.delete(key))),
        );
        return Effect.forkDetach(run).pipe(Effect.andThen(Deferred.await(entry.deferred)));
      });

    // ------------------------------------------------------------------
    // Connections
    // ------------------------------------------------------------------

    const connectionsCreate = (
      input: CreateConnectionInput,
    ): Effect.Effect<
      Connection,
      | IntegrationNotFoundError
      | ConnectionAlreadyExistsError
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

        // Create is never a replace. This early check answers the common case
        // with a typed 409 before any other work, but it is NOT the guard
        // against concurrent creates — the row insert below is: the
        // transaction re-checks, the primary key breaks the tie, and the
        // provider write happens only after the insert wins.
        const duplicate = yield* findConnectionRow({
          owner: input.owner,
          integration: input.integration,
          name,
        });
        if (duplicate) {
          return yield* new ConnectionAlreadyExistsError({
            owner: input.owner,
            integration: input.integration,
            name,
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
        // Pasted-value provider writes, built here but run only AFTER this
        // create wins the row insert below.
        const pastedWrites: Effect.Effect<void, StorageFailure>[] = [];
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
            // Deferred until the row insert wins: the item id is deterministic,
            // so writing here would overwrite the credential of an existing (or
            // concurrently created) connection with the same name even when
            // this create loses the row conflict.
            if ("value" in i.origin && provider.set) {
              pastedWrites.push(provider.set(ProviderItemId.make(itemId), i.origin.value));
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
            if (existing) {
              return yield* new ConnectionAlreadyExistsError({
                owner: input.owner,
                integration: input.integration,
                name,
              });
            }
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
              description: input.description ?? null,
              oauth_client: null,
              refresh_item_id: null,
              expires_at: null,
              oauth_scope: null,
              provider_state: null,
              created_at: now,
              updated_at: now,
            });
          }),
        ).pipe(
          // Both racers can observe absence and reach the insert; the primary
          // key then picks the winner. Map the loser's constraint violation to
          // the same typed 409 the pre-checks produce.
          Effect.catchTag("UniqueViolationError", () =>
            Effect.fail(
              new ConnectionAlreadyExistsError({
                owner: input.owner,
                integration: input.integration,
                name,
              }),
            ),
          ),
        );

        // Winner-only credential write: only the create whose row insert
        // committed may touch the provider, so a losing create can never
        // clobber the winner's (or a pre-existing connection's) secret. While
        // this row exists no concurrent create can win, so on failure the row
        // is ours to remove — a surviving row whose item_ids were never stored
        // would fail every invocation with `connection_value_missing`.
        if (pastedWrites.length > 0) {
          yield* Effect.all(pastedWrites).pipe(
            Effect.tapError(() =>
              core
                .deleteMany("connection", {
                  where: (b: AnyCb) =>
                    b.and(
                      byOwner(input.owner)(b),
                      b("integration", "=", String(input.integration)),
                      b("name", "=", String(name)),
                    ),
                })
                .pipe(Effect.ignore),
            ),
          );
        }

        // Record the sighting. The request seam (`makeScopedExecutor`) already
        // does this for every hosted call, so this is the belt for direct
        // SDK/CLI callers that never pass through it — a connecting principal
        // must always have a subject row. Outside
        // the transaction above: bookkeeping must not roll back the
        // connection, and `touchSubject` cannot fail. No-ops on a pure-org
        // executor (no principal to record), including for `owner: "org"`
        // connections created by a bound member.
        yield* touchSubject(rootDbUntyped, { tenant, externalId: subject });

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
              description: input.description ?? null,
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
    // by the OAuth service) + produce the connection's tools. Unlike
    // `connectionsCreate` (which rejects an existing name), this path upserts on
    // purpose: reconnect/refresh re-mints the SAME connection, stamping the
    // OAuth columns.
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
        // Label precedence: an explicit (user-chosen) label always wins; a
        // derived label (OIDC claims) only FILLS an empty slot. Like
        // `description` below, a reconnect or token refresh must not erase a
        // label the user curated. Resolved once, used by every write below.
        let identityLabel: string | null = null;
        // The core-owned per-connection state this mint writes WHOLESALE:
        // whatever a previous grant recorded (a stale reauth verdict, an old
        // missing-scope set) describes a credential that no longer exists.
        const nextProviderState = {
          ...(input.missingOAuthScopes === undefined || input.missingOAuthScopes.length === 0
            ? {}
            : { missingOAuthScopes: input.missingOAuthScopes }),
          ...(input.enterpriseManaged === undefined
            ? {}
            : { [ENTERPRISE_MANAGED_PROVIDER_STATE_KEY]: input.enterpriseManaged }),
        };
        // Null, not `{}`, when this grant records nothing: an empty object would
        // read back as "state exists and is empty" on a column whose absence is
        // what every reader tests.
        const providerState =
          Object.keys(nextProviderState).length === 0 ? null : nextProviderState;
        yield* transaction(
          Effect.gen(function* () {
            const existing = yield* findConnectionRow(ref);
            const existingLabel = existing?.identity_label?.trim() ? existing.identity_label : null;
            identityLabel =
              input.identityLabel ?? existingLabel ?? input.derivedIdentityLabel ?? null;
            const set: Record<string, unknown> = {
              template: String(input.template),
              provider: input.provider,
              item_ids: { [PRIMARY_INPUT_VARIABLE]: input.itemId },
              identity_label: identityLabel,
              oauth_client: String(input.oauthClient),
              oauth_client_owner: input.oauthClientOwner,
              refresh_item_id: input.refreshItemId,
              expires_at: input.expiresAt,
              oauth_scope: input.oauthScope,
              oauth_token_url: input.oauthTokenUrl ?? null,
              provider_state: providerState,
              // A re-mint replaces the grant, so any persisted verdict describes
              // a credential that no longer exists. Clear it rather than let a
              // pre-reconnect "expired" outlive the reconnect; the next health
              // check writes the verdict for the new grant.
              last_health: null,
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
                identity_label: identityLabel,
                // Curated description: never stamped by a mint — a reconnect
                // or token refresh must not erase what the user wrote.
                description: null,
                oauth_client: String(input.oauthClient),
                oauth_client_owner: input.oauthClientOwner,
                refresh_item_id: input.refreshItemId,
                expires_at: input.expiresAt,
                oauth_scope: input.oauthScope,
                oauth_token_url: input.oauthTokenUrl ?? null,
                provider_state: providerState,
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
              identity_label: identityLabel,
              description: null,
              oauth_client: String(input.oauthClient),
              oauth_client_owner: input.oauthClientOwner,
              refresh_item_id: input.refreshItemId,
              expires_at: input.expiresAt,
              oauth_scope: input.oauthScope,
              oauth_token_url: input.oauthTokenUrl ?? null,
              provider_state: providerState,
              created_at: now,
              updated_at: now,
            } as ConnectionRow);
      });

    const connectionsList = (filter?: {
      readonly integration?: IntegrationSlug;
      readonly owner?: Owner;
    }): Effect.Effect<readonly Connection[], StorageFailure> =>
      Effect.gen(function* () {
        const rows = yield* core.findMany("connection", {
          where: (b: AnyCb) =>
            b.and(
              filter?.integration === undefined
                ? true
                : b("integration", "=", String(filter.integration)),
              filter?.owner === undefined ? true : b("owner", "=", filter.owner),
            ),
        });
        const connections = rows.map(rowToConnection);
        if (!activeToolPolicyProvider) return connections;

        const visibleTools = yield* toolsList({ includeAnnotations: false });
        const visibleConnectionKeys = new Set(
          visibleTools
            .filter((tool) => !tool.static)
            .map((tool) => `${tool.owner}:${tool.integration}:${tool.connection}`),
        );
        return connections.filter((connection) =>
          visibleConnectionKeys.has(
            `${connection.owner}:${connection.integration}:${connection.name}`,
          ),
        );
      });

    const connectionsGet = (ref: ConnectionRef): Effect.Effect<Connection | null, StorageFailure> =>
      findConnectionRow(ref).pipe(Effect.map((row) => (row ? rowToConnection(row) : null)));

    const connectionsUpdate = (
      ref: ConnectionRef,
      input: UpdateConnectionInput,
    ): Effect.Effect<Connection, ConnectionNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const row = yield* findConnectionRow(ref);
        if (!row) {
          return yield* new ConnectionNotFoundError({
            owner: ref.owner,
            integration: ref.integration,
            name: ref.name,
          });
        }
        const set: Record<string, unknown> = { updated_at: new Date() };
        if (input.description !== undefined) set.description = input.description;
        if (input.identityLabel !== undefined) set.identity_label = input.identityLabel;
        yield* core.updateMany("connection", {
          where: (b: AnyCb) =>
            b.and(
              byOwner(ref.owner)(b),
              b("integration", "=", String(ref.integration)),
              b("name", "=", String(ref.name)),
            ),
          set,
        });
        const updated = yield* findConnectionRow(ref);
        return rowToConnection(updated ?? row);
      });

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

    // No health-check capability ⇒ "unknown" rather than an error: the caller
    // can still render the connection, just without a liveness verdict.
    const unknownHealth = (): HealthCheckResult => ({ status: "unknown", checkedAt: Date.now() });

    const persistHealthResult = (
      ref: ConnectionRef,
      result: HealthCheckResult,
    ): Effect.Effect<void, never> =>
      core
        .updateMany("connection", {
          where: (b: AnyCb) =>
            b.and(
              b("owner", "=", String(ref.owner)),
              b("integration", "=", String(ref.integration)),
              b("name", "=", String(ref.name)),
            ),
          set: { last_health: result, updated_at: new Date() },
        })
        .pipe(Effect.ignore);

    const healthFromCredentialResolutionFailure = (
      failure: CredentialResolutionError,
    ): HealthCheckResult =>
      failure.reauthRequired === true
        ? {
            status: "expired",
            checkedAt: Date.now(),
            // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: CredentialResolutionError carries a typed `message` field
            detail: failure.message,
          }
        : {
            status: "degraded",
            checkedAt: Date.now(),
            // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: CredentialResolutionError carries a typed `message` field
            detail: failure.message,
          };

    /** THE one place a credential-resolution failure becomes a health verdict.
     *  A third party refusing to re-mint a credential is a fact about the
     *  CONNECTION, not a fault in this service, so it must be answered — and
     *  then persisted — as `expired`/`degraded`, never raised. The failure
     *  channel stays reserved for genuine storage faults (an infra blip must
     *  fail the request rather than persist as a "degraded" verdict). Both
     *  health paths — credential-only and probing — fold through here, so
     *  they cannot disagree about what a broken credential means. */
    const foldCredentialResolutionIntoVerdict = (
      probe: Effect.Effect<HealthCheckResult, StorageFailure | CredentialResolutionError>,
    ): Effect.Effect<HealthCheckResult, StorageFailure> =>
      probe.pipe(
        Effect.catchTag("CredentialResolutionError", (failure) =>
          Effect.succeed(healthFromCredentialResolutionFailure(failure)),
        ),
      );

    const oauthCredentialHealthWithoutProbe = (
      row: ConnectionRow,
    ): Effect.Effect<HealthCheckResult, StorageFailure> =>
      foldCredentialResolutionIntoVerdict(
        resolveConnectionValues(row).pipe(
          Effect.as({
            status: "healthy" as const,
            checkedAt: Date.now(),
            detail: "Credential resolved (no probe configured).",
          }),
        ),
      );

    // Resolve an in-flight credential's value map (key-first validation) without
    // saving anything. Mirrors `resolveConnectionValues` for the saved-row path:
    // pasted `value`/`values` are used directly; `from` origins resolve through
    // their provider. Single-secret sugar lands on the `token` variable.
    const resolveInFlightValues = (
      input: ConnectionValueInput,
    ): Effect.Effect<Record<string, string | null>, StorageFailure> =>
      Effect.gen(function* () {
        const out: Record<string, string | null> = {};
        for (const { variable, origin } of normalizeConnectionInputs(input)) {
          if ("value" in origin) {
            out[variable] = origin.value;
            continue;
          }
          const provider = credentialProviders.get(String(origin.from.provider));
          if (!provider) {
            return yield* new StorageError({
              message: `Credential provider "${origin.from.provider}" is not registered.`,
              cause: undefined,
            });
          }
          out[variable] = yield* provider.get(origin.from.id);
        }
        return out;
      });

    /** Stamp the verdict + which path produced it onto the enclosing health
     *  span. Every health outcome is HTTP 200, so WITHOUT these attributes the
     *  request envelope cannot separate healthy from expired — the "what
     *  fraction of connections are dead right now" question was previously
     *  only answerable by querying the database. `status` and `httpStatus`
     *  are enumerable; `detail`/`identity` (upstream free text / an email)
     *  never go on a span. */
    const annotateHealthVerdict = (
      source: "cache" | "no_capability" | "credential_only" | "probe",
      result: HealthCheckResult,
    ): Effect.Effect<void> =>
      Effect.annotateCurrentSpan({
        "executor.health.status": result.status,
        "executor.health.source": source,
        ...(result.httpStatus !== undefined
          ? { "executor.health.http_status": result.httpStatus }
          : {}),
      });

    const connectionCheckHealth = (
      ref: ConnectionRef,
      options?: {
        /** Skip the probe and return the persisted verdict when it is younger
         *  than this. The server owns the freshness decision so N open tabs
         *  revalidating on load cannot stampede an upstream. Omit = always
         *  probe (the manual "Check now"). */
        readonly ifStaleMs?: number;
      },
    ): Effect.Effect<
      HealthCheckResult,
      ConnectionNotFoundError | IntegrationNotFoundError | StorageFailure
    > =>
      Effect.gen(function* () {
        const connectionRow = yield* findConnectionRow(ref);
        if (!connectionRow) {
          return yield* new ConnectionNotFoundError({
            owner: ref.owner,
            integration: ref.integration,
            name: ref.name,
          });
        }
        if (options?.ifStaleMs !== undefined) {
          const cached = Option.getOrNull(decodeLastHealth(connectionRow.last_health));
          if (cached && Date.now() - cached.checkedAt < options.ifStaleMs) {
            yield* annotateHealthVerdict("cache", cached);
            return cached;
          }
        }
        const integrationRow = yield* findIntegrationRow(ref.integration);
        if (!integrationRow) {
          return yield* new IntegrationNotFoundError({ slug: ref.integration });
        }
        const runtime = runtimes.get(integrationRow.plugin_id);
        const check = runtime?.plugin.checkHealth;
        if (!runtime || !check) {
          const result = unknownHealth();
          yield* annotateHealthVerdict("no_capability", result);
          return result;
        }
        const spec = describeHealthCheckForRow(integrationRow) ?? undefined;
        if (spec === undefined && connectionRow.oauth_client != null) {
          // No probe operation is declared, so "healthy" here means only "the
          // credential resolved (refreshing if due)" — a refresh failure is
          // the one real signal this path can produce, and it must not hide
          // inside a green span.
          const result = yield* oauthCredentialHealthWithoutProbe(connectionRow);
          yield* annotateHealthVerdict("credential_only", result);
          yield* persistHealthResult(ref, result);
          return result;
        }

        const result = yield* foldCredentialResolutionIntoVerdict(
          Effect.gen(function* () {
            const values = yield* resolveConnectionValues(connectionRow);
            const record = rowToIntegrationRecord(
              integrationRow,
              describeAuthMethodsForRow(integrationRow),
            );
            const grantedScopes = grantedScopesFromRow(connectionRow);
            const credential: ToolInvocationCredential = {
              owner: connectionRow.owner as Owner,
              integration: ref.integration,
              connection: ConnectionName.make(connectionRow.name),
              template: AuthTemplateSlug.make(connectionRow.template),
              value: values[PRIMARY_INPUT_VARIABLE] ?? null,
              values,
              config: record.config,
              ...(grantedScopes ? { grantedScopes } : {}),
            };
            // Core resolves the declared spec (its own column) and hands it to
            // the plugin; plugins no longer read it out of their config.
            return yield* foldPluginFailure(
              check({ ctx: runtime.ctx, integration: record, credential, spec }),
              `Health check for connection "${ref.name}" failed.`,
            );
          }),
        );
        yield* annotateHealthVerdict("probe", result);
        // Persist the verdict on the connection row so the accounts list shows
        // alive/expired at a glance, AND so the freshness gate above has
        // something to serve. A probe that could not resolve its credential
        // persists too: it is the connection most likely to be re-probed by
        // every surface on every mount, so leaving it unwritten is what turns
        // one broken connection into unbounded upstream and error traffic.
        // Best-effort: a write failure must not turn a verdict into an error.
        yield* persistHealthResult(ref, result);
        return result;
      }).pipe(
        Effect.withSpan("executor.connection.health.check", {
          attributes: {
            "executor.tenant": tenant,
            ...(subject != null ? { "executor.subject": subject } : {}),
            "executor.integration": String(ref.integration),
            "executor.connection": String(ref.name),
          },
        }),
      );

    const connectionValidate = (
      input: ValidateConnectionInput,
    ): Effect.Effect<HealthCheckResult, IntegrationNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const integrationRow = yield* findIntegrationRow(input.integration);
        if (!integrationRow) {
          return yield* new IntegrationNotFoundError({ slug: input.integration });
        }
        const runtime = runtimes.get(integrationRow.plugin_id);
        const check = runtime?.plugin.checkHealth;
        if (!runtime || !check) return unknownHealth();

        const values = yield* resolveInFlightValues(input);
        const record = rowToIntegrationRecord(
          integrationRow,
          describeAuthMethodsForRow(integrationRow),
        );
        const credential: ToolInvocationCredential = {
          owner: input.owner,
          integration: input.integration,
          // No connection exists yet (key-first); a synthetic name keeps the
          // credential shape whole. The probe authenticates on values+template,
          // not on this name (it only appears in upstream-error messages).
          connection: ConnectionName.make("(unsaved)"),
          template: input.template,
          value: values[PRIMARY_INPUT_VARIABLE] ?? null,
          values,
          config: record.config,
        };
        // Caller override (editor preview) wins; otherwise the declared spec
        // from the integration row. Nothing persists here: validate is the
        // key-first flow's dry run.
        const spec = input.spec ?? describeHealthCheckForRow(integrationRow) ?? undefined;
        const result = yield* foldPluginFailure(
          check({ ctx: runtime.ctx, integration: record, credential, spec }),
          `Validating credential for "${input.integration}" failed.`,
        );
        // Nothing persists here BY DESIGN, which makes this span the only
        // possible record of "what fraction of pasted credentials are rejected
        // at the door" — a signal the DB can never carry.
        yield* Effect.annotateCurrentSpan({
          "executor.health.status": result.status,
          ...(result.httpStatus !== undefined
            ? { "executor.health.http_status": result.httpStatus }
            : {}),
        });
        return result;
      }).pipe(
        Effect.withSpan("executor.connection.validate", {
          attributes: {
            "executor.tenant": tenant,
            ...(subject != null ? { "executor.subject": subject } : {}),
            "executor.integration": String(input.integration),
          },
        }),
      );

    // Clear the sync stamp so the next tools read re-produces this connection's
    // catalog. The deferred variant of `connectionsRefresh` for signals that
    // arrive mid-invocation (an MCP `notifications/tools/list_changed`, an
    // unknown-tool rejection) where re-listing inline would block the caller.
    const connectionsMarkToolsStale = (ref: ConnectionRef): Effect.Effect<void, StorageFailure> =>
      core.updateMany("connection", {
        where: (b: AnyCb) =>
          b.and(
            byOwner(ref.owner)(b),
            b("integration", "=", String(ref.integration)),
            b("name", "=", String(ref.name)),
          ),
        set: { tools_synced_at: null },
      });

    // ------------------------------------------------------------------
    // Active policy source.
    // ------------------------------------------------------------------

    type ActivePolicyRuleSet =
      | { readonly kind: "global"; readonly rows: readonly ToolPolicyRow[] }
      | {
          readonly kind: "provider";
          readonly provider: ToolPolicyProvider;
          readonly rules: readonly ToolPolicyProviderRule[] | null;
        }
      | {
          readonly kind: "prepared";
          readonly resolve: (input: {
            readonly toolId: string;
            readonly defaultRequiresApproval?: boolean;
          }) => EffectivePolicy;
        };

    const compareProviderPolicyRule = (
      a: ToolPolicyProviderRule,
      b: ToolPolicyProviderRule,
    ): number => {
      if (a.position < b.position) return -1;
      if (a.position > b.position) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };

    const resolveProviderPolicyFromRules = (
      toolId: string,
      rules: readonly ToolPolicyProviderRule[],
    ): EffectivePolicy => {
      for (const rule of [...rules].sort(compareProviderPolicyRule)) {
        if (!matchPattern(rule.pattern, toolId)) continue;
        return {
          action: rule.action,
          source: "user",
          pattern: rule.pattern,
          policyId: rule.id,
        };
      }
      // Toolkit-style providers are capability allowlists. No matching rule
      // means the tool is outside the capability boundary.
      return {
        action: "block",
        source: "user",
        pattern: "*",
      };
    };

    const listActivePolicyRuleSet = (): Effect.Effect<ActivePolicyRuleSet, StorageFailure> =>
      activeToolPolicyProvider
        ? // Batched per-operation resolver: fetch all policy + connection state
          // once, then resolve every tool in this operation against that
          // snapshot. Avoids the per-tool resolve N+1 on the list surface.
          activeToolPolicyProvider.prepare
          ? activeToolPolicyProvider
              .prepare()
              .pipe(Effect.map((resolve) => ({ kind: "prepared" as const, resolve })))
          : activeToolPolicyProvider.resolve
            ? Effect.succeed({
                kind: "provider" as const,
                provider: activeToolPolicyProvider,
                rules: null,
              })
            : activeToolPolicyProvider.list().pipe(
                Effect.map((rules) => ({
                  kind: "provider" as const,
                  provider: activeToolPolicyProvider!,
                  rules,
                })),
              )
        : core
            .findMany("tool_policy", {})
            .pipe(Effect.map((rows) => ({ kind: "global" as const, rows })));

    const resolvePolicyFromRuleSet = (
      toolId: string,
      ruleSet: ActivePolicyRuleSet,
      defaultRequiresApproval?: boolean,
    ): Effect.Effect<EffectivePolicy, StorageFailure> =>
      ruleSet.kind === "prepared"
        ? Effect.succeed(ruleSet.resolve({ toolId, defaultRequiresApproval }))
        : ruleSet.kind === "provider"
          ? ruleSet.provider.resolve
            ? ruleSet.provider.resolve({ toolId, defaultRequiresApproval })
            : Effect.succeed(resolveProviderPolicyFromRules(toolId, ruleSet.rules ?? []))
          : Effect.succeed(
              resolveEffectivePolicy(
                toolId,
                ruleSet.rows,
                ownerRankForRow,
                defaultRequiresApproval,
              ),
            );

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

    // How long a remote-catalog connection's persisted tools stay fresh
    // (`ExecutorConfig.toolsSyncTtlMs`; `null` disables time-based re-sync).
    const toolsSyncTtlMs =
      config.toolsSyncTtlMs === undefined ? DEFAULT_TOOLS_SYNC_TTL_MS : config.toolsSyncTtlMs;

    // Rebuild any visible connection whose persisted tool catalog is stale.
    // Three triggers:
    //  - stale-marked: `tools_synced_at` is NULL (`connections.markToolsStale`
    //    — an MCP `tools/list_changed` notification or unknown-tool rejection
    //    cleared it mid-invocation);
    //  - config-revised: the integration's last tool-affecting config change
    //    postdates the connection's catalog. The change's author could only
    //    rewrite catalogs in their own partition (owner policy); every other
    //    subject converges here, on their own read, under their own binding;
    //  - expired: the plugin lists a live remote catalog (an MCP server, whose
    //    tool set can change with no executor-visible signal) and the catalog
    //    is older than the freshness TTL.
    // Best-effort: a failed rebuild leaves the stale-but-working catalog in
    // place and retries on the next read.
    const syncStaleConnectionTools = Effect.gen(function* () {
      // The platform view can never persist a rebuilt catalog (writes are
      // denied at the storage boundary), so attempting the sync would only
      // fire upstream `resolveTools` calls whose results are thrown away —
      // network side effects on a read-only credential. Skip it entirely:
      // read-only-ness of the platform read path is a stated invariant here,
      // not an accident of the best-effort catch below.
      if (config.platformView === true) return;
      const integrations = yield* core.findMany("integration", {});
      if (integrations.length === 0) return;
      const integrationBySlug = new Map(integrations.map((row) => [row.slug, row] as const));
      // The TTL only matters when a loaded plugin actually lists a live remote
      // catalog; otherwise skip it so age alone never widens the stale query.
      const anyRemoteCatalog = Array.from(runtimes.values()).some(
        (runtime) => runtime.plugin.remoteToolCatalog === true,
      );
      const cutoff =
        toolsSyncTtlMs == null || !anyRemoteCatalog ? null : Date.now() - toolsSyncTtlMs;

      // Bound the scan to potentially-stale rows: stale-marked (NULL stamp) or
      // synced before the latest instant any trigger could fire at (the TTL
      // cutoff / the newest config revision). Per-row trigger checks below
      // re-verify against each row's own integration; in steady state this
      // query returns nothing and the read pays one indexed lookup.
      const latestRevision = integrations.reduce<number | null>(
        (max, row) =>
          row.config_revised_at == null
            ? max
            : Math.max(max ?? Number(row.config_revised_at), Number(row.config_revised_at)),
        null,
      );
      const staleBefore =
        cutoff === null && latestRevision === null
          ? null
          : Math.max(cutoff ?? Number.MIN_SAFE_INTEGER, latestRevision ?? Number.MIN_SAFE_INTEGER);

      const connections = yield* core.findMany("connection", {
        where: (b: AnyCb) =>
          staleBefore === null
            ? b.isNull("tools_synced_at")
            : b.or(b.isNull("tools_synced_at"), b("tools_synced_at", "<", staleBefore)),
      });
      // Each rebuild is an independent upstream listing, so they run together
      // rather than one after another: a host with many stale remote-catalog
      // connections otherwise pays the sum of every server's latency on the
      // read that trips the TTL. Only the listings overlap — `persistCatalog`
      // keeps the catalog writes in a single-file queue, so this fan-out never
      // opens two transactions on a one-connection database.
      const rebuilds: Effect.Effect<readonly Tool[]>[] = [];
      for (const connection of connections) {
        const integrationRow = integrationBySlug.get(connection.integration);
        if (!integrationRow) continue;
        const runtime = runtimes.get(integrationRow.plugin_id);
        // Only re-produce catalogs this executor can actually re-list —
        // rebuilding under an unloaded plugin would clear a working catalog.
        // (A loaded plugin without `resolveTools` still flows through:
        // `produceConnectionTools` runs its clear-and-stamp cleanup path.)
        if (!runtime) continue;

        const syncedAt =
          connection.tools_synced_at == null ? null : Number(connection.tools_synced_at);
        const revisedTime =
          integrationRow.config_revised_at == null
            ? null
            : Number(integrationRow.config_revised_at);

        const staleMarked = syncedAt === null;
        const configRevised = revisedTime !== null && (syncedAt ?? 0) < revisedTime;
        const expired =
          cutoff !== null &&
          runtime.plugin.remoteToolCatalog === true &&
          syncedAt !== null &&
          syncedAt < cutoff;
        if (!staleMarked && !configRevised && !expired) continue;

        rebuilds.push(
          produceConnectionTools(
            integrationRow,
            {
              owner: connection.owner as Owner,
              integration: IntegrationSlug.make(connection.integration),
              name: ConnectionName.make(connection.name),
            },
            "background",
          ).pipe(
            // Best-effort, but never silent: the read still succeeds on the
            // stale-but-working catalog and the peer rebuilds still finish,
            // while the operator gets the connection that failed and why.
            // Without this a connection whose upstream is permanently broken
            // re-fails on every read and leaves no trace anywhere.
            Effect.catch((error) =>
              Effect.logWarning("executor stale tool sync failed", {
                integration: connection.integration,
                connection: connection.name,
                error: describeSyncFailure(error),
              }).pipe(Effect.as([] as readonly Tool[])),
            ),
            Effect.withSpan("executor.tools.sync_stale", {
              attributes: {
                "executor.integration": connection.integration,
                "executor.connection": connection.name,
              },
            }),
          ),
        );
      }
      yield* Effect.all(rebuilds, { concurrency: STALE_TOOLS_SYNC_CONCURRENCY });
    });

    // How long a tools read waits for the stale sync before answering from
    // the persisted rows (`ExecutorConfig.toolsSyncGraceMs`; `null` blocks
    // until convergence).
    const toolsSyncGraceMs =
      config.toolsSyncGraceMs === undefined ? DEFAULT_TOOLS_SYNC_GRACE_MS : config.toolsSyncGraceMs;

    // Run the stale sync with a bounded wait: a read pays at most the grace
    // budget for upstream listings it did not ask for, then serves the
    // persisted catalog while the rebuilds finish on their detached fibers
    // (deduplicated per connection by `produceConnectionTools`, so overlapping
    // reads share one rebuild instead of stacking new ones). One slow or dead
    // MCP server must never gate every catalog read behind its network
    // timeout. Past the deadline the sync is best-effort by construction —
    // failures log and the stale-but-working catalog stays — so the fork
    // swallows its scan errors the same way each rebuild already swallows its
    // own.
    const awaitStaleSyncWithinGrace = (graceMs: number) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkDetach(
          syncStaleConnectionTools.pipe(
            Effect.catch((error) =>
              Effect.logWarning("executor stale tool sync scan failed", {
                error: describeSyncFailure(error),
              }),
            ),
          ),
        );
        // On hosts that cancel request-scoped I/O once the response settles
        // (Cloudflare Workers), hand the host the rebuilds' completion so the
        // catalog still converges after the read stops waiting.
        config.waitUntil?.(
          new Promise<void>((resolve) => fiber.addObserver(() => resolve(undefined))),
        );
        yield* Fiber.await(fiber).pipe(Effect.timeoutOption(graceMs), Effect.asVoid);
      });

    const toolsList = (filter?: ToolListFilter): Effect.Effect<readonly Tool[], StorageFailure> =>
      Effect.gen(function* () {
        if (toolsSyncGraceMs === null) {
          yield* syncStaleConnectionTools;
        } else {
          yield* awaitStaleSyncWithinGrace(toolsSyncGraceMs);
        }
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
        const policyRules = yield* listActivePolicyRuleSet();
        const tools: Tool[] = [];
        for (const row of rows) {
          const tool = rowToTool(row);
          if (!matchesToolFilter(tool, filter)) continue;
          if (!includeBlocked) {
            const effective = yield* resolvePolicyFromRuleSet(
              normalizedPolicyId(tool),
              policyRules,
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
            const effective = yield* resolvePolicyFromRuleSet(
              normalizedPolicyId(tool),
              policyRules,
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
        const policyRules = yield* listActivePolicyRuleSet();
        const staticEntry = staticTools.get(String(address));
        if (staticEntry) {
          const tool = staticToolToTool(staticEntry);
          const effective = yield* resolvePolicyFromRuleSet(
            normalizedPolicyId(tool),
            policyRules,
            tool.annotations?.requiresApproval,
          );
          if (effective.action === "block") return null;
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
        const effective = yield* resolvePolicyFromRuleSet(
          normalizedPolicyId(tool),
          policyRules,
          tool.annotations?.requiresApproval,
        );
        if (effective.action === "block") return null;

        const runtime = runtimes.get(row.plugin_id);
        const projected = runtime?.plugin.projectToolSchema
          ? yield* runtime.plugin
              .projectToolSchema({
                ctx: runtime.ctx,
                toolRow: row,
                inputSchema: tool.inputSchema,
                outputSchema: tool.outputSchema,
              })
              .pipe(
                Effect.mapError((cause) =>
                  pluginStorageFailure(row.plugin_id, "projectToolSchema", cause),
                ),
              )
          : null;
        const inputSchema =
          projected && Object.prototype.hasOwnProperty.call(projected, "inputSchema")
            ? projected.inputSchema
            : tool.inputSchema;
        const outputSchema =
          projected && Object.prototype.hasOwnProperty.call(projected, "outputSchema")
            ? projected.outputSchema
            : tool.outputSchema;

        // Muscle memory: when neither the catalog row nor the plugin's
        // projection declares an output schema, serve the shape observed from
        // live responses instead of letting the type collapse to `unknown`.
        // The schema's description marks it as observed.
        const observed =
          outputSchema === undefined
            ? yield* shapeMemory.recall(String(address), parsed.owner)
            : null;
        const effectiveOutputSchema =
          outputSchema !== undefined
            ? outputSchema
            : observed !== null
              ? observedShapeToJsonSchema(observed)
              : undefined;

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

        const referenced = collectReferencedDefinitions([inputSchema, effectiveOutputSchema], defs);
        const preview = yield* Effect.tryPromise({
          try: () =>
            buildToolTypeScriptPreview({
              inputSchema,
              outputSchema: effectiveOutputSchema,
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
          inputSchema,
          outputSchema: effectiveOutputSchema,
          ...(observed !== null
            ? {
                outputSchemaSource: "observed" as const,
                outputSchemaObservations: observed.observations,
              }
            : {}),
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

    const providersGet = (
      key: ProviderKey,
      id: ProviderItemId,
    ): Effect.Effect<string | null, StorageFailure> =>
      Effect.gen(function* () {
        const provider = credentialProviders.get(String(key));
        if (!provider) return null;
        return yield* provider.get(id);
      });

    const providersHas = (
      key: ProviderKey,
      id: ProviderItemId,
    ): Effect.Effect<boolean, StorageFailure> =>
      Effect.gen(function* () {
        const provider = credentialProviders.get(String(key));
        if (!provider) return false;
        if (provider.has) return yield* provider.has(id);
        const value = yield* provider.get(id);
        return value !== null;
      });

    const providersSetDefault = (
      id: ProviderItemId,
      value: string,
    ): Effect.Effect<ProviderKey, CredentialProviderNotRegisteredError | StorageFailure> =>
      Effect.gen(function* () {
        const provider = defaultWritableProvider();
        if (!provider || !provider.set) {
          return yield* new CredentialProviderNotRegisteredError({
            provider: ProviderKey.make("default"),
          });
        }
        yield* provider.set(id, value);
        return provider.key;
      });

    const providersRemove = (
      key: ProviderKey,
      id: ProviderItemId,
    ): Effect.Effect<void, StorageFailure> =>
      Effect.gen(function* () {
        const provider = credentialProviders.get(String(key));
        if (!provider || !provider.delete) return;
        yield* provider.delete(id);
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
        // Default placement is specificity-aware (below any more-specific
        // rule), not top-of-list: a client that omits position — the UI when
        // its policy list is stale, the API, an agent tool — must not have its
        // broad rule silently shadow an existing narrow one.
        const position = input.position ?? positionForNewPattern(input.pattern, existing);
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
    // Artifacts — saved generative-UI components, owner-scoped.
    // ------------------------------------------------------------------

    // Reads take no explicit owner: the owner policy already narrows to the
    // rows this binding may see (org rows plus this subject's own), which is
    // exactly "visible to the bound owner scope" and stays correct unchanged
    // when org-tier sharing lands. Writes are always `user` tier in v1.
    const artifactById =
      (id: string): CoreWhere =>
      (b: AnyCb) =>
        b("id", "=", id);

    const artifactsList = (): Effect.Effect<readonly ArtifactSummary[], StorageFailure> =>
      core
        .findMany("artifact", {
          // Newest first. `id` breaks ties so two artifacts sharing an
          // `updated_at` millisecond list in a repeatable order rather than
          // whatever the storage engine happens to return; which of the two
          // comes first is arbitrary, only its stability is guaranteed.
          orderBy: [
            ["updated_at", "desc"],
            ["id", "desc"],
          ],
          select: ARTIFACT_SUMMARY_COLUMNS,
        })
        .pipe(Effect.map((rows) => rows.map(rowToArtifactSummary)));

    const artifactsGet = (
      id: string,
    ): Effect.Effect<Artifact, ArtifactNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const row = yield* core.findFirst("artifact", { where: artifactById(id) });
        if (!row) return yield* new ArtifactNotFoundError({ id: ArtifactId.make(id) });
        return rowToArtifact(row);
      });

    const artifactsSave = (
      input: SaveArtifactInput,
    ): Effect.Effect<Artifact, ArtifactNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const now = new Date();
        const description = input.description ?? null;
        // An explicit id overwrites in place (v1 keeps no version history). It
        // must already resolve to a visible row: minting a caller-chosen id
        // would let a stale client resurrect a deleted artifact silently.
        if (input.id !== undefined) {
          const where = artifactById(input.id);
          const existing = yield* core.findFirst("artifact", { where });
          if (!existing) {
            return yield* new ArtifactNotFoundError({ id: ArtifactId.make(input.id) });
          }
          // `bindings` is written on every overwrite, including back to null:
          // it interprets `code`, so carrying the previous value forward under
          // new source would bind roles the new code never declares. `preview`
          // is written for exactly the same reason, and the case it prevents is
          // visible: an image preview captured from the OLD render would
          // otherwise keep advertising a version of the artifact that no longer
          // exists.
          const set = {
            title: input.title,
            description,
            code: input.code,
            bindings: input.bindings ?? null,
            preview: input.preview ?? null,
            updated_at: now,
          };
          yield* core.updateMany("artifact", { where, set });
          return rowToArtifact({ ...existing, ...set });
        }
        yield* requireUserSubject("user");
        const keys = yield* Effect.try({
          try: () => ownedKeys("user"),
          catch: (cause) => storageFailureFromUnknown("invalid owner", cause),
        });
        const created = yield* core.create("artifact", {
          tenant: keys.tenant,
          owner: keys.owner,
          subject: keys.subject,
          id: `art_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
          title: input.title,
          description,
          code: input.code,
          bindings: input.bindings ?? null,
          preview: input.preview ?? null,
          created_at: now,
          updated_at: now,
        });
        return rowToArtifact(created);
      });

    /**
     * Replace an artifact's preview with a snapshot of a settled render.
     *
     * Only `preview` moves. `updated_at` deliberately does not: the gallery
     * sorts by it, and opening an artifact must not reorder the grid — being
     * looked at is not an edit.
     */
    const artifactsSetPreview = (
      input: SetArtifactPreviewInput,
    ): Effect.Effect<void, ArtifactNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const where = artifactById(input.id);
        const existing = yield* core.findFirst("artifact", { where });
        if (!existing) {
          return yield* new ArtifactNotFoundError({ id: ArtifactId.make(input.id) });
        }
        yield* core.updateMany("artifact", { where, set: { preview: input.preview } });
      });

    const artifactsRename = (
      input: RenameArtifactInput,
    ): Effect.Effect<Artifact, ArtifactNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const where = artifactById(input.id);
        const existing = yield* core.findFirst("artifact", { where });
        if (!existing) {
          return yield* new ArtifactNotFoundError({ id: ArtifactId.make(input.id) });
        }
        const set = { title: input.title, updated_at: new Date() };
        yield* core.updateMany("artifact", { where, set });
        return rowToArtifact({ ...existing, ...set });
      });

    // Hard delete: an artifact is not a connection, so there is no disabled or
    // archived state to fall back to.
    const artifactsRemove = (input: RemoveArtifactInput): Effect.Effect<void, StorageFailure> =>
      core.deleteMany("artifact", { where: artifactById(input.id) });

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

    // The single source of truth for "will enforceApproval pause this call".
    // Read before pre-approval arg validation so the extra validation pass
    // only runs for calls that would otherwise burn a user approval.
    const approvalRequired = (
      annotations: ToolAnnotations | undefined,
      policy: EffectivePolicy,
    ): boolean => {
      if (policy.action === "approve") return false;
      return policy.action === "require_approval" || annotations?.requiresApproval === true;
    };

    const enforceApproval = (
      annotations: ToolAnnotations | undefined,
      address: ToolAddress,
      args: unknown,
      policy: EffectivePolicy,
      handler: ElicitationHandler,
    ) =>
      Effect.gen(function* () {
        if (!approvalRequired(annotations, policy)) return;
        const policyForcesApproval = policy.action === "require_approval";
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
          const policyRules = yield* listActivePolicyRuleSet();
          const policy = yield* resolvePolicyFromRuleSet(
            String(address),
            policyRules,
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
          // An empty catalog on a connection that DOES exist is usually not a
          // wrong tool name: discovery produced nothing, most often because the
          // upstream rejected the credential. Reporting only the address sends
          // the reader after a tool that was never the problem, so name the
          // connection and point at the surface that knows the cause.
          const connectionExists =
            connectionTools.length === 0 &&
            (yield* findConnectionRow({
              owner: parsed.owner,
              integration: parsed.integration,
              name: parsed.connection,
            })) !== null;
          return yield* new ToolNotFoundError({
            address,
            suggestions: toolSuggestions(connectionTools),
            reason: connectionExists
              ? `connection "${parsed.integration}/${parsed.connection}" has no tools; ` +
                `check its health for why discovery produced none`
              : undefined,
          });
        }

        // Resolve policy (owner-ranked).
        const toolForPolicy = rowToTool(row);
        const policyRules = yield* listActivePolicyRuleSet();
        const annotations = decodeJsonColumn(row.annotations) as ToolAnnotations | undefined;
        const policy = yield* resolvePolicyFromRuleSet(
          normalizedPolicyId(toolForPolicy),
          policyRules,
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
        // When this call is about to pause for approval, validate args
        // first: a call that can only fail (missing required path param /
        // body) must be rejected here, not after the user grants an approval
        // that then goes to waste. Non-pausing calls skip this — invokeTool
        // raises the identical failure moments later without the extra pass.
        if (approvalRequired(resolvedAnnotations, policy) && runtime.plugin.validateToolArgs) {
          yield* runtime.plugin
            .validateToolArgs({ ctx: runtime.ctx, toolRow: row, args })
            .pipe(wrapInvocationError);
        }
        yield* enforceApproval(resolvedAnnotations, address, args, policy, handler);

        // Resolve every named credential input (`variable → value`); `value` is
        // the primary `token` for single-input + OAuth callers.
        const values = yield* resolveConnectionValues(connectionRow);
        const integrationRow = yield* findIntegrationRow(parsed.integration);
        const grantedScopes = grantedScopesFromRow(connectionRow);
        const invokeTool = runtime.plugin.invokeTool;
        const invokeWith = (
          resolved: Record<string, string | null>,
        ): Effect.Effect<unknown, ToolInvocationError> => {
          const credential: ToolInvocationCredential = {
            owner: parsed.owner,
            integration: parsed.integration,
            connection: parsed.connection,
            template: AuthTemplateSlug.make(connectionRow.template),
            value: resolved[PRIMARY_INPUT_VARIABLE] ?? null,
            values: resolved,
            config: integrationRow ? decodeJsonColumn(integrationRow.config) : undefined,
            ...(grantedScopes ? { grantedScopes } : {}),
          };
          return wrapInvocationError(
            invokeTool({
              ctx: runtime.ctx,
              toolRow: row,
              credential,
              args,
              elicit: buildElicit(address, args, handler),
              invokeOptions: options,
            }),
          );
        };

        const first = yield* invokeWith(values);
        // Reactive refresh. `expires_at` is only ever the AS's ADVERTISED
        // lifetime; the upstream rejecting the token is the authoritative word
        // on whether it is still good. The two diverge routinely: server-side
        // revocation, an identity provider's idle-timeout policy shorter than
        // the token lifetime, and connections whose AS omitted `expires_in`
        // entirely (null expiry → the proactive check never fires, so this is
        // their ONLY route back to a working token short of a reconnect).
        //
        // Deliberately narrow: exactly one retry, only on the 401 that means
        // "this credential is not valid", and only for a connection holding a
        // refresh token. A 403 is excluded — it means authenticated-but-not-
        // permitted, and re-minting the same grant returns the same answer.
        // If the retry also fails its result stands, so a genuinely dead grant
        // still surfaces the upstream's own auth failure and its reconnect
        // guidance rather than a masked one.
        if (!isUnauthorizedToolFailure(first)) return first;
        const refreshed = yield* forceRefreshConnectionValues(connectionRow).pipe(
          // A failed re-mint is not this call's failure to report: the upstream
          // already produced an auth failure with recovery guidance, which is
          // strictly more actionable than a refresh-plumbing error. Keep it.
          Effect.catchTag("CredentialResolutionError", () => Effect.succeed(null)),
        );
        if (!refreshed) return first;
        yield* Effect.annotateCurrentSpan({ "executor.oauth.refresh.retried": true });
        return yield* invokeWith(refreshed);
      }).pipe(
        // Expected tool failures (`ToolResult.fail`) resolve through the
        // success channel, so the tracer alone would record them as healthy
        // spans. Stamp the outcome + error code so telemetry can distinguish
        // "tool ran fine" from "user hit an upstream error / auth wall"
        // without parsing response bodies.
        Effect.tap(annotateToolResultOutcome),
        // Muscle memory: fold successful dynamic-tool payloads into the
        // observed output shape. Static tools are hand-typed already;
        // failures teach nothing about the success shape. Runs inline — not
        // forked — so the write survives Workers request teardown; `observe`
        // never fails, is size-bounded, and stops writing once the shape
        // stabilizes, so steady-state cost is one cache lookup.
        Effect.tap((result) => {
          if (staticTools.has(String(address))) return Effect.void;
          const parsed = parseToolAddress(String(address));
          if (!parsed) return Effect.void;
          const data = isToolResult(result) ? (result.ok ? result.data : undefined) : result;
          if (data === undefined) return Effect.void;
          return shapeMemory.observe(String(address), parsed.owner, data);
        }),
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
      connectionNameTaken: (ref) => findConnectionRow(ref).pipe(Effect.map((row) => row !== null)),
      // One integration-row read + one projector run. Resolve the method this
      // template selects exactly as the runtime's `selectAuthMethod` does —
      // exact slug match, else the sole declared method (single-method
      // integrations accept any slug); an ambiguous miss selects nothing rather
      // than guessing across methods. The discover-vs-scopes choice then reads
      // off that method (MCP exposes `discoveryUrl`), so core needs no plugin-id
      // knowledge.
      resolveOAuthScopePolicy: (integration: IntegrationSlug, template: AuthTemplateSlug) =>
        findIntegrationRow(integration).pipe(
          Effect.map((row): OAuthScopePolicy => {
            const methods = row ? describeAuthMethodsForRow(row) : [];
            const selected =
              methods.find((m: AuthMethodDescriptor) => m.template === String(template)) ??
              (methods.length === 1 ? methods[0] : undefined);
            const oauth = selected?.kind === "oauth" ? selected.oauth : undefined;
            // Declared scopes win. Discover only when the selected method
            // declares none but names a source to discover them from (MCP).
            if (oauth?.scopes === undefined && oauth?.discoveryUrl !== undefined) {
              return { kind: "discover" };
            }
            return { kind: "scopes", scopes: oauth?.scopes ?? [] };
          }),
        ),
      httpClientLayer: config.httpClientLayer,
      fetch: config.fetch,
      endpointUrlPolicy: config.oauthEndpointUrlPolicy,
      // Connect-time only. The refresh path above (`performEnterpriseManagedRefresh`)
      // deliberately never sees this — it follows the enterprise state persisted
      // on the connection.
      enterpriseManagedRollout: config.enterpriseManagedRollout,
      // EXPLICIT — no localhost default. When a caller omits `redirectUri` the
      // OAuth service receives `null` and redirect-requiring flows fail loudly
      // instead of silently using `http://127.0.0.1/callback`. Hosts that serve
      // OAuth (cloud, self-host) derive a real `${webBaseUrl}/oauth/callback`.
      redirectUri: config.redirectUri ?? null,
      callbackStateOrgSlug: config.oauthCallbackStateOrgSlug ?? null,
      firstPartyClients: config.firstPartyOAuthClients,
    });

    // ------------------------------------------------------------------
    // Plugin wiring — build ctx, run extension, populate static pools,
    // register credential providers.
    // ------------------------------------------------------------------

    const blobPartitions: OwnerPartitions = {
      org: `o:${tenant}`,
      user: subject != null ? `u:${tenant}:${subject}` : null,
    };

    // Pending approvals file under the narrowest partition this executor has:
    // a subject-bound executor keeps them private to that member, and a pure-org
    // executor (no subject) files them at the org. Either way the partition IS
    // the ownership check — another caller's executor reads a different
    // namespace and simply does not see the record.
    const pendingApprovals = makePendingApprovalStore(
      blobs,
      blobPartitions.user ?? blobPartitions.org,
    );

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
            setHealthCheck: (slug, spec) =>
              integrationSetHealthCheck(slug, spec).pipe(
                // Fold not-found: a plugin declaring a default on a row it
                // never registered is a no-op, not a storage failure.
                Effect.catchTag("IntegrationNotFoundError", () => Effect.void),
              ),
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
          update: (ref, input) => connectionsUpdate(ref, input),
          remove: (ref) => connectionsRemove(ref),
          refresh: (ref) => connectionsRefresh(ref),
          markToolsStale: (ref) => connectionsMarkToolsStale(ref),
          resolveValue: (ref) => resolveConnectionValueByRef(ref),
        },
        providers: {
          list: () => providersList(),
          items: (key) => providersItems(key),
          get: (key, id) => providersGet(key, id),
          has: (key, id) => providersHas(key, id),
          setDefault: (id, value) => providersSetDefault(id, value),
          remove: (key, id) => providersRemove(key, id),
        },
        oauth,
        execute: (address, args, options) => execute(address, args, options),
        transaction: <A, E>(effect: Effect.Effect<A, E>) => transaction(effect),
        afterCommit: (effect: Effect.Effect<void>) => afterCommit(effect),
      };

      if (plugin.toolPolicyProvider) {
        const rawProvider = plugin.toolPolicyProvider(ctx);
        const provider = Effect.isEffect(rawProvider) ? yield* rawProvider : rawProvider;
        if (provider) {
          if (activeToolPolicyProvider) {
            return yield* new StorageError({
              message: "Only one plugin can provide the active tool policy source.",
              cause: undefined,
            });
          }
          activeToolPolicyProvider = provider;
        }
      }

      // Build extension FIRST so it's available as `self` for staticIntegrations.
      const extension: object = plugin.extension ? plugin.extension(ctx) : {};
      if (plugin.extension) {
        extensions[plugin.id] = extension;
      }

      const decls = plugin.staticIntegrations ? plugin.staticIntegrations(extension) : [];
      for (const integration of decls) {
        const mountUnderExecutor = integration.kind === "executor";
        const mountedIntegration = mountUnderExecutor ? EXECUTOR_INTEGRATION : integration;
        for (const tool of integration.tools) {
          const mountedTool = mountUnderExecutor
            ? { ...tool, name: `${integration.id}.${tool.name}` }
            : tool;
          const fqid = `${mountedIntegration.id}.${mountedTool.name}`;
          if (staticTools.has(fqid)) {
            return yield* new StorageError({
              message: `Duplicate static tool id: ${fqid} (plugin ${plugin.id})`,
              cause: undefined,
            });
          }
          staticTools.set(fqid, {
            integration: mountedIntegration,
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
    // Platform view — read-only, tenant-wide admin reads (opt-in).
    //
    // A SECOND handle over the same root db, bound to the same tenant but at
    // `reach: "tenant"`. Deriving it here rather than re-scoping `rootDb`
    // keeps the product view untouched: the bound handle above never learns
    // about reach, so it cannot drift into the platform view. Writes through
    // this handle are rejected by the owner policy, so "read-only" is enforced
    // at the storage boundary, not by this module's discipline.
    //
    // The base context is ALREADY `writes: "denied"` whenever the platform view
    // is on (see `ownerContext`); this handle adds tenant reach on top. The two
    // axes are separate on purpose — this is the only surface that gets the
    // widened reads, while read-only covers all of them.
    // ------------------------------------------------------------------

    const makeAdmin = (): ExecutorAdmin => {
      const platformCore = makeCoreDb(
        makeFumaClient(
          withQueryContext(rootDbUntyped, {
            ...ownerContext,
            reach: "tenant",
          } satisfies ExecutorOwnerPolicyContext),
        ),
      );

      const rowToAdminSubject = (row: CoreRow<"subject">): AdminSubject => ({
        externalId: row.external_id,
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
        // bigint on drivers that return one, and a blob on SQLite — hence the
        // ORM read rather than raw SQL (see `subject-registry.ts`).
        lastSeenAt: row.last_seen_at == null ? null : Number(row.last_seen_at),
        status: row.status ?? null,
      });

      const rowToAdminConnection = (row: ConnectionRow): AdminConnection => {
        const owner = row.owner as Owner;
        return {
          owner,
          // Org rows carry the empty-string sentinel, not a principal.
          subject: owner === "org" ? null : row.subject,
          integration: IntegrationSlug.make(row.integration),
          name: ConnectionName.make(row.name),
          oauthScope: row.oauth_scope == null ? null : String(row.oauth_scope),
          lastHealth: Option.getOrNull(decodeLastHealth(row.last_health)),
        };
      };

      const listSubjects = (
        options?: AdminListSubjectsOptions,
      ): Effect.Effect<readonly AdminSubject[], StorageFailure> => {
        // Always both, always integers — see `normalizeAdminPaging`. Passing
        // them through independently produced a bare OFFSET, which SQLite
        // rejects outright.
        const { limit, offset } = normalizeAdminPaging(options);
        return platformCore
          .findMany("subject", {
            // Oldest first, ties broken on the unique key so the order is
            // total and paging can't repeat or skip a row.
            orderBy: [
              ["created_at", "asc"],
              ["external_id", "asc"],
            ],
            limit,
            offset,
          })
          .pipe(Effect.map((rows) => rows.map(rowToAdminSubject)));
      };

      // Keyed on `(tenant, external_id)` — the table's unique index. No
      // `tenant` clause here: the tenant policy adds it to every read, the
      // same way `touchSubject` relies on it.
      const getSubject = (externalId: string): Effect.Effect<AdminSubject | null, StorageFailure> =>
        platformCore
          .findFirst("subject", { where: (b: AnyCb) => b("external_id", "=", externalId) })
          .pipe(Effect.map((row) => (row === null ? null : rowToAdminSubject(row))));

      const listSubjectConnections = (
        externalId: string,
      ): Effect.Effect<readonly AdminConnection[], StorageFailure> =>
        platformCore
          .findMany("connection", {
            // `owner: "user"` explicitly: an org connection's `subject` is the
            // empty-string sentinel, and attributing those to a user would be
            // a lie in every host that has one.
            where: (b: AnyCb) => b.and(b("owner", "=", "user"), b("subject", "=", externalId)),
            orderBy: [
              ["integration", "asc"],
              ["name", "asc"],
            ],
          })
          .pipe(Effect.map((rows) => rows.map(rowToAdminConnection)));

      // ONE connection query for the whole page, not one per subject. The
      // per-subject form was an N+1: a default page issued 100 sequential
      // `findMany`s over a per-request socket, which on cloud cost ~1.4s of a
      // ~2.4s response. Cost is now two queries regardless of page size.
      //
      // The `in` predicate carries the SAME `owner: "user"` clause the keyed
      // read does, so org rows (whose `subject` is the empty-string sentinel)
      // stay excluded, and the tenant policy scopes both reads identically.
      //
      // Ordering is preserved WITHOUT a per-subject sort: the query orders by
      // `(integration, name)` across the page, and grouping walks those rows
      // in order, so each subject's bucket comes out in the same order the
      // per-subject query produced. Subjects with no connections still report
      // an empty array rather than dropping out of the page.
      const listSubjectsWithConnections = (
        options?: AdminListSubjectsOptions,
      ): Effect.Effect<readonly AdminSubjectWithConnections[], StorageFailure> =>
        Effect.gen(function* () {
          const subjects = yield* listSubjects(options);
          // No page, no connection query — `in ([])` is a query that cannot
          // match, so issuing it would be pure latency.
          if (subjects.length === 0) return [];

          const rows = yield* platformCore.findMany("connection", {
            where: (b: AnyCb) =>
              b.and(
                b("owner", "=", "user"),
                b(
                  "subject",
                  "in",
                  subjects.map((entry) => entry.externalId),
                ),
              ),
            orderBy: [
              ["integration", "asc"],
              ["name", "asc"],
            ],
          });

          const bySubject = new Map<string, AdminConnection[]>();
          for (const row of rows) {
            const connection = rowToAdminConnection(row);
            const bucket = bySubject.get(row.subject);
            if (bucket) bucket.push(connection);
            else bySubject.set(row.subject, [connection]);
          }

          return subjects.map((entry) => ({
            ...entry,
            connections: bySubject.get(entry.externalId) ?? [],
          }));
        });

      // Absent subject short-circuits: no connection query is issued for a
      // principal the tenant never recorded.
      const getSubjectWithConnections = (
        externalId: string,
      ): Effect.Effect<AdminSubjectWithConnections | null, StorageFailure> =>
        Effect.gen(function* () {
          const subject = yield* getSubject(externalId);
          if (subject === null) return null;
          const connections = yield* listSubjectConnections(externalId);
          return { ...subject, connections };
        });

      return {
        listSubjects,
        getSubject,
        listSubjectConnections,
        listSubjectsWithConnections,
        getSubjectWithConnections,
      };
    };

    // Default OFF: without the opt-in there is no `admin` key at all, so the
    // tenant-wide handle is never even constructed.
    const admin = config.platformView === true ? makeAdmin() : undefined;

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
        healthCheck: {
          get: integrationHealthCheckGet,
          candidates: integrationHealthCheckCandidates,
          set: integrationSetHealthCheck,
        },
      },
      connections: {
        create: connectionsCreate,
        list: connectionsList,
        get: connectionsGet,
        update: connectionsUpdate,
        remove: connectionsRemove,
        refresh: connectionsRefresh,
        checkHealth: connectionCheckHealth,
        validate: connectionValidate,
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
      ...(admin ? { admin } : {}),
      artifacts: {
        list: artifactsList,
        get: artifactsGet,
        save: artifactsSave,
        rename: artifactsRename,
        remove: artifactsRemove,
        setPreview: artifactsSetPreview,
      },
      pendingApprovals,
      execute,
      close,
    };

    const toExecutor = (value: unknown): Executor<TPlugins> => value as Executor<TPlugins>;
    return toExecutor(Object.assign(base, extensions));
  });

// Helper alias so the inline literal used for the optimistic projection in
// `produceConnectionTools` satisfies the ToolRow shape.
type ConnectionToolRow = ToolRow;
