/** Trusted workerd host. App modules get isolated Workers/facets, never this environment. */
import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type {
  DurableObjectState,
  ExecutionContext,
  WorkerLoader,
  Workflow,
  Fetcher,
  WebSocket as NativeWebSocket,
} from "@cloudflare/workers-types";
import { RpcTarget, newWorkersRpcResponse, type RpcStub } from "capnweb";
import { Cause, Effect, Redacted, Schema } from "effect";
import {
  DeclaredRequirements,
  HostResponse,
  ElicitationReply,
  ResolvedAccounts,
  WorkflowRunId,
  WorkflowFailure,
  WorkflowRpcResult,
  WorkflowValue,
  type HostContext,
  type WorkflowExecution,
  type WorkflowRpc,
  type WorkflowStepOptions,
  type WorkflowDuration,
} from "apps/contracts";
import {
  facetIdentity,
  makeFacetSupervisor,
  FacetInvocation,
  FacetResult,
  type FacetBundle,
} from "@executor-js/app-data/cloudflare";
import {
  appRpcBridge,
  appFacetBridge,
  AppRpcEntrypoint,
  AppRpcInvocation,
  invocationWorkflow,
} from "../workerd.ts";
import { workerModules } from "@executor-js/app-data/worker-bundle";
import { compileWorkerApp } from "../workerd-build.ts";
import {
  CompiledWorkerApp,
  PreparedWorkflow,
  WorkerInvocation,
  type AppHostCallbacks,
  type WorkflowHostCommand,
} from "../contracts/workerd-host.ts";
import { SourceFiles } from "../contracts/deployment.ts";
import { decodeWorkflowFailure, workflowFailureMessage } from "../contracts/workflow-errors.ts";
import framework from "executor-framework";

declare const WebSocketPair: { new (): { 0: NativeWebSocket; 1: NativeWebSocket } };

type Callback = (input: unknown) => Promise<unknown>;
interface DataEntrypoint {
  invoke(
    input: typeof FacetInvocation.Type,
    load: () => Promise<typeof FacetBundle.Type>,
    elicit: Callback | null,
    controls: Callback | null,
  ): Promise<unknown>;
  cancel(id: string): Promise<void>;
  fetch(request: Request): Promise<Response>;
}
interface NativeStepPort {
  do(
    name: string,
    options: WorkflowStepOptions,
    work: () => Promise<Schema.Json>,
  ): Promise<unknown>;
  sleep(name: string, duration: WorkflowDuration): Promise<void>;
  sleepUntil(name: string, timestamp: number): Promise<void>;
}
const NativeStep = Schema.declare(
  (value): value is NativeStepPort =>
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    "do" in value &&
    typeof value.do === "function" &&
    "sleep" in value &&
    typeof value.sleep === "function" &&
    "sleepUntil" in value &&
    typeof value.sleepUntil === "function",
);
interface Environment {
  readonly AUTH: string;
  /** Host decision, not an app capability: apps never see or change this binding. */
  readonly APPS_PRIVATE_FETCH: boolean;
  /** workerd network service that refuses private, loopback and link-local destinations. */
  readonly PUBLIC_FETCH: Fetcher;
  readonly LOADER: WorkerLoader;
  readonly DATA: { getByName(name: string): DataEntrypoint };
  readonly RUNS: Workflow<{ run: string }>;
  readonly HOST: Fetcher;
}
const failure = () => new WorkflowFailure({ reason: "engine", retryable: true });
/**
 * Where an app isolate's global `fetch` goes. `global_fetch_strictly_public` cannot do this
 * here: it routes global fetch through workerd's `internet` service, which this runtime
 * configures to allow private addresses. An explicit outbound to the public-only network
 * service is the control. Omitting it leaves the isolate on the default network.
 */
const appOutbound = (env: Environment): Fetcher | undefined =>
  env.APPS_PRIVATE_FETCH ? undefined : env.PUBLIC_FETCH;
const rpcOptions = { onSendError: () => new Error("App runtime request failed") };
const json = Schema.decodeUnknownSync(Schema.Json);
const hostRequest = (env: Environment, command: WorkflowHostCommand) =>
  Effect.tryPromise({
    try: async () => {
      const response = await env.HOST.fetch("https://host.internal/workflows", {
        method: "POST",
        body: JSON.stringify(command),
      });
      return response.json();
    },
    catch: failure,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WorkflowRpcResult)),
    Effect.mapError(failure),
    Effect.flatMap((reply) => (reply.ok ? Effect.succeed(reply.value) : Effect.fail(reply.error))),
  );

/** Run a single authorized invocation through the same generated protocol as Cloud. */
const invoke = (
  env: Environment,
  input: WorkerInvocation,
  signal: AbortSignal,
  elicit: Callback | null,
  controls: Callback | null,
  execution?: WorkflowExecution,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const identity = yield* facetIdentity(input.build, JSON.stringify(input.accounts));
      const body = JSON.stringify({
        command: input.command,
        accounts: input.accounts,
        approval: input.approval,
        replay: input.replay,
        deadline: input.deadline,
        workflowRun: execution?.runId,
      });
      const data =
        input.bundle.database &&
        (input.command.operation === "call" ||
          input.command.operation === "query" ||
          input.command.operation === "mutate" ||
          ["webhook-register", "webhook-handle", "webhook-unregister"].includes(
            input.command.operation,
          ));
      if (data) {
        const target = env.DATA.getByName(input.app),
          id = crypto.randomUUID();
        return yield* Effect.tryPromise({
          try: () =>
            target.invoke(
              {
                id,
                identity,
                body,
                headers: input.headers,
                write:
                  ["mutate", "webhook-register", "webhook-handle", "webhook-unregister"].includes(
                    input.command.operation,
                  ) ||
                  (input.command.operation === "call" &&
                    input.command.tool.startsWith("mutations.")),
              },
              async () => ({
                mainModule: "__executor_facet.js",
                modules: {
                  ...input.bundle.modules,
                  "__executor_facet.js": appFacetBridge(input.bundle.mainModule),
                },
              }),
              elicit,
              controls,
            ),
          catch: failure,
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(FacetResult)),
          Effect.flatMap((result) =>
            Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(
              result.value,
            ).pipe(Effect.map((body) => ({ ...body, executorRevision: result.revision }))),
          ),
          Effect.onInterrupt(() =>
            Effect.promise(() => target.cancel(id)).pipe(Effect.catchCause(() => Effect.void)),
          ),
        );
      }
      const outbound = appOutbound(env);
      const worker = env.LOADER.get(
        `${input.app}:${execution?.runId ?? "call"}:${identity}`,
        () => ({
          mainModule: "__executor_rpc.js",
          modules: {
            ...workerModules(input.bundle.modules),
            "__executor_rpc.js": appRpcBridge(input.bundle.mainModule),
          },
          compatibilityDate: "2026-07-30",
          compatibilityFlags: ["nodejs_compat"],
          ...(outbound === undefined ? {} : { globalOutbound: outbound }),
        }),
      );
      const entry = yield* Schema.decodeUnknownEffect(AppRpcEntrypoint)(worker.getEntrypoint());
      const workflow =
        execution === undefined ? null : yield* invocationWorkflow(execution, signal);
      const delivery =
        elicit === null
          ? null
          : async (input: unknown) =>
              Schema.encodeSync(ElicitationReply)(
                Schema.decodeUnknownSync(ElicitationReply)(await elicit(input)),
              );
      const call = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => entry.start(body, input.headers, delivery, workflow, controls),
          catch: failure,
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(AppRpcInvocation))),
        (call) =>
          Effect.promise(async () => {
            try {
              await call.cancel();
            } finally {
              call[Symbol.dispose]();
            }
          }).pipe(Effect.catchCause(() => Effect.void)),
      );
      return yield* Effect.tryPromise({ try: () => call.result(), catch: failure });
    }),
  );

/** Each WebSocket session owns its invocation lifetime and host capabilities. */
class AppApi extends RpcTarget {
  readonly #env: Environment;
  readonly #lifetime = new AbortController();
  readonly #context: Pick<ExecutionContext, "waitUntil">;
  #active: Promise<unknown> | undefined;
  constructor(env: Environment, context: Pick<ExecutionContext, "waitUntil">) {
    super();
    this.#env = env;
    this.#context = context;
  }
  #run<A>(work: Effect.Effect<A, unknown>): Promise<A> {
    if (this.#active !== undefined)
      return Promise.reject(new Error("This app session already has an invocation"));
    const active = Effect.runPromise(work, { signal: this.#lifetime.signal });
    this.#active = active;
    // Keep cleanup I/O alive if the RPC socket disappears mid-transaction.
    this.#context.waitUntil(
      active.then(
        () => undefined,
        () => undefined,
      ),
    );
    return active;
  }
  async cancel(): Promise<void> {
    this.#lifetime.abort();
    try {
      await this.#active;
    } catch {
      /* The invocation reports its own failure. */
    }
  }
  [Symbol.dispose]() {
    this.#lifetime.abort();
  }
  async compile(input: string): Promise<string> {
    return this.#run(
      Effect.gen({ self: this }, function* () {
        const files = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SourceFiles))(input);
        const { bundle, ui } = yield* compileWorkerApp(files, framework);
        const build = crypto.randomUUID();
        const response = yield* invoke(
          this.#env,
          {
            app: `declaration:${build}`,
            build,
            bundle: { ...bundle, database: false },
            command: { operation: "requirements" },
            accounts: {},
            headers: {},
          },
          this.#lifetime.signal,
          null,
          null,
        );
        const envelope = yield* Schema.decodeUnknownEffect(HostResponse)(response);
        if (!envelope.ok) return yield* failure();
        const requirements = yield* Schema.decodeUnknownEffect(DeclaredRequirements)(
          envelope.value,
        );
        return yield* Schema.encodeEffect(Schema.fromJsonString(CompiledWorkerApp))({
          bundle,
          requirements: json(yield* Schema.encodeEffect(DeclaredRequirements)(requirements)),
          ...(ui === undefined ? {} : { ui }),
        });
      }),
    );
  }
  async invoke(value: string, callbacks: RpcStub<AppHostCallbacks>): Promise<string> {
    return this.#run(
      Schema.decodeUnknownEffect(Schema.fromJsonString(WorkerInvocation))(value).pipe(
        Effect.flatMap((input) =>
          invoke(
            this.#env,
            input,
            this.#lifetime.signal,
            async (input) =>
              Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
                await callbacks.elicit(JSON.stringify(input)),
              ),
            async (input) =>
              Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
                await callbacks.control(JSON.stringify(input)),
              ),
          ),
        ),
        Effect.flatMap(Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))),
      ),
    );
  }
}

/** Native app data stays in isolated facets and retains its database across code updates. */
export class AppDataSupervisor extends DurableObject<Environment> {
  readonly #supervisor: Promise<Effect.Success<ReturnType<typeof makeFacetSupervisor>>>;
  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    this.#supervisor = Effect.runPromise(makeFacetSupervisor(ctx, env.LOADER, appOutbound(env)));
  }
  async invoke(
    input: typeof FacetInvocation.Type,
    load: () => Promise<typeof FacetBundle.Type>,
    elicit: Callback | null,
    controls: Callback | null,
  ) {
    const result = Effect.runPromise(
      (await this.#supervisor).invoke(input, load, elicit, controls),
    );
    // The supervisor owns rollback even if the original RPC caller disconnects.
    this.ctx.waitUntil(
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
  async cancel(id: string) {
    return Effect.runPromise((await this.#supervisor).cancel(id));
  }
  async alarm() {
    return Effect.runPromise((await this.#supervisor).recover);
  }
  async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    await Effect.runPromise((await this.#supervisor).initial(pair[1]));
    const responseOptions: ResponseInit & { readonly webSocket: NativeWebSocket } = {
      status: 101,
      webSocket: pair[0],
    };
    return new Response(null, responseOptions);
  }
  webSocketMessage() {}
  webSocketClose(socket: NativeWebSocket) {
    socket.close(1000, "Closed");
  }
  webSocketError(socket: NativeWebSocket) {
    socket.close(1011, "Reconnect");
  }
}

/** The workflow body and every durable step execute in workerd; Node supplies only host data. */
export class AppWorkflows extends WorkflowEntrypoint<Environment, { run: string }> {
  async run(event: Readonly<{ payload: { run: string } }>, step: unknown): Promise<Schema.Json> {
    const lifetime = new AbortController();
    const nativeStep = Schema.decodeUnknownSync(NativeStep)(step);
    try {
      return await Effect.runPromise(
        Effect.gen({ self: this }, function* () {
          const prepared = yield* hostRequest(this.env, {
            operation: "prepare",
            run: Schema.decodeUnknownSync(WorkflowRunId)(event.payload.run),
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PreparedWorkflow)));
          if (prepared.state === "complete") return prepared.output;
          const { seed, bundle, accounts } = prepared;
          const native = <A>(work: () => Promise<A>) =>
            Effect.tryPromise({ try: work, catch: decodeWorkflowFailure });
          const execution: WorkflowExecution = {
            runId: seed.runId,
            driver: {
              do: (name, options, work) =>
                native(() =>
                  nativeStep.do(name, options, () =>
                    Effect.runPromise(
                      work().pipe(
                        Effect.catch((error) =>
                          Effect.die(
                            error.retryable
                              ? new Error(workflowFailureMessage(error))
                              : new NonRetryableError(workflowFailureMessage(error)),
                          ),
                        ),
                      ),
                    ),
                  ),
                ).pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(WorkflowValue)),
                  Effect.mapError(decodeWorkflowFailure),
                ),
              sleep: (name, duration) => native(() => nativeStep.sleep(name, duration)),
              sleepUntil: (name, timestamp) => native(() => nativeStep.sleepUntil(name, timestamp)),
            },
            resolve: () =>
              hostRequest(this.env, { operation: "context", run: seed.runId }).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(ResolvedAccounts)),
                Effect.map(
                  (accounts) => ({ accounts: Redacted.make(accounts) }) satisfies HostContext,
                ),
                Effect.mapError(decodeWorkflowFailure),
              ),
            invoke: (input) =>
              hostRequest(this.env, { operation: "invoke", run: seed.runId, ...input }),
          };
          const controls: WorkflowRpc = (input) =>
            Effect.runPromise(
              hostRequest(this.env, {
                operation: "control",
                run: seed.runId,
                command: json(input),
              }),
            );
          const result = yield* invoke(
            this.env,
            {
              app: seed.app,
              build: seed.build,
              bundle,
              accounts,
              command: { operation: "workflow-run", name: seed.name, input: seed.input },
              headers: {},
            },
            lifetime.signal,
            null,
            controls,
            execution,
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(HostResponse)),
            Effect.flatMap((reply): Effect.Effect<Schema.Json, WorkflowFailure> =>
              reply.ok
                ? Schema.decodeUnknownEffect(WorkflowValue)(reply.value).pipe(
                    Effect.mapError(decodeWorkflowFailure),
                  )
                : Effect.fail(decodeWorkflowFailure(reply.error)),
            ),
            Effect.matchCause({
              onSuccess: (output) => ({ ok: true as const, output }),
              onFailure: (cause) => ({
                ok: false as const,
                error: decodeWorkflowFailure(Cause.squash(cause)),
              }),
            }),
          );
          if (!result.ok) {
            if (result.error.reason !== "engine" || !result.error.retryable)
              yield* hostRequest(this.env, {
                operation: "finish",
                run: seed.runId,
                result: { ok: false, error: result.error.reason },
              });
            return yield* result.error;
          }
          yield* hostRequest(this.env, { operation: "finish", run: seed.runId, result });
          return result.output;
        }),
      );
    } finally {
      lifetime.abort();
    }
  }
}

/** Only the authenticated Node host can reach administration or create an RPC session. */
export default {
  async fetch(request: Request, env: Environment, context: ExecutionContext): Promise<Response> {
    if (request.headers.get("authorization") !== `Bearer ${env.AUTH}`)
      return new Response(null, { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === "/rpc")
      return newWorkersRpcResponse(request, new AppApi(env, context), rpcOptions);
    if (url.pathname === "/changes")
      return env.DATA.getByName(url.searchParams.get("app") ?? "").fetch(request);
    const input = Schema.decodeUnknownSync(
      Schema.Struct({
        operation: Schema.Literals(["start", "status", "terminate"]),
        run: Schema.NonEmptyString,
      }),
    )(await request.json());
    try {
      const handle = await env.RUNS.get(input.run);
      let state = await handle.status();
      if (
        input.operation === "terminate" &&
        !["complete", "errored", "terminated"].includes(state.status)
      ) {
        await handle.terminate();
        state = await handle.status();
      }
      return Response.json(state);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("instance.not_found"))
        return Response.json({ error: "engine" }, { status: 503 });
      if (input.operation === "start") {
        try {
          await env.RUNS.create({ id: input.run, params: { run: input.run } });
        } catch {
          // Another request may have created this same retained run meanwhile.
          const retained = await (await env.RUNS.get(input.run)).status();
          if (retained.status === "unknown")
            return Response.json({ error: "engine" }, { status: 503 });
          return Response.json(retained);
        }
        return Response.json({ status: "queued" });
      }
      return Response.json({ status: "missing" });
    }
  },
};
