/** The hosted product's cloud services: policy, defaults and plumbing over one executor. */
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
  withExecutorAnalytics,
} from "@executor-js/hosted-server";
import type { HostedApiDocument } from "@executor-js/hosted-server/contracts";
import { AppRepositoryRecovery, RepositoryHost, StorageError } from "@executor-js/sdk/core";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { RuntimeContext } from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer } from "effect";
import { AppDomainDatabase } from "../implementation/app-domain-records.ts";
import { UiFailed } from "apps/ui/contracts";
import type { ArtifactsTokens } from "@executor-js/app-source/cloudflare";
import { cloudProductServices } from "./product-services.ts";
import { cloudAppSources } from "./source.ts";
import { cloudHosts } from "./stage.ts";
import type { AppDataSupervisor } from "./app-data.ts";

/**
 * Every hosted service the cloud Workers provide, composed over {@link cloudProductServices}. The
 * executor is the only door to SDK data; these services add the product's access policy,
 * organization defaults and the per-event SQL client for the product's own tables.
 */
export const cloudProduct = Effect.fn(function* (
  databases: Cloudflare.DurableObject<AppDataSupervisor>,
  tokens: ArtifactsTokens,
) {
  const { blobs, sdk, sql, withDatabase, services } = yield* cloudProductServices(
    databases,
    yield* cloudAppSources(tokens),
  );
  const hosts = yield* cloudHosts.pipe(Effect.orDie);
  // The default Executor app calls this deployment's API, an OAuth resource, at its canonical origin.
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
  // Keep the default management app's API document, templates and authoring files off the
  // startup path of requests that do not install it. The document depends only on the origin, so the isolate keeps the first one
  // generated for later provisioning runs instead of regenerating it per execution.
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
  // Removal tombstones share the same client. The request check that hides a
  // removed organization and the workflow's writes read the same rows.
  const removals = makeOrganizationRemovals(
    sql.pipe(Effect.mapError(() => new OrganizationRemovalUnavailable())),
  );
  return Layer.mergeAll(
    services,
    Layer.succeed(
      AppManagementHost,
      Effect.all({ executor: sdk.pipe(Effect.map(withExecutorAnalytics)), access }).pipe(
        Effect.provide(RuntimeContext.phantom),
      ),
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
