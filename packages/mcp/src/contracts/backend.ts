import type { McpTarget, McpTargetInput } from "./targets.ts";
import type {
  App,
  Executor,
  ToolCallResult,
  ToolPending,
  ToolResumeResult,
  ToolPage,
  ToolInvocationOptions,
  ElicitationFailed,
  AppSkillCatalog,
  AppSkillDocument,
} from "@executor-js/sdk/core";
import type { Effect } from "effect";

/**
 * The catalog and calls available to one authenticated caller. Products own
 * authorization on every operation; an owner filter alone is not authority.
 * Create hosted adapters per request, never cache them across callers.
 * Preserve native errors. Schema error identifiers become public diagnostics at the MCP
 * response boundary. Declared API errors have a bounded safe projection; other
 * messages, fields and causes remain private.
 */
export interface McpBackend<E extends Error> {
  /** Authorize static metadata without evaluating the app or requiring connected accounts. */
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
  /** Enumerate only the caller's execution targets; static skills still belong to the real app. */
  readonly listTargets: (input: McpTargetInput) => Effect.Effect<readonly McpTarget[], E>;
  /** Authorize the app and its selected accounts before evaluating each catalog page. */
  readonly listTools: (
    input: Parameters<Executor["tools"]["list"]>[0],
  ) => Effect.Effect<ToolPage, E>;
  /** Check execution permission again; prior discovery does not authorize this call. */
  readonly callTool: (
    input: Parameters<Executor["tools"]["call"]>[0],
    options?: ToolInvocationOptions,
  ) => Effect.Effect<ToolCallResult, E>;
  /** Reauthorize the reviewed app/accounts and current caller before consuming this exact SDK request. */
  readonly resumeInvocation: (
    request: typeof ToolPending.Type,
    response: Parameters<Executor["tools"]["resume"]>[0]["response"],
    options?: ToolInvocationOptions,
  ) => Effect.Effect<ToolResumeResult, E>;
}
