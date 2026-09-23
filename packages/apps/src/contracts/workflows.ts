/** Portable workflow declarations, run views and durable execution capabilities. */
import { Schema, type Effect } from "effect";
import { JsonObject, JsonValue } from "./schema.ts";
import type { AppContext, AppRequirements, QueryContext, MutationContext } from "./context.ts";
import type { Operation } from "../implementation/operations.ts";
import type { HostContext } from "./host.ts";

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
/** Safe failures cross host boundaries without authored exceptions or account fields. */
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
/** Explicitly stop retrying an authored step. Its message stays inside the app runtime. */
export class NonRetryableError extends Error {
  override readonly name = "NonRetryableError";
}
/** Step outputs must fit the engine's persisted JSON result limit. */
export const WorkflowValue = JsonValue.check(
  Schema.makeFilter(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 1024 * 1024,
  ),
);
/** Live workflow metadata carries schemas rather than executable handlers. */
export const HostedWorkflow = Schema.Struct({
  name: WorkflowName,
  description: Schema.optionalKey(Schema.String),
  inputSchema: JsonObject,
  outputSchema: Schema.optionalKey(JsonObject),
});
export type HostedWorkflow = typeof HostedWorkflow.Type;

const runFields = {
  profile: Schema.optionalKey(Schema.NonEmptyString),
  id: WorkflowRunId,
  app: Schema.NonEmptyString,
  deployment: Schema.NonEmptyString,
  workflow: WorkflowName,
  createdAt: Schema.String,
};
/** Results are available only on completed runs; failure details are safe reason codes. */
export const WorkflowRun = Schema.Union([
  Schema.Struct({
    ...runFields,
    status: Schema.Literals(["queued", "running", "waiting", "paused", "waitingForPause"]),
  }),
  Schema.Struct({ ...runFields, status: Schema.Literal("complete"), output: WorkflowValue }),
  Schema.Struct({
    ...runFields,
    status: Schema.Literal("errored"),
    error: WorkflowFailure.fields.reason,
  }),
  Schema.Struct({ ...runFields, status: Schema.Literal("terminated") }),
]);
export type WorkflowRun = typeof WorkflowRun.Type;
/** A bounded run-history page, already scoped to an authorized configured app. */
export const WorkflowRunPage = Schema.Struct({
  items: Schema.Array(WorkflowRun),
  next: Schema.optionalKey(WorkflowRunId),
});
export type WorkflowRunPage = typeof WorkflowRunPage.Type;
/** Query and factory contexts may inspect only their own app's runs. */
export interface WorkflowReads {
  readonly get: (input: { readonly run: string }) => Promise<WorkflowRun>;
  readonly list: (input?: {
    readonly workflow?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }) => Promise<WorkflowRunPage>;
}
/** Mutating handlers may start and terminate runs in their own configured app. */
export interface WorkflowControls extends WorkflowReads {
  readonly start: (input: {
    readonly workflow: string;
    readonly input: JsonValue;
    readonly key?: string;
  }) => Promise<WorkflowRun>;
  readonly terminate: (input: { readonly run: string }) => Promise<WorkflowRun>;
}
/** External steps get fresh credentials and cancellation, without storage or live elicitation. */
export type WorkflowStepContext<Requirements extends AppRequirements = AppRequirements> = Omit<
  AppContext<Requirements>,
  "elicit" | "workflows"
> & {
  readonly runId: WorkflowRunId;
  readonly stepId: string;
  readonly idempotencyKey: string;
};
/** Explicit durable boundaries; database access passes through registered app operations. */
export interface WorkflowStep<Requirements extends AppRequirements = AppRequirements> {
  do<Output>(
    name: string,
    run: (context: WorkflowStepContext<Requirements>) => Promise<Output>,
  ): Promise<Output>;
  do<Output>(
    name: string,
    options: WorkflowStepOptions,
    run: (context: WorkflowStepContext<Requirements>) => Promise<Output>,
  ): Promise<Output>;
  runQuery<Input, Output>(
    name: string,
    operation: Operation<Input, Output, "query", QueryContext<Requirements>>,
    input: NoInfer<Input>,
    options?: WorkflowStepOptions,
  ): Promise<Output>;
  runMutation<Input, Output>(
    name: string,
    operation: Operation<Input, Output, "mutation", MutationContext<Requirements>>,
    input: NoInfer<Input>,
    options?: WorkflowStepOptions,
  ): Promise<Output>;
  readonly sleep: (name: string, duration: WorkflowDuration) => Promise<void>;
  readonly sleepUntil: (name: string, timestamp: number | Date) => Promise<void>;
}
/** The orchestration body gets no account, database or interactive capabilities. */
export interface WorkflowContext<Requirements extends AppRequirements = AppRequirements> {
  readonly runId: WorkflowRunId;
  readonly step: WorkflowStep<Requirements>;
}
/** Framework-owned native declaration; only the callback crosses the author Promise boundary. */
export interface AppWorkflow<Input = unknown, Output = unknown> {
  readonly description?: string;
  readonly input: Schema.Decoder<Input>;
  readonly output?: Schema.Decoder<Output>;
  readonly run: (context: WorkflowContext, input: Input) => Effect.Effect<Output, unknown>;
}
/** The backend supplies checkpoints and timers; app framework code supplies callbacks. */
export interface WorkflowDriver {
  readonly do: (
    name: string,
    options: WorkflowStepOptions,
    run: () => Effect.Effect<JsonValue, WorkflowFailure>,
  ) => Effect.Effect<JsonValue, WorkflowFailure>;
  readonly sleep: (
    name: string,
    duration: WorkflowDuration,
  ) => Effect.Effect<void, WorkflowFailure>;
  readonly sleepUntil: (name: string, timestamp: number) => Effect.Effect<void, WorkflowFailure>;
}
/** Trusted host callbacks for one pinned run. Credentials are resolved only while executing a step. */
export interface WorkflowExecution {
  readonly runId: WorkflowRunId;
  readonly driver: WorkflowDriver;
  readonly resolve: () => Effect.Effect<HostContext, WorkflowFailure>;
  readonly invoke: (input: {
    readonly kind: "query" | "mutation";
    readonly name: string;
    readonly input: JsonValue;
    readonly stepId: string;
    readonly timeout: number;
  }) => Effect.Effect<JsonValue, WorkflowFailure>;
}
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
export const WorkflowRpcResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: JsonValue }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkflowFailure }),
]);
export type WorkflowRpcResult = typeof WorkflowRpcResult.Type;
/** Callback functions are invocation-owned RPC capabilities, never persisted. */
export type WorkflowRpc = (input: unknown, callback?: () => Promise<unknown>) => Promise<unknown>;
/** Native app-scoped management capability supplied only by an authorized host invocation. */
export interface WorkflowHostControls {
  readonly start: (
    input: Parameters<WorkflowControls["start"]>[0],
  ) => Effect.Effect<WorkflowRun, WorkflowFailure>;
  readonly get: (
    input: Parameters<WorkflowControls["get"]>[0],
  ) => Effect.Effect<WorkflowRun, WorkflowFailure>;
  readonly list: (
    input: Parameters<WorkflowControls["list"]>[0],
  ) => Effect.Effect<WorkflowRunPage, WorkflowFailure>;
  readonly terminate: (
    input: Parameters<WorkflowControls["terminate"]>[0],
  ) => Effect.Effect<WorkflowRun, WorkflowFailure>;
}
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
