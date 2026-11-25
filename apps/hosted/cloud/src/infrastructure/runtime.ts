import { traceHeaders } from "@executor-js/telemetry";
import {
  BlobStoreError,
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
  RunnerUnanswered,
  runsInFacet,
} from "@executor-js/sdk/workerd";
import { HostRequirementsError, DeclaredRequirements, HostResponse } from "apps/contracts";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, FiberSet, Schema } from "effect";
import { dataChanges } from "../implementation/data-changes.ts";
import { runtimeActor } from "../implementation/runtime-actor.ts";
import { cacheRuntimeBuild, cachedRuntimeBuilds } from "../implementation/runtime-build-cache.ts";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { CloudCompileResult } from "../contracts/builds.ts";
import { AppCompiler } from "./compiler.ts";
import { AppData } from "./app-data-worker.ts";
import { CurrentRequest } from "./served-request.ts";
import type { AppDataSupervisor } from "./app-data.ts";
import {
  loadCloudBuildRecord,
  loadCloudFramework,
  retainCloudBuild,
  cloudBuildAsset,
} from "../implementation/build-storage.ts";

const failed = (stage: RuntimeBuildFailed["stage"], cause: unknown) =>
  new RuntimeBuildFailed({ stage, message: describeBuildCause(cause) });
const compilerDeadline = "50 seconds";
const compilerDidNotAnswer = Effect.annotateCurrentSpan(
  "build.compiler_deadline_exceeded",
  true,
).pipe(
  Effect.andThen(
    Effect.fail(
      new RuntimeBuildFailed({
        stage: "compile",
        message: `The compiler did not answer within ${compilerDeadline}. No new version was activated; deploy again.`,
        unanswered: true,
      }),
    ),
  ),
);
const withActor = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(runtimeActor, (actor) => Effect.annotateSpans(effect, actor));
const NativeNamespace = Schema.declare(
  (value): value is Pick<DurableObjectNamespace, "getByName"> =>
    typeof value === "object" &&
    value !== null &&
    "getByName" in value &&
    typeof value.getByName === "function",
);

const SupervisorRun = Schema.UndefinedOr(Schema.String);

const outboundGroups = new WeakMap<object, string>();
const outboundGroup = (unserved: object) =>
  Effect.map(CurrentRequest, (request) => {
    const key = request ?? unserved;
    const known = outboundGroups.get(key);
    if (known !== undefined) return known;
    const named = crypto.randomUUID();
    outboundGroups.set(key, named);
    return named;
  });

export const cloudRuntime = Effect.fn(function* (
  origin: string,
  databases: Cloudflare.DurableObject<AppDataSupervisor>,
) {
  const compiler = yield* Cloudflare.Workers.bindWorker(AppCompiler);
  const appData = yield* Cloudflare.Workers.bindWorker(AppData);
  const environment = yield* Cloudflare.WorkerEnvironment;
  return Effect.gen(function* () {
    const runner = remoteAppRunner({
      invoke: (invocation, capabilities) => appData.invoke(invocation, capabilities),
      declare: (bundle, headers) => appData.declare(bundle, headers),
    });
    const supervised = (app: string) =>
      remoteAppRunner({
        invoke: (invocation, capabilities) =>
          databases
            .getByName(app)
            .run(invocation, capabilities)
            .pipe(
              Effect.provide(RuntimeContext.phantom),
              Effect.flatMap(Schema.decodeUnknownEffect(SupervisorRun)),
              Effect.flatMap((reply) =>
                reply === undefined
                  ? Effect.annotateCurrentSpan(
                      "executor.runner.fallback",
                      "supervisor-without-run",
                    ).pipe(Effect.andThen(appData.invoke(invocation, capabilities)))
                  : Effect.succeed(reply),
              ),
            ),
        declare: (bundle, headers) => appData.declare(bundle, headers),
      });
    const unserved = {};
    const warming = yield* FiberSet.make();
    yield* Effect.addFinalizer(() =>
      FiberSet.awaitEmpty(warming).pipe(Effect.timeoutOption("2 seconds"), Effect.asVoid),
    );
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
      actor: runtimeActor,
      loadBuild: load,
      invoke: (invocation, capabilities) =>
        withActor(
          runsInFacet(invocation)
            ? supervised(invocation.app).invoke(invocation, capabilities)
            : Effect.flatMap(outboundGroup(unserved), (group) =>
                runner.invoke({ ...invocation, outboundGroup: group }, capabilities),
              ),
        ),
      build: ({ files, public: publicPaths = [], retain = true }) =>
        withActor(
          Effect.gen(function* () {
            const headers = Object.fromEntries(Object.entries(yield* traceHeaders));
            const result = yield* compiler.compile(files, publicPaths, headers).pipe(
              Effect.timeoutOrElse({
                duration: compilerDeadline,
                orElse: () => compilerDidNotAnswer,
              }),
              Effect.catchTag("RpcCallError", (error) => {
                const cause = error.cause;
                return Effect.fail(
                  cause instanceof Error && /^Worker exceeded memory limit\.?$/.test(cause.message)
                    ? new BuildMemoryExceeded()
                    : new RuntimeBuildFailed({
                        stage: "compile",
                        message: describeBuildCause(cause instanceof Error ? cause : error),
                        unanswered: true,
                      }),
                );
              }),
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
                  cause instanceof RunnerUnanswered
                    ? declarationFailed(
                        cause.failure,
                        { mainModule: bundle.mainModule, sourceMap, files },
                        true,
                      )
                    : declarationFailed(cause, { mainModule: bundle.mainModule, sourceMap, files }),
                ),
                Effect.withSpan("runtime.cloud.requirements"),
              );
            if (!retain) return { build, requirements };
            const stored = yield* retainCloudBuild(
              build,
              { ...bundle, database: ownsDatabase(requirements), protocol },
              framework,
              ui,
            ).pipe(Effect.provide(RuntimeContext.phantom));
            yield* cacheRuntimeBuild(warming, origin, build, stored);
            const assets = stored.record.ui;
            return { build, requirements, ...(assets === undefined ? {} : { ui: assets }) };
          }).pipe(
            Effect.tapError((error) =>
              Effect.annotateCurrentSpan({
                "build.stage": Schema.is(BlobStoreError)(error)
                  ? "retain"
                  : Schema.is(BuildMemoryExceeded)(error)
                    ? "compile"
                    : Schema.is(RuntimeProtocolUnsupported)(error)
                      ? "protocol"
                      : Schema.is(RuntimeAppsDependencyMissing)(error)
                        ? "dependencies"
                        : error.stage,
                "build.error": error._tag,
              }),
            ),
          ),
        ),
      asset: ({ build, path }) =>
        cloudBuildAsset(build, path).pipe(Effect.provide(RuntimeContext.phantom)),
      changes: (app) =>
        dataChanges(Schema.decodeUnknownSync(NativeNamespace)(environment.AppDataSupervisor), app),
    });
    return runtimeAdapter(runtime);
  });
});
