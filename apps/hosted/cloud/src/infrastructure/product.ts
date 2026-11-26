import { hostedAppCapabilities } from "@executor-js/hosted-server/app-management";
import { AppGitOrigins, AppManagementHost } from "@executor-js/app-management";
import {
  ScheduledAuthority,
  makeScheduledAuthority,
  OrganizationIcons,
  makeOrganizationIcons,
  OrganizationDefaults,
  makeOrganizationRemovals,
  OrganizationRemovals,
  OrganizationRemovalUnavailable,
  OrganizationTombstones,
  withDeploySetupWake,
  withExecutorAnalytics,
} from "@executor-js/hosted-server";
import type { HostedApiDocument } from "@executor-js/hosted-server/contracts";
import { AppRepositoryRecovery, RepositoryHost, StorageError } from "@executor-js/sdk/core";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { RuntimeContext } from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer } from "effect";
import { AppDomainDatabase } from "../implementation/app-domain-records.ts";
import { RemovedOrganizations } from "../implementation/organization-removal.ts";
import { UiFailed } from "apps/ui/contracts";
import type { ArtifactsTokens } from "@executor-js/app-source/cloudflare";
import { cloudMarkdownReader } from "./markdown-reader.ts";
import { cloudProductServices } from "./product-services.ts";
import { cloudAppSources } from "./source.ts";
import { cloudHosts } from "./stage.ts";
import type { AppDataSupervisor } from "./app-data.ts";

export const cloudProduct = Effect.fn(function* (
  databases: Cloudflare.DurableObject<AppDataSupervisor>,
  tokens: ArtifactsTokens,
) {
  const { blobs, sdk, sql, withDatabase, services } = yield* cloudProductServices(
    databases,
    yield* cloudAppSources(tokens),
    yield* cloudMarkdownReader,
  );
  const hosts = yield* cloudHosts.pipe(Effect.orDie);
  const apiOrigin = hosts.resourceOrigins.api[0];
  const access = yield* makeExecutionMemo(
    withDatabase(hostedAppCapabilities).pipe(Effect.mapError(() => new StorageError())),
  );
  const scheduleAuthority = yield* makeExecutionMemo(
    sdk.pipe(
      Effect.flatMap((executor) => withDatabase(makeScheduledAuthority(executor))),
      Effect.mapError(() => new StorageError()),
    ),
  );
  let document: HostedApiDocument | undefined;
  const defaults = yield* makeExecutionMemo(
    Effect.gen(function* () {
      const { defaultApp, executorCloudApiDocument } = yield* Effect.promise(
        () => import("../implementation/default-app.ts"),
      );
      return yield* withDatabase(
        defaultApp(
          yield* sdk,
          apiOrigin,
          Effect.sync(() => (document ??= executorCloudApiDocument(apiOrigin))),
        ),
      );
    }).pipe(
      Effect.mapError(() => new StorageError()),
      Effect.withSpan("runtime.cloud.defaults.initialize"),
    ),
  );
  const removals = makeOrganizationRemovals(
    sql.pipe(Effect.mapError(() => new OrganizationRemovalUnavailable())),
  );
  return Layer.mergeAll(
    services,
    Layer.succeed(
      AppManagementHost,
      Effect.all({
        executor: sdk.pipe(
          Effect.map((executor) => withDeploySetupWake(withExecutorAnalytics(executor))),
        ),
        access,
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    ),
    Layer.succeed(AppGitOrigins, () => hosts.gitOrigins),
    Layer.succeed(ScheduledAuthority, (target) =>
      scheduleAuthority.pipe(
        Effect.flatMap((authority) => authority(target)),
        Effect.provide(RuntimeContext.phantom),
      ),
    ),
    Layer.succeed(
      AppRepositoryRecovery,
      sdk.pipe(Effect.flatMap((executor) => executor[RepositoryHost].recover)),
    ),
    Layer.succeed(OrganizationRemovals, removals.removals),
    Layer.succeed(OrganizationTombstones, removals.tombstones),
    Layer.succeed(RemovedOrganizations, removals.removed),
    Layer.succeed(
      AppDomainDatabase,
      sql.pipe(Effect.mapError(() => new UiFailed({ reason: "unavailable" }))),
    ),
    Layer.succeed(OrganizationIcons, makeOrganizationIcons(blobs)),
    Layer.succeed(
      OrganizationDefaults,
      OrganizationDefaults.of((organization, user) =>
        defaults.pipe(
          Effect.flatMap((initialize) => initialize(organization, user)),
          Effect.provide(RuntimeContext.phantom),
        ),
      ),
    ),
  );
});
