/**
 * The product side of app execution, shared by every host. It turns runtime operations into app
 * invocations for the runner, gives each invocation a build loader over the host's build store,
 * and decodes the reply. Hosts differ only in where the runner lives and how builds are stored.
 */
import { Clock, Effect, Option, Redacted, Result, Schema, type Scope, type Stream } from "effect";
import { makeTelemetryForwarder, TelemetryBatch, traceHeaders } from "@executor-js/telemetry";
import { recordAs } from "@executor-js/utils/recorded-message";
import {
  AccountCheckResult,
  HostAccountCheckError,
  HostCallError,
  HostDataError,
  HostedCatalog,
  HostedCatalogSummary,
  HostedSharedCatalog,
  HostInspectError,
  HostResponse,
  MigrateResult,
  indexCommand,
  InvocationTiming,
  inspectCommand,
  restoreSharedCatalog,
  selectTools,
  skillCatalog,
  SkillCatalogResponse,
  skillsCommand,
  ToolResultObservation,
  type HostContext,
  type HostRequest,
  type WebhookCommand,
  scopedSlots,
} from "apps/contracts";
import {
  AppCacheChanges,
  AppCodeEntered,
  DispatchTiming,
  AppEventSink,
  InvocationRun,
  IsolateTiming,
  RuntimeCallTimings,
  RuntimeProtocolFailed,
  type RuntimeCallTiming,
  type RuntimeProtocolUnsupported,
  type Runtime,
  type RuntimeBuildUnavailable,
} from "../contracts/runtime.ts";
import type { HostApiCheck } from "../contracts/host-api.ts";
import { Json, type BuildId } from "../contracts/shared.ts";
import type { LoadedWorkerBuild } from "../contracts/worker-build.ts";
import type { BlobStore } from "../contracts/blobs.ts";
import { appWorker, type AppCapabilities, type AppInvocation } from "./app-runner.ts";
import { appProtocol } from "./app-protocols.ts";
import { invocationElicitation } from "./worker-elicitation.ts";
import { invocationWorkflowControls } from "./worker-workflow-rpc.ts";
import { runtimeCallParts } from "./tool-call-overhead.ts";

/** What telemetry records for an error an app's reply carried, beside the error's name. */
const appErrorRecorded = "The app returned this error; its text is not recorded";

/** The part of a webhook's life each command runs, as its span records it. */
const webhookOperations = {
  webhooks: "definitions",
  "webhook-validate": "validate",
  "webhook-complete": "complete",
  "webhook-register": "register",
  "webhook-unregister": "unregister",
  "webhook-handle": "handle",
} as const satisfies Record<WebhookCommand["operation"], string>;

/** The span recorded each time a host reads a build, to learn its protocol or cold-start it. */
export const buildLoadSpan = "runtime.app.build.load";

/**
 * One invocation's build loader over a host's build store. The runner calls it to learn a build's
 * protocol and on a cold start. A build whose protocol this host does not run never starts, so
 * only its load finds that out: `refused` keeps that as the invocation's failure.
 */
export const invocationBuildLoader = <R>(
  invocation: Pick<AppInvocation, "app" | "build" | "database" | "command" | "accounts" | "run">,
  read: Effect.Effect<LoadedWorkerBuild, RuntimeBuildUnavailable, R>,
): Effect.Effect<
  {
    readonly load: AppCapabilities["load"];
    readonly refused: <A, E, R2>(
      invoked: Effect.Effect<A, E | RuntimeProtocolFailed, R2>,
    ) => Effect.Effect<A, E | RuntimeProtocolFailed | RuntimeProtocolUnsupported, R2>;
  },
  RuntimeProtocolFailed,
  R | Scope.Scope
> =>
  Effect.gen(function* () {
    const lifetime = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) => Effect.sync(() => controller.abort()),
    );
    const services = yield* Effect.context<R>();
    const worker = yield* appWorker(invocation).pipe(
      Effect.mapError(() => new RuntimeProtocolFailed()),
    );
    let unsupported: RuntimeProtocolUnsupported | undefined;
    return {
      load: () =>
        Effect.runPromiseWith(services)(
          read.pipe(
            Effect.tap((loaded) =>
              appProtocol(loaded.protocol).pipe(
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    unsupported = error;
                  }),
                ),
              ),
            ),
            Effect.withSpan(buildLoadSpan, {
              attributes: {
                "executor.app.id": invocation.app,
                "executor.build.id": invocation.build,
                "executor.runtime.mode": worker.mode,
                "executor.worker.identity": worker.name,
                ...(invocation.run === undefined ? {} : { "executor.run.id": invocation.run }),
              },
            }),
          ),
          { signal: lifetime.signal },
        ),
      refused: (invoked) =>
        invoked.pipe(
          Effect.catchTag("RuntimeProtocolFailed", (error) => Effect.fail(unsupported ?? error)),
        ),
    };
  });

/** What one host provides. Everything else about app execution is shared. */
export interface AppRuntimeHost {
  /** Span prefix for this host's runtime operations. */
  readonly name: string;
  /**
   * Opaque ids of whom the current operation runs for, such as its organization, read from its
   * context without I/O. Each runtime operation's span records them.
   */
  readonly actor?: Effect.Effect<Readonly<Record<string, string>>>;
  /** Read one retained build, with the protocol its framework speaks, from this host's store. */
  readonly loadBuild: (
    build: BuildId,
  ) => Effect.Effect<LoadedWorkerBuild, RuntimeBuildUnavailable, BlobStore>;
  /** Deliver one invocation to the runner, wherever it runs. */
  readonly invoke: (
    invocation: AppInvocation,
    capabilities: AppCapabilities,
  ) => Effect.Effect<unknown, RuntimeProtocolFailed | RuntimeProtocolUnsupported>;
  readonly build: Runtime<BlobStore>["build"];
  readonly asset: NonNullable<Runtime<BlobStore>["asset"]>;
  readonly changes: (app: string) => Stream.Stream<number, RuntimeProtocolFailed>;
}

/** Assemble runtime operations over one host's runner and build store. */
export const appRuntime = (host: AppRuntimeHost) =>
  Effect.gen(function* () {
    const forward = yield* makeTelemetryForwarder;
    const dispatch = <A, E>(
      input: {
        readonly app: string;
        readonly build: BuildId;
        readonly hostApi: HostApiCheck | undefined;
        readonly database: boolean;
        readonly observeRevision?: (revision: number) => void;
      } & HostContext,
      command: HostRequest,
      output: Schema.Decoder<A>,
      errors: Schema.Decoder<E>,
    ) => {
      // This call's share of a tool call, reported when it is over.
      let invoked: RuntimeCallTiming["invoked"];
      let parts: RuntimeCallTiming["parts"];
      return Effect.scoped(
        Effect.gen(function* () {
          const lifetime = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (controller) => Effect.sync(() => controller.abort()),
          );
          const build = input.build;
          const run = yield* InvocationRun;
          const invocation: AppInvocation = {
            app: input.app,
            build,
            database: input.database,
            command,
            accounts: Redacted.value(input.accounts),
            ...(input.caller === undefined ? {} : { caller: input.caller }),
            // Workers RPC structured-clones its arguments; Effect headers carry a prototype it rejects.
            headers: Object.fromEntries(Object.entries(yield* traceHeaders)),
            ...(input.hostApi === undefined ? {} : { hostApi: input.hostApi }),
            ...(input.approval === undefined ? {} : { approval: input.approval }),
            ...(input.replay === undefined ? {} : { replay: input.replay }),
            ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
            ...(run === undefined ? {} : { run }),
          };
          // Only the trusted runner or data supervisor calls the loader. The runner may sit behind
          // RPC, so the loader keeps an unsupported protocol as this call's typed failure.
          const loader = yield* invocationBuildLoader(invocation, host.loadBuild(build));
          const capabilities: AppCapabilities = {
            load: loader.load,
            elicit:
              input.elicitation === undefined
                ? null
                : invocationElicitation(input.elicitation, lifetime.signal),
            controls:
              input.workflowControls === undefined
                ? null
                : yield* invocationWorkflowControls(input.workflowControls, lifetime.signal),
            ...(input.workflow === undefined ? {} : { workflow: input.workflow }),
          };
          const from = yield* Clock.currentTimeNanos;
          // Recorded here, by the host, before the runner receives the invocation: whatever it
          // reports afterwards came through code the app controls.
          (yield* AppCodeEntered).entered();
          const body = yield* loader.refused(host.invoke(invocation, capabilities)).pipe(
            Effect.ensuring(
              Effect.flatMap(Clock.currentTimeNanos, (to) =>
                Effect.sync(() => {
                  invoked = [from, to];
                }),
              ),
            ),
          );
          // Telemetry is an additive transport field. Retained builds keep their original protocol.
          const collected = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              telemetry: Schema.optional(TelemetryBatch),
              executorRevision: Schema.optional(Schema.Int),
              cacheChanged: Schema.optional(Schema.Boolean),
              timing: Schema.optional(InvocationTiming),
              dispatch: Schema.optional(DispatchTiming),
              runner: Schema.optional(IsolateTiming),
              supervisor: Schema.optional(IsolateTiming),
            }),
          )(body).pipe(Effect.result);
          // Each isolate reports its own part on its own clock; see tool-call-overhead.ts.
          if (
            Result.isSuccess(collected) &&
            collected.success.timing !== undefined &&
            collected.success.dispatch !== undefined &&
            collected.success.runner !== undefined &&
            invoked !== undefined
          ) {
            const { timing, dispatch, runner, supervisor } = collected.success;
            parts = runtimeCallParts(
              Number(invoked[1] - invoked[0]) / 1_000_000,
              runner,
              supervisor,
              dispatch,
              timing,
            );
            yield* Effect.annotateCurrentSpan({
              "executor.runner.own_ms": runner.elapsedMs - runner.waitMs,
              "executor.runner.wait_ms": runner.waitMs,
              "executor.runner.gap_ms": parts.gaps.runner,
              // The runner ran inside the app's data supervisor, which the caller reached directly.
              ...(runner.host === undefined ? {} : { "executor.runner.host": runner.host }),
              ...(supervisor === undefined
                ? {}
                : {
                    "executor.supervisor.own_ms": supervisor.elapsedMs - supervisor.waitMs,
                    "executor.supervisor.wait_ms": supervisor.waitMs,
                    "executor.supervisor.gap_ms": parts.gaps.supervisor ?? 0,
                  }),
              "executor.app.elapsed_ms": dispatch.elapsedMs,
              "executor.app.own_ms": parts.appOwnMs,
              "executor.app.gap_ms": parts.gaps.app,
              "executor.upstream.wait_ms": parts.upstreamMs,
              "executor.elicitation.wait_ms": parts.elicitationMs,
              "executor.authored_ms": parts.authoredMs,
              "executor.lease.wait_ms": parts.leaseMs,
              "executor.background_ms": parts.backgroundMs,
              "executor.start_ms": parts.startMs,
              "executor.unclocked_ms": parts.unclockedMs,
              ...(parts.started === undefined
                ? {}
                : {
                    "executor.runtime.cold": parts.cold === true,
                    "executor.runtime.started": parts.started.join(","),
                  }),
              ...(parts.staleClocks.length === 0
                ? {}
                : {
                    "executor.clock.stale": true,
                    "executor.clock.stale_between": parts.staleClocks.join(","),
                  }),
            });
          }
          if (Result.isFailure(collected)) yield* Effect.logWarning("Invalid app telemetry batch");
          if (Result.isSuccess(collected) && collected.success.telemetry !== undefined) {
            const span = yield* Effect.currentSpan.pipe(Effect.option);
            if (Option.isSome(span))
              yield* forward(collected.success.telemetry, span.value.traceId, {
                build,
                app: input.app,
              });
          }
          if (Result.isSuccess(collected) && collected.success.cacheChanged === true)
            yield* (yield* AppCacheChanges).changed(input.app);
          const reply = yield* Schema.decodeUnknownEffect(HostResponse)(body);
          // The app wrote these errors. Their text reaches the caller each is for; telemetry
          // records their names only.
          if (!reply.ok)
            return yield* Schema.decodeUnknownEffect(errors)(reply.error).pipe(
              Effect.flatMap((error) => Effect.fail(recordAs(error, appErrorRecorded))),
            );
          if (reply.toolError === true) {
            (yield* ToolResultObservation).failed();
            yield* Effect.annotateCurrentSpan({
              "executor.outcome": "failed",
              "error.type": "McpToolError",
            });
          }
          const value = yield* Schema.decodeUnknownEffect(output)(reply.value);
          // Only a successful invocation's events are kept; its writes have committed.
          if (reply.events !== undefined && reply.events.length > 0)
            yield* (yield* AppEventSink).emitted({
              app: input.app,
              accounts: [
                ...new Set(
                  scopedSlots(Redacted.value(input.accounts)).flatMap(([, selected]) =>
                    (Array.isArray(selected) ? selected : [selected]).map((account) => account.id),
                  ),
                ),
              ],
              events: reply.events,
            });
          const revision = Result.isSuccess(collected)
            ? collected.success.executorRevision
            : undefined;
          if (command.operation === "query" && revision !== undefined)
            input.observeRevision?.(revision);
          return value;
        }),
      ).pipe(
        Effect.onExit(() =>
          Effect.gen(function* () {
            const report = yield* RuntimeCallTimings;
            report?.({
              ...(invoked === undefined ? {} : { invoked }),
              ...(parts === undefined ? {} : { parts }),
            });
          }),
        ),
        Effect.catchTag("SchemaError", () =>
          Effect.fail(new RuntimeProtocolFailed({ reason: "invalid-reply" })),
        ),
      );
    };
    const actor: Effect.Effect<Readonly<Record<string, string>>> = host.actor ?? Effect.succeed({});
    /**
     * One runtime operation's span. It records the app the operation runs and whom the host says
     * it runs for, so one app's or organization's failures can be told from the runtime's own.
     */
    const traced =
      (operation: string, attributes: Readonly<Record<string, string>> = {}) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.flatMap(actor, (ids) =>
          Effect.withSpan(effect, `${host.name}.${operation}`, {
            attributes: { ...ids, ...attributes },
          }),
        );
    const app = (input: { readonly app: string }) => ({ "executor.app.id": input.app });
    return {
      build: (input) => host.build(input).pipe(traced("build")),
      asset: host.asset,
      changes: host.changes,
      skills: ({ sources, ...input }) =>
        dispatch(
          { ...input, database: false },
          skillsCommand(sources === true),
          SkillCatalogResponse,
          HostInspectError,
        ).pipe(Effect.map(skillCatalog), traced("skills", app(input))),
      inspect: ({ tools, scheduled, definitions, ...input }) =>
        (definitions === "shared"
          ? dispatch(
              { ...input, database: false },
              inspectCommand({ tools, scheduled, definitions }),
              HostedSharedCatalog,
              HostInspectError,
            ).pipe(
              Effect.flatMap((catalog) => {
                const restored = restoreSharedCatalog(catalog);
                return restored === undefined
                  ? Effect.fail(new RuntimeProtocolFailed({ reason: "invalid-reply" }))
                  : Effect.succeed(restored);
              }),
            )
          : dispatch(
              { ...input, database: false },
              inspectCommand({ tools, scheduled }),
              HostedCatalog,
              HostInspectError,
            )
        ).pipe(Effect.map(selectTools(tools)), traced("inspect", app(input))),
      index: (input) =>
        dispatch(
          { ...input, database: false },
          indexCommand,
          HostedCatalogSummary,
          HostInspectError,
        ).pipe(traced("index", app(input))),
      query: (input) =>
        dispatch(
          input,
          { operation: "query", name: input.name, input: input.input },
          Json,
          HostDataError,
        ).pipe(traced("query", app(input))),
      mutate: (input) =>
        dispatch(
          input,
          { operation: "mutate", name: input.name, input: input.input },
          Json,
          HostDataError,
        ).pipe(traced("mutate", app(input))),
      call: (input) =>
        dispatch(
          input,
          {
            operation: "call",
            tool: input.tool,
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            input: input.input,
          },
          Json,
          HostCallError,
        ).pipe(traced("call", app(input))),
      connect: (input) =>
        dispatch(input, input.command, Json, HostCallError).pipe(traced("connect", app(input))),
      webhook: (input) =>
        dispatch(input, input.command, Json, HostCallError).pipe(
          traced("webhook", {
            ...app(input),
            "executor.webhook.operation": webhookOperations[input.command.operation],
          }),
        ),
      checkAccount: ({ requirement, ...input }) =>
        dispatch(
          { ...input, database: false },
          { operation: "account-check", requirement },
          AccountCheckResult,
          HostAccountCheckError,
        ).pipe(traced("checkAccount", app(input))),
      migrate: (input) =>
        dispatch(
          // Migrations run the build's SQL files only, so they read no cache or API.
          {
            ...input,
            hostApi: undefined,
            database: true,
            accounts: Redacted.make({ app: {} }),
          },
          { operation: "migrate" },
          MigrateResult,
          HostCallError,
        ).pipe(traced("migrate", app(input))),
      workflow: (input) =>
        dispatch({ ...input, database: false }, input.command, Json, HostCallError).pipe(
          traced("workflow", {
            ...app(input),
            "executor.build.id": input.build,
            ...(input.workflow === undefined ? {} : { "executor.run.id": input.workflow.runId }),
          }),
        ),
    } satisfies Runtime<BlobStore>;
  });
