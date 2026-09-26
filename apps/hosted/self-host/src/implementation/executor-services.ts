import { hostedAppCapabilities } from "@executor-js/hosted-server/app-management";
import { executorSelfHostApiDocument } from "../contracts/api.ts";
import { AppManagementHost } from "@executor-js/app-management";
import { hostedExecutorOrigin, remoteRegistry } from "@executor-js/app-registry";
import { gitSourceStorage } from "@executor-js/app-source";
import type { RepositoryBackend } from "@executor-js/app-source";
/** Self-host SDK uses the same PGlite connection as Better Auth. */
import type { HostEgress } from "@executor-js/utils/url-policy";
import {
  toEffectRuntime,
  makeExecutorStorage,
  WorkflowHost,
  recoverAppRepositories,
  type Executor,
  type SourceFile,
} from "@executor-js/sdk/core";
import {
  HostedExecutor,
  ScheduledAuthority,
  makeScheduledAuthority,
  OrganizationIcons,
  makeOrganizationIcons,
  OrganizationDefaults,
  organizationDefaults,
} from "@executor-js/hosted-server";
import { postgresExecutor } from "@executor-js/hosted-server/database";
import { HostedAppRuntime } from "@executor-js/hosted-server/app-ui/contracts";
import { workerdHostHandler } from "@executor-js/sdk/workerd";
import type { AppRuntime, BlobStorage, WorkflowRuntime } from "@executor-js/sdk/core";
import { Config, Effect, Layer, Option, Deferred, Schedule, Context } from "effect";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import { SqlClient } from "effect/unstable/sql";

/** Native resources supplied at the self-host composition boundary. */
export interface SelfHostPlatform {
  readonly blobs: BlobStorage;
  readonly repositories: RepositoryBackend;
  readonly runtime: AppRuntime;
  readonly workflows: WorkflowRuntime;
}

/** Private callback surface for app workflows, exposed only through a service binding. */
export class SelfHostWorkflowRequests extends Context.Service<
  SelfHostWorkflowRequests,
  Effect.Success<ReturnType<typeof workerdHostHandler>>
>()("self-host/WorkflowRequests") {}

/** Database initialization finishes before this service is acquired. */
export const selfHostExecutorServices = <E, R>(
  skills: readonly SourceFile[],
  egress: HostEgress,
  acquire: (executor: Effect.Effect<Executor>) => Effect.Effect<SelfHostPlatform, E, R>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const key = yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY");
      const origin = yield* Config.String("BETTER_AUTH_URL");
      const clientMetadataUrl = yield* Config.String("EXECUTOR_OAUTH_CLIENT_METADATA_URL").pipe(
        Config.option,
        Config.map(Option.getOrUndefined),
      );
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      const ready = yield* Deferred.make<Executor>();
      const { runtime, workflows, blobs, repositories } = yield* acquire(Deferred.await(ready));
      const registry = remoteRegistry(
        yield* Config.String("EXECUTOR_REGISTRY_URL").pipe(
          Config.withDefault(hostedExecutorOrigin),
        ),
      );
      const sources = gitSourceStorage(repositories);
      const executor = yield* postgresExecutor(
        key,
        runtime,
        blobs,
        sources,
        {
          httpClient: egress.client,
          urlPolicy: egress.policy,
          ...(clientMetadataUrl === undefined ? {} : { clientMetadataUrl }),
        },
        { storage, webhookOrigin: origin, workflows },
      );
      yield* Deferred.succeed(ready, executor);
      yield* Effect.forkScoped(
        recoverAppRepositories({ database: storage, sources, blobs }).pipe(
          Effect.catch(() => Effect.logWarning("App repository recovery failed")),
          Effect.repeat(Schedule.spaced("10 seconds")),
        ),
      );
      yield* Effect.forkScoped(
        executor[WorkflowHost].reconcile.pipe(
          Effect.catch(() => Effect.logWarning("Workflow queue reconciliation failed")),
          Effect.repeat(Schedule.spaced("5 seconds")),
        ),
      );
      const initialize = yield* organizationDefaults(
        executor,
        origin,
        storage,
        skills,
        executorSelfHostApiDocument(origin),
        // Password registration is admitted locally; self-host does not send verification mail.
        false,
      );
      const scheduleAuthority = yield* makeScheduledAuthority(executor);
      const groupDatabase = yield* SqlClient.SqlClient;
      const workflowRequests = yield* workerdHostHandler({
        executor: Effect.succeed(executor),
        blobs,
      });
      return Layer.mergeAll(
        Layer.succeed(SelfHostWorkflowRequests, workflowRequests),
        Layer.succeed(ScheduledAuthority, scheduleAuthority),
        Layer.succeed(GroupDatabase, Effect.succeed(groupDatabase)),
        Layer.succeed(OrganizationIcons, makeOrganizationIcons(blobs)),
        Layer.succeed(
          AppManagementHost,
          Effect.succeed({
            executor,
            sources,
            repositories,
            registry,
            blobs,
            publisher: undefined,
            access: yield* hostedAppCapabilities,
          }),
        ),
        Layer.succeed(HostedExecutor, Effect.succeed(executor)),
        Layer.succeed(OrganizationDefaults, initialize),
        Layer.succeed(HostedAppRuntime, toEffectRuntime(runtime, blobs)),
      );
    }),
  );
