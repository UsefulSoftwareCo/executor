import type { McpAppAccounts, McpTargetInput } from "./targets.ts";
import type {
  App,
  Executor,
  ToolCallResult,
  ToolPending,
  ToolResumeResult,
  ToolPage,
  SearchableTools,
  ToolSearchPage,
  ToolInvocationOptions,
  ToolListOptions,
  CatalogReadOptions,
  ElicitationFailed,
  AppSkillCatalog,
  AppSkillDocument,
  AppId,
  EventCallbackFailed,
  EventDefinitionChanged,
  EventNotFound,
  EventSubscription,
  EventSubscriptionGrant,
  EventSubscriptionInvalid,
  EventSubscriptionKey,
  EventsUnavailable,
  SubscribeEvent,
} from "@executor-js/sdk/core";
import { Context, type Effect } from "effect";

/** A subscription key without its principal: the product binds that to the caller. */
export type McpEventKey = Omit<EventSubscriptionKey, "principal">;

/**
 * The events a subscription targets: one event of an app, all of an app's events (`event` null),
 * or every event of every app the caller can use (`app` null), whose owner the product supplies.
 */
export type McpEventTarget =
  | { readonly app: AppId; readonly event: string | null }
  | { readonly app: null; readonly event: null };

/** Why a subscription was refused, beside the host's own errors. */
export type McpEventError =
  | EventNotFound
  | EventDefinitionChanged
  | EventSubscriptionInvalid
  | EventCallbackFailed
  | EventsUnavailable;

/**
 * The catalog and calls available to one authenticated caller. Products own
 * authorization on every operation; an owner filter alone is not authority.
 * Create hosted adapters per request, never cache them across callers.
 * Preserve native errors. Schema error identifiers become public diagnostics at the MCP
 * response boundary. Declared API errors have a bounded safe projection; other
 * messages, fields and causes remain private.
 */
export interface McpBackend<E extends Error> {
  /** Authorize app and account access before evaluating skill metadata. */
  readonly listSkills: (
    input: Parameters<Executor["skills"]["list"]>[0],
    options?: CatalogReadOptions,
  ) => Effect.Effect<AppSkillCatalog, E>;
  /** Reauthorize each document/reference read, including previous versions. */
  readonly readSkill: (
    input: Parameters<Executor["skills"]["read"]>[0],
  ) => Effect.Effect<AppSkillDocument, E>;
  /** Reauthorize input delivery using the current request before releasing a running tool. */
  readonly authorizeElicitation: (
    input: Pick<Parameters<Executor["tools"]["call"]>[0], "app" | "tool" | "accounts">,
  ) => Effect.Effect<void, ElicitationFailed>;
  /** Apply IDs in storage before loading app metadata. [] selects none; omitted IDs add no restriction.
   * Hosts still enforce owner access; this filter is never an authorization grant.
   */
  readonly listApps: (
    input?: Pick<NonNullable<Parameters<Executor["apps"]["list"]>[0]>, "ids"> & {
      /** Restrict the inventory to apps whose tools this caller may reach. */
      readonly toolsOnly?: boolean;
    },
  ) => Effect.Effect<ReadonlyArray<Pick<App, "id" | "name" | "slug" | "activeVersion">>, E>;
  /**
   * The caller's linked accounts for the app, by user requirement; skills use the same authority.
   * App requirements are not listed: operations name `{ app: {}, user }` and the backend fills the
   * app requirements from the app links.
   */
  readonly listAccounts: (input: McpTargetInput) => Effect.Effect<McpAppAccounts, E>;
  /** Authorize the app and its selected accounts before evaluating each catalog page. */
  readonly listTools: (
    input: Parameters<Executor["tools"]["list"]>[0],
    options?: ToolListOptions,
  ) => Effect.Effect<ToolPage, E>;
  /**
   * Authorize the app and its selected accounts as for `listTools`, then keep the target's current
   * listing as search rows. Only failed routers the caller may discover are returned.
   */
  readonly searchableTools: (
    input: Parameters<Executor["tools"]["searchable"]>[0],
    options?: ToolListOptions,
  ) => Effect.Effect<SearchableTools, E>;
  /**
   * Rank the tools of listings `searchableTools` returned to this backend. Narrow each target's
   * scopes to the tools the caller may discover, as `listTools` filters them, before ranking, so
   * pages and counts never include hidden tools; never widen them.
   */
  readonly searchTools: (
    input: Parameters<Executor["tools"]["search"]>[0],
  ) => Effect.Effect<ToolSearchPage, E>;
  /** Check execution permission again; prior discovery does not authorize this call. */
  readonly callTool: (
    input: Parameters<Executor["tools"]["call"]>[0],
    options?: ToolInvocationOptions,
  ) => Effect.Effect<ToolCallResult, E>;
  /** This caller's saved subscription with the key, if any. Reveals nothing of other callers. */
  readonly findEventSubscription: (key: McpEventKey) => Effect.Effect<EventSubscription | null, E>;
  /**
   * Authorize the target's events for this caller, then subscribe or refresh as the caller. A
   * target of every app is the caller's owner's apps; each delivery checks the occurrence's app.
   */
  readonly subscribeEvent: (
    input: Omit<SubscribeEvent, "key" | "subject" | "target"> & {
      readonly key: McpEventKey;
      readonly target: McpEventTarget;
    },
  ) => Effect.Effect<EventSubscriptionGrant, E | McpEventError>;
  /**
   * Stop this caller's subscription with the key. Its app, when it has one, is authorized as for
   * subscribing.
   */
  readonly unsubscribeEvent: (input: {
    readonly app: AppId | null;
    readonly key: McpEventKey;
  }) => Effect.Effect<void, E>;
  /** Reauthorize the reviewed app/accounts and current caller before consuming this exact SDK request. */
  readonly resumeInvocation: (
    request: typeof ToolPending.Type,
    response: Parameters<Executor["tools"]["resume"]>[0]["response"],
    options?: ToolInvocationOptions,
  ) => Effect.Effect<ToolResumeResult, E>;
}

/**
 * The execution a backend operation runs for: one `execute` program or one `call` batch, from its
 * start until it ends, across the requests that resume it. Its ID is the `executor.execution.id`
 * its spans carry. Provided around every operation the execution starts; unset elsewhere.
 */
export const CurrentMcpExecution = Context.Reference<string | undefined>(
  "executor/mcp/CurrentExecution",
  { defaultValue: () => undefined },
);

/**
 * Told the host's reference for the call `callTool` is making, once the host has recorded the
 * call: an opaque ID the caller can quote to whoever reviews the host's records, such as hosted
 * Executor's tool call log. The execution provides it around each tool call, including across the
 * driving request that makes the call for a program; a host that keeps no records never calls it.
 * A call the host did not record has no reference.
 */
export const ToolCallRecorded = Context.Reference<((reference: string) => void) | undefined>(
  "executor/mcp/ToolCallRecorded",
  { defaultValue: () => undefined },
);
