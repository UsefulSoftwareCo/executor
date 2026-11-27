/**
 * Host protocol 13: protocol 12 plus account scopes, confirmed tool kinds and shared catalog
 * definitions.
 *
 * Requirements and resolved accounts are nested by scope: `app` for accounts linked to the app for
 * everyone, `user` for the caller's; a tool's schedule may run in the `app` scope. Tools may say their kind is confirmed (`kindConfirmed`). A
 * build may declare `capabilities.sharedDefinitions`; the host then may ask an inspection for
 * `definitions: "shared"`, answered with a shared catalog that sends each `$defs` once. Every other
 * message is protocol 12's, re-exported unchanged.
 *
 * Released and frozen like the earlier ones: `bun run check` compares `protocol13` with
 * `packages/apps/protocols/13.json`. The module imports only `effect` and earlier protocol modules,
 * so no change elsewhere can alter it. Define the next protocol instead of editing this file. See
 * notes/apps-publishing.md.
 */
import { Schema } from "effect";
import {
  AccountId,
  AppSkillName,
  JsonObject,
  JsonValue,
  OperationSchedule as PreviousSchedule,
  ToolAnnotations,
  WebhookCommand,
  WorkflowCommand,
  WorkflowReplay,
  WorkflowRunId,
} from "./1.ts";
import {
  AccountCheckCommand,
  DeclaredProvider,
  DeclaredRequirements as PreviousRequirements,
  HostRouterError,
  InvocationDeadline,
  MigrateCommand,
  RouterIcon,
  ToolKind,
  TrustedToolApproval,
  protocol12,
} from "./12.ts";

export * from "./12.ts";

/** One requirement: its provider, how many accounts it takes, and whether it has a check. */
export const DeclaredAccountSlot = Schema.Struct({
  definition: DeclaredProvider,
  cardinality: Schema.Literals(["one", "many"]),
  health: Schema.optionalKey(Schema.Literal(true)),
});
export type DeclaredAccountSlot = typeof DeclaredAccountSlot.Type;

/** One scope's requirements, by name. */
export const DeclaredAccountSlots = Schema.Record(Schema.NonEmptyString, DeclaredAccountSlot);
export type DeclaredAccountSlots = typeof DeclaredAccountSlots.Type;

/**
 * Protocol 12's requirements, nested by scope, with the sharedDefinitions capability. A name is
 * used in one scope only.
 */
export const DeclaredRequirements = Schema.Struct({
  capabilities: Schema.optionalKey(
    Schema.Struct({
      skills: Schema.Literal(true),
      toolIndex: Schema.optionalKey(Schema.Literal(true)),
      skillSources: Schema.optionalKey(Schema.Literal(true)),
      scheduledTools: Schema.optionalKey(Schema.Literal(true)),
      sharedDefinitions: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
  database: PreviousRequirements.fields.database,
  accounts: Schema.Struct({ app: DeclaredAccountSlots, user: DeclaredAccountSlots }),
  sql: PreviousRequirements.fields.sql,
  events: PreviousRequirements.fields.events,
  icons: PreviousRequirements.fields.icons,
});
export type DeclaredRequirements = typeof DeclaredRequirements.Type;

/** Host-resolved credentials for one stable saved account. */
export const ResolvedAccount = Schema.Struct({
  id: AccountId,
  provider: DeclaredProvider,
  method: Schema.NonEmptyString,
  generation: Schema.optionalKey(Schema.Int),
  fields: JsonObject,
});
export type ResolvedAccount = typeof ResolvedAccount.Type;

/** One scope's resolved accounts by requirement; [] differs from a missing slot. */
export const ResolvedAccountSlots = Schema.Record(
  Schema.NonEmptyString,
  Schema.Union([ResolvedAccount, Schema.Array(ResolvedAccount)]),
);
export type ResolvedAccountSlots = typeof ResolvedAccountSlots.Type;

/** An invocation's accounts by scope. `user` is absent for work without a caller. */
export const ResolvedAccounts = Schema.Struct({
  app: ResolvedAccountSlots,
  user: Schema.optionalKey(ResolvedAccountSlots),
});
export type ResolvedAccounts = typeof ResolvedAccounts.Type;

/** Protocol 12's operation schedule; an app's schedule may run with its app accounts. */
export const OperationSchedule = Schema.Struct({
  name: PreviousSchedule.fields.name,
  scope: Schema.optionalKey(Schema.Literal("app")),
  timing: PreviousSchedule.fields.timing,
  input: PreviousSchedule.fields.input,
});
export type OperationSchedule = typeof OperationSchedule.Type;

/**
 * Protocol 12's tool description. A tool may say its kind is confirmed, and its schedules may
 * name the app scope.
 */
export const HostedTool = Schema.Struct({
  schedules: Schema.optionalKey(Schema.Array(OperationSchedule)),
  name: Schema.NonEmptyString,
  router: Schema.optionalKey(Schema.NonEmptyString),
  tags: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  description: Schema.String,
  inputSchema: JsonObject,
  readOnly: Schema.optionalKey(Schema.Boolean),
  kindConfirmed: Schema.optionalKey(Schema.Boolean),
  title: Schema.optionalKey(Schema.String),
  outputSchema: Schema.optionalKey(JsonObject),
  annotations: Schema.optionalKey(ToolAnnotations),
  _meta: Schema.optionalKey(JsonObject),
});
export type HostedTool = typeof HostedTool.Type;

/** Catalog entry without schemas. */
export const HostedToolSummary = HostedTool.mapFields(
  ({ inputSchema: _input, outputSchema: _output, _meta, ...fields }) => fields,
);
export type HostedToolSummary = typeof HostedToolSummary.Type;

/** One router in a live catalog. */
export const HostedRouter = Schema.Struct({
  path: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  icons: Schema.optionalKey(Schema.Array(RouterIcon)),
  tags: Schema.optionalKey(Schema.Record(Schema.NonEmptyString, Schema.String)),
  skill: Schema.optionalKey(AppSkillName),
  error: Schema.optionalKey(HostRouterError),
});
export type HostedRouter = typeof HostedRouter.Type;

/** A live evaluation's tools and the routers that group them. */
export const HostedCatalog = Schema.Struct({
  tools: Schema.Array(HostedTool),
  routers: Schema.Array(HostedRouter),
});
export type HostedCatalog = typeof HostedCatalog.Type;

/** A catalog without tool schemas. */
export const HostedCatalogSummary = Schema.Struct({
  tools: Schema.Array(HostedToolSummary),
  routers: Schema.Array(HostedRouter),
});
export type HostedCatalogSummary = typeof HostedCatalogSummary.Type;

/** A tool schema whose `$defs` a shared catalog sends once, beside its tools. */
export const SharedSchemaKey = Schema.Literals(["inputSchema", "outputSchema"]);
export type SharedSchemaKey = typeof SharedSchemaKey.Type;

/** A tool of a shared catalog; `shared` names the schemas whose `$defs` the catalog holds. */
export const HostedSharedTool = Schema.Struct({
  ...HostedTool.fields,
  shared: Schema.optionalKey(Schema.Array(SharedSchemaKey)),
});
export type HostedSharedTool = typeof HostedSharedTool.Type;

/** A catalog that sends each `$defs` its tools' schemas hold once, and each definition once. */
export const HostedSharedCatalog = Schema.Struct({
  tools: Schema.Array(HostedSharedTool),
  routers: Schema.Array(HostedRouter),
  definitions: Schema.Array(JsonValue),
  defs: Schema.Array(Schema.Record(Schema.String, Schema.Int)),
});
export type HostedSharedCatalog = typeof HostedSharedCatalog.Type;

/** Protocol 12's commands; an inspection may ask for shared definitions. */
export const HostRequest = Schema.Union([
  WorkflowCommand,
  WebhookCommand,
  Schema.Struct({ operation: Schema.Literal("requirements") }),
  Schema.Struct({
    operation: Schema.Literal("inspect"),
    detail: Schema.optionalKey(Schema.Literal("summary")),
    tools: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
    scheduled: Schema.optionalKey(Schema.Literal(true)),
    definitions: Schema.optionalKey(Schema.Literal("shared")),
  }),
  Schema.Struct({
    operation: Schema.Literal("skills"),
    sources: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({
    operation: Schema.Literal("query"),
    name: Schema.NonEmptyString,
    input: JsonValue,
  }),
  Schema.Struct({
    operation: Schema.Literal("mutate"),
    name: Schema.NonEmptyString,
    input: JsonValue,
  }),
  Schema.Struct({
    operation: Schema.Literal("call"),
    tool: Schema.NonEmptyString,
    kind: Schema.optionalKey(ToolKind),
    input: JsonValue,
  }),
  AccountCheckCommand,
  MigrateCommand,
]);
export type HostRequest = typeof HostRequest.Type;

/** The JSON body the host sends to a bundle's generated server entry. */
export const HostInvocation = Schema.Struct({
  command: HostRequest,
  accounts: ResolvedAccounts,
  approval: Schema.optionalKey(TrustedToolApproval),
  replay: Schema.optionalKey(WorkflowReplay),
  deadline: Schema.optionalKey(InvocationDeadline),
  workflowRun: Schema.optionalKey(WorkflowRunId),
});
export type HostInvocation = typeof HostInvocation.Type;

/** Every message of protocol 13, in the order its snapshot records them. */
export const protocol13 = {
  version: 13,
  schemas: {
    ...protocol12.schemas,
    invocation: HostInvocation,
    request: HostRequest,
    requirements: DeclaredRequirements,
    catalog: HostedCatalog,
    catalogSummary: HostedCatalogSummary,
    sharedCatalog: HostedSharedCatalog,
    accounts: ResolvedAccounts,
  },
} as const;
