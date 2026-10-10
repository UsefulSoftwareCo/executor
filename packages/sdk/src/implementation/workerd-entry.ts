/** Trusted workerd host. App modules get isolated Workers/facets, never this environment. */
import { DurableObject, WorkerEntrypoint, WorkflowEntrypoint } from "cloudflare:workers";
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
  HostRequirementsError,
  HostResponse,
  HostAccounts,
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
  makeFacetSupervisor,
  FacetInvocation,
  type FacetBundle,
} from "@executor-js/app-data/cloudflare";
import { EvaluatedCommandJson, EvaluatedReplyJson } from "@executor-js/app-data/evaluated";
import { makeAppRunner } from "./app-runner.ts";
import { credentialFetch, credentialKey } from "./credential-handles.ts";
import {
  defaultAppWorkerLimit,
  defaultAppWorkerIdleSeconds,
  makeAppWorkerResidency,
  type AppWorkerResidency,
} from "./app-worker-residency.ts";
import { compileWorkerApp } from "../workerd-build.ts";
import { assembleWorkerBundle } from "./worker-build-storage.ts";
import { declarationFailed } from "./worker-source-map.ts";
import {
  CompileWorkerApp,
  CompileWorkerResult,
  PreparedWorkflow,
  WorkerInvocation,
  type AppHostCallbacks,
  type WorkflowHostCommand,
} from "../contracts/workerd-host.ts";
import { LoadedWorkerBuild } from "../contracts/worker-build.ts";
import {
  describeBuildCause,
  RuntimeAppsDependencyMissing,
  RuntimeBuildFailed,
  RuntimeProtocolUnsupported,
} from "../contracts/runtime.ts";
import {
  decodeWorkflowFailure,
  workflowFailureDetail,
  workflowFailureMessage,
} from "../contracts/workflow-errors.ts";

declare const WebSocketPair: { new (): { 0: NativeWebSocket; 1: NativeWebSocket } };

type Callback = (input: unknown) => Promise<unknown>;
interface DataEntrypoint {
  cache(namespace: string, command: unknown): Promise<unknown>;
  evaluated(command: unknown): Promise<unknown>;
  invoke(
    input: typeof FacetInvocation.Type,
    load: () => Promise<typeof FacetBundle.Type>,
    elicit: Callback | null,
    controls: Callback | null,
  ): Promise<unknown>;
  cancel(id: string): Promise<void>;
  unload(identity: string): Promise<boolean>;
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
interface HttpService {
  fetch(request: Request): Promise<Response>;
}
interface Environment {
  readonly AUTH: string;
  /**
   * The secret credential handles are sealed with, derived from the instance's encryption key so
   * it is the same after a restart and never a value anyone else knows. Only this host's runner
   * and outbound read it; app code never does.
   */
  readonly CREDENTIAL_SECRET: string;
  /** Host decision, not an app capability: apps never see or change this binding. */
  readonly APPS_PRIVATE_FETCH: boolean;
  /** workerd network service that refuses private, loopback and link-local destinations. */
  readonly PUBLIC_FETCH: HttpService;
  /** This instance's own dashboard origin, or empty when the host serves none. */
  readonly SELF_ORIGIN: string;
  /** Reaches the product that serves `SELF_ORIGIN` without the network. */
  readonly SELF?: HttpService;
  /** The npm registry builds resolve packages from, or empty for the public registry. */
  readonly NPM_REGISTRY: string;
  readonly LOADER: WorkerLoader;
  /** Most app Workers this process keeps loaded, or null for the default. */
  readonly APP_WORKERS?: number | null;
  /** Seconds an idle app Worker stays loaded, zero for no idle unloading, or null for the default. */
  readonly APP_WORKER_IDLE_SECONDS?: number | null;
  readonly DATA: { getByName(name: string): DataEntrypoint };
  readonly RUNS: Workflow<{ run: string }>;
  readonly HOST: Fetcher;
}
const failure = () => new WorkflowFailure({ reason: "engine", retryable: true });
/** The deployer sees the underlying failure; builds bind no accounts. */
const buildFailed = (stage: RuntimeBuildFailed["stage"], cause: unknown) =>
  new RuntimeBuildFailed({ stage, message: describeBuildCause(cause) });
/** What the runner binds to one app's outbound network. App code cannot set it. */
const OutboundProps = Schema.Struct({ app: Schema.NonEmptyString });
type OutboundProps = typeof OutboundProps.Type;
/** Handles are sealed with a key derived from the secret only this host and its runner share. */
const credentials = (env: Environment) => credentialKey(env.CREDENTIAL_SECRET);
/**
 * Every app isolate's global `fetch`, bound to its app. It substitutes the credential handles the
 * request carries when its target is allowed; see credential-handles.ts.
 *
 * `global_fetch_strictly_public` cannot do this here: it routes global fetch through workerd's
 * `internet` service, which this runtime configures to allow private addresses. Requests for this
 * instance's own dashboard origin go to the product through a service binding, so the bundled
 * Executor app works when that origin resolves to a private address. Everything else uses the
 * public-only network service unless the operator allows private fetch. Redirects return to the
 * isolate, which sends each hop back here.
 */
export class AppOutbound extends WorkerEntrypoint<Environment> {
  async fetch(request: Request): Promise<Response> {
    const self = this.env.SELF === undefined ? undefined : URL.parse(this.env.SELF_ORIGIN)?.origin;
    return credentialFetch(request, {
      app: Schema.decodeUnknownSync(OutboundProps)(this.ctx.props).app,
      key: await Effect.runPromise(credentials(this.env)),
      // Refuse a private destination by name, before the public-only network refuses its
      // address with an error app code cannot tell apart from any other connection failure.
      egress: { refusePrivateAddresses: !this.env.APPS_PRIVATE_FETCH, selfOrigin: self },
      send: (request) => {
        if (this.env.SELF !== undefined && new URL(request.url).origin === self)
          return this.env.SELF.fetch(request);
        return this.env.APPS_PRIVATE_FETCH ? fetch(request) : this.env.PUBLIC_FETCH.fetch(request);
      },
    });
  }
}
type OutboundLoopback = (options: { readonly props: OutboundProps }) => Fetcher;
const OutboundExports = Schema.Struct({
  AppOutbound: Schema.declare((value): value is OutboundLoopback => typeof value === "function"),
});
/** The loopback binding to `AppOutbound` that workerd supplies on every context's exports. */
const appOutbound =
  (context: { readonly exports: unknown }) =>
  (app: string): Fetcher =>
    Schema.decodeUnknownSync(OutboundExports)(context.exports).AppOutbound({ props: { app } });
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

/**
 * workerd keeps this isolate, and every app Worker it loads, for the life of the process. One
 * residency, shared by every request, bounds how many app Workers stay loaded.
 */
// oxlint-disable-next-line executor/no-module-level-mutable-state -- one process-wide residency bounds loaded app Workers across requests
let residency: AppWorkerResidency | undefined;
/** The shared runner over this Worker's loader, data supervisors and outbound network. */
const runner = (env: Environment, context: Pick<ExecutionContext, "waitUntil" | "exports">) =>
  makeAppRunner({
    loader: env.LOADER,
    residency: (residency ??= makeAppWorkerResidency({
      limit: env.APP_WORKERS ?? defaultAppWorkerLimit,
      idleSeconds: env.APP_WORKER_IDLE_SECONDS ?? defaultAppWorkerIdleSeconds,
    })),
    // A later call's trim runs this, so the stub is made then, in that call's request.
    unloadFacet: (app, identity) =>
      Effect.tryPromise({
        try: () => env.DATA.getByName(app).unload(identity),
        catch: (cause) => cause,
      }),
    outbound: appOutbound(context),
    credentialKey: credentials(env),
    data: (app) => {
      const target = env.DATA.getByName(app);
      return {
        invoke: (input, load, elicit, controls) =>
          Effect.tryPromise({
            try: () => target.invoke(input, load, elicit, controls),
            catch: (cause) => cause,
          }),
        cancel: (id) =>
          Effect.tryPromise({ try: () => target.cancel(id), catch: (cause) => cause }),
        cache: (namespace, command) =>
          Effect.tryPromise({
            try: () => target.cache(namespace, command),
            catch: (cause) => cause,
          }),
      };
    },
    waitUntil: (task) => context.waitUntil(task.then(ignore, ignore)),
  });
const ignore = () => undefined;
const encodedJson = Schema.fromJsonString(Schema.Json);

/** Each WebSocket session owns its invocation lifetime and host capabilities. */
class AppApi extends RpcTarget {
  readonly #env: Environment;
  readonly #lifetime = new AbortController();
  readonly #context: Pick<ExecutionContext, "waitUntil" | "exports">;
  #active: Promise<unknown> | undefined;
  constructor(env: Environment, context: Pick<ExecutionContext, "waitUntil" | "exports">) {
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
        const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CompileWorkerApp))(
          input,
        ).pipe(Effect.mapError((cause) => buildFailed("source", cause)));
        const compiled = yield* compileWorkerApp(
          request.files,
          this.#env.NPM_REGISTRY === "" ? {} : { registry: this.#env.NPM_REGISTRY },
        );
        const { bundle, framework, ui, sourceMap } = compiled;
        const requirements = yield* runner(this.#env, this.#context)
          .declare({ ...assembleWorkerBundle(bundle, framework), protocol: compiled.protocol }, {})
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(HostResponse)),
            Effect.flatMap((envelope) =>
              envelope.ok
                ? Schema.decodeUnknownEffect(DeclaredRequirements)(envelope.value)
                : Schema.decodeUnknownEffect(HostRequirementsError)(envelope.error).pipe(
                    Effect.flatMap(Effect.fail),
                  ),
            ),
            Effect.mapError((cause) =>
              declarationFailed(cause, {
                mainModule: bundle.mainModule,
                sourceMap,
                files: request.files,
              }),
            ),
          );
        return {
          ok: true as const,
          value: {
            bundle,
            framework,
            protocol: compiled.protocol,
            requirements: json(yield* Schema.encodeEffect(DeclaredRequirements)(requirements)),
            ...(ui === undefined ? {} : { ui }),
          },
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            error:
              Schema.is(RuntimeBuildFailed)(error) ||
              Schema.is(RuntimeProtocolUnsupported)(error) ||
              Schema.is(RuntimeAppsDependencyMissing)(error)
                ? error
                : buildFailed("compile", error),
          }),
        ),
        Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(CompileWorkerResult))),
      ),
    );
  }
  async invoke(value: string, callbacks: RpcStub<AppHostCallbacks>): Promise<string> {
    return this.#run(
      Schema.decodeUnknownEffect(Schema.fromJsonString(WorkerInvocation))(value).pipe(
        Effect.flatMap(({ elicitation, workflowControls, ...invocation }) =>
          runner(this.#env, this.#context).invoke(invocation, {
            load: async () =>
              Schema.decodeUnknownSync(Schema.fromJsonString(LoadedWorkerBuild))(
                await callbacks.load(),
              ),
            elicit: elicitation
              ? async (input) =>
                  Schema.decodeUnknownSync(encodedJson)(
                    await callbacks.elicit(JSON.stringify(input)),
                  )
              : null,
            controls: workflowControls
              ? async (input) =>
                  Schema.decodeUnknownSync(encodedJson)(
                    await callbacks.control(JSON.stringify(input)),
                  )
              : null,
          }),
        ),
        Effect.flatMap(Schema.encodeUnknownEffect(encodedJson)),
      ),
    );
  }
}

/** Native app data stays in isolated facets and retains its database across code updates. */
export class AppDataSupervisor extends DurableObject<Environment> {
  readonly #supervisor: Promise<Effect.Success<ReturnType<typeof makeFacetSupervisor>>>;
  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    this.#supervisor = Effect.runPromise(
      makeFacetSupervisor(ctx, env.LOADER, appOutbound(ctx), true),
    );
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
  async cache(namespace: string, command: unknown) {
    return Effect.runPromise((await this.#supervisor).cache(namespace, command));
  }
  async evaluated(command: unknown) {
    return Effect.runPromise((await this.#supervisor).evaluated(command));
  }
  async cancel(id: string) {
    return Effect.runPromise((await this.#supervisor).cancel(id));
  }
  async unload(identity: string) {
    return Effect.runPromise((await this.#supervisor).unload(identity));
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
          const { seed, accounts } = prepared;
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
                Effect.flatMap(Schema.decodeUnknownEffect(HostAccounts)),
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
          const result = yield* runner(this.env, this.ctx)
            .invoke(
              {
                app: seed.app,
                build: seed.build,
                database: false,
                accounts,
                command: { operation: "workflow-run", name: seed.name, input: seed.input },
                headers: {},
              },
              {
                // Only a cold start of the run's Worker reads its build from the product.
                load: () =>
                  Effect.runPromise(
                    hostRequest(this.env, { operation: "load", run: seed.runId }).pipe(
                      Effect.flatMap(Schema.decodeUnknownEffect(LoadedWorkerBuild)),
                    ),
                  ),
                elicit: null,
                controls,
                workflow: execution,
              },
            )
            .pipe(
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
            const detail = workflowFailureDetail(result.error);
            if (result.error.reason !== "engine" || !result.error.retryable)
              yield* hostRequest(this.env, {
                operation: "finish",
                run: seed.runId,
                result: {
                  ok: false,
                  error: result.error.reason,
                  ...(detail === undefined ? {} : { detail }),
                },
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
    // Evaluated results the host keeps in the app's supervisor, beside its app cache.
    if (url.pathname === "/evaluated") {
      const command = Schema.decodeUnknownOption(EvaluatedCommandJson)(await request.text());
      if (command._tag === "None") return new Response(null, { status: 400 });
      const reply = await env.DATA.getByName(url.searchParams.get("app") ?? "").evaluated(
        command.value,
      );
      return new Response(Schema.encodeUnknownSync(EvaluatedReplyJson)(reply), {
        headers: { "content-type": "application/json" },
      });
    }
    const input = Schema.decodeUnknownSync(
      Schema.Struct({
        operation: Schema.Literals(["start", "status", "terminate"]),
        run: Schema.NonEmptyString,
      }),
    )(await request.json());
    try {
      const handle = await env.RUNS.get(input.run);
      let state = await handle.status();
      const finished = () => ["complete", "errored", "terminated"].includes(state.status);
      if (input.operation === "terminate" && !finished()) {
        try {
          await handle.terminate();
        } catch (error) {
          // The run can finish after the status read; terminating a finished instance fails.
          state = await handle.status();
          if (!finished()) throw error;
        }
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
