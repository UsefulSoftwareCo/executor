import { sourceDisplay, sourceDisplayFile } from "@executor-js/app-management/source-display";
import { requireAppAccess } from "./resource-policy.ts";
/** App use cases and routes. Hosts supply an SDK; they do not enumerate these operations. */
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
import { executorCatalogPackage, HostedCatalog } from "../contracts/catalog.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { recordUsage } from "../contracts/product-analytics.ts";
import { appManagerOwner, currentOwner } from "./access.ts";

/** Install a catalog entry as a new app without replacing an existing name. */
export const installApp = (owner: OwnerId, input: typeof InstallApp.Type) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const catalog = yield* HostedCatalog;
    const generated = yield* catalog.prepare(input);
    // An official app keeps its own package name, as an installed published app does.
    if (generated.origin !== undefined) {
      const app = yield* executor.apps
        .copy({
          from: { files: generated.files, origin: generated.origin, activation: "deploy" },
          owner,
          name: input.name,
        })
        .pipe(
          // A snapshot reads no registry or earlier app; those failures belong to other copy sources.
          Effect.catchTags({
            RegistryError: Effect.die,
            VersionNotFound: Effect.die,
            AppNotDeployed: Effect.die,
          }),
          Effect.flatMap(deployedCopy),
        );
      if (input.entry !== executorCatalogPackage)
        yield* recordUsage("app_installed", { app_id: input.entry });
      return app;
    }
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
/**
 * Confirm a tenant-supplied MCP server and create an organization app without replacing a name.
 * The URL is checked by the host, so it stays on public destinations.
 */
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
/** Deploying source directly uses the same create-only operation as a catalog install. */
export const deployApp = (owner: OwnerId, input: typeof DeployApp.Type) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    return (yield* executor.apps.deploy({ ...input, owner })).app;
  });
/** Read a configured app only within its authenticated organization. */
export const getApp = (owner: OwnerId, input: { readonly app: AppId }) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* requireAppAccess(input.app, "read");
    const app = yield* executor.apps.get({ ...input, owner });
    return app;
  });
/** Retained source is administrative data; versions from other owners stay private. */
export const appVersions = (owner: OwnerId, app: AppId) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* executor.apps.versions({ owner, app, versionOwner: owner });
  });
/** An explicit app and optional version select source, never a free-standing version ID. */
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
/** Activation moves a pointer; it never rewinds app data or upstream side effects. */
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
/** Keep the configured identity and selections while changing its organization-local name. */
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
/** Delete one configured copy while preserving its reusable accounts. */
export const removeApp = (owner: OwnerId, input: { readonly app: AppId }) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* executor.apps.remove({ ...input, owner });
  });

/** Resolve current authority before running app operations. */
/** One file of a version's source, rendered for display. */
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
