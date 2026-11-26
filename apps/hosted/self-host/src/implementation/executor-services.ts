import { hostedAppCapabilities } from "@executor-js/hosted-server/app-management";
import { executorSelfHostApiDocument } from "../contracts/api.ts";
import { AppGitOrigins, AppManagementHost } from "@executor-js/app-management";
import {
  expireIdleAgentGrants,
  runStartupDataSteps,
  startupCatalogCopyRebuild,
} from "@executor-js/app-management/data-steps";
import { SelfHostAuth, selfHostAuth } from "../auth.ts";
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
  HostedBackground,
  HostedExecutor,
  ScheduledAuthority,
  makeScheduledAuthority,
  OrganizationIcons,
  makeOrganizationIcons,
  OrganizationDefaults,
  organizationDefaults,
  noOrganizationRemovals,
  lazyHostedApiDocument,
  hostedApi,
  hostedApiRevision,
  authSettings,
  clientMetadataSetting,
  firstPartyOAuthClients,
  withDeploySetupWake,
  withExecutorAnalytics,
  executorDefaultRedeployed,
  hostedAppCopies,
  pruneToolCallLog,
} from "@executor-js/hosted-server";
import { hostedResourceLifecycle } from "@executor-js/hosted-server/resource-lifecycle";
import { hostedEventAuthority } from "@executor-js/hosted-server/events";
import { deliverEvents } from "@executor-js/sdk/scheduling";
import { markdownRefusals } from "@executor-js/sdk/markdown";
import { Digest, SecureRandom } from "effect/crypto";
import { HostedAppRuntime } from "@executor-js/hosted-server/app-ui/contracts";
import { workerdHostHandler, type RegistryRead } from "@executor-js/sdk/workerd";
import type { AppRuntime, BlobStorage, WorkflowRuntime } from "@executor-js/sdk/core";
import { Cause, Config, Effect, Layer, Option, Deferred, Schedule, Context, Scope } from "effect";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import { SqlClient } from "effect/sql";
import { productBrandConfig } from "@executor-js/utils/product-brand";

export interface SelfHostPlatform {
  readonly blobs: BlobStorage;
  readonly repositories: RepositoryBackend;
  readonly runtime: AppRuntime;
  readonly workflows: WorkflowRuntime;
  readonly declarations: DurableDeclarations;
  readonly readRegistry: RegistryRead;
}

export class SelfHostWorkflowRequests extends Context.Service<
  SelfHostWorkflowRequests,
  Effect.Success<ReturnType<typeof workerdHostHandler>>
>()("self-host/WorkflowRequests") {}

export class SelfHostRegistry extends Context.Service<SelfHostRegistry, RegistryRead>()(
  "self-host/Registry",
) {}

export const selfHostExecutorServices = <E, R>(
  egress: HostEgress,
  acquire: (executor: Effect.Effect<Executor>) => Effect.Effect<SelfHostPlatform, E, R>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const key = yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY");
      const settings = yield* authSettings;
      const origin = settings.url;
      const accountCallback = settings.oauthRedirectUri;
      const clientMetadata = yield* clientMetadataSetting({
        origin,
        oauthRedirectUri: Option.getOrUndefined(accountCallback),
      });
      const firstPartyClients = yield* firstPartyOAuthClients({
        registrations: "operator",
        testDefinitions:
          (yield* Config.String("EXECUTOR_ENVIRONMENT").pipe(Config.withDefault(""))) === "e2e",
      });
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      const evaluation = yield* declarationConfig;
      const server = yield* Scope.Scope;
      const background = (work: Effect.Effect<void>) =>
        Effect.forkIn(work, server).pipe(Effect.as(true));
      const ready = yield* Deferred.make<Executor>();
      const { runtime, workflows, declarations, blobs, repositories, readRegistry } =
        yield* acquire(Deferred.await(ready));
      const registry = remoteRegistry(
        yield* Config.String("EXECUTOR_REGISTRY_URL").pipe(
          Config.withDefault(hostedExecutorOrigin),
        ),
      );
      const lifecycle = yield* hostedResourceLifecycle;
      const api = lazyHostedApiDocument(() => executorSelfHostApiDocument(origin));
      const revision = yield* hostedApiRevision(yield* api.body).pipe(
        Effect.provide(Digest.layerWebCrypto),
      );
      const executor = yield* createExecutor({
        database: storage,
        secret: key,
        origin,
        git: repositories,
        markdown: markdownRefusals,
        blobs,
        runtime,
        workflows,
        registry,
        hooks: lifecycle.hooks,
        oauth: {
          httpClient: egress.client,
          clientName: (yield* productBrandConfig).name,
          urlPolicy: egress.policy,
          ...(Option.isSome(clientMetadata)
            ? {
                clientMetadataUrl: clientMetadata.value.url,
                clientMetadataRedirectUri: clientMetadata.value.redirectUri,
              }
            : {}),
          ...(Option.isSome(accountCallback)
            ? { savedClientCallbacks: [accountCallback.value] }
            : {}),
          firstPartyClients,
        },
        cache: {
          memory: makeDeclarationCache(evaluation.limits),
          durable: declarations,
          toolListings: evaluation.toolListings,
        },
        hostApi: hostedApi([origin], revision),
        background,
        events: {
          sender: httpEventSender(egress),
          authorize: hostedEventAuthority(Effect.succeed(yield* SqlClient.SqlClient)),
          allowInsecureCallbacks: egress.policy.allowLoopbackHttp,
        },
      }).pipe(Effect.provide([SecureRandom.layerWebCrypto, Digest.layerWebCrypto]));
      yield* lifecycle.attach(executor, { requireVerifiedEmail: false });
      yield* Deferred.succeed(ready, executor);
      yield* Effect.forkScoped(deliverEvents(executor));
      const auth = yield* selfHostAuth;
      const catalogCopyRebuild = yield* startupCatalogCopyRebuild;
      yield* runStartupDataSteps(
        {
          executor,
          blobs,
          agentGrants: auth.agentGrants,
          executorAppRedeployed: executorDefaultRedeployed(Effect.void),
          appCopies: hostedAppCopies(executor),
          ...(catalogCopyRebuild === undefined ? {} : { catalogCopyRebuild }),
        },
        "private_hosted",
      );
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
      yield* Effect.forkScoped(
        pruneToolCallLog.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logWarning("Tool call log pruning failed", cause),
          ),
          Effect.repeat(Schedule.spaced("5 minutes")),
        ),
      );
      const initialize = yield* organizationDefaults(executor, origin, api.document, false);
      const scheduleAuthority = yield* makeScheduledAuthority(executor);
      const hosted = withDeploySetupWake(withExecutorAnalytics(executor));
      const groupDatabase = yield* SqlClient.SqlClient;
      const workflowRequests = yield* workerdHostHandler({
        executor: Effect.succeed(executor),
        blobs,
      });
      return Layer.mergeAll(
        Layer.succeed(SelfHostWorkflowRequests, workflowRequests),
        Layer.succeed(SelfHostRegistry, readRegistry),
        Layer.succeed(SelfHostAuth, auth),
        Layer.succeed(ScheduledAuthority, scheduleAuthority),
        Layer.succeed(GroupDatabase, Effect.succeed(groupDatabase)),
        Layer.succeed(OrganizationIcons, makeOrganizationIcons(blobs)),
        Layer.succeed(AppGitOrigins, () => [new URL(origin).origin]),
        Layer.succeed(
          AppManagementHost,
          Effect.succeed({
            executor: hosted,
            access: yield* hostedAppCapabilities,
          }),
        ),
        Layer.succeed(HostedExecutor, Effect.succeed(hosted)),
        Layer.succeed(HostedBackground, background),
        Layer.succeed(OrganizationDefaults, initialize),
        Layer.succeed(HostedAppRuntime, toEffectRuntime(runtime, blobs)),
        noOrganizationRemovals,
      );
    }),
  );
