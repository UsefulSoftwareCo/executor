import { hostedAppCapabilities } from "@executor-js/hosted-server/app-management";
import { executorSelfHostApiDocument } from "../contracts/api.ts";
import { AppGitOrigins, AppManagementHost } from "@executor-js/app-management";
import { expireIdleAgentGrants, runStartupDataSteps } from "@executor-js/app-management/data-steps";
import { SelfHostAuth, selfHostAuth } from "../auth.ts";
/** Self-host SDK uses the same PGlite connection as Better Auth. */
import type { HostEgress } from "@executor-js/utils/url-policy";
import {
  createExecutor,
  toEffectRuntime,
  makeExecutorStorage,
  WorkflowHost,
  RepositoryHost,
  makeDeclarationCache,
  declarationConfig,
  hostedExecutorOrigin,
  remoteRegistry,
  httpEventSender,
  type DurableDeclarations,
  type Executor,
  type RepositoryBackend,
} from "@executor-js/sdk/core";
import {
  HostedExecutor,
  ScheduledAuthority,
  makeScheduledAuthority,
  OrganizationIcons,
  makeOrganizationIcons,
  OrganizationDefaults,
  organizationDefaults,
  noOrganizationRemovals,
  lazyHostedApiDocument,
  clientMetadataSetting,
  firstPartyOAuthClients,
  hostedOAuthClientName,
  withDeploySetupWake,
  withExecutorAnalytics,
  executorDefaultRedeployed,
} from "@executor-js/hosted-server";
import { hostedResourceLifecycle } from "@executor-js/hosted-server/resource-lifecycle";
import { hostedEventAuthority } from "@executor-js/hosted-server/events";
import { deliverEvents } from "@executor-js/sdk/scheduling";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { HostedAppRuntime } from "@executor-js/hosted-server/app-ui/contracts";
import { workerdHostHandler } from "@executor-js/sdk/workerd";
import type { AppRuntime, BlobStorage, WorkflowRuntime } from "@executor-js/sdk/core";
import { Config, Effect, Layer, Option, Deferred, Schedule, Context, Scope } from "effect";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import { SqlClient } from "effect/sql";

/** Native resources supplied at the self-host composition boundary. */
export interface SelfHostPlatform {
  readonly blobs: BlobStorage;
  readonly repositories: RepositoryBackend;
  readonly runtime: AppRuntime;
  readonly workflows: WorkflowRuntime;
  /** Evaluated results kept in each app's data supervisor. */
  readonly declarations: DurableDeclarations;
}

/** Private callback surface for app workflows, exposed only through a service binding. */
export class SelfHostWorkflowRequests extends Context.Service<
  SelfHostWorkflowRequests,
  Effect.Success<ReturnType<typeof workerdHostHandler>>
>()("self-host/WorkflowRequests") {}

/** Database initialization finishes before this service is acquired. */
export const selfHostExecutorServices = <E, R>(
  egress: HostEgress,
  acquire: (executor: Effect.Effect<Executor>) => Effect.Effect<SelfHostPlatform, E, R>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const key = yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY");
      const origin = yield* Config.String("BETTER_AUTH_URL");
      const clientMetadata = yield* clientMetadataSetting(origin);
      const firstPartyClients = yield* firstPartyOAuthClients;
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      const evaluation = yield* declarationConfig;
      const server = yield* Scope.Scope;
      const ready = yield* Deferred.make<Executor>();
      const { runtime, workflows, declarations, blobs, repositories } = yield* acquire(
        Deferred.await(ready),
      );
      const registry = remoteRegistry(
        yield* Config.String("EXECUTOR_REGISTRY_URL").pipe(
          Config.withDefault(hostedExecutorOrigin),
        ),
      );
      const executor = yield* createExecutor({
        database: storage,
        secret: key,
        origin,
        git: repositories,
        blobs,
        runtime,
        workflows,
        registry,
        hooks: yield* hostedResourceLifecycle,
        oauth: {
          httpClient: egress.client,
          clientName: hostedOAuthClientName,
          urlPolicy: egress.policy,
          ...(Option.isSome(clientMetadata) ? { clientMetadataUrl: clientMetadata.value.url } : {}),
          firstPartyClients,
        },
        cache: {
          memory: makeDeclarationCache(evaluation.limits),
          // Kept in each app's supervisor too, so a restart does not evaluate every app again.
          durable: declarations,
          toolListings: evaluation.toolListings,
        },
        // Stale declarations refresh on the server's own lifetime.
        background: (work) => Effect.forkIn(work, server).pipe(Effect.as(true)),
        events: {
          sender: httpEventSender(egress),
          authorize: hostedEventAuthority(Effect.succeed(yield* SqlClient.SqlClient)),
          allowInsecureCallbacks: egress.policy.allowLoopbackHttp,
        },
      }).pipe(Effect.provide(BrowserCrypto.layer));
      yield* Deferred.succeed(ready, executor);
      yield* Effect.forkScoped(deliverEvents(executor));
      // The schema is current and nothing serves or builds yet; the caller holds the data lock.
      const auth = yield* selfHostAuth;
      yield* runStartupDataSteps(
        {
          executor,
          blobs,
          agentGrants: auth.agentGrants,
          // Nothing sets profiles up yet: the schedule worker starts after these steps, and its
          // first pass sets up the profiles a redeploy left pending.
          executorAppRedeployed: executorDefaultRedeployed(Effect.void),
        },
        "private_hosted",
      );
      // Once the idle grant step has applied, revoke grants that became idle since, daily.
      yield* Effect.forkScoped(
        expireIdleAgentGrants(auth.agentGrants, "private_hosted").pipe(
          Effect.catch(() => Effect.logWarning("Idle agent grant expiry failed")),
          Effect.repeat(Schedule.spaced("1 day")),
        ),
      );
      yield* Effect.forkScoped(
        executor[RepositoryHost].recover.pipe(
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
        lazyHostedApiDocument(() => executorSelfHostApiDocument(origin)).document,
        // Password registration is admitted locally; self-host does not send verification mail.
        false,
      );
      const scheduleAuthority = yield* makeScheduledAuthority(executor);
      // Records and wakes setup only inside requests that carry this instance's analytics sink
      // and schedule wake.
      const hosted = withDeploySetupWake(withExecutorAnalytics(executor));
      const groupDatabase = yield* SqlClient.SqlClient;
      const workflowRequests = yield* workerdHostHandler({
        executor: Effect.succeed(executor),
        blobs,
      });
      return Layer.mergeAll(
        Layer.succeed(SelfHostWorkflowRequests, workflowRequests),
        Layer.succeed(SelfHostAuth, auth),
        Layer.succeed(ScheduledAuthority, scheduleAuthority),
        Layer.succeed(GroupDatabase, Effect.succeed(groupDatabase)),
        Layer.succeed(OrganizationIcons, makeOrganizationIcons(blobs)),
        // Self-host serves Git, like everything else, on its one origin.
        Layer.succeed(AppGitOrigins, () => [new URL(origin).origin]),
        Layer.succeed(
          AppManagementHost,
          Effect.succeed({
            executor: hosted,
            access: yield* hostedAppCapabilities,
          }),
        ),
        Layer.succeed(HostedExecutor, Effect.succeed(hosted)),
        Layer.succeed(OrganizationDefaults, initialize),
        Layer.succeed(HostedAppRuntime, toEffectRuntime(runtime, blobs)),
        // Self-host cannot remove an organization.
        noOrganizationRemovals,
      );
    }),
  );
