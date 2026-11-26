import { Cause, Data, Effect, Redacted, Schema } from "effect";
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
import { engineCallFailure } from "../contracts/workflow-errors.ts";
import { errorClassOf } from "./runtime-hop.ts";

type Callback = (input: unknown) => Promise<unknown>;

export interface RemoteWorkflow {
  readonly runId: string;
  input?(command: unknown): Promise<unknown>;
  waitForInput?(name: string, id: string, expiresAt: number): Promise<unknown>;
  do(name: string, options: unknown, run: () => Promise<unknown>): Promise<unknown>;
  sleep(name: string, duration: unknown): Promise<unknown>;
  sleepUntil(name: string, timestamp: number): Promise<unknown>;
  context(): Promise<unknown>;
  invoke(input: unknown): Promise<unknown>;
}

export interface RemoteCapabilities {
  readonly load?: () => Promise<string>;
  readonly elicit: Callback | null;
  readonly controls: Callback | null;
  readonly workflow: RemoteWorkflow | null;
}

export type RemoteAppRunner<Result> = {
  readonly invoke: (invocation: string, capabilities: RemoteCapabilities) => Result;
  readonly declare: (bundle: string, headers: Readonly<Record<string, string>>) => Result;
};

const RemoteResult = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      ok: Schema.Literal(true),
      value: Schema.Json,
      hostApi: Schema.optionalKey(Schema.NonEmptyString),
    }),
    Schema.Struct({
      ok: Schema.Literal(false),
      reason: Schema.optionalKey(RuntimeFailure),
      message: Schema.optionalKey(Schema.String),
      unsupported: Schema.optionalKey(RuntimeProtocolUnsupported),
    }),
  ]),
);
const encodedInvocation = Schema.fromJsonString(WorkerInvocation);
const encodedBuild = Schema.fromJsonString(LoadedWorkerBuild);
export const encodeLoadedBuild = (build: LoadedWorkerBuild) =>
  asciiJson(Schema.encodeSync(encodedBuild)(build));
const engine = () => new WorkflowFailure({ reason: "engine", retryable: true });

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

const settle = (call: () => Promise<unknown>) =>
  Effect.tryPromise({ try: async () => await call(), catch: engine }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WorkflowRpcResult)),
    Effect.mapError((error) => (Schema.is(WorkflowFailure)(error) ? error : engine())),
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.value) : Effect.fail(result.error),
    ),
  );

const settleSleep = (call: () => Promise<unknown>) =>
  Effect.tryPromise({
    try: async () => await call(),
    catch: (error) => engineCallFailure("host", errorClassOf(error), "unanswered"),
  }).pipe(
    Effect.flatMap((reply) =>
      Schema.decodeUnknownEffect(WorkflowRpcResult)(reply).pipe(
        Effect.mapError(() => engineCallFailure("host", "other", "unreadable")),
      ),
    ),
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.value) : Effect.fail(result.error),
    ),
  );

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
                settleSleep(() =>
                  workflow.sleep(name, Schema.encodeSync(WorkflowDuration)(duration)),
                ).pipe(Effect.asVoid),
              sleepUntil: (name, timestamp) =>
                settleSleep(() => workflow.sleepUntil(name, timestamp)).pipe(Effect.asVoid),
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

export const runnerReply = (
  effect: Effect.Effect<{ readonly value: unknown; readonly hostApi?: string }, unknown>,
) =>
  effect.pipe(
    Effect.map((result) => ({ ok: true as const, ...result })),
    Effect.catchCause((cause) => Effect.succeed(refused(Cause.squash(cause)))),
    Effect.flatMap((result) =>
      encodeResult(result).pipe(
        Effect.catch(() => encodeResult({ ok: false, reason: "invalid-reply" })),
      ),
    ),
    Effect.orDie,
  );

export const serveAppRunner = (
  runner: AppRunner,
  read: (build: BuildId) => Effect.Effect<LoadedWorkerBuild, RuntimeBuildUnavailable>,
): RemoteAppRunner<Effect.Effect<string>> => ({
  invoke: (invocation, capabilities) =>
    runnerReply(
      Effect.scoped(
        Effect.gen(function* () {
          const ingress = yield* runnerIngress;
          const {
            elicitation: _elicitation,
            workflowControls: _controls,
            ...decoded
          } = yield* Schema.decodeUnknownEffect(encodedInvocation)(invocation);
          const build = yield* Schema.decodeUnknownEffect(BuildId)(decoded.build);
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

const replyResult =
  (hostApi?: string) =>
  (reply: string): Effect.Effect<unknown, RuntimeProtocolFailed | RuntimeProtocolUnsupported> =>
    Schema.decodeUnknownEffect(RemoteResult)(reply).pipe(
      Effect.catch(() => Effect.fail(new RuntimeProtocolFailed({ reason: "invalid-reply" }))),
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

export const runnerResult = <E>(effect: Effect.Effect<string, E>, hostApi?: string) =>
  effect.pipe(Effect.catch(failedFrom(false, "runner")), Effect.flatMap(replyResult(hostApi)));

export class RunnerUnanswered extends Data.TaggedError("RunnerUnanswered")<{
  readonly failure: RuntimeProtocolFailed;
}> {}

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
      Effect.flatMap((encoded) =>
        remote.declare(encoded, headers).pipe(
          Effect.catch((cause) =>
            failedFrom(
              false,
              "runner",
            )(cause).pipe(Effect.mapError((failure) => new RunnerUnanswered({ failure }))),
          ),
          Effect.flatMap(replyResult()),
        ),
      ),
      Effect.withSpan("runtime.app.remote.declare"),
    ),
});
