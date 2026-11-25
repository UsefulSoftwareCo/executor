import { urlPolicyConfig, type HostEgress } from "@executor-js/utils/url-policy";
import { Digest, SecureRandom } from "effect/crypto";
import { makeRegistryStorage } from "@executor-js/app-registry";
import {
  firstPartyOAuthClients,
  hostedApi,
  hostedApiRevision,
  hostedOAuthClientName,
} from "@executor-js/hosted-server";
import { servesBuiltApiDocument } from "../contracts/browser.ts";
import api from "../../.generated/executor-api-revision.json" with { type: "json" };
import { hostedResourceLifecycle } from "@executor-js/hosted-server/resource-lifecycle";
import {
  createExecutor,
  declarationConfig,
  httpEventSender,
  StorageError,
  makeExecutorStorage,
  type MarkdownReader,
} from "@executor-js/sdk/core";
import { hostedEventAuthority } from "@executor-js/hosted-server/events";
import { SqlClient } from "effect/sql";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import * as Cloudflare from "alchemy/Cloudflare";
import { Context, Effect, FiberSet, Option } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { cachedVersionSources } from "../implementation/version-source-cache.ts";
import { organizationPublishers } from "../implementation/publishers.ts";
import type { AppSources } from "./source.ts";
import { isolateDeclarations } from "./isolate-memory.ts";
import { cloudBlobs } from "./blobs.ts";
import { cloudWorkflows } from "./workflow-runtime.ts";
import { cloudRuntime } from "./runtime.ts";
import { durableDeclarations } from "./durable-declarations.ts";
import { InvocationDatabase } from "./invocation-database.ts";
import { backgroundWait, CurrentRequest, ownTelemetryScope } from "./served-request.ts";
import { TelemetryDrainScope, TelemetryWaitReport } from "@executor-js/telemetry";
import { cloudSecrets } from "./secrets.ts";
import {
  cloudOrigin,
  cloudOwnerRevocationBudget,
  cloudResourceOrigins,
  productionStage,
  stageName,
} from "./stage.ts";
import { cloudEmulators } from "./emulators.ts";
import { missingFirstPartyGitHubClient } from "./first-party-oauth-settings.ts";
import { cloudAccountSignIns } from "../implementation/oauth-proxy-settings.ts";
import { cloudClientMetadata } from "./client-metadata.ts";
import type { AppDataSupervisor } from "./app-data.ts";

export const cloudEgress = Effect.gen(function* () {
  const policy = yield* urlPolicyConfig;
  const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
  return { policy, client } satisfies HostEgress;
});

const cloudFirstPartyOAuthClients = Effect.gen(function* () {
  const emulated = Option.isSome(yield* cloudEmulators);
  const clients = yield* firstPartyOAuthClients({
    testDefinitions: emulated,
    registrations: "executor",
  });
  const production = Option.getOrUndefined(yield* stageName) === productionStage;
  if (production && !clients.some((client) => client.id === "github"))
    return yield* Effect.die(new Error(missingFirstPartyGitHubClient));
  return clients;
});

export const cloudExecutor = Effect.fn(function* (
  databases: Cloudflare.DurableObject<AppDataSupervisor>,
  appSources: AppSources,
  markdown: MarkdownReader,
) {
  const secrets = yield* cloudSecrets.pipe(Effect.orDie);
  const origin = yield* cloudOrigin.pipe(Effect.orDie);
  const resourceOrigins = yield* cloudResourceOrigins.pipe(Effect.orDie);
  const webhookOrigin = resourceOrigins.api[0];
  const apiOrigin = resourceOrigins.api[0];
  const apiRevision =
    apiOrigin === undefined || servesBuiltApiDocument(apiOrigin)
      ? api.revision
      : yield* Effect.promise(() => import("../implementation/default-app.ts")).pipe(
          Effect.flatMap(({ executorCloudApiDocument }) =>
            hostedApiRevision(JSON.stringify(executorCloudApiDocument(apiOrigin))),
          ),
          Effect.provide(Digest.layerWebCrypto),
        );
  const accountSignIns = yield* cloudAccountSignIns.pipe(Effect.orDie);
  const egress = yield* cloudEgress;
  const clientMetadata = yield* cloudClientMetadata.pipe(Effect.orDie);
  const firstPartyClients = yield* cloudFirstPartyOAuthClients.pipe(Effect.orDie);
  const { toolListings } = yield* declarationConfig.pipe(Effect.orDie);
  const ownerRevocationBudget = yield* cloudOwnerRevocationBudget(
    (yield* Cloudflare.WorkerEnvironment).REMOVAL_REVOCATION_BUDGET_SWITCH === true,
  ).pipe(Effect.orDie);
  const makeRuntime = yield* cloudRuntime(origin, databases);
  const workflows = yield* cloudWorkflows;
  const blobs = yield* cloudBlobs;
  const database = (yield* InvocationDatabase).pipe(Effect.mapError(() => new StorageError()));
  const backgroundWork = yield* makeExecutionMemo(
    Effect.gen(function* () {
      yield* database;
      const scope = yield* Effect.scope;
      const fibers = yield* FiberSet.make();
      const drained = FiberSet.awaitEmpty(fibers);
      const served = yield* CurrentRequest;
      let closing = false;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closing = true;
        }).pipe(
          Effect.andThen(
            served?.scope === scope
              ? served.bounded(drained, "background")
              : Effect.asVoid(Effect.timeoutOption(drained, backgroundWait)),
          ),
        ),
      );
      const join = Effect.flatMap(CurrentRequest, (request) =>
        request === undefined || request.scope === scope ? Effect.void : request.join(drained),
      );
      return (work: Effect.Effect<void>) =>
        Effect.suspend(() =>
          closing
            ? Effect.succeed(false)
            : FiberSet.run(fibers, work).pipe(Effect.andThen(join), Effect.as(true)),
        );
    }),
  );
  const background = (work: Effect.Effect<void>) =>
    backgroundWork.pipe(
      Effect.flatMap((run) => run(work)),
      Effect.catchTag("StorageError", () => Effect.succeed(false)),
    );
  const executor = yield* makeExecutionMemo(
    Effect.gen(function* () {
      const key = yield* secrets.encryptionKey;
      const services = yield* database;
      const storage = yield* makeExecutorStorage({ provider: "postgresql" }).pipe(
        Effect.provideContext(services),
      );
      const lifecycle = yield* hostedResourceLifecycle.pipe(Effect.provideContext(services));
      const executor = yield* createExecutor({
        database: storage,
        secret: key,
        origin,
        webhookOrigin,
        git: appSources(background),
        markdown,
        blobs: yield* cachedVersionSources(origin, blobs),
        runtime: yield* Effect.flatMap(ownTelemetryScope, (own) =>
          makeRuntime.pipe(
            Effect.provideService(TelemetryDrainScope, own),
            own === undefined
              ? Effect.provideService(TelemetryWaitReport, () => Effect.void)
              : (runtime) => runtime,
          ),
        ),
        workflows,
        registry: {
          storage: yield* Effect.flatMap(organizationPublishers, makeRegistryStorage).pipe(
            Effect.provideContext(services),
          ),
        },
        hooks: lifecycle.hooks,
        hostApi: hostedApi(resourceOrigins.api, apiRevision),
        oauth: {
          httpClient: egress.client,
          clientName: hostedOAuthClientName,
          urlPolicy: egress.policy,
          ...(Option.isSome(clientMetadata)
            ? {
                clientMetadataUrl: clientMetadata.value.url,
                clientMetadataRedirectUri: clientMetadata.value.redirectUri,
              }
            : {}),
          ...(Option.isSome(accountSignIns.callbacks)
            ? {
                previousRedirectUris: accountSignIns.callbacks.value.previous,
                savedClientCallbacks: [accountSignIns.callbacks.value.current],
              }
            : {}),
          statePrefix: accountSignIns.statePrefix,
          firstPartyClients,
        },
        cache: {
          memory: isolateDeclarations,
          durable: durableDeclarations(databases),
          toolListings,
        },
        background,
        ...(ownerRevocationBudget === undefined ? {} : { ownerRevocationBudget }),
        events: {
          sender: httpEventSender(egress),
          authorize: hostedEventAuthority(
            Effect.succeed(Context.get(services, SqlClient.SqlClient)),
          ),
          allowInsecureCallbacks: egress.policy.allowLoopbackHttp,
        },
      }).pipe(Effect.provide([SecureRandom.layerWebCrypto, Digest.layerWebCrypto]));
      yield* lifecycle.attach(executor);
      return executor;
    }).pipe(
      Effect.mapError(() => new StorageError()),
      Effect.withSpan("runtime.cloud.executor.initialize"),
    ),
  );
  return { executor, database, background };
});
