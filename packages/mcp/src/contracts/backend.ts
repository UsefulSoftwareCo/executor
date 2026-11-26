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
  AppSkillBundle,
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

export type McpEventKey = Omit<EventSubscriptionKey, "principal">;

export type McpEventTarget =
  | { readonly app: AppId; readonly event: string | null }
  | { readonly app: null; readonly event: null };

export type McpEventError =
  | EventNotFound
  | EventDefinitionChanged
  | EventSubscriptionInvalid
  | EventCallbackFailed
  | EventsUnavailable;

export interface McpBackend<E extends Error> {
  readonly listSkills: (
    input: Parameters<Executor["skills"]["list"]>[0],
    options?: CatalogReadOptions,
  ) => Effect.Effect<AppSkillCatalog, E>;
  readonly bundleSkills: (
    input: Parameters<Executor["skills"]["bundle"]>[0],
    options?: CatalogReadOptions,
  ) => Effect.Effect<AppSkillBundle, E>;
  readonly readSkill: (
    input: Parameters<Executor["skills"]["read"]>[0],
  ) => Effect.Effect<AppSkillDocument, E>;
  readonly authorizeElicitation: (
    input: Pick<Parameters<Executor["tools"]["call"]>[0], "app" | "tool" | "accounts">,
  ) => Effect.Effect<void, ElicitationFailed>;
  readonly listApps: (
    input?: Pick<NonNullable<Parameters<Executor["apps"]["list"]>[0]>, "ids"> & {
      readonly toolsOnly?: boolean;
    },
  ) => Effect.Effect<ReadonlyArray<Pick<App, "id" | "name" | "slug" | "activeVersion">>, E>;
  readonly listAccounts: (input: McpTargetInput) => Effect.Effect<McpAppAccounts, E>;
  readonly listTools: (
    input: Parameters<Executor["tools"]["list"]>[0],
    options?: ToolListOptions,
  ) => Effect.Effect<ToolPage, E>;
  readonly searchableTools: (
    input: Parameters<Executor["tools"]["searchable"]>[0],
    options?: ToolListOptions,
  ) => Effect.Effect<SearchableTools, E>;
  readonly searchTools: (
    input: Parameters<Executor["tools"]["search"]>[0],
  ) => Effect.Effect<ToolSearchPage, E>;
  readonly callTool: (
    input: Parameters<Executor["tools"]["call"]>[0],
    options?: ToolInvocationOptions,
  ) => Effect.Effect<ToolCallResult, E>;
  readonly findEventSubscription: (key: McpEventKey) => Effect.Effect<EventSubscription | null, E>;
  readonly subscribeEvent: (
    input: Omit<SubscribeEvent, "key" | "subject" | "target"> & {
      readonly key: McpEventKey;
      readonly target: McpEventTarget;
    },
  ) => Effect.Effect<EventSubscriptionGrant, E | McpEventError>;
  readonly unsubscribeEvent: (input: {
    readonly app: AppId | null;
    readonly key: McpEventKey;
  }) => Effect.Effect<void, E>;
  readonly resumeInvocation: (
    request: typeof ToolPending.Type,
    response: Parameters<Executor["tools"]["resume"]>[0]["response"],
    options?: ToolInvocationOptions,
  ) => Effect.Effect<ToolResumeResult, E>;
}

export const CurrentMcpExecution = Context.Reference<string | undefined>(
  "executor/mcp/CurrentExecution",
  { defaultValue: () => undefined },
);

export const ToolCallRecorded = Context.Reference<((reference: string) => void) | undefined>(
  "executor/mcp/ToolCallRecorded",
  { defaultValue: () => undefined },
);
