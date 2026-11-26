import { sourceDisplay, sourceDisplayFile } from "@executor-js/app-management/source-display";
import { requireAppAccess } from "./resource-policy.ts";
import { CatalogImportFailed, deployedCopy, type CustomAppInput } from "@executor-js/catalog";
import {
  scopeGeneratedPackage,
  type AppId,
  type VersionId,
  type SourceFilePath,
  type OwnerId,
} from "@executor-js/sdk/core";
import { Effect } from "effect";
import { CurrentOrganizationNamespace } from "../contracts/organization.ts";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import type { DeployApp, InstallApp } from "../contracts/apps.ts";
import { HostedCatalog } from "../contracts/catalog.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { appManagerOwner, currentOwner } from "./access.ts";

export const installApp = (owner: OwnerId, input: typeof InstallApp.Type) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const catalog = yield* HostedCatalog;
    const generated = yield* catalog.prepare(input);
    if (generated.origin !== undefined)
      return yield* executor.apps
        .copy({
          from: { files: generated.files, origin: generated.origin, activation: "deploy" },
          owner,
          name: input.name,
        })
        .pipe(
          Effect.catchTags({
            RegistryError: Effect.die,
            VersionNotFound: Effect.die,
            AppNotDeployed: Effect.die,
          }),
          Effect.flatMap(deployedCopy),
        );
    const namespace = yield* Effect.flatten(CurrentOrganizationNamespace);
    const files = yield* scopeGeneratedPackage(generated.files, namespace, input.name).pipe(
      Effect.mapError(
        () =>
          new CatalogImportFailed({
            code: "package_name",
            reason: "The app package could not be named for this organization.",
          }),
      ),
      Effect.tapError((error) => Effect.annotateCurrentSpan("catalog.error.reason", error.code)),
      Effect.withSpan("catalog.package", { attributes: { "catalog.stage": "package" } }),
    );
    const { app } = yield* executor.apps.deploy({ owner, name: input.name, files });
    return app;
  });
export const importCustomApp = (owner: OwnerId, input: CustomAppInput) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const catalog = yield* HostedCatalog;
    const generated = yield* catalog.custom(input);
    const namespace = yield* Effect.flatten(CurrentOrganizationNamespace);
    const files = yield* scopeGeneratedPackage(generated.files, namespace, input.name).pipe(
      Effect.mapError(
        () =>
          new CatalogImportFailed({
            code: "package_name",
            reason: "The app package could not be named for this organization.",
          }),
      ),
      Effect.tapError((error) => Effect.annotateCurrentSpan("catalog.error.reason", error.code)),
      Effect.withSpan("catalog.package", { attributes: { "catalog.stage": "package" } }),
    );
    const { app } = yield* executor.apps.deploy({ owner, name: input.name, files });
    return app;
  });
export const deployApp = (owner: OwnerId, input: typeof DeployApp.Type) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    return (yield* executor.apps.deploy({ ...input, owner })).app;
  });
export const getApp = (owner: OwnerId, input: { readonly app: AppId }) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* requireAppAccess(input.app, "read");
    const app = yield* executor.apps.get({ ...input, owner });
    return app;
  });
export const appVersions = (owner: OwnerId, app: AppId) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* executor.apps.versions({ owner, app, versionOwner: owner });
  });
export const appSource = (owner: OwnerId, app: AppId, version?: VersionId) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* executor.apps.source({
      owner,
      versionOwner: owner,
      app,
      ...(version === undefined ? {} : { version }),
    });
  });
export const activateApp = (
  owner: OwnerId,
  app: AppId,
  version: VersionId,
  expectedVersion: VersionId | null,
) =>
  Effect.gen(function* () {
    yield* appSource(owner, app, version);
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* requireAppAccess(app, "manage");
    const saved = yield* executor.apps.activate({ owner, app, version, expectedVersion });
    return saved;
  });
export const renameApp = (owner: OwnerId, app: AppId, name: string) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const saved = yield* executor.apps.rename({
      owner,
      app,
      name,
    });
    return saved;
  });
export const removeApp = (owner: OwnerId, input: { readonly app: AppId }) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* executor.apps.remove({ ...input, owner });
  });

const versionDisplayFile = (
  params: { readonly app: AppId; readonly version: VersionId },
  path: SourceFilePath,
) =>
  Effect.flatMap(appManagerOwner(params.app), (owner) =>
    appSource(owner, params.app, params.version).pipe(
      Effect.flatMap((source) => sourceDisplayFile(source.files, path)),
    ),
  );
export const hostedAppHandlers = HttpApiBuilder.group(HostedApi, "apps", (handlers) =>
  handlers
    .handle("install", ({ payload }) =>
      Effect.flatMap(currentOwner, (owner) => installApp(owner, payload)),
    )
    .handle("importCustom", ({ payload }) =>
      Effect.flatMap(currentOwner, (owner) => importCustomApp(owner, payload.source)),
    )
    .handle("deploy", ({ payload }) =>
      Effect.flatMap(currentOwner, (owner) => deployApp(owner, payload)),
    )
    .handle("get", ({ params }) => Effect.flatMap(currentOwner, (owner) => getApp(owner, params)))
    .handle("versions", ({ params }) =>
      Effect.flatMap(appManagerOwner(params.app), (owner) => appVersions(owner, params.app)),
    )
    .handle("deployments", ({ params }) =>
      Effect.flatMap(appManagerOwner(params.app), (owner) => appVersions(owner, params.app)),
    )
    .handle("source", ({ params, query }) =>
      Effect.flatMap(appManagerOwner(params.app), (owner) =>
        appSource(owner, params.app, query.version),
      ),
    )
    .handle("sourceDisplay", ({ params, query }) =>
      Effect.flatMap(appManagerOwner(params.app), (owner) =>
        appSource(owner, params.app, query.version).pipe(Effect.flatMap(sourceDisplay)),
      ),
    )
    .handle("sourceDisplayFile", ({ params, query }) => versionDisplayFile(params, query.path))
    .handle("legacySourceDisplayFile", ({ params, query }) =>
      versionDisplayFile(params, query.path),
    )
    .handle("activate", ({ params, payload }) =>
      Effect.flatMap(appManagerOwner(params.app), (owner) =>
        activateApp(owner, params.app, payload.version, payload.expectedVersion),
      ),
    )
    .handle("rename", ({ params, payload }) =>
      Effect.flatMap(appManagerOwner(params.app), (owner) =>
        renameApp(owner, params.app, payload.name),
      ),
    )
    .handle("remove", ({ params }) =>
      Effect.flatMap(appManagerOwner(params.app), (owner) => removeApp(owner, params)),
    ),
);
