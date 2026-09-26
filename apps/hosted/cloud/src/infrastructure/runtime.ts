import { CacheCommand } from "@executor-js/app-cache/contracts";
import { invocationWorkflow, invocationWorkflowControls } from "../implementation/workflow-rpc.ts";
/** Cloud apps use account-isolated cached Workers; explicitly declared databases run in facets. */
import { appRpcBridge, appFacetBridge } from "../implementation/app-bridge.ts";
import {
  AppRpcEntrypoint,
  AppRpcInvocation,
  invocationElicitation,
} from "../implementation/elicitation.ts";
import { makeTelemetryForwarder, TelemetryBatch, traceHeaders } from "@executor-js/telemetry";
import {
  BuildId,
  BlobStore,
  Json,
  type RuntimeBuildUnavailable,
  RuntimeBuildFailed,
  BuildMemoryExceeded,
  RuntimeProtocolFailed,
  runtimeAdapter,
} from "@executor-js/sdk/core";
import {
  HostRequirementsError,
  HostInspectError,
  HostCallError,
  DeclaredRequirements,
  HostedTool,
  HostedToolSummary,
  indexCommand,
  inspectCommand,
  skillCatalog,
  SkillCatalogResponse,
  skillsCommand,
  selectTools,
  HostResponse,
  ToolResultObservation,
  type HostContext,
  type HostRequest,
} from "apps/contracts";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Exit, Option, Redacted, Result, Schema } from "effect";
import { facetIdentity, FacetResult } from "@executor-js/app-data/cloudflare";
import type { AppDataSupervisor } from "./app-data.ts";
import { dataChanges } from "../implementation/data-changes.ts";
import { cachedRuntimeBuilds } from "../implementation/runtime-build-cache.ts";
import type { DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";
import { workerModules } from "@executor-js/app-data/worker-bundle";
import type { CloudBundle } from "../contracts/builds.ts";
import { CompiledCloudApp } from "../contracts/builds.ts";
import { AppCompiler } from "./compiler.ts";
import { AppOutbound } from "./app-outbound.ts";
import {
  loadCloudBuild,
  retainCloudBuild,
  cloudBuildAsset,
} from "../implementation/build-storage.ts";

/** Keep the underlying failure beside the public error so the build span can report it. */
const causes = new WeakMap<object, string>();
const causeOf = (error: unknown) =>
  (typeof error === "object" && error !== null ? causes.get(error) : undefined) ?? "";
const describe = (cause: unknown) =>
  cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : (JSON.stringify(cause) ?? String(cause));
const protocolFailed = (cause: unknown) => {
  const error = new RuntimeProtocolFailed();
  causes.set(error, describe(cause));
  return error;
};
const failed = (stage: RuntimeBuildFailed["stage"], cause: unknown) => {
  const error = new RuntimeBuildFailed({ stage });
  causes.set(
    error,
    cause instanceof Error
      ? `${cause.name}: ${cause.message}`
      : (JSON.stringify(cause) ?? String(cause)),
  );
  return error;
};
const NativeFetcher = Schema.declare(
  (value): value is Fetcher =>
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function",
);

/** The longest a call's release, including its cache refreshes, may keep running. */
const releaseLimit = "35 seconds";

/** Native Alchemy bindings are resolved once; actual work belongs to the current invocation. */
export const cloudRuntime = Effect.fn(function* (
  databases: Cloudflare.DurableObject<AppDataSupervisor>,
  origin: string,
) {
  const loader = yield* Cloudflare.WorkerLoader("AppLoader");
  const compiler = yield* Cloudflare.Workers.bindWorker(AppCompiler);
  const network = yield* AppOutbound;
  const worker = yield* Cloudflare.Worker;
  yield* worker.bind`${network}`({
    bindings: [{ type: "service", name: "AppOutbound", service: network.workerName }],
  });
  const environment = yield* Cloudflare.WorkerEnvironment;
  return Effect.gen(function* () {
    const outbound = Cloudflare.fromCloudflareFetcher(
      yield* Schema.decodeUnknownEffect(NativeFetcher)(environment.AppOutbound).pipe(Effect.orDie),
    );
    const forward = yield* makeTelemetryForwarder;
    // This runtime is memoized in whichever scope first uses it; an MCP execution scopes each
    // operation. A successful call's cache refreshes belong to the Worker or Durable Object
    // invocation, as self-host's waitUntil and local's runtime-owned refreshes do, so they never
    // hold an operation, its database client or its result open.
    const { waitUntil } = yield* Effect.promise(() => import("cloudflare:workers"));
    const collect = (body: unknown, build?: BuildId) =>
      Effect.gen(function* () {
        // Telemetry is an additive transport field. Retained builds keep their original protocol.
        const collected = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ telemetry: Schema.optional(TelemetryBatch) }),
        )(body).pipe(Effect.result);
        if (Result.isFailure(collected)) yield* Effect.logWarning("Invalid app telemetry batch");
        if (Result.isSuccess(collected) && collected.success.telemetry !== undefined) {
          const span = yield* Effect.currentSpan.pipe(Effect.option);
          const batch = collected.success.telemetry;
          if (Option.isSome(span)) yield* forward(batch, span.value.traceId, build);
        }
      });
    const dispatch = <A, E>(
      bundle: Effect.Effect<CloudBundle, RuntimeBuildUnavailable, BlobStore>,
      command: HostRequest,
      context: HostContext,
      schema: Schema.Decoder<A>,
      error: Schema.Decoder<E>,
      build: BuildId,
      identity: string,
      app?: string,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const lifetime = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (controller) => Effect.sync(() => controller.abort()),
          );
          // The identity includes app, build and current credentials. Reuse never crosses account contexts.
          const worker = yield* loader
            .get(identity, () =>
              bundle.pipe(
                Effect.map((bundle) => ({
                  mainModule: "__executor_rpc.js",
                  modules: {
                    ...workerModules(bundle.modules),
                    "__executor_rpc.js": appRpcBridge(bundle.mainModule),
                  },
                  compatibilityDate: "2026-07-30",
                  compatibilityFlags: ["nodejs_compat"],
                  // Validation and discovery can also run inside a native Workflow,
                  // without a workflow execution context. Its implicit outbound is
                  // not a Fetcher. Always use the private service, which enforces
                  // public routing; the strictly-public flag here would bypass it.
                  globalOutbound: command.operation === "requirements" ? null : outbound,
                })),
              ),
            )
            .pipe(Effect.withSpan("runtime.cloud.worker.load"));
          // Workers RPC structured-clones its arguments; Effect headers carry a prototype it rejects.
          const headers = Object.fromEntries(Object.entries(yield* traceHeaders));
          const services = yield* Effect.context<never>();
          // Native RPC carries the live callback; the fetch payload remains the existing portable protocol.
          const entrypoint = yield* Schema.decodeUnknownEffect(AppRpcEntrypoint)(
            worker.getEntrypoint().raw,
          ).pipe(Effect.mapError((cause) => protocolFailed(cause)));
          const workflow =
            context.workflow === undefined
              ? null
              : yield* invocationWorkflow(context.workflow, lifetime.signal);
          const controls =
            context.workflowControls === undefined
              ? null
              : yield* invocationWorkflowControls(context.workflowControls, lifetime.signal);
          const invocation = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                entrypoint.start(
                  JSON.stringify({
                    command,
                    accounts: Redacted.value(context.accounts),
                    approval: context.approval,
                    replay: context.replay,
                    deadline: context.deadline,
                    workflowRun: context.workflow?.runId,
                  }),
                  headers,
                  context.elicitation === undefined
                    ? null
                    : invocationElicitation(context.elicitation, lifetime.signal),
                  context.workflow === undefined ? null : workflow,
                  context.workflowControls === undefined ? null : controls,
                  app === undefined
                    ? null
                    : (command) =>
                        Effect.runPromiseWith(services)(
                          Effect.gen(function* () {
                            const parsed = yield* Schema.decodeUnknownEffect(CacheCommand)(command);
                            yield* Effect.annotateCurrentSpan("cache.operation", parsed.operation);
                            return yield* databases.getByName(app).cache(build, parsed);
                          }).pipe(
                            Effect.provide(RuntimeContext.phantom),
                            Effect.withSpan("runtime.cloud.cache"),
                          ),
                        ),
                ),
              catch: protocolFailed,
            }).pipe(
              Effect.flatMap((value) =>
                Schema.decodeUnknownEffect(AppRpcInvocation)(value).pipe(
                  Effect.mapError(protocolFailed),
                ),
              ),
              Effect.withSpan("runtime.cloud.rpc.start"),
            ),
            (call, exit) => {
              // Bounded, so a release RPC that never settles cannot hold its owner open.
              const release = Effect.promise(async () => {
                try {
                  if (Exit.isSuccess(exit)) await call.drain?.();
                } finally {
                  try {
                    await call.cancel();
                  } finally {
                    call[Symbol.dispose]();
                  }
                }
              }).pipe(
                Effect.interruptible,
                Effect.timeoutOption(releaseLimit),
                Effect.tap((settled) =>
                  Option.isNone(settled)
                    ? Effect.annotateCurrentSpan("executor.release.timed_out", true)
                    : Effect.void,
                ),
                Effect.withSpan("runtime.cloud.rpc.release"),
                Effect.catchCause(() => Effect.void),
              );
              if (Exit.isFailure(exit)) return release;
              return Effect.context<never>().pipe(
                Effect.flatMap((services) =>
                  Effect.sync(() => waitUntil(Effect.runPromiseWith(services)(release))),
                ),
              );
            },
          );
          const body = yield* Effect.tryPromise({
            try: () => invocation.result(),
            catch: protocolFailed,
          }).pipe(Effect.withSpan("runtime.cloud.rpc.result"));
          yield* collect(body, build);
          const envelope = yield* Schema.decodeUnknownEffect(HostResponse)(body).pipe(
            Effect.mapError((cause) => protocolFailed(cause)),
          );
          if (!envelope.ok)
            return yield* Schema.decodeUnknownEffect(error)(envelope.error).pipe(
              Effect.mapError((cause) => protocolFailed(cause)),
              Effect.flatMap(Effect.fail),
            );
          if (envelope.toolError === true) {
            (yield* ToolResultObservation).failed();
            yield* Effect.annotateCurrentSpan({
              "executor.outcome": "failed",
              "error.type": "McpToolError",
            });
          }
          return yield* Schema.decodeUnknownEffect(schema)(envelope.value).pipe(
            Effect.mapError((cause) => protocolFailed(cause)),
          );
        }),
      ).pipe(
        Effect.provide(RuntimeContext.phantom),
        Effect.catchDefect((defect) => Effect.fail(protocolFailed(defect))),
        Effect.tapError((error) =>
          Effect.annotateCurrentSpan({ "dispatch.cause": causeOf(error) }),
        ),
      );
    const load = yield* cachedRuntimeBuilds(origin, (build) =>
      loadCloudBuild(build).pipe(Effect.provide(RuntimeContext.phantom)),
    );
    const data = (
      command: Extract<
        HostRequest,
        {
          operation:
            | "query"
            | "mutate"
            | "call"
            | "webhook-complete"
            | "webhook-validate"
            | "webhooks"
            | "webhook-register"
            | "webhook-handle"
            | "webhook-unregister";
        }
      >,
      input: {
        readonly app: string;
        readonly build: BuildId;
        readonly database: boolean;
        readonly observeRevision?: (revision: number) => void;
      } & HostContext,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (input.storage !== undefined) return yield* new RuntimeProtocolFailed();
          const identity = yield* facetIdentity(
            input.build,
            JSON.stringify(Redacted.value(input.accounts)),
          );
          yield* Effect.annotateCurrentSpan({
            "executor.runtime.mode": input.database ? "facet" : "worker",
            "executor.worker.identity": `${input.app}:${identity}`,
          });
          if (!input.database)
            return yield* dispatch(
              load(input.build),
              command,
              input,
              Json,
              HostCallError,
              input.build,
              `${input.app}:${identity}`,
              input.app,
            );
          const lifetime = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (controller) => Effect.sync(() => controller.abort()),
          );
          const target = databases.getByName(input.app);
          const services = yield* Effect.context<BlobStore>();
          const id = crypto.randomUUID();
          const workflowControls =
            input.workflowControls === undefined
              ? null
              : yield* invocationWorkflowControls(input.workflowControls, lifetime.signal);
          const result = yield* target
            .invoke(
              {
                id,
                identity,
                cacheNamespace: input.build,
                write:
                  ["mutate", "webhook-register", "webhook-handle", "webhook-unregister"].includes(
                    command.operation,
                  ) ||
                  (command.operation === "call" && command.tool.startsWith("mutations.")),
                body: JSON.stringify({
                  command,
                  approval: input.approval,
                  replay: input.replay,
                  deadline: input.deadline,
                  accounts: Redacted.value(input.accounts),
                }),
                headers: Object.fromEntries(Object.entries(yield* traceHeaders)),
              },
              // Only the trusted supervisor receives this invocation-owned capability.
              // Its WorkerLoader calls it on a cold runtime; warm calls transfer no code.
              () =>
                Effect.runPromiseWith(services)(
                  load(input.build).pipe(
                    Effect.map((bundle) => ({
                      mainModule: "__executor_facet.js",
                      modules: {
                        ...bundle.modules,
                        "__executor_facet.js": appFacetBridge(bundle.mainModule),
                      },
                    })),
                  ),
                  { signal: lifetime.signal },
                ),
              input.elicitation === undefined
                ? null
                : invocationElicitation(input.elicitation, lifetime.signal),
              workflowControls,
            )
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(FacetResult)),
              Effect.onInterrupt(() => target.cancel(id).pipe(Effect.catch(() => Effect.void))),
            );
          const body = result.value;
          yield* collect(body, input.build);
          const envelope = yield* Schema.decodeUnknownEffect(HostResponse)(body);
          if (!envelope.ok)
            return yield* Schema.decodeUnknownEffect(HostCallError)(envelope.error).pipe(
              Effect.flatMap(Effect.fail),
            );
          const value = yield* Schema.decodeUnknownEffect(Json)(envelope.value);
          if (command.operation === "query") input.observeRevision?.(result.revision);
          return value;
        }),
      ).pipe(
        Effect.provide(RuntimeContext.phantom),
        Effect.catchTags({
          SchemaError: () => Effect.fail(new RuntimeProtocolFailed()),
          AppDatabaseError: () => Effect.fail(new RuntimeProtocolFailed()),
        }),
      );
    return runtimeAdapter({
      asset: ({ build, path }) =>
        cloudBuildAsset(build, path).pipe(Effect.provide(RuntimeContext.phantom)),
      build: ({ files }) =>
        Effect.gen(function* () {
          const headers = Object.fromEntries(Object.entries(yield* traceHeaders));
          const { bundle, ui } = yield* compiler.compile(files, headers).pipe(
            Effect.catchTag("RpcCallError", (error) => {
              const cause = error.cause;
              const failure =
                cause instanceof Error && /^Worker exceeded memory limit\.?$/.test(cause.message)
                  ? new BuildMemoryExceeded()
                  : new RuntimeBuildFailed({ stage: "compile" });
              causes.set(failure, describe(error));
              return Effect.fail(failure);
            }),
            Effect.flatMap(Schema.decodeUnknownEffect(CompiledCloudApp)),
            Effect.catchTag("SchemaError", (cause) => Effect.fail(failed("compile", cause))),
            Effect.withSpan("runtime.cloud.compiler.request"),
          );
          const build = BuildId.make(`bld_${crypto.randomUUID()}`);
          const requirements = yield* dispatch(
            Effect.succeed(bundle),
            { operation: "requirements" },
            { accounts: Redacted.make({}) },
            DeclaredRequirements,
            HostRequirementsError,
            build,
            `declaration:${build}`,
          ).pipe(
            Effect.mapError((cause) => failed("declaration", cause)),
            Effect.withSpan("runtime.cloud.requirements"),
          );
          const assets = yield* retainCloudBuild(
            build,
            {
              ...bundle,
              database: requirements.database !== undefined,
            },
            ui,
          ).pipe(Effect.provide(RuntimeContext.phantom));
          return { build, requirements, ...(assets === undefined ? {} : { ui: assets }) };
        }).pipe(
          // The failing stage and its cause belong on the span; the public error stays small.
          Effect.tapError((error) =>
            Effect.annotateCurrentSpan({
              "build.stage": Schema.is(BuildMemoryExceeded)(error) ? "compile" : error.stage,
              "build.cause": causeOf(error),
            }),
          ),
          Effect.withSpan("runtime.cloud.build"),
        ),
      skills: ({ app, build, sources, ...context }) =>
        Effect.gen(function* () {
          const identity = `${app}:${yield* facetIdentity(build, JSON.stringify(Redacted.value(context.accounts))).pipe(Effect.mapError(protocolFailed))}`;
          yield* Effect.annotateCurrentSpan({
            "executor.runtime.mode": "worker",
            "executor.worker.identity": identity,
          });
          return skillCatalog(
            yield* dispatch(
              load(build),
              skillsCommand(sources === true),
              context,
              SkillCatalogResponse,
              HostInspectError,
              build,
              identity,
              app,
            ),
          );
        }).pipe(Effect.withSpan("runtime.cloud.skills")),
      inspect: ({ app, build, tools, ...context }) =>
        Effect.gen(function* () {
          const identity = `${app}:${yield* facetIdentity(build, JSON.stringify(Redacted.value(context.accounts))).pipe(Effect.mapError(protocolFailed))}`;
          yield* Effect.annotateCurrentSpan({
            "executor.runtime.mode": "worker",
            "executor.worker.identity": identity,
          });
          return selectTools(tools)(
            yield* dispatch(
              load(build),
              inspectCommand(tools),
              context,
              Schema.Array(HostedTool),
              HostInspectError,
              build,
              identity,
              app,
            ),
          );
        }).pipe(Effect.withSpan("runtime.cloud.inspect")),
      index: ({ app, build, ...context }) =>
        Effect.gen(function* () {
          const identity = `${app}:${yield* facetIdentity(build, JSON.stringify(Redacted.value(context.accounts))).pipe(Effect.mapError(protocolFailed))}`;
          yield* Effect.annotateCurrentSpan({
            "executor.runtime.mode": "worker",
            "executor.worker.identity": identity,
          });
          return yield* dispatch(
            load(build),
            indexCommand,
            context,
            Schema.Array(HostedToolSummary),
            HostInspectError,
            build,
            identity,
            app,
          );
        }).pipe(Effect.withSpan("runtime.cloud.index")),
      workflow: ({ app, build, command, ...context }) =>
        Effect.gen(function* () {
          const identity = `${app}:workflow:${context.workflow?.runId ?? "inspect"}:${yield* facetIdentity(build, JSON.stringify(Redacted.value(context.accounts))).pipe(Effect.mapError(protocolFailed))}`;
          return yield* dispatch(
            load(build),
            command,
            context,
            Json,
            HostCallError,
            build,
            identity,
            app,
          );
        }).pipe(
          Effect.withSpan("runtime.cloud.workflow", {
            attributes: {
              "executor.app.id": app,
              "executor.build.id": build,
              ...(context.workflow === undefined
                ? {}
                : { "executor.run.id": context.workflow.runId }),
            },
          }),
        ),
      webhook: (input) => data(input.command, input),
      call: (input) =>
        data({ operation: "call", tool: input.tool, input: input.input }, input).pipe(
          Effect.withSpan("runtime.cloud.call"),
        ),
      query: (input) =>
        data({ operation: "query", name: input.name, input: input.input }, input).pipe(
          Effect.withSpan("runtime.cloud.query"),
        ),
      mutate: (input) =>
        data({ operation: "mutate", name: input.name, input: input.input }, input).pipe(
          Effect.withSpan("runtime.cloud.mutate"),
        ),
      changes: (app) => {
        // Native fetch retains the upgrade response; Alchemy's typed HTTP stub omits it.
        const namespace = Schema.decodeUnknownSync(
          Schema.declare(
            (value): value is Pick<DurableObjectNamespace, "getByName"> =>
              typeof value === "object" &&
              value !== null &&
              "getByName" in value &&
              typeof value.getByName === "function",
          ),
        )(environment.AppDataSupervisor);
        return dataChanges(namespace, app);
      },
    });
  });
});
