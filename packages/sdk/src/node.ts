/** Node host adapters. Products use workerdApps to isolate authored code. */
import { nodeRuntime as nativeNodeRuntime } from "./implementation/node-runtime.ts";
import { runtimeAdapter, type AppRuntime } from "./implementation/runtime.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";

/** Disposable working/cache location; durable output belongs to ExecutorOptions.blobs. */
export interface NodeRuntimeOptions {
  readonly workDirectory: string;
}

export { filesystemBlobStore } from "./implementation/filesystem-blobs.ts";

/** Create a lazy Node runtime. This constructor opens no files and starts no processes. */
export const nodeRuntime = (options: NodeRuntimeOptions): AppRuntime => {
  const runtime = nativeNodeRuntime(options);
  const asset = runtime.asset;
  const provideNode = Effect.provide(NodeServices.layer);
  return runtimeAdapter({
    build: (input) => runtime.build(input).pipe(provideNode),
    ...(asset === undefined
      ? {}
      : {
          asset: (input: Parameters<NonNullable<typeof runtime.asset>>[0]) =>
            asset(input).pipe(provideNode),
        }),
    inspect: (input) => runtime.inspect(input).pipe(provideNode),
    query: (input) => runtime.query(input).pipe(provideNode),
    mutate: (input) => runtime.mutate(input).pipe(provideNode),
    workflow: (input) => runtime.workflow(input).pipe(provideNode),
    webhook: (input) => runtime.webhook(input).pipe(provideNode),
    call: (input) => runtime.call(input).pipe(provideNode),
  });
};

export { filesystemAppDatabases } from "@executor-js/app-data/node";

export { workerdApps, WorkerdMigrationRequired } from "./implementation/workerd-apps.ts";
