/**
 * The app runner behind a Workers RPC boundary. A host whose own Worker cannot run app code calls
 * the runner in another Worker: the invocation and results cross as JSON, and the invocation's
 * capabilities cross as RPC callbacks. Effect-based workflow capabilities become callbacks that
 * return encoded `WorkflowRpcResult`s, and are rebuilt on the runner's side. The invocation names
 * its build, and the runner's Worker reads it from its own store.
 */
import { Cause, Effect, Redacted, Schema } from "effect";
import { withRemoteSpan } from "@executor-js/telemetry";
import {
  HostAccounts,
  WorkflowInput,
  WorkflowInputCommand,
  WorkflowDuration,
  WorkflowFailure,
  WorkflowRpcResult,
  WorkflowRunId,
  WorkflowStepOptions,
  type WorkflowExecution,
} from "apps/contracts";
import {
  RuntimeFailure,
  RuntimeProtocolFailed,
  RuntimeProtocolUnsupported,
  type RuntimeBuildUnavailable,
} from "../contracts/runtime.ts";
import { BuildId } from "../contracts/shared.ts";
import { LoadedWorkerBuild } from "../contracts/worker-build.ts";
import { WorkerInvocation } from "../contracts/workerd-host.ts";
import {
  classify,
  failedFrom,
  RunnerIngress,
  runnerIngress,
  type AppCapabilities,
  type AppInvocation,
  type AppRunner,
} from "./app-runner.ts";
import { invocationBuildLoader } from "./app-runtime.ts";
import { asciiJson } from "./ascii-json.ts";

type Callback = (input: unknown) => Promise<unknown>;

/** One workflow run's capabilities as RPC callbacks. Each returns an encoded `WorkflowRpcResult`. */
export interface RemoteWorkflow {
  readonly runId: string;
  input?(command: unknown): Promise<unknown>;
  waitForInput?(name: string, id: string, expiresAt: number): Promise<unknown>;
  do(name: string, options: unknown, run: () => Promise<unknown>): Promise<unknown>;
  sleep(name: string, duration: unknown): Promise<unknown>;
  sleepUntil(name: string, timestamp: number): Promise<unknown>;
  /** The run's current accounts, resolved by the host. */
  context(): Promise<unknown>;
  invoke(input: unknown): Promise<unknown>;
}

/** An invocation's capabilities as RPC callbacks; see {@link AppCapabilities}. */
export interface RemoteCapabilities {
  /**
   * The invocation's encoded build. Runners that read builds by ID never call it; callers still
   * send it so that an older runner, which reads builds only through it, keeps working during a
   * rollout or rollback. A later release stops sending it.
   */
  readonly load?: () => Promise<string>;
  readonly elicit: Callback | null;
  readonly controls: Callback | null;
  readonly workflow: RemoteWorkflow | null;
}

/** What the runner's Worker serves. Arguments and results other than callbacks are JSON. */
export type RemoteAppRunner<Result> = {
  readonly invoke: (invocation: string, capabilities: RemoteCapabilities) => Result;
  readonly declare: (bundle: string, headers: Readonly<Record<string, string>>) => Result;
};

const RemoteResult = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      ok: Schema.Literal(true),
      value: Schema.Json,
      /**
       * The host API revision the runner bound the call's cache and network to. A runner from
       * before that check sends none, and its caller refuses the result; see `remoteAppRunner`.
       */
      hostApi: Schema.optionalKey(Schema.NonEmptyString),
    }),
    Schema.Struct({
      ok: Schema.Literal(false),
      reason: Schema.optionalKey(RuntimeFailure),
      /** Only a declaration failure's text, for the deployer. */
      message: Schema.optionalKey(Schema.String),
      /** The build's protocol is one this runner does not run; only its load finds that out. */
      unsupported: Schema.optionalKey(RuntimeProtocolUnsupported),
    }),
  ]),
);
const encodedInvocation = Schema.fromJsonString(WorkerInvocation);
const encodedBuild = Schema.fromJsonString(LoadedWorkerBuild);
/**
 * A build's code as one string for a runner, written in ASCII: a single non-ASCII character in any
 * module would otherwise store the whole text, a large app's source included, at two bytes per
 * character on both sides of the call. It decodes to the same modules.
 */
export const encodeLoadedBuild = (build: LoadedWorkerBuild) =>
  asciiJson(Schema.encodeSync(encodedBuild)(build));
const engine = () => new WorkflowFailure({ reason: "engine", retryable: true });

/** Release a callback stub once the invocation is done with it, rather than at garbage collection. */
const release = (value: unknown) => {
  if (
    (typeof value === "function" || (typeof value === "object" && value !== null)) &&
    Symbol.dispose in value
  ) {
    const dispose = value[Symbol.dispose];
    if (typeof dispose === "function") dispose.call(value);
  }
};
const releaseCapabilities = (remote: RemoteCapabilities) => {
  release(remote.load);
  release(remote.elicit);
  release(remote.controls);
  if (remote.workflow !== null)
    for (const callback of [
      remote.workflow.do,
      remote.workflow.sleep,
      remote.workflow.sleepUntil,
      remote.workflow.context,
      remote.workflow.invoke,
      remote.workflow.input,
      remote.workflow.waitForInput,
    ])
      release(callback);
};

/** Encode a workflow capability's outcome; any failure that is not a WorkflowFailure is engine's. */
const reply = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.matchCause({
      onSuccess: (value) => ({ ok: true as const, value }),
      onFailure: (cause) => {
        const error = Cause.squash(cause);
        return { ok: false as const, error: Schema.is(WorkflowFailure)(error) ? error : engine() };
      },
    }),
    Effect.flatMap(Schema.encodeUnknownEffect(WorkflowRpcResult)),
  );

/** Read an encoded `WorkflowRpcResult` back into the workflow's own outcome. */
const settle = (call: () => Promise<unknown>) =>
  // An RPC result is a pipelining proxy, not a Promise; await it into one before Effect reads it.
  Effect.tryPromise({ try: async () => await call(), catch: engine }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WorkflowRpcResult)),
    Effect.mapError((error) => (Schema.is(WorkflowFailure)(error) ? error : engine())),
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.value) : Effect.fail(result.error),
    ),
  );

/** The caller's side: callbacks over this invocation's capabilities, released with `signal`. */
export const remoteCapabilities = (capabilities: AppCapabilities, signal: AbortSignal) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
    const run = <A>(effect: Effect.Effect<A, unknown>) =>
      Effect.runPromiseWith(services)(reply(effect), { signal });
    const execution = capabilities.workflow;
    const workflow: RemoteWorkflow | null =
      execution === undefined
        ? null
        : {
            runId: execution.runId,
            input: (command) =>
              run(
                Schema.decodeUnknownEffect(WorkflowInputCommand)(command).pipe(
                  Effect.flatMap((command) =>
                    execution.input === undefined
                      ? Effect.fail(engine())
                      : execution.input(command),
                  ),
                  Effect.flatMap(Schema.encodeEffect(WorkflowInput)),
                ),
              ),
            waitForInput: (name, id, expiresAt) =>
              run(
                execution.driver.waitForInput === undefined
                  ? Effect.fail(engine())
                  : execution.driver.waitForInput(name, id, expiresAt).pipe(Effect.as(null)),
              ),
            do: (name, options, body) =>
              run(
                Schema.decodeUnknownEffect(WorkflowStepOptions)(options).pipe(
                  Effect.flatMap((options) =>
                    execution.driver.do(name, options, () => settle(body)),
                  ),
                  Effect.ensuring(Effect.sync(() => release(body))),
                ),
              ),
            sleep: (name, duration) =>
              run(
                Schema.decodeUnknownEffect(WorkflowDuration)(duration).pipe(
                  Effect.flatMap((duration) => execution.driver.sleep(name, duration)),
                  Effect.as(null),
                ),
              ),
            sleepUntil: (name, timestamp) =>
              run(execution.driver.sleepUntil(name, timestamp).pipe(Effect.as(null))),
            context: () =>
              run(
                execution.resolve().pipe(Effect.map((context) => Redacted.value(context.accounts))),
              ),
            invoke: (input) =>
              run(
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    kind: Schema.Literals(["query", "mutation"]),
                    name: Schema.String,
                    input: Schema.Json,
                    stepId: Schema.String,
                    timeout: Schema.Number,
                  }),
                )(input).pipe(Effect.flatMap(execution.invoke)),
              ),
          };
    return {
      load: async () => encodeLoadedBuild(await capabilities.load()),
      elicit: capabilities.elicit,
      controls: capabilities.controls,
      workflow,
    } satisfies RemoteCapabilities;
  });

/** The runner's side: the invocation's capabilities over the caller's callbacks and its build. */
const localCapabilities = (remote: RemoteCapabilities, load: () => Promise<LoadedWorkerBuild>) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
    const workflow = remote.workflow;
    const execution: WorkflowExecution | undefined =
      workflow === null
        ? undefined
        : {
            runId: yield* Schema.decodeUnknownEffect(WorkflowRunId)(workflow.runId),
            input: (command) =>
              workflow.input === undefined
                ? Effect.fail(engine())
                : settle(() => workflow.input!(command)).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(WorkflowInput)),
                    Effect.mapError(engine),
                  ),
            driver: {
              waitForInput: (name, id, expiresAt) =>
                workflow.waitForInput === undefined
                  ? Effect.fail(engine())
                  : settle(() => workflow.waitForInput!(name, id, expiresAt)).pipe(Effect.asVoid),
              do: (name, options, run) =>
                settle(() =>
                  workflow.do(name, Schema.encodeSync(WorkflowStepOptions)(options), () =>
                    Effect.runPromiseWith(services)(reply(run())),
                  ),
                ),
              sleep: (name, duration) =>
                settle(() =>
                  workflow.sleep(name, Schema.encodeSync(WorkflowDuration)(duration)),
                ).pipe(Effect.asVoid),
              sleepUntil: (name, timestamp) =>
                settle(() => workflow.sleepUntil(name, timestamp)).pipe(Effect.asVoid),
            },
            resolve: () =>
              settle(() => workflow.context()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(HostAccounts)),
                Effect.mapError(engine),
                Effect.map((accounts) => ({ accounts: Redacted.make(accounts) })),
              ),
            invoke: (input) => settle(() => workflow.invoke(input)),
          };
    return {
      load,
      elicit: remote.elicit,
      controls: remote.controls,
      ...(execution === undefined ? {} : { workflow: execution }),
    } satisfies AppCapabilities;
  });

/**
 * A failure the caller can name. Anything that is not already a runtime failure is classified here,
 * where its text is: past the boundary the caller would see only that the call failed.
 */
const refused = (error: unknown) =>
  Schema.is(RuntimeProtocolUnsupported)(error)
    ? { ok: false as const, unsupported: error }
    : Schema.is(RuntimeProtocolFailed)(error)
      ? {
          ok: false as const,
          ...(error.reason === undefined ? {} : { reason: error.reason }),
          ...(error.message ? { message: error.message } : {}),
        }
      : { ok: false as const, reason: classify(error) };
const encodeResult = Schema.encodeUnknownEffect(RemoteResult);

/**
 * The runner's reply as JSON: its value, or the failure it can name. A rejected RPC loses an error's
 * fields, and Cap'n Web replaces its text, so a failure crosses inside the reply instead. `hostApi`
 * is the revision the runner bound the call to; see `RemoteResult`.
 */
export const runnerReply = (
  effect: Effect.Effect<{ readonly value: unknown; readonly hostApi?: string }, unknown>,
) =>
  effect.pipe(
    Effect.map((result) => ({ ok: true as const, ...result })),
    Effect.catchCause((cause) => Effect.succeed(refused(Cause.squash(cause)))),
    Effect.flatMap((result) =>
      encodeResult(result).pipe(
        // A value that is not JSON cannot cross; say so instead of failing the RPC without a reason.
        Effect.catch(() => encodeResult({ ok: false, reason: "invalid-reply" })),
      ),
    ),
    Effect.orDie,
  );

/**
 * Serve the runner's Worker side of the boundary. `read` loads a build from this Worker's own
 * store, so a build never crosses the boundary from the caller.
 */
export const serveAppRunner = (
  runner: AppRunner,
  read: (build: BuildId) => Effect.Effect<LoadedWorkerBuild, RuntimeBuildUnavailable>,
): RemoteAppRunner<Effect.Effect<string>> => ({
  invoke: (invocation, capabilities) =>
    runnerReply(
      Effect.scoped(
        Effect.gen(function* () {
          // The runner's part starts here, so decoding the call and reading its build count too.
          const ingress = yield* runnerIngress;
          const {
            elicitation: _elicitation,
            workflowControls: _controls,
            ...decoded
          } = yield* Schema.decodeUnknownEffect(encodedInvocation)(invocation);
          const build = yield* Schema.decodeUnknownEffect(BuildId)(decoded.build);
          // The caller's trace context travels in the invocation's headers; the runner's spans join it.
          return yield* Effect.gen(function* () {
            const loader = yield* invocationBuildLoader(decoded, read(build));
            const value = yield* loader.refused(
              runner.invoke(decoded, yield* localCapabilities(capabilities, loader.load)),
            );
            return decoded.hostApi === undefined
              ? { value }
              : { value, hostApi: decoded.hostApi.revision };
          }).pipe(
            Effect.provideService(RunnerIngress, ingress),
            withRemoteSpan(
              new Request("https://app-runner.internal", { headers: decoded.headers }),
              "runtime.app.serve",
            ),
          );
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => releaseCapabilities(capabilities)))),
    ),
  declare: (bundle, headers) =>
    runnerReply(
      Schema.decodeUnknownEffect(encodedBuild)(bundle).pipe(
        Effect.flatMap((bundle) => runner.declare(bundle, headers)),
        Effect.map((value) => ({ value })),
      ),
    ),
});

/**
 * Decode a runner's reply: its value, or the runtime failure it names. A call bound to a host API
 * revision (`hostApi`) succeeds only when the runner says it bound the call's cache and network to
 * that revision: a runner deployed before that check ignores it, and would fill the revision's
 * cache with whichever document it read.
 */
export const runnerResult = <E>(effect: Effect.Effect<string, E>, hostApi?: string) =>
  effect.pipe(
    // A rejected RPC carries the platform's text, such as a size or memory limit, only here.
    Effect.catch(failedFrom(false)),
    Effect.flatMap((reply) =>
      Schema.decodeUnknownEffect(RemoteResult)(reply).pipe(
        Effect.catch(() => Effect.fail(new RuntimeProtocolFailed({ reason: "invalid-reply" }))),
      ),
    ),
    Effect.flatMap(
      (reply): Effect.Effect<unknown, RuntimeProtocolFailed | RuntimeProtocolUnsupported> =>
        reply.ok
          ? hostApi === undefined || reply.hostApi === hostApi
            ? Effect.succeed(reply.value)
            : Effect.fail(new RuntimeProtocolFailed({ reason: "unsupported" }))
          : reply.unsupported !== undefined
            ? Effect.fail(reply.unsupported)
            : Effect.fail(
                new RuntimeProtocolFailed({
                  ...(reply.reason === undefined ? {} : { reason: reply.reason }),
                  ...(reply.message === undefined ? {} : { message: reply.message }),
                }),
              ),
    ),
  );

/** The caller's side: the runner's operations over the runner Worker's service. */
export const remoteAppRunner = <E>(remote: RemoteAppRunner<Effect.Effect<string, E>>) => ({
  invoke: (invocation: AppInvocation, capabilities: AppCapabilities) =>
    Effect.scoped(
      Effect.gen(function* () {
        const lifetime = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) => Effect.sync(() => controller.abort()),
        );
        const encoded = yield* Schema.encodeEffect(encodedInvocation)({
          ...invocation,
          elicitation: capabilities.elicit !== null,
          workflowControls: capabilities.controls !== null,
        }).pipe(Effect.mapError(() => new RuntimeProtocolFailed()));
        const callbacks = yield* remoteCapabilities(capabilities, lifetime.signal);
        return yield* runnerResult(remote.invoke(encoded, callbacks), invocation.hostApi?.revision);
      }),
    ).pipe(
      Effect.withSpan("runtime.app.remote.invoke", {
        attributes: { "executor.app.id": invocation.app },
      }),
    ),
  declare: (bundle: LoadedWorkerBuild, headers: Readonly<Record<string, string>>) =>
    Effect.try({
      try: () => encodeLoadedBuild(bundle),
      catch: () => new RuntimeProtocolFailed(),
    }).pipe(
      Effect.flatMap((encoded) => runnerResult(remote.declare(encoded, headers))),
      Effect.withSpan("runtime.app.remote.declare"),
    ),
});
