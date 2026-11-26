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
  Config,
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
import { Hex } from "effect/encoding";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { WorkflowFailure, WorkflowRunId } from "apps/contracts";
import { WorkflowBackendState, type WorkflowRuntime } from "../contracts/workflow-runtime.ts";
import { type WorkerdAppApi } from "../contracts/workerd-host.ts";
import { type BlobStorage } from "../contracts/blobs.ts";
import {
  EvaluatedCommandJson,
  EvaluatedReplyJson,
  type EvaluatedCommand,
} from "@executor-js/app-data/evaluated";

import { RuntimeBuildFailed, RuntimeProtocolFailed } from "../contracts/runtime.ts";
import type { Executor } from "../contracts/executor.ts";
import type { DurableDeclarations } from "../contracts/declarations.ts";
import { runtimeAdapter } from "./runtime.ts";

import {
  connectedWorkerdApps,
  TransportClosed,
  workerdHostHandler,
  type RegistryRead,
} from "./workerd-client.ts";
import { workerdHostModules } from "./workerd-bundle.ts";
import { appWorkerIdleSeconds, appWorkerLimit } from "./app-worker-residency.ts";
import { EngineFaults } from "../contracts/engine-faults.ts";

const supervisorFaults = Effect.gen(function* () {
  const environment = yield* Config.option(Config.String("EXECUTOR_ENVIRONMENT"));
  if (Option.getOrUndefined(environment) !== "e2e") return null;
  const delay = (name: string) =>
    Config.option(
      Config.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25_000 })), name),
    ).pipe(Effect.map(Option.getOrUndefined));
  const faults = {
    resetDelayMs: yield* delay("EXECUTOR_TEST_SUPERVISOR_RESET_DELAY_MS"),
    resetHoldMs: yield* delay("EXECUTOR_TEST_SUPERVISOR_RESET_HOLD_MS"),
    replyDelayMs: yield* delay("EXECUTOR_TEST_SUPERVISOR_REPLY_DELAY_MS"),
  };
  return Object.values(faults).some((value) => value !== undefined) ? faults : null;
});
const engineFaults = Effect.gen(function* () {
  const environment = yield* Config.option(Config.String("EXECUTOR_ENVIRONMENT"));
  if (Option.getOrUndefined(environment) !== "e2e") return null;
  const configured = yield* Config.option(Config.String("EXECUTOR_TEST_WORKFLOW_ENGINE_FAULTS"));
  return Option.isNone(configured)
    ? null
    : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EngineFaults))(configured.value).pipe(
        Effect.orDie,
      );
});
import { runtimeHops, type SocketRecord } from "./runtime-hop.ts";
import { repeatingAtConnect, repeatUnopened, type Opening } from "./runtime-connect.ts";

export class WorkerdMigrationRequired extends Schema.TaggedError<WorkerdMigrationRequired>()(
  "WorkerdMigrationRequired",
  { directory: Schema.String },
) {}
const PUBLIC_EGRESS_SERVICE = "internet:public";
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
        get network() {
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
const SELF_ORIGIN_SERVICE = "executor:self-origin";
class SelfOriginService extends AlchemyPlugin.Service<SelfOriginService>()(
  "cloudflare-runtime/plugin/executor-self-origin",
) {}
const selfOriginService = (address: string) =>
  Layer.succeed(SelfOriginService, {
    services: [{ name: SELF_ORIGIN_SERVICE, external: { address, http: {} } }],
  });
const selfOriginBinding: BindingHook = Effect.succeed({
  name: "SELF",
  service: { name: SELF_ORIGIN_SERVICE },
});

const engineFailure = () => new WorkflowFailure({ reason: "engine", retryable: true });
const protocolFailure = () => new RuntimeProtocolFailed();

const credentialHandleSecret = (encryptionKey: Redacted.Redacted<string>) =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(Redacted.value(encryptionKey)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode("executor credential handles"),
    );
    return Hex.encode(new Uint8Array(signature));
  });

export const workerdApps = (options: {
  readonly directory: string;
  readonly blobs: BlobStorage;
  readonly executor: Effect.Effect<Executor>;
  readonly legacyDataDirectories?: readonly string[];
  readonly allowPrivateAppFetch?: boolean;
  readonly selfOrigin?: { readonly origin: string; readonly address: string };
  readonly npmRegistry?: string;
  readonly encryptionKey: Redacted.Redacted<string>;
}): Effect.Effect<
  {
    readonly runtime: ReturnType<typeof runtimeAdapter>;
    readonly workflows: WorkflowRuntime;
    readonly declarations: DurableDeclarations;
    readonly readRegistry: RegistryRead;
  },
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
    const flags = (process.env.ALCHEMY_WORKERD_V8_FLAGS ?? "").split(/\s+/).filter(Boolean);
    process.env.ALCHEMY_WORKERD_V8_FLAGS = [
      ...flags,
      ...["--expose-gc", "--no-flush-liftoff-code"].filter((flag) => !flags.includes(flag)),
    ].join(" ");
    const runtimeContext = yield* Layer.build(
      layerLocalRuntime({ directory: options.directory }).pipe(
        Layer.provide(publicEgress),
        Layer.provide(
          options.selfOrigin === undefined
            ? Layer.empty
            : selfOriginService(options.selfOrigin.address),
        ),
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
    const services = yield* Effect.context<never>();
    let restarts = 0;
    let lastRestartAt: number | undefined;
    const restarted = (exit: {
      readonly exitCode: number | null;
      readonly signal: string | null;
    }) => {
      restarts += 1;
      lastRestartAt = performance.now();
      Effect.runForkWith(services)(
        Effect.logWarning("App runtime restarted").pipe(
          Effect.annotateLogs({
            restarts,
            ...(exit.exitCode === null ? {} : { exitCode: exit.exitCode }),
            ...(exit.signal === null ? {} : { signal: exit.signal }),
          }),
        ),
      );
    };
    const secret = crypto.randomUUID();
    const privateAppFetch = options.allowPrivateAppFetch === true;
    const origin = yield* engine
      .start({
        name: "executor-apps",
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat", "no_brotli_content_encoding"],
        modules: yield* workerdHostModules,
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
          JsonBinding.local(
            "CREDENTIAL_SECRET",
            yield* credentialHandleSecret(options.encryptionKey),
          ),
          JsonBinding.local("APPS_PRIVATE_FETCH", privateAppFetch),
          JsonBinding.local("APP_WORKERS", Option.getOrNull(yield* appWorkerLimit)),
          JsonBinding.local(
            "APP_WORKER_IDLE_SECONDS",
            Option.getOrNull(yield* appWorkerIdleSeconds),
          ),
          JsonBinding.local("WORKFLOW_ENGINE_FAULTS", yield* engineFaults),
          JsonBinding.local("SUPERVISOR_FAULTS", yield* supervisorFaults),
          publicEgressBinding,
          JsonBinding.local("SELF_ORIGIN", options.selfOrigin?.origin ?? ""),
          JsonBinding.local("NPM_REGISTRY", options.npmRegistry ?? ""),
          ...(options.selfOrigin === undefined ? [] : [selfOriginBinding]),
          Loopback.local({ binding: "HOST", name: "executor-workflow-host", handler }),
        ],
        logging: { onOutput: () => {} },
        onRestart: restarted,
      })
      .pipe(Effect.provideContext(runtimeContext));
    const headers = { authorization: `Bearer ${secret}` };
    const hops = runtimeHops({
      restarts: () => ({ count: restarts, lastAt: lastRestartAt }),
      probe: () => ({}),
    });
    const websocketUrl = (pathname: string) => {
      const url = new URL(pathname, origin);
      url.protocol = "ws:";
      return url.href;
    };
    const connect = (pathname: string) =>
      new NodeWebSocket(websocketUrl(pathname), { headers, perMessageDeflate: false });
    const rpc = <A, E>(
      work: (api: RpcStub<WorkerdAppApi>, signal: AbortSignal) => Effect.Effect<A, E>,
    ) =>
      repeatUnopened((opening) =>
        session(opening, (api, signal) => Effect.andThen(opening.opened, () => work(api, signal))),
      );
    const session = <A, E>(
      opening: Opening,
      work: (api: RpcStub<WorkerdAppApi>, signal: AbortSignal) => Effect.Effect<A, E>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const lifetime = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (controller) => Effect.sync(() => controller.abort()),
          );
          let socketRecord: SocketRecord | undefined;
          const peer = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const socket = connect("/rpc");
              socketRecord = hops.track(socket);
              opening.watch(socket);
              let closed = false;
              const close = () => {
                closed = true;
              };
              socket.on("close", close);
              socket.on("error", close);
              const peer = newWebSocketRpcSession<WorkerdAppApi>(
                socket as unknown as WebSocket,
                undefined,
                { onSendError: () => new Error("App host callback failed") },
              );
              peer.onRpcBroken(() => lifetime.abort(closed ? TransportClosed : undefined));
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
          return yield* hops.rpc(() => socketRecord, work(peer, lifetime.signal));
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
              }),
            );
          }),
        { bufferSize: 1, strategy: "sliding" },
      );
    const backend = (
      operation: "start" | "status" | "terminate" | "input",
      run: WorkflowRunId,
      id?: string,
    ) =>
      repeatingAtConnect(
        Effect.gen(function* () {
          const request = yield* HttpClientRequest.post(new URL("/workflow", origin), {
            headers: { ...headers, connection: "close" },
          }).pipe(
            HttpClientRequest.bodyJson({ operation, run, ...(id === undefined ? {} : { id }) }),
          );
          return yield* hops.http("/workflow", http.execute(request), (response) =>
            Effect.gen(function* () {
              if (response.status !== 200) return yield* engineFailure();
              return yield* response.json.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(WorkflowBackendState)),
              );
            }),
          );
        }),
      ).pipe(Effect.mapError(engineFailure));
    const evaluated = (app: string, command: EvaluatedCommand) =>
      repeatingAtConnect(
        Effect.gen(function* () {
          const url = new URL("/evaluated", origin);
          url.searchParams.set("app", app);
          const request = HttpClientRequest.post(url, {
            headers: { ...headers, connection: "close" },
          }).pipe(
            HttpClientRequest.bodyText(
              yield* Schema.encodeEffect(EvaluatedCommandJson)(command),
              "application/json",
            ),
          );
          return yield* hops.http("/evaluated", http.execute(request), (response) =>
            Effect.gen(function* () {
              if (response.status !== 200) return yield* protocolFailure();
              return yield* response.text.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(EvaluatedReplyJson)),
              );
            }),
          );
        }),
      ).pipe(Effect.mapError(protocolFailure));
    return yield* connectedWorkerdApps(options.blobs, { rpc, changes, evaluated, backend });
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
