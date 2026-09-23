/** Node composition for Alchemy's workerd app runtime and native workflow engine. */
import {
  Runtime as LocalRuntime,
  layerLocalRuntime,
  type BindingHook,
} from "@alchemy.run/cloudflare-runtime/core";
import {
  DurableObjectNamespace,
  Json as JsonBinding,
  Loopback,
  WorkerLoader,
  Workflows,
} from "@alchemy.run/cloudflare-runtime/core/bindings";
import * as AlchemyPlugin from "@alchemy.run/cloudflare-runtime/core/Plugin";
import { Internet, InternetLive } from "@alchemy.run/cloudflare-runtime/core/globals/Internet";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WebSocket as NodeWebSocket } from "ws";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import {
  Cause,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Path,
  Queue,
  Schema,
  Stream,
  type Scope,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { WorkflowFailure, WorkflowRunId } from "apps/contracts";
import { WorkflowBackendState, type WorkflowRuntime } from "../contracts/workflow-runtime.ts";
import { type WorkerdAppApi } from "../contracts/workerd-host.ts";
import { type BlobStorage } from "../contracts/blobs.ts";

import { RuntimeBuildFailed, RuntimeProtocolFailed } from "../contracts/runtime.ts";
import type { Executor } from "../contracts/executor.ts";
import { runtimeAdapter } from "./runtime.ts";

import { connectedWorkerdApps, workerdHostHandler } from "./workerd-client.ts";
import { bundleWorkerdHost } from "./workerd-bundle.ts";

/** Existing stores need an explicit migration; opening a new empty store would hide retained app data. */
export class WorkerdMigrationRequired extends Schema.TaggedError<WorkerdMigrationRequired>()(
  "WorkerdMigrationRequired",
  { directory: Schema.String },
) {}
/**
 * workerd's `internet` service backs every global fetch, and Alchemy configures it to allow
 * private and loopback addresses because the host worker and local development need them. A
 * second network service carries the public-only rule, so app isolates can be pointed at it
 * through `globalOutbound` without changing the network the host itself uses. The refusal
 * happens in workerd after DNS resolution, so a public name that resolves to 127.0.0.1 is
 * refused too.
 */
const PUBLIC_EGRESS_SERVICE = "internet:public";
/** Environment name of the public-only network service inside the workerd host worker. */
const PUBLIC_EGRESS_BINDING = "PUBLIC_FETCH";
class PublicEgress extends AlchemyPlugin.Service<PublicEgress>()(
  "cloudflare-runtime/plugin/executor-public-egress",
) {}
const publicEgress = Layer.effect(
  PublicEgress,
  Effect.map(Internet, (internet) => ({
    services: [
      {
        name: PUBLIC_EGRESS_SERVICE,
        // A getter, like Alchemy's own service, so added CA certificates are read per config build.
        get network() {
          // Same TLS trust as the default network. Only the destination rule differs.
          return {
            ...("network" in internet ? internet.network : undefined),
            allow: ["public"],
            deny: [],
          };
        },
      },
    ],
  })),
).pipe(Layer.provide(InternetLive));
const publicEgressBinding: BindingHook = Effect.succeed({
  name: PUBLIC_EGRESS_BINDING,
  service: { name: PUBLIC_EGRESS_SERVICE },
});

const engineFailure = () => new WorkflowFailure({ reason: "engine", retryable: true });
const protocolFailure = () => new RuntimeProtocolFailed();

/** App-facing callbacks are scoped to the already-authorized invocation, never looked up by arbitrary IDs. */
/** Own one workerd process for authored apps and workflows. Agent execute(code) is unrelated. */
export const workerdApps = (options: {
  readonly directory: string;
  readonly blobs: BlobStorage;
  readonly executor: Effect.Effect<Executor>;
  readonly legacyDataDirectories?: readonly string[];
  /**
   * Let authored app code reach loopback and private address space. Hosted Cloudflare never
   * does. Local development needs it, because the bundled Executor app calls this process on
   * 127.0.0.1. Self-host leaves it off unless an operator opts in for an internal service.
   */
  readonly allowPrivateAppFetch?: boolean;
}): Effect.Effect<
  { readonly runtime: ReturnType<typeof runtimeAdapter>; readonly workflows: WorkflowRuntime },
  RuntimeBuildFailed | WorkerdMigrationRequired | WorkflowFailure,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      http = yield* HttpClient.HttpClient;
    for (const directory of options.legacyDataDirectories ?? []) {
      if ((yield* fs.exists(directory)) && (yield* fs.readDirectory(directory)).length > 0)
        return yield* new WorkerdMigrationRequired({ directory });
    }
    const handler = yield* workerdHostHandler(options);
    const runtimeContext = yield* Layer.build(
      layerLocalRuntime({ directory: options.directory }).pipe(
        // Registered as a runtime plugin so its service reaches the generated workerd config.
        Layer.provide(publicEgress),
        Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              CLOUDFLARE_RUNTIME_HOME: path.join(options.directory, "runtime"),
            }),
          ),
        ),
      ),
    );
    const engine = yield* LocalRuntime.pipe(Effect.provideContext(runtimeContext));
    const secret = crypto.randomUUID();
    const privateAppFetch = options.allowPrivateAppFetch === true;
    const origin = yield* engine
      .start({
        name: "executor-apps",
        compatibilityDate: "2026-07-30",
        // The trusted host worker keeps the default network. Only app isolates are restricted.
        compatibilityFlags: ["nodejs_compat"],
        modules: yield* bundleWorkerdHost,
        durableObjectNamespaces: [
          { className: "AppDataSupervisor", sql: true, uniqueKey: "executor-app-data" },
        ],
        workflows: [{ workflowName: "executor-app-workflows", className: "AppWorkflows" }],
        bindings: [
          WorkerLoader.local("LOADER"),
          DurableObjectNamespace.local({ binding: "DATA", className: "AppDataSupervisor" }),
          Workflows.local({
            binding: "RUNS",
            workflowName: "executor-app-workflows",
            className: "AppWorkflows",
          }),
          JsonBinding.local("AUTH", secret),
          JsonBinding.local("APPS_PRIVATE_FETCH", privateAppFetch),
          publicEgressBinding,
          Loopback.local({ binding: "HOST", name: "executor-workflow-host", handler }),
        ],
        // Raw authored console output is not a host log. Apps return bounded telemetry through their protocol.
        logging: { onOutput: () => {} },
      })
      .pipe(Effect.provideContext(runtimeContext));
    const headers = { authorization: `Bearer ${secret}` };
    const websocketUrl = (pathname: string) => {
      const url = new URL(pathname, origin);
      url.protocol = "ws:";
      return url.href;
    };
    const connect = (pathname: string) => new NodeWebSocket(websocketUrl(pathname), { headers });
    const rpc = <A, E>(
      work: (api: RpcStub<WorkerdAppApi>, signal: AbortSignal) => Effect.Effect<A, E>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const lifetime = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (controller) => Effect.sync(() => controller.abort()),
          );
          const peer = yield* Effect.acquireRelease(
            Effect.sync(() => {
              // SAFETY: ws implements the WebSocket methods used by Cap'n Web's transport;
              // its Node-specific constructor only supplies the private authorization header.
              const peer = newWebSocketRpcSession<WorkerdAppApi>(
                connect("/rpc") as unknown as WebSocket,
                undefined,
                { onSendError: () => new Error("App host callback failed") },
              );
              peer.onRpcBroken(() => lifetime.abort());
              return peer;
            }),
            (peer) =>
              Effect.promise(async () => {
                lifetime.abort();
                try {
                  await peer.cancel();
                } finally {
                  peer[Symbol.dispose]();
                }
              }).pipe(Effect.catchCause(() => Effect.void)),
          );
          return yield* work(peer, lifetime.signal);
        }),
      );
    const changes = (app: string) =>
      Stream.callback<number, RuntimeProtocolFailed>(
        (queue) =>
          Effect.gen(function* () {
            const socket = yield* Effect.acquireRelease(
              Effect.sync(() => connect(`/changes?app=${encodeURIComponent(app)}`)),
              (socket) => Effect.sync(() => socket.close()),
            );
            const changed = (data: import("ws").RawData) => {
              try {
                const { revision } = Schema.decodeUnknownSync(
                  Schema.fromJsonString(Schema.Struct({ revision: Schema.Int })),
                )(data.toString());
                Queue.offerUnsafe(queue, revision);
              } catch {
                Queue.failCauseUnsafe(queue, Cause.fail(protocolFailure()));
              }
            };
            const failed = () => {
              Queue.failCauseUnsafe(queue, Cause.fail(protocolFailure()));
            };
            socket.on("message", changed);
            socket.on("close", failed);
            socket.on("error", failed);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                socket.off("message", changed);
                socket.off("close", failed);
                socket.off("error", failed);
              }),
            );
          }),
        { bufferSize: 1, strategy: "sliding" },
      );
    const backend = (operation: "start" | "status" | "terminate", run: WorkflowRunId) =>
      Effect.scoped(
        Effect.gen(function* () {
          const request = yield* HttpClientRequest.post(new URL("/workflow", origin), {
            headers,
          }).pipe(HttpClientRequest.bodyJson({ operation, run }));
          const response = yield* http.execute(request);
          if (response.status !== 200) return yield* engineFailure();
          return yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(WorkflowBackendState)),
          );
        }),
      ).pipe(Effect.mapError(engineFailure));
    return yield* connectedWorkerdApps(options.blobs, { rpc, changes, backend });
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provide(FetchHttpClient.layer),
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      if (Cause.hasInterrupts(cause)) return Effect.interrupt;
      return Effect.fail(
        Schema.is(WorkerdMigrationRequired)(error) || Schema.is(RuntimeBuildFailed)(error)
          ? error
          : engineFailure(),
      );
    }),
  );
