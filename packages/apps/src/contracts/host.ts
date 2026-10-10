export * from "./skills.ts";
import { type SkillFile } from "./skills.ts";
import { ProviderError } from "./provider-error.ts";
import { OpenapiResponseError } from "./api-response-error.ts";
export {
  ApiErrorResponse,
  maxApiErrorInstructionsLength,
  maxApiErrorMessageLength,
  OpenapiResponseError,
} from "./api-response-error.ts";
export { ProviderError } from "./provider-error.ts";
export {
  FetchOptionUnsupported,
  NetworkRefusal,
  NetworkRefused,
  networkRefusalHeader,
  networkRefusalResponse,
  networkRefusalStatus,
} from "./network.ts";
import {
  WorkflowFailure,
  type WorkflowExecution,
  type WorkflowReplay,
  type WorkflowHostControls,
} from "./workflows.ts";
export * from "./workflows.ts";
export * from "./failure.ts";
import { DatabaseFieldReserved, DatabaseLimitExceeded } from "@executor-js/app-data/contracts";
export { DatabaseFieldReserved, DatabaseLimitExceeded } from "@executor-js/app-data/contracts";
/** Portable framework dispatch contracts. Requests never carry account bindings. */
import { Context, Schema, type Effect, type Redacted } from "effect";
import type { AppSqlStorage } from "./sql.ts";
import type { InvocationTelemetry } from "@executor-js/telemetry";
export {
  type AppSqlStorage,
  type Sql,
  type SqlCursor,
  type SqlReader,
  type SqlRow,
  type SqlValue,
} from "./sql.ts";
import { ElicitationFailed, type ElicitationHandler } from "./elicitation.ts";
export {
  ElicitationLimits,
  defaultElicitationLimits,
  FormElicitation,
  ElicitationResponse,
  ElicitationReply,
  ElicitationFailed,
  type ElicitationHandler,
  ApprovalElicitation,
  ApprovalResponse,
  approvalElicitation,
} from "./elicitation.ts";
export { McpClientLimits, defaultMcpClientLimits } from "./mcp.ts";
export * from "./webhook-protocol.ts";
export * from "./events.ts";
export * from "./placement.ts";

export { AccountId, HttpUrl } from "./schema.ts";
export {
  OAuthAuthorizationParams,
  OAuthClientAuth,
  OAuthSecretClientAuth,
  OAuthTokenRequestFormat,
  OAuthTokenResponse,
} from "./provider.ts";

/**
 * The host protocol this framework speaks and its wire schemas, from `protocols/current.ts`. The
 * released protocol modules are frozen records that host adapters read.
 */
export { frameworkProtocol } from "./protocol-version.ts";
export { protocol1 } from "./protocols/1.ts";
export { protocol2 } from "./protocols/2.ts";
export { protocol3 } from "./protocols/3.ts";
export { protocol4 } from "./protocols/4.ts";
export { protocol5 } from "./protocols/5.ts";
export { protocol6 } from "./protocols/6.ts";
export { protocol7 } from "./protocols/7.ts";
export { protocol8 } from "./protocols/8.ts";
export { protocol9 } from "./protocols/9.ts";
export { protocol10 } from "./protocols/10.ts";
export {
  current as protocol11,
  AccountCheckCommand,
  CredentialHost,
  MigrateCommand,
  MigrateResult,
} from "./protocols/current.ts";
export { AccountCheckResult, AccountInfo } from "./provider.ts";
import {
  HostAccountsInvalid,
  HostDeclarationInvalid,
  HostEvaluationFailed,
  HostInputInvalid,
  HostKindMismatch,
  HostOperationFailed,
  HostOperationNotFound,
  HostOutputInvalid,
  HostRequestInvalid,
  HostToolApprovalRequired,
  HostToolBlocked,
  HostToolNotFound,
  HostToolPolicyFailed,
  McpError,
  SkillLoadFailed,
  SkillSources,
  type InvocationDeadline,
  ResolvedAccount,
  ResolvedAccounts,
  type SkillCatalogResponse,
  type TrustedToolApproval,
} from "./protocols/current.ts";
export { DeclaredRequirements, HostRequest } from "./protocols/current.ts";
/**
 * The MCP and skill loader failures as they cross the host boundary. Apps throw the author-facing
 * classes from `apps/mcp` and `apps/skills`.
 */
export { McpError, SkillLoadFailed } from "./protocols/current.ts";
export {
  DeclaredAuthMethod,
  DeclaredProvider,
  ResolvedAccount,
  ResolvedAccounts,
  TrustedToolApproval,
  InvocationDeadline,
  HostedTool,
  HostedToolSummary,
  HostRouterError,
  HostedRouter,
  HostedCatalog,
  HostedCatalogSummary,
  SkillSources,
  SkillCatalogResponse,
  HostRequestInvalid,
  HostAccountsInvalid,
  HostDeclarationInvalid,
  HostEvaluationFailed,
  HostOperationNotFound,
  HostOperationFailed,
  HostToolNotFound,
  HostKindMismatch,
  InputProblem,
  maxInputProblems,
  HostInputInvalid,
  HostToolBlocked,
  HostToolApprovalRequired,
  HostToolPolicyFailed,
  HostOutputInvalid,
  HostError,
  HostResponse,
  HostInvocation,
} from "./protocols/current.ts";
/** Raw host inputs; the host boundary parses and redacts these immediately. */
export type ResolvedAccountsInput = typeof ResolvedAccounts.Encoded;

/**
 * An account as the host sends it to the runner. `managed` marks a credential issued to the
 * instance operator's own OAuth client: the runner seals every one of its strings, whatever the
 * method exposes, so that only the operator's placement can send it. The runner removes the mark;
 * a bundle reads a `ResolvedAccount`. Not part of any host protocol.
 */
export const HostAccount = Schema.Struct({
  ...ResolvedAccount.fields,
  managed: Schema.optionalKey(Schema.Literal(true)),
});
export type HostAccount = typeof HostAccount.Type;

/** An invocation's selections as the host sends them to the runner; see `HostAccount`. */
export const HostAccounts = Schema.Record(
  Schema.NonEmptyString,
  Schema.Union([HostAccount, Schema.Array(HostAccount)]),
);
export type HostAccounts = typeof HostAccounts.Type;

/** Trusted invocation context, supplied separately from the Request. */
export interface HostContext {
  /** Trusted host deadline; never accepted in public operation JSON. */
  readonly deadline?: typeof InvocationDeadline.Type;
  /** Host-owned cache storage and refresh lifetime, separate from app database transactions. */
  readonly cache?: import("./cache.ts").HostCache;
  /** Packaged app text files supplied by the build bridge. Direct hosts may omit them for an empty package. */
  readonly files?: readonly SkillFile[];
  /** Private delivery capability. It is never accepted in public request JSON or stored in a build. */
  readonly workflowControls?: WorkflowHostControls;
  readonly workflow?: WorkflowExecution;
  readonly replay?: WorkflowReplay;
  readonly elicitation?: ElicitationHandler;
  /** Trusted in-process tracing capability; never decoded from a public request. */
  readonly telemetry?: InvocationTelemetry;
  readonly approval?: TrustedToolApproval;
  /** The data facet's SQLite storage, for apps that declare `sql`. Never exposed to app code. */
  readonly storage?: AppSqlStorage;
  /** The invocation's accounts as the host resolved them; see `HostAccount`. */
  readonly accounts: Redacted.Redacted<HostAccounts>;
}

/** Skill commands. Send sources only to builds that declare skillSources. */
export const skillsCommand = (sources: boolean) =>
  sources ? ({ operation: "skills", sources: true } as const) : ({ operation: "skills" } as const);
export interface SkillCatalog {
  readonly skills: SkillSources["skills"];
  readonly dynamic?: boolean;
  readonly cached?: boolean;
}
export const skillCatalog = (response: typeof SkillCatalogResponse.Type): SkillCatalog =>
  Schema.is(SkillSources)(response) ? response : { skills: response };

/**
 * Inspection commands. Send detail or tools only to builds that declare toolIndex,
 * and scheduled only to builds that declare scheduledTools.
 */
export const inspectCommand = (tools?: readonly string[], scheduled?: true) => ({
  operation: "inspect" as const,
  ...(tools === undefined ? {} : { tools: [...tools] }),
  ...(scheduled === undefined ? {} : { scheduled }),
});
export const indexCommand = { operation: "inspect", detail: "summary" } as const;
/** Keep only the requested tools from an inspection that may have described every tool. */
export const selectTools =
  (tools?: readonly string[]) =>
  <A extends { readonly tools: readonly { readonly name: string }[] }>(catalog: A): A =>
    tools === undefined
      ? catalog
      : { ...catalog, tools: catalog.tools.filter((tool) => tools.includes(tool.name)) };

/** Declaration reads do not bind accounts or evaluate the app factory. A named declaration
 * problem is reported so the deploy can explain it. */
export const HostRequirementsError = Schema.Union([
  HostRequestInvalid,
  HostDeclarationInvalid,
  DatabaseFieldReserved,
]);
/** Inspection can fail while binding accounts or evaluating the live definition. */
export const HostInspectError = Schema.Union([
  ProviderError,
  McpError,
  SkillLoadFailed,
  HostRequestInvalid,
  HostDeclarationInvalid,
  HostAccountsInvalid,
  HostEvaluationFailed,
]);
/** Tool invocation adds lookup, input, execution and output failures to inspection. */
export const HostCallError = Schema.Union([
  OpenapiResponseError,
  WorkflowFailure,
  HostInspectError,
  HostToolNotFound,
  HostOperationNotFound,
  HostKindMismatch,
  HostOperationFailed,
  DatabaseLimitExceeded,
  HostInputInvalid,
  HostOutputInvalid,
  HostToolBlocked,
  HostToolApprovalRequired,
  HostToolPolicyFailed,
  ElicitationFailed,
]);
/**
 * An account check binds one account and runs the provider's check without evaluating the app.
 * Timeouts arrive as WorkflowFailure from the shared deadline guard.
 */
export const HostAccountCheckError = Schema.Union([
  ProviderError,
  WorkflowFailure,
  HostRequestInvalid,
  HostDeclarationInvalid,
  HostAccountsInvalid,
  HostOperationNotFound,
  HostOperationFailed,
  HostOutputInvalid,
]);
/** Queries, mutations and agent calls use the same operation failures. */
export const HostDataError = HostCallError;

/** Invocation-owned outcome sink. Framework adapters report semantic failures
 * independently of successful JSON transport; customer output is never inspected. */
export const ToolResultObservation = Context.Reference<{ readonly failed: () => void }>(
  "apps/ToolResultObservation",
  { defaultValue: () => ({ failed: () => {} }) },
);

/**
 * One tool invocation's own timing, on the isolate's clock: how long it ran, and how much of that
 * it waited on upstream providers, waited on elicitation answers and ran the app's authored code.
 * Each instant counts once, so the rest is Executor's own time. The isolated handler returns it
 * beside the result so the host can add the other isolates' parts.
 */
export const InvocationTiming = Schema.Struct({
  elapsedMs: Schema.Finite,
  upstreamMs: Schema.Finite,
  elicitationMs: Schema.Finite,
  authoredMs: Schema.Finite,
});
export type InvocationTiming = typeof InvocationTiming.Type;
/** Receives the invocation's timing once it is over; hosts that do not return it ignore it. */
export const InvocationTimingSink = Context.Reference<(timing: InvocationTiming) => void>(
  "apps/InvocationTimingSink",
  { defaultValue: () => () => {} },
);

/** Native handler; context comes from host authority, never from request content. */
export type AppHandler = (request: Request, context: HostContext) => Effect.Effect<Response>;

export { type AppOperation, type OperationContext } from "./operations.ts";
export {
  RouterIcon,
  RouterKey,
  RouterMeta,
  type AppNode,
  type AppRouter,
  type DynamicRouter,
} from "./router.ts";

export * from "./schedules.ts";
