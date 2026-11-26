import {
  RuntimeBuildFailed,
  RuntimeProtocolUnsupported,
  RuntimeAppsDependencyMissing,
  type CodeFiles,
} from "@executor-js/sdk/core";
import {
  RetainedWorkerBuild,
  WorkerBundle as CloudBundle,
  WorkerFramework,
} from "@executor-js/sdk/workerd";
import { Schema, type Effect } from "effect";
import type { RpcCallError } from "alchemy/Rpc";
export { CloudBundle };
export { RetainedWorkerBuild as RetainedCloudBuild } from "@executor-js/sdk/workerd";

export const CompiledCloudApp = Schema.Struct({
  bundle: Schema.toType(CloudBundle),
  framework: WorkerFramework,
  protocol: RetainedWorkerBuild.fields.protocol,
  ui: Schema.UndefinedOr(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        contentType: Schema.String,
        body: Schema.Uint8Array,
      }),
    ),
  ),
  sourceMap: Schema.String,
});

export const isolateBuildCacheBytes = 32 * 1024 * 1024;
export const isolateBuildCacheEntries = 256;
export const isolateBuildModuleOverhead = 256;
export const isolateBuildEntryOverhead = 1024;

export const CloudCompileResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: CompiledCloudApp }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Union([
      RuntimeBuildFailed,
      RuntimeProtocolUnsupported,
      RuntimeAppsDependencyMissing,
    ]),
  }),
]);

export type CloudCompiler = {
  readonly compile: (
    files: CodeFiles,
    publicPaths: ReadonlyArray<string>,
    headers: Readonly<Record<string, string>>,
  ) => Effect.Effect<typeof CloudCompileResult.Encoded, RpcCallError>;
};
