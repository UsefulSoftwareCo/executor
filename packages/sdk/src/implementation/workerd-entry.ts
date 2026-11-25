import { DurableObject, WorkerEntrypoint, WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type {
  DurableObjectId,
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
import { runnerReply } from "./remote-app-runner.ts";
import { allowedPrivateOrigin, credentialFetch, credentialKey } from "./credential-handles.ts";
import {
  defaultAppWorkerLimit,
  defaultAppWorkerIdleSeconds,
  makeAppWorkerResidency,
  type AppWorkerResidency,
} from "./app-worker-residency.ts";
import { isPrivateHostname } from "@executor-js/utils/url-policy";
import { defaultNpmRegistry } from "@executor-js/utils/release-version";
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
import { HostApiCheck } from "../contracts/host-api.ts";
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
import {
  engineFaultCall,
  engineFaultError,
  engineFaultFor,
  engineLateFor,
  type EngineFaultList,
} from "../contracts/engine-faults.ts";
import { nativeEngineFailure } from "./native-engine-failure.ts";

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
  readonly CREDENTIAL_SECRET: string;
  readonly APPS_PRIVATE_FETCH: boolean;
  readonly APPS_PRIVATE_ORIGINS?: ReadonlyArray<string> | null;
  readonly PUBLIC_FETCH: HttpService;
  readonly SELF_ORIGIN: string;
  readonly SELF?: HttpService;
  readonly NPM_REGISTRY: string;
  readonly LOADER: WorkerLoader;
  readonly APP_WORKERS?: number | null;
  readonly APP_WORKER_IDLE_SECONDS?: number | null;
  readonly DATA: {
    getByName(name: string): DataEntrypoint;
    idFromName(name: string): DurableObjectId;
  };
  readonly RUNS: Workflow<{ run: string }>;
  readonly HOST: Fetcher;
  readonly SUPERVISOR_FAULTS?: {
    readonly resetDelayMs?: number;
    readonly resetHoldMs?: number;
    readonly replyDelayMs?: number;
  } | null;
  readonly WORKFLOW_ENGINE_FAULTS?: EngineFaultList | null;
}

const sleep = (ms: number | undefined) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// oxlint-disable-next-line executor/no-module-level-mutable-state -- one token per isolate; it carries no request data
let resetToken: string | undefined;
const supervisorReset = () => (resetToken ??= `Data supervisor reset ${crypto.randomUUID()}`);
const toSupervisor = async <A>(
  env: Environment,
  app: string,
  call: (supervisor: DataEntrypoint) => Promise<A>,
  resent: () => void = () => undefined,
): Promise<A> => {
  try {
    return await call(env.DATA.getByName(app));
  } catch (cause) {
    if (!(cause instanceof Error) || cause.message !== supervisorReset()) throw cause;
    resent();
    return call(env.DATA.getByName(app));
  }
};
const supervisorCall = <A>(
  env: Environment,
  app: string,
  call: (supervisor: DataEntrypoint) => Promise<A>,
) =>
  Effect.suspend(() => {
    let resent = false;
    return Effect.tryPromise({
      try: () =>
        toSupervisor(env, app, call, () => {
          resent = true;
        }),
      catch: (cause) => cause,
    }).pipe(Effect.map((value) => ({ value, resent })));
  });

const nativeSleep = (work: () => Promise<unknown>) =>
  Effect.tryPromise({ try: work, catch: nativeEngineFailure }).pipe(Effect.asVoid);
const failure = () => new WorkflowFailure({ reason: "engine", retryable: true });
const buildFailed = (stage: RuntimeBuildFailed["stage"], cause: unknown) =>
  new RuntimeBuildFailed({ stage, message: describeBuildCause(cause) });
const OutboundProps = Schema.Struct({
  app: Schema.NonEmptyString,
  hostApi: Schema.optionalKey(HostApiCheck),
});
type OutboundProps = typeof OutboundProps.Type;
const credentials = (env: Environment) => credentialKey(env.CREDENTIAL_SECRET);
export class AppOutbound extends WorkerEntrypoint<Environment> {
  async fetch(request: Request): Promise<Response> {
    const self = this.env.SELF === undefined ? undefined : URL.parse(this.env.SELF_ORIGIN)?.origin;
    const props = Schema.decodeUnknownSync(OutboundProps)(this.ctx.props);
    const egress = {
      refusePrivateAddresses: !this.env.APPS_PRIVATE_FETCH,
      selfOrigin: self,
      privateOrigins: this.env.APPS_PRIVATE_ORIGINS ?? [],
    };
    return credentialFetch(request, {
      app: props.app,
      ...(props.hostApi === undefined ? {} : { hostApi: props.hostApi }),
      key: await Effect.runPromise(credentials(this.env)),
      egress,
      send: (request) => {
        const url = new URL(request.url);
        if (this.env.SELF !== undefined && url.origin === self) return this.env.SELF.fetch(request);
        if (this.env.APPS_PRIVATE_FETCH) return fetch(request);
        // external: this fetch can reach every private address, so it must not follow a redirect
        // itself; manual returns each one to the app, whose next hop comes back through this check.
        if (allowedPrivateOrigin(url, egress))
          return fetch(new Request(request, { redirect: "manual" }));
        return this.env.PUBLIC_FETCH.fetch(request);
      },
    });
  }
}
class TarballDestinationRefused extends Error {
  override readonly name = "NetworkRefused";
}
const publicTarballFetch =
  (network: HttpService) =>
  (input: string, init?: RequestInit): Promise<Response> => {
    const url = URL.parse(input);
    if (url === null || isPrivateHostname(url.hostname))
      return Promise.reject(new TarballDestinationRefused());
    return network.fetch(new Request(url, init));
  };
type OutboundLoopback = (options: { readonly props: OutboundProps }) => Fetcher;
const OutboundExports = Schema.Struct({
  AppOutbound: Schema.declare((value): value is OutboundLoopback => typeof value === "function"),
});
const appOutbound =
  (context: { readonly exports: unknown }) =>
  (app: string, hostApi: HostApiCheck | undefined): Fetcher =>
    Schema.decodeUnknownSync(OutboundExports)(context.exports).AppOutbound({
      props: hostApi === undefined ? { app } : { app, hostApi },
    });
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

// oxlint-disable-next-line executor/no-module-level-mutable-state -- one process-wide residency bounds loaded app Workers across requests
let residency: AppWorkerResidency | undefined;
const runner = (env: Environment, context: Pick<ExecutionContext, "waitUntil" | "exports">) =>
  makeAppRunner({
    loader: env.LOADER,
    residency: (residency ??= makeAppWorkerResidency({
      limit: env.APP_WORKERS ?? defaultAppWorkerLimit,
      idleSeconds: env.APP_WORKER_IDLE_SECONDS ?? defaultAppWorkerIdleSeconds,
    })),
    unloadFacet: (app, identity) =>
      Effect.tryPromise({
        try: () => env.DATA.getByName(app).unload(identity),
        catch: (cause) => cause,
      }),
    outbound: appOutbound(context),
    credentialKey: credentials(env),
    data: (app) => ({
      invoke: (input, load, elicit, controls) =>
        Effect.map(
          supervisorCall(env, app, (supervisor) =>
            supervisor.invoke(input, load, elicit, controls),
          ),
          ({ value, resent }) =>
            resent && typeof value === "object" && value !== null
              ? { ...value, resent: true }
              : value,
        ),
      cancel: (id) =>
        Effect.tryPromise({
          try: () => env.DATA.getByName(app).cancel(id),
          catch: (cause) => cause,
        }),
      cache: (namespace, command) =>
        Effect.map(
          supervisorCall(env, app, (supervisor) => supervisor.cache(namespace, command)),
          ({ value }) => value,
        ),
    }),
    waitUntil: (task) => context.waitUntil(task.then(ignore, ignore)),
  });
const ignore = () => undefined;
const encodedJson = Schema.fromJsonString(Schema.Json);

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
    } catch {}
  }
  [Symbol.dispose]() {
    this.#lifetime.abort();
  }
  readRegistry(path: string): Promise<{ readonly status: number; readonly body: string }> {
    return readRegistry(this.#env, path);
  }
  async compile(input: string): Promise<string> {
    return this.#run(
      Effect.gen({ self: this }, function* () {
        const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CompileWorkerApp))(
          input,
        ).pipe(Effect.mapError((cause) => buildFailed("source", cause)));
        const compiled = yield* compileWorkerApp(
          request.files,
          {
            ...(this.#env.NPM_REGISTRY === "" ? {} : { registry: this.#env.NPM_REGISTRY }),
            ...(this.#env.APPS_PRIVATE_FETCH
              ? {}
              : { tarballFetch: publicTarballFetch(this.#env.PUBLIC_FETCH) }),
          },
          request.public ?? [],
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
      runnerReply(
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
          Effect.map((value) => ({ value })),
        ),
      ),
    );
  }
}

export class AppDataSupervisor extends DurableObject<Environment> {
  readonly #supervisor: Promise<Effect.Success<ReturnType<typeof makeFacetSupervisor>>>;
  #received = 0;
  #resetWhenIdle(seen: number) {
    const faults = this.env.SUPERVISOR_FAULTS;
    setTimeout(async () => {
      if (faults?.resetDelayMs !== undefined) await sleep(faults.resetDelayMs);
      if (this.#received !== seen) return;
      if (this.ctx.getWebSockets().length > 0) return;
      if (faults?.resetHoldMs !== undefined)
        await this.ctx.blockConcurrencyWhile(() => sleep(faults.resetHoldMs));
      try {
        this.ctx.abort(supervisorReset());
      } catch {}
    }, 0);
  }
  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    this.#supervisor = Effect.runPromise(
      makeFacetSupervisor(
        ctx,
        env.LOADER,
        appOutbound(ctx),
        (app) => ctx.id.equals(env.DATA.idFromName(app)),
        true,
      ),
    );
  }
  async invoke(
    input: typeof FacetInvocation.Type,
    load: () => Promise<typeof FacetBundle.Type>,
    elicit: Callback | null,
    controls: Callback | null,
  ) {
    this.#received += 1;
    const result = Effect.runPromise(
      (await this.#supervisor).invoke(input, load, elicit, controls),
    );
    this.ctx.waitUntil(
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    const delay = this.env.SUPERVISOR_FAULTS?.replyDelayMs;
    if (delay === undefined) return result;
    const value = await result;
    await sleep(delay);
    return value;
  }
  async cache(namespace: string, command: unknown) {
    this.#received += 1;
    return Effect.runPromise((await this.#supervisor).cache(namespace, command));
  }
  async evaluated(command: unknown) {
    this.#received += 1;
    return Effect.runPromise((await this.#supervisor).evaluated(command));
  }
  async cancel(id: string) {
    this.#received += 1;
    return Effect.runPromise((await this.#supervisor).cancel(id));
  }
  async unload(identity: string) {
    const seen = this.#received;
    const unloaded = await Effect.runPromise((await this.#supervisor).unload(identity));
    if (unloaded) this.#resetWhenIdle(seen);
    return unloaded;
  }
  async alarm() {
    this.#received += 1;
    return Effect.runPromise((await this.#supervisor).recover);
  }
  async fetch(): Promise<Response> {
    this.#received += 1;
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
          const faults = this.env.WORKFLOW_ENGINE_FAULTS;
          const sleepCall = (name: string, call: () => Promise<unknown>) => {
            const late = engineLateFor(faults, seed.runId, name);
            const work =
              late === undefined
                ? call
                : () => new Promise((settle) => setTimeout(settle, late)).then(call);
            const fault = engineFaultFor(faults, seed.runId, name);
            return nativeSleep(fault === undefined ? work : () => engineFaultCall(fault, work));
          };
          const execution: WorkflowExecution = {
            runId: seed.runId,
            driver: {
              do: (name, options, work) => {
                const fault = engineFaultFor(faults, seed.runId, name);
                if (fault?.when === "before")
                  return Effect.fail(nativeEngineFailure(engineFaultError(fault)));
                const call = native(() =>
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
                );
                return fault === undefined
                  ? call
                  : call.pipe(
                      Effect.flatMap(() =>
                        Effect.fail(nativeEngineFailure(engineFaultError(fault))),
                      ),
                    );
              },
              sleep: (name, duration) => sleepCall(name, () => nativeStep.sleep(name, duration)),
              sleepUntil: (name, timestamp) =>
                sleepCall(name, () => nativeStep.sleepUntil(name, timestamp)),
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
                ...(seed.hostApi === undefined ? {} : { hostApi: seed.hostApi }),
                database: false,
                accounts,
                command: { operation: "workflow-run", name: seed.name, input: seed.input },
                headers: {},
              },
              {
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
            const recorded =
              result.error.reason !== "engine" ||
              !result.error.retryable ||
              (detail !== undefined &&
                (yield* Effect.tryPromise(async () =>
                  (await this.env.RUNS.get(seed.runId)).status(),
                ).pipe(
                  Effect.map((state) => state.status === "running" || state.status === "waiting"),
                  Effect.orElseSucceed(() => false),
                )));
            if (recorded)
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

const readRegistry = async (
  env: Environment,
  path: string,
): Promise<{ readonly status: number; readonly body: string }> => {
  if (!path.startsWith("/") || path.startsWith("//")) return { status: 400, body: "" };
  const registry = (env.NPM_REGISTRY === "" ? defaultNpmRegistry : env.NPM_REGISTRY).replace(
    /\/+$/u,
    "",
  );
  try {
    const answer = await fetch(`${registry}${path}`, { redirect: "manual" });
    return { status: answer.status, body: await answer.text() };
  } catch {
    return { status: 502, body: "" };
  }
};

export default {
  async fetch(request: Request, env: Environment, context: ExecutionContext): Promise<Response> {
    if (request.headers.get("authorization") !== `Bearer ${env.AUTH}`)
      return new Response(null, { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === "/rpc")
      return newWorkersRpcResponse(request, new AppApi(env, context), rpcOptions);
    if (url.pathname === "/changes")
      return toSupervisor(env, url.searchParams.get("app") ?? "", (supervisor) =>
        supervisor.fetch(request),
      );
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
