import type { McpTarget, McpTargetInput } from "./targets.ts";
import type {
  App,
  Executor,
  ToolCallResult,
  ToolPending,
  ToolResumeResult,
  ToolPage,
  ToolInvocationOptions,
  ToolListOptions,
  ElicitationFailed,
  AppSkillCatalog,
  AppSkillDocument,
  AppEventDefinition,
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
import type { Effect } from "effect";

/** A subscription key without its principal: the product binds that to the caller. */
export type McpEventKey = Omit<EventSubscriptionKey, "principal">;

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
  /** Authorize app and profile access before evaluating skill metadata. */
  readonly listSkills: (
    input: Parameters<Executor["skills"]["list"]>[0],
  ) => Effect.Effect<AppSkillCatalog, E>;
  /** Reauthorize each document/reference read, including previous deployments. */
  readonly readSkill: (
    input: Parameters<Executor["skills"]["read"]>[0],
  ) => Effect.Effect<AppSkillDocument, E>;
  /** Reauthorize input delivery using the current request before releasing a running tool. */
  readonly authorizeElicitation: (
    input: Pick<
      Parameters<Executor["tools"]["call"]>[0],
      "app" | "tool" | "profile" | "expectedProfileRevision"
    >,
  ) => Effect.Effect<void, ElicitationFailed>;
  /** Apply IDs in storage before loading app metadata. [] selects none; omitted IDs add no restriction.
   * Hosts still enforce owner access; this filter is never an authorization grant.
   */
  readonly listApps: (
    input?: Pick<NonNullable<Parameters<Executor["apps"]["list"]>[0]>, "ids">,
  ) => Effect.Effect<ReadonlyArray<Pick<App, "id" | "name" | "slug">>, E>;
  /** Enumerate only the caller's execution targets; skills use the same app and account authority. */
  readonly listTargets: (input: McpTargetInput) => Effect.Effect<readonly McpTarget[], E>;
  /** Authorize the app and its selected accounts before evaluating each catalog page. */
  readonly listTools: (
    input: Parameters<Executor["tools"]["list"]>[0],
    options?: ToolListOptions,
  ) => Effect.Effect<ToolPage, E>;
  /** Check execution permission again; prior discovery does not authorize this call. */
  readonly callTool: (
    input: Parameters<Executor["tools"]["call"]>[0],
    options?: ToolInvocationOptions,
  ) => Effect.Effect<ToolCallResult, E>;
  /** Authorize the app, then list the events its active deployment declares. */
  readonly eventDefinitions: (input: {
    readonly app: AppId;
  }) => Effect.Effect<readonly AppEventDefinition[], E>;
  /** This caller's saved subscription with the key, if any. Reveals nothing of other callers. */
  readonly findEventSubscription: (key: McpEventKey) => Effect.Effect<EventSubscription | null, E>;
  /** Authorize the target app's events for this caller, then subscribe or refresh as the caller. */
  readonly subscribeEvent: (
    input: Omit<SubscribeEvent, "key" | "subject" | "target"> & {
      readonly key: McpEventKey;
      readonly target: NonNullable<SubscribeEvent["target"]>;
    },
  ) => Effect.Effect<EventSubscriptionGrant, E | McpEventError>;
  /** Stop this caller's subscription with the key. Its app is authorized as for subscribing. */
  readonly unsubscribeEvent: (input: {
    readonly app: AppId;
    readonly key: McpEventKey;
  }) => Effect.Effect<void, E>;
  /** Reauthorize the reviewed app/accounts and current caller before consuming this exact SDK request. */
  readonly resumeInvocation: (
    request: typeof ToolPending.Type,
    response: Parameters<Executor["tools"]["resume"]>[0]["response"],
    options?: ToolInvocationOptions,
  ) => Effect.Effect<ToolResumeResult, E>;
}
