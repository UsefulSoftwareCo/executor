/** Private host capabilities and parsed app requests for the embedded workerd runtime. */
import { Schema } from "effect";
import {
  HostRequest,
  InvocationDeadline,
  HostAccounts,
  TrustedToolApproval,
  WorkflowReplay,
  WorkflowRunId,
  WorkflowRunFailure,
  WorkflowValue,
} from "apps/contracts";
import { WorkflowSeed } from "./workflow-runtime.ts";
import { RetainedWorkerBuild, WorkerBundle, WorkerFramework } from "./worker-build.ts";
import { SourceFiles } from "./deployment.ts";
import {
  RuntimeAppsDependencyMissing,
  RuntimeBuildFailed,
  RuntimeProtocolUnsupported,
} from "./runtime.ts";
import type { RpcTarget } from "capnweb";

/**
 * The serving product authorizes and binds these values before invoking app code. Code is not
 * part of an invocation: the runner asks the invocation's callbacks for it on a cold start.
 */
export const WorkerInvocation = Schema.Struct({
  app: Schema.NonEmptyString,
  build: Schema.NonEmptyString,
  database: Schema.Boolean,
  command: HostRequest,
  accounts: HostAccounts,
  approval: Schema.optionalKey(TrustedToolApproval),
  replay: Schema.optionalKey(WorkflowReplay),
  deadline: Schema.optionalKey(InvocationDeadline),
  /** The scheduled run the invocation serves, for telemetry; see `InvocationRun`. */
  run: Schema.optionalKey(Schema.String),
  headers: Schema.Record(Schema.String, Schema.String),
  /** Whether the invocation may ask for input or manage workflows through its callbacks. */
  elicitation: Schema.Boolean,
  workflowControls: Schema.Boolean,
});
export type WorkerInvocation = typeof WorkerInvocation.Type;
/** Only these capabilities cross from a live app invocation back to the product. */
export interface AppHostCallbacks extends RpcTarget {
  elicit(input: string): Promise<string>;
  control(input: string): Promise<string>;
  /** The invocation's encoded build, read only when the runner cold-starts its Worker. */
  load(): Promise<string>;
}
/** Sources declare the `apps` release they use in `dependencies.apps`; the host has none. */
export const CompileWorkerApp = Schema.Struct({ files: SourceFiles });
/** Compiler output is validated before it is retained by the host, which stores the framework once. */
export const CompiledWorkerApp = Schema.Struct({
  bundle: WorkerBundle,
  framework: WorkerFramework,
  protocol: RetainedWorkerBuild.fields.protocol,
  requirements: Schema.Json,
  ui: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        contentType: Schema.String,
        body: Schema.Uint8ArrayFromBase64,
      }),
    ),
  ),
});
export type CompiledWorkerApp = typeof CompiledWorkerApp.Type;
/** Expected build failures cross the RPC boundary typed, so the deploy can explain them. */
export const CompileWorkerResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: CompiledWorkerApp }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Union([
      RuntimeBuildFailed,
      RuntimeProtocolUnsupported,
      RuntimeAppsDependencyMissing,
    ]),
  }),
]);
/** RPC surface hosted by a trusted Worker; authored modules receive no host bindings. */
export interface WorkerdAppApi {
  cancel(): Promise<void>;
  compile(input: string): Promise<string>;
  invoke(input: string, callbacks: AppHostCallbacks): Promise<string>;
}
/** Background runs use finite host requests; no step callback or Promise lives in Node. */
export const WorkflowHostCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("prepare"), run: WorkflowRunId }),
  /** The run's build, read only when the runner cold-starts the run's Worker. */
  Schema.Struct({ operation: Schema.Literal("load"), run: WorkflowRunId }),
  Schema.Struct({ operation: Schema.Literal("context"), run: WorkflowRunId }),
  Schema.Struct({
    operation: Schema.Literal("invoke"),
    run: WorkflowRunId,
    kind: Schema.Literals(["query", "mutation"]),
    name: Schema.NonEmptyString,
    input: WorkflowValue,
    stepId: Schema.NonEmptyString,
    timeout: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({ operation: Schema.Literal("control"), run: WorkflowRunId, command: Schema.Json }),
  Schema.Struct({
    operation: Schema.Literal("finish"),
    run: WorkflowRunId,
    result: Schema.Union([
      Schema.Struct({ ok: Schema.Literal(true), output: WorkflowValue }),
      Schema.Struct({
        ok: Schema.Literal(false),
        error: Schema.NonEmptyString,
        detail: Schema.optionalKey(WorkflowRunFailure),
      }),
    ]),
  }),
]);
export type WorkflowHostCommand = typeof WorkflowHostCommand.Type;
/** A completed run can return immediately even if the engine lost its final checkpoint. */
export const PreparedWorkflow = Schema.Union([
  Schema.Struct({ state: Schema.Literal("complete"), output: WorkflowValue }),
  Schema.Struct({
    state: Schema.Literal("execute"),
    seed: WorkflowSeed,
    accounts: HostAccounts,
  }),
]);
