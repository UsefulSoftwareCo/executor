/** Portable app protocol. Runtime adapters own processes, sockets and storage bindings. */
import { RpcTarget, type RpcStub } from "capnweb";
import { Cause, Effect, Option, Redacted, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
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
  HostedToolSummary,
  indexCommand,
  inspectCommand,
  skillCatalog,
  SkillCatalogResponse,
  skillsCommand,
  selectTools,
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

/** Assemble app execution without starting a runtime or opening host files. */
export const connectedWorkerdApps = (blobs: BlobStorage, transport: WorkerdTransport) =>
  Effect.gen(function* () {
    const forward = yield* makeTelemetryForwarder;
    const provideBlobs = Effect.provideService(BlobStore, blobs);
    const rpc = transport.rpc;
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
              ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
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
      skills: ({ sources, ...input }) =>
        dispatch(
          input,
          skillsCommand(sources === true),
          SkillCatalogResponse,
          HostInspectError,
        ).pipe(Effect.map(skillCatalog)),
      inspect: ({ tools, ...input }) =>
        dispatch(input, inspectCommand(tools), Schema.Array(HostedTool), HostInspectError).pipe(
          Effect.map(selectTools(tools)),
        ),
      index: (input) =>
        dispatch(input, indexCommand, Schema.Array(HostedToolSummary), HostInspectError),
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
      changes: transport.changes,
    };
    return {
      runtime: runtimeAdapter(runtime),
      workflows: {
        start: (run: WorkflowRunId) => transport.backend("start", run).pipe(Effect.asVoid),
        status: (run: WorkflowRunId) => transport.backend("status", run),
        terminate: (run: WorkflowRunId) => transport.backend("terminate", run).pipe(Effect.asVoid),
      } satisfies WorkflowRuntime,
    };
  });
