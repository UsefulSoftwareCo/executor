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
import { RpcTarget, newWebSocketRpcSession, type RpcStub } from "capnweb";
import {
  Cause,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Redacted,
  Schema,
  Stream,
  type Scope,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { traceHeaders, TelemetryBatch, makeTelemetryForwarder } from "@executor-js/telemetry";
import {
  DeclaredRequirements,
  ElicitationFailed,
  ElicitationReply,
  HostResponse,
  ToolResultObservation,
  HostInspectError,
  HostCallError,
  HostDataError,
  HostedTool,
  WorkflowFailure,
  WorkflowRpcResult,
  WorkflowRunId,
  type HostContext,
  type HostRequest,
} from "apps/contracts";
import {
  WorkflowHost,
  WorkflowBackendState,
  type WorkflowRuntime,
} from "../contracts/workflow-runtime.ts";
import {
  CompiledWorkerApp,
  WorkflowHostCommand,
  type AppHostCallbacks,
  type WorkerdAppApi,
  WorkerInvocation,
  PreparedWorkflow,
} from "../contracts/workerd-host.ts";
import { BlobStore, type BlobStorage } from "../contracts/blobs.ts";
import { BuildId, Json } from "../contracts/shared.ts";
import { RuntimeBuildFailed, RuntimeProtocolFailed, type Runtime } from "../contracts/runtime.ts";
import type { Executor } from "../contracts/executor.ts";
import { runtimeAdapter } from "./runtime.ts";
import { invocationElicitation } from "./worker-elicitation.ts";
import { invocationWorkflowControls } from "./worker-workflow-rpc.ts";
import { loadWorkerBuild, retainWorkerBuild, workerBuildAsset } from "./worker-build-storage.ts";
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
const json = Schema.decodeUnknownSync(Schema.Json);

/** App-facing callbacks are scoped to the already-authorized invocation, never looked up by arbitrary IDs. */
class HostCallbacks extends RpcTarget implements AppHostCallbacks {
  readonly #elicit: (input: unknown) => Promise<unknown>;
  readonly #control: (input: unknown) => Promise<unknown>;
  constructor(
    elicit: (input: unknown) => Promise<unknown>,
    control: (input: unknown) => Promise<unknown>,
  ) {
    super();
    this.#elicit = elicit;
    this.#control = control;
  }
  async elicit(input: string) {
    return JSON.stringify(
      json(await this.#elicit(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(input))),
    );
  }
  async control(input: string) {
    return JSON.stringify(
      json(
        await this.#control(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(input)),
      ),
    );
  }
}

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
    const services = yield* Effect.context<never>();
    const forward = yield* makeTelemetryForwarder;
    const provideBlobs = Effect.provideService(BlobStore, options.blobs);
    const hostOperation = (command: WorkflowHostCommand) =>
      Effect.gen(function* () {
        const executor = yield* options.executor,
          host = executor[WorkflowHost];
        switch (command.operation) {
          case "prepare": {
            const current = yield* host.get(command.run);
            if (current.status === "complete") return { state: "complete", output: current.output };
            const seed = yield* host.seed(command.run),
              context = yield* host.context(command.run);
            const bundle = yield* loadWorkerBuild(seed.build).pipe(provideBlobs);
            return yield* Schema.encodeEffect(PreparedWorkflow)({
              state: "execute",
              seed,
              bundle,
              accounts: Redacted.value(context.accounts),
            });
          }
          case "context": {
            const context = yield* host.context(command.run);
            return Redacted.value(context.accounts);
          }
          case "invoke":
            return yield* host.invoke(command.run, command).pipe(Effect.timeout(command.timeout));
          case "finish": {
            if (command.result.ok) yield* host.finish(command.run, command.result);
            else
              yield* host.finish(command.run, {
                ok: false,
                error: yield* Schema.decodeUnknownEffect(WorkflowFailure.fields.reason)(
                  command.result.error,
                ),
              });
            return null;
          }
          case "control": {
            const context = yield* host.context(command.run);
            if (context.workflowControls === undefined)
              return yield* new WorkflowFailure({ reason: "unavailable", retryable: false });
            const control = yield* invocationWorkflowControls(
              context.workflowControls,
              new AbortController().signal,
            );
            // This adapter returns the shared encoded reply, which the Worker forwards unchanged.
            return yield* Effect.tryPromise({
              try: () => control(command.command),
              catch: engineFailure,
            });
          }
        }
      });
    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const command = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(WorkflowHostCommand)),
      );
      return yield* hostOperation(command).pipe(Effect.provideContext(services));
    }).pipe(
      Effect.matchCause({
        onSuccess: (value) => ({ ok: true as const, value }),
        onFailure: (cause) => ({
          ok: false as const,
          error: Schema.is(WorkflowFailure)(Cause.squash(cause))
            ? Cause.squash(cause)
            : engineFailure(),
        }),
      }),
      Effect.flatMap(Schema.encodeUnknownEffect(WorkflowRpcResult)),
      Effect.flatMap(HttpServerResponse.json),
    );
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
    const dispatch = <A, E>(
      input: {
        readonly app: string;
        readonly build: BuildId;
        readonly observeRevision?: (revision: number) => void;
      } & HostContext,
      command: HostRequest,
      output: Schema.Decoder<A>,
      errors: Schema.Decoder<E>,
    ) =>
      Effect.gen(function* () {
        if (input.storage !== undefined) return yield* protocolFailure();
        const bundle = yield* loadWorkerBuild(input.build).pipe(provideBlobs);
        const trace = Object.fromEntries(Object.entries(yield* traceHeaders));
        const body = yield* rpc((api, signal) =>
          Effect.gen(function* () {
            const control =
              input.workflowControls === undefined
                ? undefined
                : yield* invocationWorkflowControls(input.workflowControls, signal);
            const elicit =
              input.elicitation === undefined
                ? () =>
                    Effect.runPromise(
                      Schema.encodeEffect(ElicitationReply)({
                        ok: false,
                        error: new ElicitationFailed({ reason: "unavailable" }),
                      }),
                    )
                : invocationElicitation(input.elicitation, signal);
            const controls =
              control ??
              (() =>
                Effect.runPromise(
                  Schema.encodeEffect(WorkflowRpcResult)({
                    ok: false,
                    error: new WorkflowFailure({ reason: "unavailable", retryable: false }),
                  }),
                ));
            const request: WorkerInvocation = {
              app: input.app,
              build: input.build,
              bundle,
              command,
              accounts: Redacted.value(input.accounts),
              headers: trace,
              ...(input.approval === undefined ? {} : { approval: input.approval }),
              ...(input.replay === undefined ? {} : { replay: input.replay }),
            };
            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(WorkerInvocation))(
              request,
            );
            return yield* Effect.tryPromise({
              try: async () =>
                Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
                  await api.invoke(encoded, new HostCallbacks(elicit, controls)),
                ),
              catch: protocolFailure,
            });
          }),
        );
        const telemetry = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            telemetry: Schema.optional(TelemetryBatch),
            executorRevision: Schema.optional(Schema.Int),
          }),
        )(body);
        if (telemetry.telemetry !== undefined) {
          const span = yield* Effect.currentSpan.pipe(Effect.option);
          if (Option.isSome(span))
            yield* forward(telemetry.telemetry, span.value.traceId, input.build);
        }
        const reply = yield* Schema.decodeUnknownEffect(HostResponse)(body).pipe(
          Effect.mapError(protocolFailure),
        );
        if (!reply.ok)
          return yield* Schema.decodeUnknownEffect(errors)(reply.error).pipe(
            Effect.mapError(protocolFailure),
            Effect.flatMap(Effect.fail),
          );
        if (reply.toolError === true) {
          (yield* ToolResultObservation).failed();
          yield* Effect.annotateCurrentSpan({
            "executor.outcome": "failed",
            "error.type": "McpToolError",
          });
        }
        const value = yield* Schema.decodeUnknownEffect(output)(reply.value).pipe(
          Effect.mapError(protocolFailure),
        );
        if (command.operation === "query" && telemetry.executorRevision !== undefined)
          input.observeRevision?.(telemetry.executorRevision);
        return value;
      }).pipe(Effect.catchTag("SchemaError", () => Effect.fail(protocolFailure())));
    const runtime: Runtime = {
      build: ({ files }) =>
        Effect.gen(function* () {
          const result = yield* rpc((api) =>
            Effect.tryPromise({
              try: async () => await api.compile(JSON.stringify(files)),
              catch: protocolFailure,
            }),
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CompiledWorkerApp))),
          );
          const requirements = yield* Schema.decodeUnknownEffect(DeclaredRequirements)(
            result.requirements,
          );
          const build = BuildId.make(`bld_${crypto.randomUUID()}`);
          const ui = yield* retainWorkerBuild(
            build,
            { ...result.bundle, database: requirements.database !== undefined },
            result.ui,
          ).pipe(provideBlobs);
          return { build, requirements, ...(ui === undefined ? {} : { ui }) };
        }).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" }))),
      asset: ({ build, path }) => workerBuildAsset(build, path).pipe(provideBlobs),
      inspect: (input) =>
        dispatch(input, { operation: "inspect" }, Schema.Array(HostedTool), HostInspectError),
      query: (input) =>
        dispatch(
          input,
          { operation: "query", name: input.name, input: input.input },
          Json,
          HostDataError,
        ),
      mutate: (input) =>
        dispatch(
          input,
          { operation: "mutate", name: input.name, input: input.input },
          Json,
          HostDataError,
        ),
      call: (input) =>
        dispatch(
          input,
          { operation: "call", tool: input.tool, input: input.input },
          Json,
          HostCallError,
        ),
      webhook: (input) => dispatch(input, input.command, Json, HostCallError),
      workflow: (input) => dispatch(input, input.command, Json, HostCallError),
      changes: (app) =>
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
        ),
    };
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
    return {
      runtime: runtimeAdapter(runtime),
      workflows: {
        start: (run: WorkflowRunId) => backend("start", run).pipe(Effect.asVoid),
        status: (run: WorkflowRunId) => backend("status", run),
        terminate: (run: WorkflowRunId) => backend("terminate", run).pipe(Effect.asVoid),
      },
    };
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
