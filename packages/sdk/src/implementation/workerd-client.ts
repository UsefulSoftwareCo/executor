/** Portable app protocol. Runtime adapters own processes, sockets and storage bindings. */
import { RpcTarget, type RpcStub } from "capnweb";
import { Cause, Effect, Redacted, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  DeclaredRequirements,
  WorkflowFailure,
  WorkflowRpcResult,
  WorkflowRunId,
} from "apps/contracts";
import {
  WorkflowHost,
  WorkflowBackendState,
  type WorkflowRuntime,
} from "../contracts/workflow-runtime.ts";
import {
  CompileWorkerApp,
  CompileWorkerResult,
  WorkflowHostCommand,
  type AppHostCallbacks,
  type WorkerdAppApi,
  WorkerInvocation,
  PreparedWorkflow,
} from "../contracts/workerd-host.ts";
import { BlobStore, type BlobStorage } from "../contracts/blobs.ts";
import { BuildId } from "../contracts/shared.ts";
import {
  describeBuildCause,
  RuntimeBuildFailed,
  RuntimeProtocolFailed,
} from "../contracts/runtime.ts";
import { LoadedWorkerBuild } from "../contracts/worker-build.ts";
import type { Executor } from "../contracts/executor.ts";
import { runtimeAdapter } from "./runtime.ts";
import { appRuntime, buildLoadSpan } from "./app-runtime.ts";
import { appWorker } from "./app-runner.ts";
import { invocationWorkflowControls } from "./worker-workflow-rpc.ts";
import { loadWorkerBuild, retainWorkerBuild, workerBuildAsset } from "./worker-build-storage.ts";
import { ownsDatabase } from "../contracts/apps.ts";

const engineFailure = () => new WorkflowFailure({ reason: "engine", retryable: true });
const protocolFailure = () => new RuntimeProtocolFailed();
const json = Schema.decodeUnknownSync(Schema.Json);
type Callback = (input: unknown) => Promise<unknown>;

const encodedJson = Schema.fromJsonString(Schema.Json);
/** App-facing callbacks are scoped to the already-authorized invocation, never looked up by arbitrary IDs. */
class HostCallbacks extends RpcTarget implements AppHostCallbacks {
  readonly #elicit: Callback | null;
  readonly #control: Callback | null;
  readonly #load: () => Promise<string>;
  constructor(elicit: Callback | null, control: Callback | null, load: () => Promise<string>) {
    super();
    this.#elicit = elicit;
    this.#control = control;
    this.#load = load;
  }
  async elicit(input: string) {
    if (this.#elicit === null) throw new Error("This invocation cannot ask for input");
    return JSON.stringify(json(await this.#elicit(Schema.decodeUnknownSync(encodedJson)(input))));
  }
  async control(input: string) {
    if (this.#control === null) throw new Error("This invocation cannot manage workflows");
    return JSON.stringify(json(await this.#control(Schema.decodeUnknownSync(encodedJson)(input))));
  }
  load() {
    return this.#load();
  }
}

/** Authorized workflow callbacks shared by native loopback and Worker service bindings. */
export const workerdHostHandler = (options: {
  readonly executor: Effect.Effect<Executor>;
  readonly blobs: BlobStorage;
}) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
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
            return yield* Schema.encodeEffect(PreparedWorkflow)({
              state: "execute",
              seed,
              accounts: Redacted.value(context.accounts),
            });
          }
          case "load": {
            const seed = yield* host.seed(command.run),
              context = yield* host.context(command.run);
            const worker = yield* appWorker({
              app: seed.app,
              build: seed.build,
              database: false,
              command: { operation: "workflow-run", name: seed.name, input: seed.input },
              accounts: Redacted.value(context.accounts),
            });
            const bundle = yield* loadWorkerBuild(seed.build).pipe(
              provideBlobs,
              Effect.withSpan(buildLoadSpan, {
                attributes: {
                  "executor.app.id": seed.app,
                  "executor.build.id": seed.build,
                  "executor.runtime.mode": worker.mode,
                  "executor.worker.identity": worker.name,
                },
              }),
            );
            return yield* Schema.encodeEffect(LoadedWorkerBuild)({
              mainModule: bundle.mainModule,
              modules: bundle.modules,
              protocol: bundle.protocol,
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
                ...(command.result.detail === undefined ? {} : { detail: command.result.detail }),
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
    return Effect.gen(function* () {
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
  });

/** Transport lifetime belongs to the host; each RPC scope owns its cancellation. */
export interface WorkerdTransport {
  readonly rpc: <A, E>(
    work: (api: RpcStub<WorkerdAppApi>, signal: AbortSignal) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | RuntimeProtocolFailed>;
  readonly changes: (app: string) => Stream.Stream<number, RuntimeProtocolFailed>;
  readonly backend: (
    operation: "start" | "status" | "terminate",
    run: WorkflowRunId,
  ) => Effect.Effect<typeof WorkflowBackendState.Type, WorkflowFailure>;
}

/**
 * App execution for hosts whose runner lives in the trusted apps Worker. The product sends each
 * invocation there with its callbacks, and the runner asks for the build only on a cold start.
 */
export const connectedWorkerdApps = (blobs: BlobStorage, transport: WorkerdTransport) =>
  Effect.gen(function* () {
    const provideBlobs = Effect.provideService(BlobStore, blobs);
    const rpc = transport.rpc;
    const runtime = yield* appRuntime({
      name: "runtime.workerd",
      loadBuild: (build) =>
        loadWorkerBuild(build).pipe(
          provideBlobs,
          Effect.map(({ mainModule, modules, protocol }) => ({ mainModule, modules, protocol })),
        ),
      invoke: (invocation, capabilities) =>
        Effect.gen(function* () {
          // A workflow body runs in the apps Worker's own workflow engine, never through a call.
          if (capabilities.workflow !== undefined) return yield* protocolFailure();
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(WorkerInvocation))({
            ...invocation,
            elicitation: capabilities.elicit !== null,
            workflowControls: capabilities.controls !== null,
          }).pipe(Effect.mapError(protocolFailure));
          const callbacks = new HostCallbacks(
            capabilities.elicit,
            capabilities.controls,
            async () =>
              Schema.encodeSync(Schema.fromJsonString(LoadedWorkerBuild))(
                await capabilities.load(),
              ),
          );
          return yield* rpc((api) =>
            Effect.tryPromise({
              try: async () =>
                Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
                  await api.invoke(encoded, callbacks),
                ),
              catch: protocolFailure,
            }),
          );
        }),
      build: ({ files }) =>
        Effect.gen(function* () {
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(CompileWorkerApp))({
            files,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimeBuildFailed({ stage: "source", message: describeBuildCause(cause) }),
            ),
          );
          const result = yield* rpc((api) =>
            Effect.tryPromise({
              try: async () => await api.compile(encoded),
              catch: protocolFailure,
            }),
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CompileWorkerResult))),
            Effect.mapError(
              (cause) =>
                new RuntimeBuildFailed({ stage: "compile", message: describeBuildCause(cause) }),
            ),
          );
          if (!result.ok) return yield* Effect.fail(result.error);
          const compiled = result.value;
          const requirements = yield* Schema.decodeUnknownEffect(DeclaredRequirements)(
            compiled.requirements,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimeBuildFailed({
                  stage: "declaration",
                  message: describeBuildCause(cause),
                }),
            ),
          );
          const build = BuildId.make(`bld_${crypto.randomUUID()}`);
          const { record } = yield* retainWorkerBuild(
            build,
            {
              ...compiled.bundle,
              database: ownsDatabase(requirements),
              protocol: compiled.protocol,
            },
            compiled.framework,
            compiled.ui,
          ).pipe(provideBlobs);
          return { build, requirements, ...(record.ui === undefined ? {} : { ui: record.ui }) };
        }),
      asset: ({ build, path }) => workerBuildAsset(build, path).pipe(provideBlobs),
      changes: transport.changes,
    });
    return {
      runtime: runtimeAdapter(runtime),
      workflows: {
        start: (run: WorkflowRunId) => transport.backend("start", run).pipe(Effect.asVoid),
        status: (run: WorkflowRunId) => transport.backend("status", run),
        terminate: (run: WorkflowRunId) => transport.backend("terminate", run).pipe(Effect.asVoid),
      } satisfies WorkflowRuntime,
    };
  });
