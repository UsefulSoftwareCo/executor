/** Private host capabilities and parsed app requests for the embedded workerd runtime. */
import { Schema } from "effect";
import {
  HostRequest,
  ResolvedAccounts,
  TrustedToolApproval,
  WorkflowReplay,
  WorkflowRunId,
  WorkflowValue,
} from "apps/contracts";
import { WorkflowSeed } from "./workflow-runtime.ts";
import { RetainedWorkerBuild, WorkerBundle } from "./worker-build.ts";
import type { RpcTarget } from "capnweb";

/** The serving product authorizes and binds these values before invoking app code. */
export const WorkerInvocation = Schema.Struct({
  app: Schema.NonEmptyString,
  build: Schema.NonEmptyString,
  bundle: RetainedWorkerBuild,
  command: HostRequest,
  accounts: ResolvedAccounts,
  approval: Schema.optionalKey(TrustedToolApproval),
  replay: Schema.optionalKey(WorkflowReplay),
  headers: Schema.Record(Schema.String, Schema.String),
});
export type WorkerInvocation = typeof WorkerInvocation.Type;
/** Only these two capabilities cross from a live app invocation back to Node. */
export interface AppHostCallbacks extends RpcTarget {
  elicit(input: string): Promise<string>;
  control(input: string): Promise<string>;
}
/** Compiler output is validated before it is retained by the host. */
export const CompiledWorkerApp = Schema.Struct({
  bundle: WorkerBundle,
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
/** RPC surface hosted by a trusted Worker; authored modules receive no host bindings. */
export interface WorkerdAppApi {
  cancel(): Promise<void>;
  compile(files: string): Promise<string>;
  invoke(input: string, callbacks: AppHostCallbacks): Promise<string>;
}
/** Background runs use finite host requests; no step callback or Promise lives in Node. */
export const WorkflowHostCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("prepare"), run: WorkflowRunId }),
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
      Schema.Struct({ ok: Schema.Literal(false), error: Schema.NonEmptyString }),
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
    bundle: RetainedWorkerBuild,
    accounts: ResolvedAccounts,
  }),
]);
