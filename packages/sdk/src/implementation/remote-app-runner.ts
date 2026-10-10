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
import type { AppCapabilities, AppInvocation, AppRunner } from "./app-runner.ts";
import { invocationBuildLoader } from "./app-runtime.ts";

type Callback = (input: unknown) => Promise<unknown>;

/** One workflow run's capabilities as RPC callbacks. Each returns an encoded `WorkflowRpcResult`. */
export interface RemoteWorkflow {
  readonly runId: string;
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
    Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
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
      load: async () => Schema.encodeSync(encodedBuild)(await capabilities.load()),
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
            driver: {
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

const answer = (effect: Effect.Effect<unknown, unknown>) =>
  effect.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      if (Schema.is(RuntimeProtocolUnsupported)(error))
        return Effect.succeed({ ok: false as const, unsupported: error });
      if (!Schema.is(RuntimeProtocolFailed)(error)) return Effect.succeed({ ok: false as const });
      return Effect.succeed({
        ok: false as const,
        ...(error.reason === undefined ? {} : { reason: error.reason }),
        ...(error.message ? { message: error.message } : {}),
      });
    }),
    Effect.flatMap(Schema.encodeUnknownEffect(RemoteResult)),
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
    answer(
      Effect.scoped(
        Effect.gen(function* () {
          const {
            elicitation: _elicitation,
            workflowControls: _controls,
            ...decoded
          } = yield* Schema.decodeUnknownEffect(encodedInvocation)(invocation);
          const build = yield* Schema.decodeUnknownEffect(BuildId)(decoded.build);
          // The caller's trace context travels in the invocation's headers; the runner's spans join it.
          return yield* Effect.gen(function* () {
            const loader = yield* invocationBuildLoader(decoded, read(build));
            return yield* loader.refused(
              runner.invoke(decoded, yield* localCapabilities(capabilities, loader.load)),
            );
          }).pipe(
            withRemoteSpan(
              new Request("https://app-runner.internal", { headers: decoded.headers }),
              "runtime.app.serve",
            ),
          );
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => releaseCapabilities(capabilities)))),
    ),
  declare: (bundle, headers) =>
    answer(
      Schema.decodeUnknownEffect(encodedBuild)(bundle).pipe(
        Effect.flatMap((bundle) => runner.declare(bundle, headers)),
      ),
    ),
});

const result = <E>(effect: Effect.Effect<string, E>) =>
  effect.pipe(
    Effect.mapError(() => new RuntimeProtocolFailed()),
    Effect.flatMap(Schema.decodeUnknownEffect(RemoteResult)),
    Effect.mapError(() => new RuntimeProtocolFailed()),
    Effect.flatMap(
      (reply): Effect.Effect<unknown, RuntimeProtocolFailed | RuntimeProtocolUnsupported> =>
        reply.ok
          ? Effect.succeed(reply.value)
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
        return yield* result(remote.invoke(encoded, callbacks));
      }),
    ).pipe(Effect.withSpan("runtime.app.remote.invoke")),
  declare: (bundle: LoadedWorkerBuild, headers: Readonly<Record<string, string>>) =>
    Schema.encodeEffect(encodedBuild)(bundle).pipe(
      Effect.mapError(() => new RuntimeProtocolFailed()),
      Effect.flatMap((encoded) => result(remote.declare(encoded, headers))),
      Effect.withSpan("runtime.app.remote.declare"),
    ),
});
