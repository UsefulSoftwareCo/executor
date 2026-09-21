/** App use cases and routes. Hosts supply an SDK; they do not enumerate these operations. */
import { CatalogImportFailed, type RemoteCustomAppInput } from "@executor-js/catalog";
import {
  type AppId,
  type DeploymentId,
  type OwnerId,
  type SelectedAccounts,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import { scopeGeneratedPackage } from "@executor-js/app-registry";
import { CurrentOrganizationNamespace } from "../contracts/organization.ts";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HostedApi } from "../contracts/api.ts";
import type { DeployApp, InstallApp } from "../contracts/apps.ts";
import { HostedCatalog } from "../contracts/catalog.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { adminOwner, checkAccounts, currentOwner, selectedApp } from "./access.ts";

/** Prepare ordinary source and create an app without replacing an existing name. */
export const installApp = (owner: OwnerId, input: typeof InstallApp.Type) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const catalog = yield* HostedCatalog;
    const generated = yield* catalog.prepare(input);
    const namespace = yield* Effect.flatten(CurrentOrganizationNamespace);
    const files = yield* scopeGeneratedPackage(generated.files, namespace, input.name).pipe(
      Effect.mapError(
        () =>
          new CatalogImportFailed({
            reason: "The app package could not be named for this organization.",
          }),
      ),
    );
    return (yield* executor.apps.deploy({ owner, name: input.name, files })).app;
  });
/**
 * Generate remote protocol source and create an organization app without replacing a name.
 * A tenant-supplied import URL is fetched by the host, so it stays on public destinations.
 * Operators who need an internal definition deploy its source instead.
 */
export const importCustomApp = (owner: OwnerId, input: RemoteCustomAppInput) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const catalog = yield* HostedCatalog;
    const generated = yield* catalog.custom(input);
    const namespace = yield* Effect.flatten(CurrentOrganizationNamespace);
    const files = yield* scopeGeneratedPackage(generated.files, namespace, input.name).pipe(
      Effect.mapError(
        () =>
          new CatalogImportFailed({
            reason: "The app package could not be named for this organization.",
          }),
      ),
    );
    return (yield* executor.apps.deploy({ owner, name: input.name, files })).app;
  });
/** Direct source deployment uses the same create-only operation as a catalog install. */
export const deployApp = (owner: OwnerId, input: typeof DeployApp.Type) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    return (yield* executor.apps.deploy({ ...input, owner })).app;
  });
/** Read a configured app only within its authenticated organization. */
export const getApp = (owner: OwnerId, input: { readonly app: AppId }) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* executor.apps.get({ ...input, owner });
  });
/** Validate organization ownership before saving reusable account selections. */
export const selectAccounts = (
  owner: OwnerId,
  input: { readonly app: AppId; readonly accounts: SelectedAccounts },
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* executor.apps.get({ owner, app: input.app });
    yield* checkAccounts(executor, owner, input.accounts);
    return yield* executor.apps.update(input);
  });
/** Retained source is administrative data; deployments from other owners stay private. */
export const appDeployments = (owner: OwnerId, app: AppId) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* executor.apps.deployments({ owner, app, deploymentOwner: owner });
  });
/** An explicit app and optional version select source, never a free-standing deployment ID. */
export const appSource = (owner: OwnerId, app: AppId, deployment?: DeploymentId) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* executor.apps.source({
      owner,
      deploymentOwner: owner,
      app,
      ...(deployment === undefined ? {} : { deployment }),
    });
  });
/** Activation moves a pointer; it never rewinds app data or upstream side effects. */
export const activateApp = (
  owner: OwnerId,
  app: AppId,
  deployment: DeploymentId,
  expectedDeployment: DeploymentId | null,
) =>
  Effect.gen(function* () {
    yield* appSource(owner, app, deployment);
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* selectedApp(executor, owner, app);
    return yield* executor.apps.activate({ owner, app, deployment, expectedDeployment });
  });
/** Keep the configured identity and selections while changing its organization-local name. */
export const renameApp = (owner: OwnerId, app: AppId, name: string) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* executor.apps.rename({
      owner,
      app,
      name,
    });
  });
/** Delete one configured copy while preserving its reusable accounts. */
export const removeApp = (owner: OwnerId, input: { readonly app: AppId }) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* executor.apps.remove({ ...input, owner });
  });

/** Resolve current authority before running app operations. */
export const hostedAppHandlers = HttpApiBuilder.group(HostedApi, "apps", (handlers) =>
  handlers
    .handle("install", ({ payload }) =>
      Effect.flatMap(adminOwner, (owner) => installApp(owner, payload)),
    )
    .handle("importCustom", ({ payload }) =>
      Effect.flatMap(adminOwner, (owner) => importCustomApp(owner, payload.source)),
    )
    .handle("deploy", ({ payload }) =>
      Effect.flatMap(adminOwner, (owner) => deployApp(owner, payload)),
    )
    .handle("get", ({ params }) => Effect.flatMap(currentOwner, (owner) => getApp(owner, params)))
    .handle("selectAccounts", ({ params, payload }) =>
      Effect.flatMap(adminOwner, (owner) => selectAccounts(owner, { app: params.app, ...payload })),
    )
    .handle("deployments", ({ params }) =>
      Effect.flatMap(adminOwner, (owner) => appDeployments(owner, params.app)),
    )
    .handle("source", ({ params, query }) =>
      Effect.flatMap(adminOwner, (owner) => appSource(owner, params.app, query.deployment)),
    )
    .handle("activate", ({ params, payload }) =>
      Effect.flatMap(adminOwner, (owner) =>
        activateApp(owner, params.app, payload.deployment, payload.expectedDeployment),
      ),
    )
    .handle("rename", ({ params, payload }) =>
      Effect.flatMap(adminOwner, (owner) => renameApp(owner, params.app, payload.name)),
    )
    .handle("remove", ({ params }) =>
      Effect.flatMap(adminOwner, (owner) => removeApp(owner, params)),
    ),
);
