/** Cloud composition: Postgres is authoritative; no organization data is stored in a DO. */
import { urlPolicyConfig, type HostEgress } from "@executor-js/utils/url-policy";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { makeRegistryStorage } from "@executor-js/app-registry";
import { clientMetadataSetting, hostedOAuthClientName } from "@executor-js/hosted-server";
import { hostedResourceLifecycle } from "@executor-js/hosted-server/resource-lifecycle";
import {
  createExecutor,
  httpEventSender,
  StorageError,
  makeExecutorStorage,
} from "@executor-js/sdk/core";
import { hostedEventAuthority } from "@executor-js/hosted-server/events";
import { SqlClient } from "effect/sql";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import * as Cloudflare from "alchemy/Cloudflare";
import { Context, Effect, FiberSet, Option } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { cachedDeploymentSources } from "../implementation/deployment-source-cache.ts";
import type { AppSources } from "./source.ts";
import { isolateDeclarations } from "./isolate-memory.ts";
import { cloudBlobs } from "./blobs.ts";
import { cloudWorkflows } from "./workflow-runtime.ts";
import { cloudRuntime } from "./runtime.ts";
import { durableDeclarations } from "./durable-declarations.ts";
import { InvocationDatabase } from "./invocation-database.ts";
import { cloudSecrets } from "./secrets.ts";
import { cloudHosts, cloudOrigin, cloudResourceOrigins } from "./stage.ts";
import { accountOAuthStatePrefix } from "../contracts/edge-paths.ts";
import type { AppDataSupervisor } from "./app-data.ts";

/**
 * Cloudflare offers no connect hook for global fetch, so this host cannot re-check a resolved
 * address. `global_fetch_strictly_public` on the app isolates and `parseDestination` on every
 * host-side fetch are the controls here.
 */
export const cloudEgress = Effect.gen(function* () {
  const policy = yield* urlPolicyConfig;
  const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
  return { policy, client } satisfies HostEgress;
});

/**
 * Build the executor from cloud inputs. Callers choose the app source backend: Git through the
 * API-owned token coordinator, or none where no source is read. The event's SQL client comes from
 * {@link InvocationDatabase}, shared with Better Auth. Its SQL.PostgresLayer currently returns a
 * lazy proxy: FumaDB's synchronous Statement.join cannot inspect those deferred fragments, so the
 * native client is resolved before composing ORM queries, through Alchemy's execution memo rather
 * than an isolate-global pool. Product services live in `product.ts`; nothing here decides access.
 */
export const cloudExecutor = Effect.fn(function* (
  databases: Cloudflare.DurableObject<AppDataSupervisor>,
  appSources: AppSources,
) {
  // Resolve during initialization so Alchemy binds every value into the Worker environment.
  const secrets = yield* cloudSecrets.pipe(Effect.orDie);
  const origin = yield* cloudOrigin.pipe(Effect.orDie);
  // New app webhooks register on the canonical API origin (`api.` once it is canonical); every
  // origin keeps delivering, so existing subscriptions keep the URL they stored.
  const webhookOrigin = (yield* cloudResourceOrigins.pipe(Effect.orDie)).api[0];
  const accountCallbacks = (yield* cloudHosts.pipe(Effect.orDie)).accountCallbacks;
  const egress = yield* cloudEgress;
  // Deployed stages bind this to their own document; see `clientMetadataBinding`.
  const clientMetadata = yield* clientMetadataSetting(origin).pipe(Effect.orDie);
  const makeRuntime = yield* cloudRuntime(origin);
  const workflows = yield* cloudWorkflows;
  const blobs = yield* cloudBlobs;
  // App storage, hosted permission checks and Better Auth share the event's client.
  const database = (yield* InvocationDatabase).pipe(Effect.mapError(() => new StorageError()));
  const executor = yield* makeExecutionMemo(
    Effect.gen(function* () {
      const key = yield* secrets.encryptionKey;
      const services = yield* database;
      const storage = yield* makeExecutorStorage({ provider: "postgresql" }).pipe(
        Effect.provideContext(services),
      );
      // Stale metadata refreshes and tool listings nobody waits for run beside the request, inside
      // this event's lifetime: until 20 s after it closes, when the remaining work is interrupted.
      // Work offered once the event is closing is refused, so its caller releases what it holds,
      // and work it accepted always has those 20 s.
      const refreshes = yield* FiberSet.make();
      let closing = false;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closing = true;
        }).pipe(
          Effect.andThen(FiberSet.awaitEmpty(refreshes)),
          Effect.timeoutOption("20 seconds"),
          Effect.asVoid,
        ),
      );
      const background = (work: Effect.Effect<void>) =>
        Effect.suspend(() =>
          closing ? Effect.succeed(false) : FiberSet.run(refreshes, work).pipe(Effect.as(true)),
        );
      return yield* createExecutor({
        database: storage,
        secret: key,
        origin,
        webhookOrigin,
        git: appSources(background),
        blobs: yield* cachedDeploymentSources(origin, blobs),
        runtime: yield* makeRuntime,
        workflows,
        registry: { storage: yield* makeRegistryStorage.pipe(Effect.provideContext(services)) },
        hooks: yield* hostedResourceLifecycle.pipe(Effect.provideContext(services)),
        oauth: {
          httpClient: egress.client,
          clientName: hostedOAuthClientName,
          urlPolicy: egress.policy,
          ...(Option.isSome(clientMetadata) ? { clientMetadataUrl: clientMetadata.value.url } : {}),
          // Entered clients saved before sign-ins moved to `executor.sh` keep the callback they name.
          ...(Option.isSome(accountCallbacks)
            ? { previousRedirectUris: accountCallbacks.value.previous }
            : {}),
          // v1's edge forwards `executor.sh/api/oauth/callback` to v2 by this state prefix.
          statePrefix: accountOAuthStatePrefix,
        },
        cache: {
          // One store per isolate, shared by every executor built in it.
          memory: isolateDeclarations,
          // Every isolate reads the results each app's supervisor keeps when its own store misses.
          durable: durableDeclarations(databases),
        },
        // A tool listing nobody waits for runs until the event's background work ends, and is
        // remembered as timed out if it has not finished by then.
        background,
        events: {
          sender: httpEventSender(egress),
          // The same event's client, which hosted permission checks already share.
          authorize: hostedEventAuthority(
            Effect.succeed(Context.get(services, SqlClient.SqlClient)),
          ),
          // Deployed Workers cannot reach loopback; the local development Worker can.
          allowInsecureCallbacks: egress.policy.allowLoopbackHttp,
        },
      }).pipe(Effect.provide(BrowserCrypto.layer));
    }).pipe(
      Effect.mapError(() => new StorageError()),
      Effect.withSpan("runtime.cloud.executor.initialize"),
    ),
  );
  return { executor, database };
});
