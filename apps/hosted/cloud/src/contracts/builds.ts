/** Retained Worker bundles use the shared SDK wire format. */
import {
  RuntimeBuildFailed,
  RuntimeProtocolUnsupported,
  RuntimeAppsDependencyMissing,
  type SourceFiles,
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

/** Private compiler RPC result; no storage handles or caller credentials cross this boundary. */
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
  /** Locates the build's declaration failures in the authored source; never retained. */
  sourceMap: Schema.String,
});

/**
 * The heap decoded build records and frameworks may hold in one AppData isolate, accounted from
 * every retained field (two bytes per string code unit, WASM bytes and a fixed allowance per
 * module and entry), not measured.
 * Each framework is held once, however many builds link it. Set from a heap test on a stage with
 * production's largest builds (notes/app-runtime.md); the isolate's limit is 128 MB.
 */
export const isolateBuildCacheBytes = 32 * 1024 * 1024;
/** At most this many records and frameworks, however small. */
export const isolateBuildCacheEntries = 256;
export const isolateBuildModuleOverhead = 256;
export const isolateBuildEntryOverhead = 1024;

/** Expected build failures cross the binding as data so the deploy can explain them. */
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

/** Compiler binding calls fail only with Alchemy transport failures; build failures are results. */
export type CloudCompiler = {
  readonly compile: (
    files: SourceFiles,
    headers: Readonly<Record<string, string>>,
  ) => Effect.Effect<typeof CloudCompileResult.Encoded, RpcCallError>;
};
