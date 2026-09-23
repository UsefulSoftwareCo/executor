/** Retained Worker bundles use the shared SDK wire format. */
import type { RuntimeBuildFailed, SourceFiles } from "@executor-js/sdk/core";
import { WorkerBundle as CloudBundle } from "@executor-js/sdk/workerd";
import { Schema, type Effect } from "effect";
export { CloudBundle };
export { RetainedWorkerBuild as RetainedCloudBuild } from "@executor-js/sdk/workerd";

/** Private compiler RPC result; no storage handles or caller credentials cross this boundary. */
export const CompiledCloudApp = Schema.Struct({
  bundle: Schema.toType(CloudBundle),
  ui: Schema.UndefinedOr(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        contentType: Schema.String,
        body: Schema.Uint8Array,
      }),
    ),
  ),
});

/** A private Worker owns compiler initialization; API requests only hold its service binding. */
export type CloudCompiler = {
  readonly compile: (
    files: SourceFiles,
    headers: Readonly<Record<string, string>>,
  ) => Effect.Effect<typeof CompiledCloudApp.Type, RuntimeBuildFailed>;
};
