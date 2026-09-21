import { executorSelfHostApiDocument } from "./contracts/api.ts";
import { AppManagementHost } from "@executor-js/app-management";
import { remoteRegistry } from "@executor-js/app-registry";
import { gitSourceStorage } from "@executor-js/app-source";
import { nativeRepositories } from "@executor-js/app-source/node";
/** Self-host SDK uses the same PGlite connection as Better Auth. */
import type { HostEgress } from "@executor-js/utils/url-policy";
import {
  toEffectRuntime,
  makeExecutorStorage,
  WorkflowHost,
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
import { filesystemBlobStore, workerdApps } from "@executor-js/sdk/node";
import { Config, Effect, Layer, Option, Path, Deferred, Schedule } from "effect";
import {
  allowPrivateAppFetch as allowPrivateAppFetchFor,
  dataDirectory,
} from "./contracts/config.ts";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import { SqlClient } from "effect/unstable/sql";

/** Database initialization finishes before this service is acquired. */
export const selfHostExecutor = (skills: readonly SourceFile[], egress: HostEgress) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* dataDirectory;
      const key = yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY");
      const origin = yield* Config.String("BETTER_AUTH_URL");
      // Match hosted Cloudflare wherever the dashboard origin is public. An operator whose apps
      // must call an internal service opts in, accepting that app code then shares this network.
      const allowPrivateAppFetch = yield* allowPrivateAppFetchFor(origin);
      const clientMetadataUrl = yield* Config.String("EXECUTOR_OAUTH_CLIENT_METADATA_URL").pipe(
        Config.option,
        Config.map(Option.getOrUndefined),
      );
      const blobs = filesystemBlobStore({ directory: path.resolve(directory, "builds") });
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      const ready = yield* Deferred.make<Executor>();
      const { runtime, workflows } = yield* workerdApps({
        directory: path.resolve(directory, "workerd"),
        blobs,
        executor: Deferred.await(ready),
        legacyDataDirectories: [
          path.resolve(directory, "app-data"),
          path.resolve(directory, "workflow-engine"),
        ],
        allowPrivateAppFetch,
      });
      const registry = remoteRegistry(
        yield* Config.String("EXECUTOR_REGISTRY_URL").pipe(
          Config.withDefault("https://v2.executor.sh"),
        ),
      );
      const repositories = nativeRepositories(path.resolve(directory, "repositories"));
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
      );
      const scheduleAuthority = yield* makeScheduledAuthority(executor);
      const groupDatabase = yield* SqlClient.SqlClient;
      return Layer.mergeAll(
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
          }),
        ),
        Layer.succeed(HostedExecutor, Effect.succeed(executor)),
        Layer.succeed(OrganizationDefaults, initialize),
        Layer.succeed(HostedAppRuntime, toEffectRuntime(runtime, blobs)),
      );
    }),
  );
