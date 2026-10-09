/**
 * Host protocol 1: the messages that cross between a host and a retained app bundle.
 *
 * This protocol is released and frozen. Retained builds and published `apps` versions speak it,
 * and every later host must keep running and rebuilding them unchanged. `bun run check` compares
 * `protocol1` with `packages/apps/protocols/1.json` and fails on any difference. The module imports
 * only `effect` and the frozen OAuth sibling `./oauth.ts`, so no change elsewhere in the repository
 * can alter it. Do not edit it to change the wire format: define the next protocol instead and
 * give the host an adapter for this one. See notes/apps-publishing.md.
 */
import { Cron, Result, Schema } from "effect";
import * as McpSchema from "effect/ai/McpSchema";
import { HttpUrl, OAuth2Config } from "./oauth.ts";

/** JSON values carried by remote protocols such as MCP. */
export const JsonValue = Schema.Json;
export type JsonValue = Schema.Json;

/** A JSON object, distinct from an authored value schema. */
export const JsonObject = Schema.Record(Schema.String, JsonValue);
export type JsonObject = typeof JsonObject.Type;

/** Stable saved account identity supplied by a host, unchanged across refreshes. */
export const AccountId = Schema.String.pipe(
  Schema.check(Schema.isStartingWith("acc_"), Schema.isMinLength(5)),
  Schema.brand("acc"),
);
/** Parsed saved account identity. */
export type AccountId = typeof AccountId.Type;

/** Expected cache failures never include keys, values or upstream exception text. */
export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
  reason: Schema.Literals(["unavailable", "storage", "invalid", "capacity", "timeout"]),
}) {}

const Key = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
/** Stored values carry a version independent of their freshness clock. */
export const CacheEntry = Schema.Struct({
  value: Schema.Json,
  version: Schema.String,
  freshUntil: Time,
  staleUntil: Time,
});
/** Decoded cache value envelope. */
export type CacheEntry = typeof CacheEntry.Type;

/**
 * Publication requires the lease acquired against the previously observed version.
 * `acquire` reads one entry and claims its load in the same transaction, so a cache
 * miss costs one round trip. `read` and `claim` remain for builds retained before it.
 */
export const CacheCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("read"), keys: Schema.Array(Key) }),
  Schema.Struct({
    operation: Schema.Literal("acquire"),
    key: Key,
    /** Claim even a fresh entry, as an explicit refresh does. */
    refresh: Schema.Boolean,
    /** Claim only while the entry still has this version. Absent accepts the current one. */
    version: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    operation: Schema.Literal("claim"),
    key: Key,
    version: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    operation: Schema.Literal("publish"),
    key: Key,
    lease: Schema.String,
    entry: CacheEntry,
  }),
  Schema.Struct({ operation: Schema.Literal("release"), key: Key, lease: Schema.String }),
  /** Extend a lease its holder still owns. Replies false once the lease lapsed or was replaced. */
  Schema.Struct({ operation: Schema.Literal("renew"), key: Key, lease: Schema.String }),
  Schema.Struct({
    operation: Schema.Literal("write"),
    entries: Schema.Array(Schema.Struct({ key: Key, entry: CacheEntry })),
  }),
  Schema.Struct({ operation: Schema.Literal("invalidate"), key: Key }),
]);
/** Parsed host command; namespaces cannot be selected by app code. */
export type CacheCommand = typeof CacheCommand.Type;

/** Safe protocol envelope used at process boundaries. */
export const CacheReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({ ok: Schema.Literal(false), error: CacheError }),
]);

/** Names have Lakebed's identifier shape and are always bound SQL values, never raw SQL. */
export const DataName = Schema.String.check(
  Schema.makeFilter((value) => /^[A-Za-z][A-Za-z0-9_]*$/.test(value) && value.length <= 128),
);
/** Stored fields and index terms use finite scalar values; absent optional fields are represented by null in transport. */
export const Scalar = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);
export type Scalar = typeof Scalar.Type;
export const Field = Schema.Struct({
  kind: Schema.Literals(["string", "number", "boolean", "id", "userId"]),
  optional: Schema.optional(Schema.Boolean),
  default: Schema.optional(Scalar),
  references: Schema.optional(DataName),
});
export type Field = typeof Field.Type;
export const Index = Schema.Struct({ name: DataName, fields: Schema.NonEmptyArray(DataName) });
export const Table = Schema.Struct({
  fields: Schema.Record(DataName, Field),
  indexes: Schema.Array(Index),
});
export type Table = typeof Table.Type;
export const DatabaseSchema = Schema.Record(DataName, Table);
export type DatabaseSchema = typeof DatabaseSchema.Type;

/** Longest agent guidance an API error's recovery carries. */
export const maxApiErrorInstructionsLength = 4096;

/** Bounded recovery a declared API error published for its caller: a short next step and agent guidance. */
export const ApiErrorRecovery = Schema.Struct({
  action: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  instructions: Schema.NonEmptyString.check(Schema.isMaxLength(maxApiErrorInstructionsLength)),
});
/** Recovery copied from an error response body; extra keys are dropped on decode. */
export type ApiErrorRecovery = typeof ApiErrorRecovery.Type;

/** Longest message an API error response carries. */
export const maxApiErrorMessageLength = 4096;

/** Bounded public fields from a response matching its declared API error schema. */
export const ApiErrorResponse = Schema.Struct({
  code: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  status: Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })),
  message: Schema.NonEmptyString.check(Schema.isMaxLength(maxApiErrorMessageLength)),
  recovery: Schema.optionalKey(ApiErrorRecovery),
});
/** Safe projection of a response matching a declared API error schema. */
export type ApiErrorResponse = typeof ApiErrorResponse.Type;

/** A validated OpenAPI failure with its declared message or static schema explanation. */
export class OpenapiResponseError extends Schema.TaggedError<OpenapiResponseError>()(
  "OpenapiResponseError",
  ApiErrorResponse.fields,
) {}

/** Plain-data form request derived from the pinned MCP protocol schema. */
export const FormElicitation = Schema.Struct({
  ...McpSchema.ElicitRequestFormParams.fields,
  mode: Schema.Literal("form"),
  requestedSchema: Schema.toEncoded(McpSchema.ElicitRequestFormParams.fields.requestedSchema),
  _meta: Schema.optional(JsonObject),
});
export type FormElicitation = typeof FormElicitation.Type;

/** MCP accept/decline/cancel response, without imposing a client or transport on app code. */
export const ElicitationResponse = Schema.Union([
  Schema.Struct({ ...McpSchema.ElicitAcceptResult.fields, _meta: Schema.optional(JsonObject) }),
  Schema.Struct({ ...McpSchema.ElicitDeclineResult.fields, _meta: Schema.optional(JsonObject) }),
]);
export type ElicitationResponse = typeof ElicitationResponse.Type;

/** A tool interaction could not be delivered or its request/response was invalid. No private payload is retained. */
export class ElicitationFailed extends Schema.TaggedError<ElicitationFailed>()(
  "ElicitationFailed",
  {
    reason: Schema.Literals([
      "unavailable",
      "transaction",
      "invalid-request",
      "invalid-response",
      "transport",
      "expired",
      "forbidden",
    ]),
  },
) {}

/** Safe reply for a runtime that crosses an RPC boundary. */
export const ElicitationReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), response: ElicitationResponse }),
  Schema.Struct({ ok: Schema.Literal(false), error: ElicitationFailed }),
]);
export type ElicitationReply = typeof ElicitationReply.Type;

/** Invocation consent requests no additional fields; arguments are reviewed, never edited in the form. */
export const ApprovalElicitation = Schema.Struct({
  ...FormElicitation.fields,
  requestedSchema: Schema.Struct({
    type: Schema.Literal("object"),
    properties: Schema.Record(Schema.String, Schema.Never),
  }),
});
export type ApprovalElicitation = typeof ApprovalElicitation.Type;

/** Dispatch coalesces overdue ticks, so sub-minute intervals promise a cadence the runner cannot keep. */
export const minimumIntervalMilliseconds = 60_000;
/** Calendar schedules use five cron fields and an explicit IANA time zone. */
export const CalendarSchedule = Schema.Struct({
  expression: Schema.NonEmptyString,
  timezone: Schema.NonEmptyString,
}).check(
  Schema.makeFilter(
    (value) =>
      value.expression.trim().split(/\s+/).length === 5 &&
      Result.isSuccess(Cron.parse(value.expression, value.timezone)),
  ),
);
/** Validated timing crosses all runtime and persistence boundaries as data. */
export const ScheduleTiming = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("interval"),
    milliseconds: Schema.Int.check(
      Schema.makeFilter((value) => value >= minimumIntervalMilliseconds, {
        message: "Schedule intervals must be at least 60 seconds",
      }),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("cron"), calendar: CalendarSchedule }),
]);
export type ScheduleTiming = typeof ScheduleTiming.Type;
/** A named trigger attached to the mutation it invokes, including schema-validated arguments. */
export const OperationSchedule = Schema.Struct({
  name: Schema.NonEmptyString,
  timing: ScheduleTiming,
  input: JsonValue,
});
export type OperationSchedule = typeof OperationSchedule.Type;

/** Canonical resource path within one skill. */
export const SkillFilePath = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  ),
);
/** UTF-8 text resource. Reading a resource never executes it. */
export const SkillFile = Schema.Struct({ path: SkillFilePath, content: Schema.String });
export type SkillFile = typeof SkillFile.Type;

/** Agent Skills format constraints, not Executor execution or storage budgets. */
export const skillFormatLimits = {
  nameCharacters: 64,
  descriptionCharacters: 1024,
  compatibilityCharacters: 500,
} as const;

/** A lowercase alphanumeric skill directory name with single separating hyphens. */
export const AppSkillName = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      value === value.toLowerCase() &&
      /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(value) &&
      [...value].length <= skillFormatLimits.nameCharacters,
  ),
);
/** Frontmatter is metadata only. In particular, allowed-tools never grants execution authority. */
export const AppSkillMetadata = Schema.Struct({
  name: AppSkillName,
  description: Schema.String.check(
    Schema.makeFilter(
      (value) =>
        value.trim().length > 0 && [...value].length <= skillFormatLimits.descriptionCharacters,
    ),
  ),
  license: Schema.optionalKey(Schema.String),
  compatibility: Schema.optionalKey(
    Schema.String.check(
      Schema.makeFilter(
        (value) =>
          value.trim().length > 0 && [...value].length <= skillFormatLimits.compatibilityCharacters,
      ),
    ),
  ),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  "allowed-tools": Schema.optionalKey(Schema.String),
});
export type AppSkillMetadata = typeof AppSkillMetadata.Type;

/** Files use paths relative to this skill directory; reading one never executes its contents. */
export const AppSkillSource = Schema.Struct({
  ...AppSkillMetadata.fields,
  files: Schema.Array(SkillFile).check(
    Schema.makeFilter(
      (files) =>
        files.some((file) => file.path === "SKILL.md") &&
        new Set(files.map((file) => file.path)).size === files.length,
    ),
  ),
});
export type AppSkillSource = typeof AppSkillSource.Type;

/** One evaluated catalog cannot contain ambiguous names. */
export const AppSkills = Schema.Array(AppSkillSource).check(
  Schema.makeFilter((skills) => new Set(skills.map((skill) => skill.name)).size === skills.length),
);

/** Advisory tool hints; neither the framework nor these declarations enforce access. */
export const ToolAnnotations = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  readOnlyHint: Schema.optionalKey(Schema.Boolean),
  destructiveHint: Schema.optionalKey(Schema.Boolean),
  idempotentHint: Schema.optionalKey(Schema.Boolean),
  openWorldHint: Schema.optionalKey(Schema.Boolean),
});
export type ToolAnnotations = typeof ToolAnnotations.Type;

/** Raw-byte ceiling shared by callback HTTP, app execution and the encoded host protocol. */
export const WebhookTransportLimits = Schema.Struct({
  maxBodyBytes: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type WebhookTransportLimits = typeof WebhookTransportLimits.Type;
/** Requests and responses use the same existing transport bound. */
export const defaultWebhookTransportLimits = WebhookTransportLimits.make({
  maxBodyBytes: 1024 * 1024,
});
const encodedBodyChars = 4 * Math.ceil(defaultWebhookTransportLimits.maxBodyBytes / 3);

/** Bounded callback transport. Headers and base64 bytes preserve the provider signature input. */
export const WebhookRequestData = Schema.Struct({
  url: HttpUrl,
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String.check(Schema.isMaxLength(encodedBodyChars)),
});
/** Registration identity and signing secret supplied by the trusted host, never by a callback sender. */
const identity = {
  name: Schema.NonEmptyString,
  subscriptionId: Schema.NonEmptyString,
  sourceAccount: AccountId,
  callbackUrl: HttpUrl,
  secret: Schema.String,
  config: JsonValue,
};
/** Each command runs with a fresh factory and the subscription's saved account selections. */
export const WebhookCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("webhooks") }),
  Schema.Struct({ operation: Schema.Literal("webhook-validate"), ...identity }),
  Schema.Struct({ operation: Schema.Literal("webhook-complete"), ...identity, state: JsonValue }),
  Schema.Struct({ operation: Schema.Literal("webhook-register"), ...identity }),
  Schema.Struct({ operation: Schema.Literal("webhook-unregister"), ...identity, state: JsonValue }),
  Schema.Struct({
    operation: Schema.Literal("webhook-handle"),
    ...identity,
    state: JsonValue,
    request: WebhookRequestData,
  }),
]);
/** Parsed framework command; contains private host inputs and must not be logged. */
export type WebhookCommand = typeof WebhookCommand.Type;

/** Run identity is opaque and shared by author and SDK interfaces. */
export const WorkflowRunId = Schema.NonEmptyString.pipe(Schema.brand("wfr"));
export type WorkflowRunId = typeof WorkflowRunId.Type;
/** Stable names identify declarations and replay steps. */
export const WorkflowName = Schema.NonEmptyString.check(Schema.isMaxLength(200));
const durationUnits: Readonly<Record<string, number>> = {
  millisecond: 1,
  milliseconds: 1,
  second: 1000,
  seconds: 1000,
  minute: 60000,
  minutes: 60000,
  hour: 3600000,
  hours: 3600000,
  day: 86400000,
  days: 86400000,
  week: 604800000,
  weeks: 604800000,
};
/** Convert portable duration syntax to milliseconds; invalid or overflowing values are rejected. */
export const workflowDurationMillis = (value: number | string): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  const match = /^(\d+(?:\.\d+)?) (milliseconds?|seconds?|minutes?|hours?|days?|weeks?)$/.exec(
    value,
  );
  const unit = match?.[2] === undefined ? undefined : durationUnits[match[2]];
  if (unit === undefined) return undefined;
  const result = Number(match?.[1]) * unit;
  return Number.isFinite(result) ? result : undefined;
};
/** Numbers are milliseconds; strings use a quantity and full unit, such as "5 minutes". */
export const WorkflowDuration = Schema.Union([
  Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.NonEmptyString,
]).check(Schema.makeFilter((value) => workflowDurationMillis(value) !== undefined));
export type WorkflowDuration = typeof WorkflowDuration.Type;
/** Author retry and timeout options are passed to the durable engine. */
export const WorkflowStepOptions = Schema.Struct({
  retries: Schema.optionalKey(
    Schema.Struct({
      limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      delay: WorkflowDuration,
      backoff: Schema.optionalKey(Schema.Literals(["constant", "linear", "exponential"])),
    }),
  ),
  timeout: Schema.optionalKey(WorkflowDuration),
});
export type WorkflowStepOptions = typeof WorkflowStepOptions.Type;
/** Step outputs must fit the engine's persisted JSON result limit. */
export const WorkflowValue = JsonValue.check(
  Schema.makeFilter(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 1024 * 1024,
  ),
);
/** Private replay metadata is attached by the host, never accepted in author input. */
export const WorkflowReplay = Schema.Struct({
  key: Schema.NonEmptyString,
  fingerprint: Schema.NonEmptyString,
});
export type WorkflowReplay = typeof WorkflowReplay.Type;
/** Portable discovery, input validation and execution commands. */
export const WorkflowCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("workflows") }),
  Schema.Struct({
    operation: Schema.Literal("workflow-validate"),
    name: WorkflowName,
    input: JsonValue,
  }),
  Schema.Struct({
    operation: Schema.Literal("workflow-run"),
    name: WorkflowName,
    input: JsonValue,
  }),
]);
export type WorkflowCommand = typeof WorkflowCommand.Type;

/** Private invocation RPC protocol shared by the host and isolated app bundle. */
export const WorkflowRpcCommand = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("do"),
    name: WorkflowName,
    options: WorkflowStepOptions,
  }),
  Schema.Struct({
    operation: Schema.Literal("sleep"),
    name: WorkflowName,
    duration: WorkflowDuration,
  }),
  Schema.Struct({
    operation: Schema.Literal("until"),
    name: WorkflowName,
    timestamp: Schema.Finite,
  }),
  Schema.Struct({ operation: Schema.Literal("context") }),
  Schema.Struct({
    operation: Schema.Literal("invoke"),
    kind: Schema.Literals(["query", "mutation"]),
    name: Schema.NonEmptyString,
    input: JsonValue,
    stepId: Schema.NonEmptyString,
    timeout: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
]);
/** Serializable requests do not contain an app ID; authority is captured in the supplied capability. */
export const WorkflowControlCommand = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("start"),
    workflow: WorkflowName,
    input: WorkflowValue,
    key: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(128))),
  }),
  Schema.Struct({ operation: Schema.Literal("get"), run: WorkflowRunId }),
  Schema.Struct({
    operation: Schema.Literal("list"),
    workflow: Schema.optionalKey(WorkflowName),
    cursor: Schema.optionalKey(WorkflowRunId),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  Schema.Struct({ operation: Schema.Literal("terminate"), run: WorkflowRunId }),
]);

/** Protocol 1's provider failure, as released: a reason, an HTTP status and the account used. */
export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  reason: Schema.Literals(["unauthorized", "forbidden", "rate_limited", "unavailable", "rejected"]),
  status: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  accountId: Schema.optional(AccountId),
}) {}

/** Protocol 1's MCP failure, as released: a phase, a reason and an HTTP status. */
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
}) {}

/** Protocols 1 to 8's skill loader failure, as released: a reason, a message and an HTTP status. */
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
}) {}

/** Protocol 1's workflow failure: a reason code only, as released. */
export class WorkflowFailure extends Schema.TaggedError<WorkflowFailure>()("WorkflowFailure", {
  reason: Schema.Literals([
    "unavailable",
    "not_found",
    "input",
    "output",
    "operation",
    "approval",
    "credentials",
    "terminated",
    "execution",
    "conflict",
    "engine",
  ]),
  retryable: Schema.Boolean,
}) {}
/** Protocol 1's workflow step reply, carrying its own failure. */
export const WorkflowRpcResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: JsonValue }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkflowFailure }),
]);

/** Serializable auth methods shared with SDK hosts; protocol configuration has one schema. */
export const DeclaredAuthMethod = Schema.Union([
  Schema.Struct({ type: Schema.Literal("secrets"), label: Schema.String, fields: JsonObject }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[0].fields,
    response: JsonObject,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[1].fields,
    response: JsonObject,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[2].fields,
    response: JsonObject,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[3].fields,
    response: JsonObject,
  }),
]);

/** Serializable declaration of a provider's named authentication methods. */
export const DeclaredProvider = Schema.Struct({
  name: Schema.NonEmptyString,
  auth: Schema.Record(Schema.NonEmptyString, DeclaredAuthMethod),
});
/** Credential-free provider declaration; content matching remains host policy. */
export type DeclaredProvider = typeof DeclaredProvider.Type;

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
    }),
  ),
  database: Schema.optionalKey(DatabaseSchema),
  accounts: Schema.Record(
    Schema.NonEmptyString,
    Schema.Struct({
      definition: DeclaredProvider,
      cardinality: Schema.Literals(["one", "many"]),
    }),
  ),
});
/** Parsed declared account requirements. */
export type DeclaredRequirements = typeof DeclaredRequirements.Type;

/** Host-resolved credentials for one stable saved account. Never a request DTO. */
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

/** Full saved selection resolved by the trusted caller; [] differs from a missing slot. */
export const ResolvedAccounts = Schema.Record(
  Schema.NonEmptyString,
  Schema.Union([ResolvedAccount, Schema.Array(ResolvedAccount)]),
);
/** Parsed host selections, kept redacted until native account binding. */
export type ResolvedAccounts = typeof ResolvedAccounts.Type;

/** Trusted approval for one decoded call. Never accepted in public command JSON. */
export const TrustedToolApproval = Schema.Struct({ tool: Schema.NonEmptyString, input: JsonValue });
export type TrustedToolApproval = typeof TrustedToolApproval.Type;

/** Absolute Unix time in milliseconds; remote hosts enforce it inside the operation transaction. */
export const InvocationDeadline = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** Serializable live tool metadata; executable callbacks never cross this boundary. */
export const HostedTool = Schema.Struct({
  schedules: Schema.optionalKey(Schema.Array(OperationSchedule)),
  name: Schema.NonEmptyString,
  description: Schema.String,
  inputSchema: JsonObject,
  readOnly: Schema.optionalKey(Schema.Boolean),
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
 * A skill catalog and whether any of it came from `dynamicSkills`. Without a live loader the
 * catalog is determined by the build and its evaluation inputs; with one it reflects a publisher.
 */
export const SkillSources = Schema.Struct({ skills: AppSkills, dynamic: Schema.Boolean });
export type SkillSources = typeof SkillSources.Type;
/** Either response shape; `dynamic` is unknown for builds that predate skillSources. */
export const SkillCatalogResponse = Schema.Union([SkillSources, AppSkills]);

/** Framework-owned dispatch, independent of app-authored HTTP routing. */
export const HostRequest = Schema.Union([
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
    input: JsonValue,
  }),
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
/** The module or declared capability shape could not be hosted. */
export class HostDeclarationInvalid extends Schema.TaggedError<HostDeclarationInvalid>()(
  "HostDeclarationInvalid",
  {},
) {}
/** Fresh app evaluation failed before calling a tool. */
export class HostEvaluationFailed extends Schema.TaggedError<HostEvaluationFailed>()(
  "HostEvaluationFailed",
  {},
) {}
/** No query or mutation matched the requested name. */
export class HostOperationNotFound extends Schema.TaggedError<HostOperationNotFound>()(
  "HostOperationNotFound",
  {},
) {}
/** An app operation failed. Raw author failures remain private. */
export class HostOperationFailed extends Schema.TaggedError<HostOperationFailed>()(
  "HostOperationFailed",
  {},
) {}
/** The freshly evaluated catalog did not contain the requested tool. */
export class HostToolNotFound extends Schema.TaggedError<HostToolNotFound>()(
  "HostToolNotFound",
  {},
) {}
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

/** Safe error envelope; no author exception, source, account fields or stack is serialized. */
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
  HostToolNotFound,
  HostInputInvalid,
  HostOutputInvalid,
  HostToolBlocked,
  HostToolApprovalRequired,
  HostToolPolicyFailed,
  ElicitationFailed,
]);
/** Expected host failures. */
export type HostError = typeof HostError.Type;

/** Portable response envelope; callers parse the success value for their operation. */
export const HostResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    value: JsonValue,
    toolError: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: HostError }),
]);
/** Parsed response envelope. */
export type HostResponse = typeof HostResponse.Type;

/**
 * The JSON body the host sends to a bundle's generated server entry. The entry is compiled into
 * the retained build, so this shape is frozen with the protocol too.
 */
export const HostInvocation = Schema.Struct({
  command: HostRequest,
  accounts: ResolvedAccounts,
  approval: Schema.optionalKey(TrustedToolApproval),
  replay: Schema.optionalKey(WorkflowReplay),
  deadline: Schema.optionalKey(InvocationDeadline),
  workflowRun: Schema.optionalKey(WorkflowRunId),
});
export type HostInvocation = typeof HostInvocation.Type;

/** Every message of protocol 1, in the order its snapshot records them. */
export const protocol1 = {
  version: 1,
  schemas: {
    invocation: HostInvocation,
    request: HostRequest,
    response: HostResponse,
    requirements: DeclaredRequirements,
    tools: Schema.Array(HostedTool),
    toolSummaries: Schema.Array(HostedToolSummary),
    skills: SkillCatalogResponse,
    elicitationRequest: FormElicitation,
    elicitationReply: ElicitationReply,
    workflowStep: WorkflowRpcCommand,
    workflowStepReply: WorkflowRpcResult,
    workflowControl: WorkflowControlCommand,
    cacheCommand: CacheCommand,
    cacheReply: CacheReply,
  },
} as const;
