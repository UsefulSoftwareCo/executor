/** Cloud's app runtime: the shared runner in the AppData Worker, with R2 and the Cache API as build store. */
import { traceHeaders } from "@executor-js/telemetry";
import {
  BuildId,
  RuntimeBuildFailed,
  BuildMemoryExceeded,
  RuntimeProtocolUnsupported,
  describeBuildCause,
  RuntimeAppsDependencyMissing,
  ownsDatabase,
  runtimeAdapter,
} from "@executor-js/sdk/core";
import {
  appRuntime,
  assembleWorkerBundle,
  declarationFailed,
  remoteAppRunner,
} from "@executor-js/sdk/workerd";
import { HostRequirementsError, DeclaredRequirements, HostResponse } from "apps/contracts";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Context, Effect, FiberSet, Option, Schema } from "effect";
import { CurrentOrganization, CurrentUserId } from "@executor-js/hosted-server";
import { dataChanges } from "../implementation/data-changes.ts";
import { cacheRuntimeBuild, cachedRuntimeBuilds } from "../implementation/runtime-build-cache.ts";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { CloudCompileResult } from "../contracts/builds.ts";
import { AppCompiler } from "./compiler.ts";
import { AppData } from "./app-data-worker.ts";
import {
  loadCloudBuildRecord,
  loadCloudFramework,
  retainCloudBuild,
  cloudBuildAsset,
} from "../implementation/build-storage.ts";

/** The deployer sees the underlying failure; builds bind no accounts, so it holds no credentials. */
const failed = (stage: RuntimeBuildFailed["stage"], cause: unknown) =>
  new RuntimeBuildFailed({ stage, message: describeBuildCause(cause) });
/**
 * How long a deploy waits for the compiler Worker to answer. A lost compiler isolate otherwise
 * leaves the binding call open until the platform reports a lost connection, 100-230s later.
 * Over September 2026, the slowest successful compiler requests took 16.5s in production and
 * 34s on test stages (a cold default-app provision), and compiler memory failures surfaced within
 * 37s, so they still report as such. The bound leaves the whole deploy room to answer within the
 * 60s that MCP clients and the deployed scenarios commonly wait.
 */
const compilerDeadline = "50 seconds";
const compilerDidNotAnswer = Effect.annotateCurrentSpan(
  "build.compiler_deadline_exceeded",
  true,
).pipe(
  Effect.andThen(
    Effect.fail(
      new RuntimeBuildFailed({
        stage: "compile",
        message: `The compiler did not answer within ${compilerDeadline}. No new deployment was activated; deploy again.`,
      }),
    ),
  ),
);
/**
 * Attribute Worker Loader use to the caller. Cloudflare bills each unique loaded Worker per day,
 * and its own usage data cannot be split by user or organization.
 */
const withActor = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const user = Context.get(context, CurrentUserId);
    const organization = Context.getOption(context, CurrentOrganization);
    return yield* effect.pipe(
      Effect.annotateSpans({
        ...(user === undefined ? {} : { "executor.user.id": user }),
        ...(Option.isSome(organization)
          ? { "executor.organization.id": organization.value.organization }
          : {}),
      }),
    );
  });
const NativeNamespace = Schema.declare(
  (value): value is Pick<DurableObjectNamespace, "getByName"> =>
    typeof value === "object" &&
    value !== null &&
    "getByName" in value &&
    typeof value.getByName === "function",
);

/** Native Alchemy bindings are resolved once; actual work belongs to the current invocation. */
export const cloudRuntime = Effect.fn(function* (origin: string) {
  const compiler = yield* Cloudflare.Workers.bindWorker(AppCompiler);
  const appData = yield* Cloudflare.Workers.bindWorker(AppData);
  const environment = yield* Cloudflare.WorkerEnvironment;
  return Effect.gen(function* () {
    // App Workers run in AppData, whose own entrypoint can be their outbound network.
    const runner = remoteAppRunner({
      invoke: (invocation, capabilities) => appData.invoke(invocation, capabilities),
      declare: (bundle, headers) => appData.declare(bundle, headers),
    });
    // Cache writes run in this event scope, bounded when it closes.
    const warming = yield* FiberSet.make();
    yield* Effect.addFinalizer(() =>
      FiberSet.awaitEmpty(warming).pipe(Effect.timeoutOption("2 seconds"), Effect.asVoid),
    );
    // Only a runner from before AppData read builds itself calls this loader; it stays until
    // callers stop sending it, so such a runner keeps working through a rollback.
    const load = cachedRuntimeBuilds(
      origin,
      {
        record: (build) => loadCloudBuildRecord(build).pipe(Effect.provide(RuntimeContext.phantom)),
        framework: (identity) =>
          loadCloudFramework(identity).pipe(Effect.provide(RuntimeContext.phantom)),
      },
      (write) => FiberSet.run(warming, write).pipe(Effect.asVoid),
    );
    const runtime = yield* appRuntime({
      name: "runtime.cloud",
      loadBuild: load,
      invoke: (invocation, capabilities) => withActor(runner.invoke(invocation, capabilities)),
      build: ({ files }) =>
        withActor(
          Effect.gen(function* () {
            const headers = Object.fromEntries(Object.entries(yield* traceHeaders));
            const result = yield* compiler.compile(files, headers).pipe(
              Effect.timeoutOrElse({
                duration: compilerDeadline,
                orElse: () => compilerDidNotAnswer,
              }),
              Effect.catchTag("RpcCallError", (error) => {
                const cause = error.cause;
                return Effect.fail(
                  cause instanceof Error && /^Worker exceeded memory limit\.?$/.test(cause.message)
                    ? new BuildMemoryExceeded()
                    : failed("compile", cause instanceof Error ? cause : error),
                );
              }),
              // Builds share a compiler isolate, so another build can exhaust its memory. The
              // runtime discards that isolate: one retry compiles alone on a fresh one, and a
              // build that cannot fit fails again.
              Effect.tapError((error) =>
                Schema.is(BuildMemoryExceeded)(error)
                  ? Effect.annotateCurrentSpan("build.memory_retry", true)
                  : Effect.void,
              ),
              Effect.retry({ times: 1, while: Schema.is(BuildMemoryExceeded) }),
              Effect.flatMap(Schema.decodeUnknownEffect(CloudCompileResult)),
              Effect.catchTag("SchemaError", (cause) => Effect.fail(failed("compile", cause))),
              Effect.withSpan("runtime.cloud.compiler.request"),
            );
            if (!result.ok) return yield* Effect.fail(result.error);
            const { bundle, framework, ui, protocol, sourceMap } = result.value;
            const build = BuildId.make(`bld_${crypto.randomUUID()}`);
            const requirements = yield* runner
              .declare({ ...assembleWorkerBundle(bundle, framework), protocol }, headers)
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
                  declarationFailed(cause, { mainModule: bundle.mainModule, sourceMap, files }),
                ),
                Effect.withSpan("runtime.cloud.requirements"),
              );
            const stored = yield* retainCloudBuild(
              build,
              { ...bundle, database: ownsDatabase(requirements), protocol },
              framework,
              ui,
            ).pipe(Effect.provide(RuntimeContext.phantom));
            // Only after R2 holds the build: the runner's first read of it can then skip R2 in this
            // data centre. The Cache API is per data centre, so other colos still read R2 once.
            yield* cacheRuntimeBuild(warming, origin, build, stored);
            const assets = stored.record.ui;
            return { build, requirements, ...(assets === undefined ? {} : { ui: assets }) };
          }).pipe(
            Effect.tapError((error) =>
              Effect.annotateCurrentSpan({
                "build.stage": Schema.is(BuildMemoryExceeded)(error)
                  ? "compile"
                  : Schema.is(RuntimeProtocolUnsupported)(error)
                    ? "protocol"
                    : Schema.is(RuntimeAppsDependencyMissing)(error)
                      ? "dependencies"
                      : error.stage,
                // The message quotes the deployer's source and its compiler errors, which only the
                // deployer receives; the span records which failure it was.
                "build.error": error._tag,
              }),
            ),
          ),
        ),
      asset: ({ build, path }) =>
        cloudBuildAsset(build, path).pipe(Effect.provide(RuntimeContext.phantom)),
      // Native fetch retains the upgrade response; Alchemy's typed HTTP stub omits it.
      changes: (app) =>
        dataChanges(Schema.decodeUnknownSync(NativeNamespace)(environment.AppDataSupervisor), app),
    });
    return runtimeAdapter(runtime);
  });
});
