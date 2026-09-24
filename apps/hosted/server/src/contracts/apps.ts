import {
  DeploymentDisplay,
  SourceDisplayFile,
  SourceDisplayFileQuery,
} from "@executor-js/app-management/contracts/source-display";
import { RequiredAction } from "./authorization.ts";
import { AppWorkflowsActive } from "@executor-js/sdk/core";
import { AppWebhooksActive } from "@executor-js/sdk/core";
/** App installation and configuration. Owners always come from authenticated organization context. */
import {
  CatalogImport,
  CatalogImportFailed,
  CatalogUnavailable,
  ImportedApp,
  RemoteCustomAppInput,
} from "@executor-js/catalog/contracts";
import {
  AccountNotFound,
  AccountSelectionInvalid,
  App,
  DeployedApp,
  AppNotDeployed,
  AppId,
  AppName,
  Deployment,
  DeploymentId,
  DeploymentSummary,
  DeploymentNotFound,
  AppDeploymentChanged,
  AppNameTaken,
  AppSlugTaken,
  AppNotFound,
  DeploymentBuildFailed,
  BuildMemoryExceeded,
  SkillDefinitionInvalid,
  SourceFiles,
  sourceErrors,
  StorageError,
} from "@executor-js/sdk/core";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";

/** Catalog installation is create-only: it cannot overwrite another app by name. */
export const InstallApp = Schema.Struct({ ...CatalogImport.fields, name: Schema.NonEmptyString });
/** Direct source deployment uses the same runtime as generated catalog apps. */
export const DeployApp = Schema.Struct({ name: Schema.NonEmptyString, files: SourceFiles });
const params = { organization: OrganizationReference };
const app = { ...params, app: AppId };
const deployErrors = [
  AppNotFound,
  AppDeploymentChanged,
  StorageError,
  DeploymentBuildFailed,
  BuildMemoryExceeded,
  SkillDefinitionInvalid,
  ...sourceErrors,
  AppNameTaken,
  AppSlugTaken,
  AccountNotFound,
  AccountSelectionInvalid,
  OrganizationForbidden,
] as const;
const prefix = "/api/organizations/:organization/apps";
/** Shared app routes; both hosts supply the same handlers. */
export const HostedApps = HttpApiGroup.make("apps")
  .add(
    HttpApiEndpoint.post("install", `${prefix}/install`, {
      params,
      payload: InstallApp,
      success: ImportedApp,
      error: [...deployErrors, CatalogImportFailed, CatalogUnavailable],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post("importCustom", `${prefix}/import`, {
      params,
      payload: Schema.Struct({ source: RemoteCustomAppInput }),
      success: ImportedApp,
      error: [...deployErrors, CatalogImportFailed],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post("deploy", `${prefix}/deploy`, {
      params,
      payload: DeployApp,
      success: DeployedApp,
      error: deployErrors,
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.get("get", `${prefix}/:app`, {
      params: app,
      success: App,
      error: [StorageError, AppNotFound],
    }).annotate(RequiredAction, "discover"),
  )
  .add(
    HttpApiEndpoint.delete("remove", `${prefix}/:app`, {
      params: app,
      success: Schema.Struct({ app: AppId }),
      error: [StorageError, AppWebhooksActive, AppWorkflowsActive, OrganizationForbidden],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.get("deployments", `${prefix}/:app/deployments`, {
      params: app,
      success: Schema.Array(DeploymentSummary),
      error: [StorageError, AppNotFound, OrganizationForbidden],
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.get("source", `${prefix}/:app/source`, {
      params: app,
      query: { deployment: Schema.optional(DeploymentId) },
      success: Deployment,
      error: [StorageError, AppNotFound, AppNotDeployed, DeploymentNotFound, OrganizationForbidden],
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.get("sourceDisplay", `${prefix}/:app/source/display`, {
      params: app,
      query: { deployment: Schema.optional(DeploymentId) },
      success: DeploymentDisplay,
      error: [StorageError, AppNotFound, AppNotDeployed, DeploymentNotFound, OrganizationForbidden],
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.get(
      "sourceDisplayFile",
      `${prefix}/:app/deployments/:deployment/display/file`,
      {
        params: { ...app, deployment: DeploymentId },
        query: SourceDisplayFileQuery,
        success: SourceDisplayFile,
        error: [
          StorageError,
          AppNotFound,
          AppNotDeployed,
          DeploymentNotFound,
          OrganizationForbidden,
          ...sourceErrors,
        ],
      },
    ).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.post("activate", `${prefix}/:app/activate`, {
      params: app,
      payload: Schema.Struct({
        deployment: DeploymentId,
        expectedDeployment: Schema.NullOr(DeploymentId),
      }),
      success: App,
      error: [
        StorageError,
        AppNotFound,
        AppNotDeployed,
        DeploymentNotFound,
        AppDeploymentChanged,
        AccountNotFound,
        AccountSelectionInvalid,
        OrganizationForbidden,
      ],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.patch("rename", `${prefix}/:app/name`, {
      params: app,
      payload: Schema.Struct({ name: AppName }),
      success: App,
      error: [StorageError, AppNotFound, AppNameTaken, AppSlugTaken, OrganizationForbidden],
    }).annotate(RequiredAction, "manage"),
  )
  .middleware(RequireOrganization);
