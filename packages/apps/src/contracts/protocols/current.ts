/**
 * The host protocol this framework speaks: every message that crosses between a host and an app
 * bundle built with it. Its number is `frameworkProtocol` in `../protocol-version.ts`.
 *
 * This module is live. The framework and the SDK read the current boundary from here, through
 * `../host.ts`. `bun run check` records it in `packages/apps/protocols/<frameworkProtocol>.json` and
 * checks that it stays compatible with every released protocol in `released.ts`: a host that speaks
 * this module must keep running every bundle a released protocol retained. A change that no longer
 * does so is a break: freeze this module's previous content as `<frameworkProtocol>.ts`, raise the
 * number, and give the host an adapter for the frozen one. See notes/apps-publishing.md.
 *
 * The frozen protocol modules beside this one are records of released boundaries. Nothing here
 * imports them, so a change here never edits a released protocol.
 */
import { Schema } from "effect";
import { ConnectCommand } from "../connect.ts";
import { CacheCommand, CacheReply } from "@executor-js/app-cache/contracts";
import { frameworkProtocol } from "../protocol-version.ts";
import {
  DatabaseFieldReserved,
  DatabaseLimitExceeded,
  DatabaseSchema,
} from "@executor-js/app-data/contracts";
import { OpenapiResponseError } from "../api-response-error.ts";
import {
  ApprovalElicitation,
  ElicitationFailed,
  ElicitationReply,
  FormElicitation,
} from "../elicitation.ts";
import { DeclaredEvents, EmittedEvents } from "../events.ts";
import { FailureDetail, UpstreamError } from "../failure.ts";
import { AccountCheckResult, OAuth2Config } from "../provider.ts";
import { ProviderError } from "../provider-error.ts";
import { RouterIcon } from "../router.ts";
import { AppIcons } from "../icons.ts";
import { Placements } from "../placement.ts";
import { OperationSchedule } from "../schedules.ts";
import { AccountId, JsonObject, JsonValue } from "../schema.ts";
import { AppSkillName, AppSkills } from "../skills.ts";
import { ToolAnnotations } from "../tools.ts";
import { WebhookCommand } from "../webhook-protocol.ts";
import {
  WorkflowCommand,
  WorkflowControlCommand,
  WorkflowFailure,
  WorkflowReplay,
  WorkflowRpcCommand,
  WorkflowRpcResult,
  WorkflowRunId,
} from "../workflows.ts";

/** An MCP failure as it crosses the host boundary. Apps throw the author-facing class from `apps/mcp`. */
export class McpError extends Schema.TaggedError<McpError>()("McpError", {
  phase: Schema.Literals(["connect", "discover", "call", "schema", "transport"]),
  reason: Schema.Literals([
    "request",
    "unauthorized",
    "invalid_response",
    "timeout",
    "invalid_input",
  ]),
  status: Schema.optional(Schema.Number),
  /** The JSON-RPC error the server stated. */
  upstream: Schema.optional(UpstreamError),
  /**
   * The refused request carried the session ID the server issued at initialization, so a 404 reads
   * as a session the server may have lost. Chooses the explanation only; the host never decides from
   * it whose side a failure is on.
   */
  session: Schema.optional(Schema.Literal(true)),
}) {}

/** A skill loader failure as it crosses the host boundary. Apps throw the author-facing class from `apps/skills`. */
export class SkillLoadFailed extends Schema.TaggedError<SkillLoadFailed>()("SkillLoadFailed", {
  reason: Schema.Literals([
    "source",
    "request",
    "rate_limited",
    "document",
    "limit",
    "changed",
    "encoding",
  ]),
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  status: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  /** What the service's answer points to as missing: the repository, or the branch or tag. */
  missing: Schema.optional(Schema.Literals(["repository", "ref"])),
}) {}

/**
 * Where a provider's credentials may be sent: an exact host, `host:port`, or `*.` followed by a
 * domain, matching exactly one more label. Lowercase, without a scheme or path.
 */
export const CredentialHost = Schema.String.check(
  Schema.isPattern(
    /^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?$/,
  ),
);

/**
 * Field names an auth method exposes to app code, and where its secret fields may be sent. Every
 * other string field is secret.
 */
const exposure = {
  /** Not secret: app code reads the real value and forms show it. */
  plain: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /** Secret, but app code reads the real value, for signing and similar uses. */
  raw: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /**
   * The only places the outbound network substitutes this method's secret fields: whole header
   * values and query parameters, each an exact template. Part of the provider's identity. In an
   * invocation, an account's provider carries the placements granted to that account, which can
   * be narrower than the app's declaration.
   */
  request: Schema.optionalKey(Placements),
};

/** Serializable authentication declarations interpreted by the trusted host. */
export const DeclaredAuthMethod = Schema.Union([
  Schema.Struct({ type: Schema.Literal("interactive"), label: Schema.String, ...exposure }),
  Schema.Struct({
    type: Schema.Literal("secrets"),
    provisioned: Schema.optionalKey(Schema.Literal(true)),
    label: Schema.String,
    fields: JsonObject,
    ...exposure,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[0].fields,
    response: JsonObject,
    ...exposure,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[1].fields,
    response: JsonObject,
    ...exposure,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[2].fields,
    response: JsonObject,
    ...exposure,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[3].fields,
    response: JsonObject,
    ...exposure,
  }),
]);

/** A credential-free provider declaration with the hosts its credentials may be sent to. */
export const DeclaredProvider = Schema.Struct({
  name: Schema.NonEmptyString,
  auth: Schema.Record(Schema.NonEmptyString, DeclaredAuthMethod),
  hosts: Schema.optionalKey(Schema.Array(CredentialHost)),
});
/** Credential-free provider declaration; content matching remains host policy. */
export type DeclaredProvider = typeof DeclaredProvider.Type;

/** One requirement: its provider, how many accounts it takes, and whether it has a check. */
export const DeclaredAccountSlot = Schema.Struct({
  definition: DeclaredProvider,
  cardinality: Schema.Literals(["one", "many"]),
  /**
   * The slot's provider defines an account check. Kept beside the definition, not in it, so
   * adding or editing a check never changes the provider's identity.
   */
  health: Schema.optionalKey(Schema.Literal(true)),
  /** The methods acquired by a host driver rather than this app's handlers. */
  hostAcquisition: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /** This slot can check app-acquired references through connect.check. */
  interactiveHealth: Schema.optionalKey(Schema.Literal(true)),
});
export type DeclaredAccountSlot = typeof DeclaredAccountSlot.Type;

/** One scope's requirements, by name. */
export const DeclaredAccountSlots = Schema.Record(Schema.NonEmptyString, DeclaredAccountSlot);
export type DeclaredAccountSlots = typeof DeclaredAccountSlots.Type;

/** Account slots available without binding accounts or evaluating the app factory. */
export const DeclaredRequirements = Schema.Struct({
  /** Protocol support of this retained framework build, not an author-declared requirement. */
  capabilities: Schema.optionalKey(
    Schema.Struct({
      skills: Schema.Literal(true),
      /** Accepts inspect detail and tools. Earlier builds reject both as excess fields. */
      toolIndex: Schema.optionalKey(Schema.Literal(true)),
      /** Accepts skills sources and reports whether the catalog includes a live loader. */
      skillSources: Schema.optionalKey(Schema.Literal(true)),
      /** Accepts scheduled inspection. Earlier builds reject it as an excess field. */
      scheduledTools: Schema.optionalKey(Schema.Literal(true)),
      /**
       * Accepts inspect definitions and answers it with a shared catalog. Earlier builds reject it
       * as an excess field.
       */
      sharedDefinitions: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
  /**
   * The document database an app of protocol 9 or earlier declared. Apps of this protocol declare
   * `sql` instead; the field remains so requirements read from older retained builds keep their meaning.
   */
  database: Schema.optionalKey(DatabaseSchema),
  /**
   * Requirements by scope. `app` requirements are filled by the accounts the app's managers link for everyone,
   * for every caller and for background work; `user` requirements by each caller's linked
   * accounts. A name is used in one scope only. Bundles of protocol 12 and earlier declare user
   * requirements only.
   */
  accounts: Schema.Struct({ app: DeclaredAccountSlots, user: DeclaredAccountSlots }),
  /** The build has SQL files in `migrations/` and owns a raw SQLite database. */
  sql: Schema.optionalKey(Schema.Literal(true)),
  /** The events the app declares, so a host lists them without evaluating the app. */
  events: Schema.optionalKey(DeclaredEvents),
  /** The icons the app declares, so a host shows them without evaluating the app. */
  icons: Schema.optionalKey(AppIcons),
});
/** Parsed declared account requirements. */
export type DeclaredRequirements = typeof DeclaredRequirements.Type;

/**
 * Host-resolved credentials for one stable saved account. Never a request DTO. When the provider
 * declares hosts, its secret string fields are sealed handles, not values. The provider carries
 * the hosts and placements granted to this account.
 */
export const ResolvedAccount = Schema.Struct({
  id: AccountId,
  provider: DeclaredProvider,
  method: Schema.NonEmptyString,
  /**
   * Changes when the account is reconnected or its credentials replaced, not on renewal. Hosts
   * send it since credential generations; `apps@0.0.1-beta.0` and `beta.1` ignore it.
   */
  generation: Schema.optionalKey(Schema.Int),
  fields: JsonObject,
});
/** Parsed host account binding. */
export type ResolvedAccount = typeof ResolvedAccount.Type;

/** One scope's resolved accounts by requirement; [] differs from a missing slot. */
export const ResolvedAccountSlots = Schema.Record(
  Schema.NonEmptyString,
  Schema.Union([ResolvedAccount, Schema.Array(ResolvedAccount)]),
);
export type ResolvedAccountSlots = typeof ResolvedAccountSlots.Type;

/**
 * An invocation's accounts by scope, resolved by the trusted caller. `user` is absent for work
 * without a caller, such as an app schedule or an app-account webhook: its context has no `user`.
 */
export const ResolvedAccounts = Schema.Struct({
  app: ResolvedAccountSlots,
  user: Schema.optionalKey(ResolvedAccountSlots),
});
/** Parsed host selections, kept redacted until native account binding. */
export type ResolvedAccounts = typeof ResolvedAccounts.Type;

/** Trusted approval for one decoded call. Never accepted in public command JSON. */
export const TrustedToolApproval = Schema.Struct({ tool: Schema.NonEmptyString, input: JsonValue });
export type TrustedToolApproval = typeof TrustedToolApproval.Type;

/** Absolute Unix time in milliseconds; remote hosts enforce it inside the operation transaction. */
export const InvocationDeadline = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Serializable live tool metadata; executable callbacks never cross this boundary. `name` is the
 * tool's full dotted path. `router` is the path of the router that owns it, omitted at the root.
 * `readOnly` marks a query; a tool without it is a mutation. `kindConfirmed` marks a kind that the
 * app's code or the tool's protocol fixes, such as a declared operation, a `kinds` entry or an HTTP
 * method, rather than an upstream claim such as an MCP server's `readOnlyHint`. Executor tells an
 * agent that a call only read only when both are set.
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
/** Parsed live tool description. */
export type HostedTool = typeof HostedTool.Type;

/** Catalog entry without schemas. Browsing lists these and reads one full tool on selection. */
export const HostedToolSummary = HostedTool.mapFields(
  ({ inputSchema: _input, outputSchema: _output, _meta, ...fields }) => fields,
);
export type HostedToolSummary = typeof HostedToolSummary.Type;

/**
 * The module or declared capability shape could not be hosted. The detail names what the app
 * declared wrongly; declarations bind no accounts.
 */
export class HostDeclarationInvalid extends Schema.TaggedError<HostDeclarationInvalid>()(
  "HostDeclarationInvalid",
  FailureDetail,
) {}
/** Fresh app evaluation failed before calling a tool. */
export class HostEvaluationFailed extends Schema.TaggedError<HostEvaluationFailed>()(
  "HostEvaluationFailed",
  FailureDetail,
) {}

/** Why one router's tools could not be read. The rest of the app's catalog is unaffected. */
export const HostRouterError = Schema.Union([
  ProviderError,
  McpError,
  SkillLoadFailed,
  HostDeclarationInvalid,
  HostEvaluationFailed,
]);
export type HostRouterError = typeof HostRouterError.Type;

/**
 * One router in a live catalog. `path` is "" for the app's root router. `skill` names the skill
 * that carries this router's instructions. A router with `error` lists none of its tools.
 */
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

/** A catalog without tool schemas. Browsing lists these and reads one full tool on selection. */
export const HostedCatalogSummary = Schema.Struct({
  tools: Schema.Array(HostedToolSummary),
  routers: Schema.Array(HostedRouter),
});
export type HostedCatalogSummary = typeof HostedCatalogSummary.Type;

/** A tool schema whose `$defs` a shared catalog sends once, beside its tools. */
export const SharedSchemaKey = Schema.Literals(["inputSchema", "outputSchema"]);
export type SharedSchemaKey = typeof SharedSchemaKey.Type;

/**
 * A tool of a shared catalog. The `$defs` of each schema `shared` names is the position of its
 * entries in the catalog's `defs`; the tool's other fields are as `HostedTool`'s.
 */
export const HostedSharedTool = Schema.Struct({
  ...HostedTool.fields,
  shared: Schema.optionalKey(Schema.Array(SharedSchemaKey)),
});
export type HostedSharedTool = typeof HostedSharedTool.Type;

/**
 * A catalog that sends each `$defs` its tools' schemas hold once, and each definition in them
 * once. Routers such as the OpenAPI importer give every tool the definitions its schemas reach,
 * which for a densely connected document is most of the document again for each tool, under the
 * same few hundred `$defs`. Putting each tool's `$defs` back gives the `HostedCatalog` the bundle
 * evaluated. Only builds that declare the sharedDefinitions capability send it, and only when
 * the inspection asks.
 */
export const HostedSharedCatalog = Schema.Struct({
  tools: Schema.Array(HostedSharedTool),
  routers: Schema.Array(HostedRouter),
  definitions: Schema.Array(JsonValue),
  /** Each distinct `$defs`, its entries naming positions in `definitions`. */
  defs: Schema.Array(Schema.Record(Schema.String, Schema.Int)),
});
export type HostedSharedCatalog = typeof HostedSharedCatalog.Type;

/**
 * A skill catalog and whether any of it came from `dynamicSkills`. Without a live loader the
 * catalog is determined by the build and its evaluation inputs; with one it reflects a publisher.
 * `cached` says the loader read through the app cache, so the cache's freshness and invalidation
 * govern its publisher reads.
 */
export const SkillSources = Schema.Struct({
  skills: AppSkills,
  dynamic: Schema.Boolean,
  cached: Schema.optionalKey(Schema.Boolean),
});
export type SkillSources = typeof SkillSources.Type;
/** Either response shape; `dynamic` is unknown for builds that predate skillSources. */
export const SkillCatalogResponse = Schema.Union([SkillSources, AppSkills]);

/** Whether a tool reads or writes. */
export const ToolKind = Schema.Literals(["query", "mutation"]);

/**
 * Check one account for one declared slot. The invocation supplies only that slot, in its scope,
 * as a single account even when the slot takes many. The app factory is not evaluated.
 */
export const AccountCheckCommand = Schema.Struct({
  operation: Schema.Literal("account-check"),
  requirement: Schema.NonEmptyString,
});
export type AccountCheckCommand = typeof AccountCheckCommand.Type;

/** Apply the build's pending SQL migrations. No accounts are bound and the app is not evaluated. */
export const MigrateCommand = Schema.Struct({ operation: Schema.Literal("migrate") });
export type MigrateCommand = typeof MigrateCommand.Type;

/** The migrations this command applied, oldest first, by position and file path. Empty when the database was current. */
export const MigrateResult = Schema.Array(
  Schema.Struct({ id: Schema.Int, name: Schema.NonEmptyString }),
);
export type MigrateResult = typeof MigrateResult.Type;

/** Framework-owned dispatch, independent of app-authored HTTP routing. */
export const HostRequest = Schema.Union([
  ...ConnectCommand.members,
  WorkflowCommand,
  WebhookCommand,
  Schema.Struct({ operation: Schema.Literal("requirements") }),
  Schema.Struct({
    operation: Schema.Literal("inspect"),
    /** Omit schemas. Only builds that declare the toolIndex capability accept this. */
    detail: Schema.optionalKey(Schema.Literal("summary")),
    /** Describe only these tools. Only builds that declare the toolIndex capability accept this. */
    tools: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
    /**
     * Describe only declared operations that have schedules, without dynamic tool discovery.
     * Only builds that declare the scheduledTools capability accept this.
     */
    scheduled: Schema.optionalKey(Schema.Literal(true)),
    /**
     * Answer with a HostedSharedCatalog, each shared `$defs` entry sent once. Only builds that
     * declare the sharedDefinitions capability accept this.
     */
    definitions: Schema.optionalKey(Schema.Literal("shared")),
  }),
  Schema.Struct({
    operation: Schema.Literal("skills"),
    /** Answer with SkillSources. Only builds that declare the skillSources capability accept this. */
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
    /**
     * The caller's claim; the bundle rejects a call whose tool has the other kind. The host omits
     * it for a tool its catalog does not list, and then opens storage for writing.
     */
    kind: Schema.optionalKey(ToolKind),
    input: JsonValue,
  }),
  AccountCheckCommand,
  MigrateCommand,
]);
/** Parsed portable dispatch request. */
export type HostRequest = typeof HostRequest.Type;

/** The dispatch request did not match the protocol. */
export class HostRequestInvalid extends Schema.TaggedError<HostRequestInvalid>()(
  "HostRequestInvalid",
  {},
) {}
/** Host-supplied accounts did not satisfy the declared slots or native method schemas. */
export class HostAccountsInvalid extends Schema.TaggedError<HostAccountsInvalid>()(
  "HostAccountsInvalid",
  {},
) {}
/** No query or mutation matched the requested name. */
export class HostOperationNotFound extends Schema.TaggedError<HostOperationNotFound>()(
  "HostOperationNotFound",
  {},
) {}
/** An app operation failed. Carries the app's own error name, code, fields and bounded message. */
export class HostOperationFailed extends Schema.TaggedError<HostOperationFailed>()(
  "HostOperationFailed",
  FailureDetail,
) {}
/** The freshly evaluated catalog did not contain the requested tool. */
export class HostToolNotFound extends Schema.TaggedError<HostToolNotFound>()(
  "HostToolNotFound",
  {},
) {}
/** The tool exists but is a query called as a mutation, or the reverse. Nothing ran. */
export class HostKindMismatch extends Schema.TaggedError<HostKindMismatch>()("HostKindMismatch", {
  tool: Schema.NonEmptyString,
  requested: ToolKind,
  actual: ToolKind,
}) {}
/** One failing input location and its expected shape; never the supplied value. */
export const InputProblem = Schema.String.check(Schema.isMaxLength(512));
/** Input decoding reports at most this many problems. */
export const maxInputProblems = 10;
/** Native input decoding failed; supplied values are omitted. Builds before problems were reported send none. */
export class HostInputInvalid extends Schema.TaggedError<HostInputInvalid>()("HostInputInvalid", {
  problems: Schema.optionalKey(
    Schema.Array(InputProblem).check(Schema.isMaxLength(maxInputProblems)),
  ),
}) {}
/** The tool's approval policy blocked this call before its tool body ran. */
export class HostToolBlocked extends Schema.TaggedError<HostToolBlocked>()("HostToolBlocked", {}) {}
/** Policy elicitation plus decoded input. No tool body ran; the host owns delivery and resumption. */
export class HostToolApprovalRequired extends Schema.TaggedError<HostToolApprovalRequired>()(
  "HostToolApprovalRequired",
  { input: JsonValue, elicitation: ApprovalElicitation },
) {}
/** The tool's approval policy failed or returned an invalid decision. Author failures remain private. */
export class HostToolPolicyFailed extends Schema.TaggedError<HostToolPolicyFailed>()(
  "HostToolPolicyFailed",
  {},
) {}
/** A tool result was not JSON; the result is never included in the error. */
export class HostOutputInvalid extends Schema.TaggedError<HostOutputInvalid>()(
  "HostOutputInvalid",
  {},
) {}

/**
 * Safe error envelope. Author failures carry only their name, code, scalar fields and bounded
 * message with account secrets replaced; no stack or cause value is serialized.
 */
export const HostError = Schema.Union([
  OpenapiResponseError,
  ProviderError,
  McpError,
  SkillLoadFailed,
  WorkflowFailure,
  HostRequestInvalid,
  HostAccountsInvalid,
  HostDeclarationInvalid,
  HostEvaluationFailed,
  HostOperationNotFound,
  HostOperationFailed,
  DatabaseLimitExceeded,
  DatabaseFieldReserved,
  HostToolNotFound,
  HostInputInvalid,
  HostOutputInvalid,
  HostToolBlocked,
  HostToolApprovalRequired,
  HostToolPolicyFailed,
  ElicitationFailed,
  HostKindMismatch,
]);
/** Expected host failures. */
export type HostError = typeof HostError.Type;

/** Portable response envelope; callers parse the success value for their operation. */
export const HostResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    value: JsonValue,
    toolError: Schema.optionalKey(Schema.Literal(true)),
    /** The occurrences this invocation emitted, kept only because it succeeded. */
    events: Schema.optionalKey(EmittedEvents),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: HostError }),
]);
/** Parsed response envelope. */
export type HostResponse = typeof HostResponse.Type;

/**
 * The JSON body the host sends to a bundle's generated server entry. The entry is compiled into
 * the retained build, so this shape is part of the protocol too.
 */
export const HostInvocation = Schema.Struct({
  command: HostRequest,
  accounts: ResolvedAccounts,
  /** Trusted host identity; never part of the public command. */
  caller: Schema.optionalKey(Schema.NonEmptyString),
  approval: Schema.optionalKey(TrustedToolApproval),
  replay: Schema.optionalKey(WorkflowReplay),
  deadline: Schema.optionalKey(InvocationDeadline),
  workflowRun: Schema.optionalKey(WorkflowRunId),
});
export type HostInvocation = typeof HostInvocation.Type;

/**
 * Who sends each message. The host must keep accepting everything a released protocol's bundles
 * send (`bundle`), and must send a released protocol's bundles only what they accept, or gate the
 * addition on something the bundle declared (`host`). Names a released protocol used and this one
 * dropped, such as `tools`, keep their direction here.
 */
export const messageDirections = {
  invocation: "host",
  request: "host",
  accounts: "host",
  elicitationReply: "host",
  workflowStepReply: "host",
  cacheReply: "host",
  response: "bundle",
  requirements: "bundle",
  catalog: "bundle",
  catalogSummary: "bundle",
  sharedCatalog: "bundle",
  tools: "bundle",
  toolSummaries: "bundle",
  skills: "bundle",
  elicitationRequest: "bundle",
  workflowStep: "bundle",
  workflowControl: "bundle",
  cacheCommand: "bundle",
  accountCheck: "bundle",
  migrate: "bundle",
} as const satisfies Record<string, "host" | "bundle">;
/** A message name every protocol so far has used. */
export type MessageName = keyof typeof messageDirections;

/** Every message of the current protocol. The snapshot records them by name. */
export const current = {
  version: frameworkProtocol,
  schemas: {
    invocation: HostInvocation,
    request: HostRequest,
    response: HostResponse,
    requirements: DeclaredRequirements,
    catalog: HostedCatalog,
    catalogSummary: HostedCatalogSummary,
    sharedCatalog: HostedSharedCatalog,
    skills: SkillCatalogResponse,
    elicitationRequest: FormElicitation,
    elicitationReply: ElicitationReply,
    workflowStep: WorkflowRpcCommand,
    workflowStepReply: WorkflowRpcResult,
    workflowControl: WorkflowControlCommand,
    cacheCommand: CacheCommand,
    cacheReply: CacheReply,
    accountCheck: AccountCheckResult,
    accounts: ResolvedAccounts,
    migrate: MigrateResult,
  },
} as const satisfies {
  readonly version: number;
  readonly schemas: Partial<Record<MessageName, Schema.Top>>;
};
