import {
  VersionDisplay,
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
  CustomAppInput,
} from "@executor-js/catalog/contracts";
import {
  AccountNotFound,
  AccountSelectionInvalid,
  App,
  DeployedApp,
  AppNotDeployed,
  AppId,
  AppName,
  Version,
  VersionId,
  VersionSummary,
  VersionNotFound,
  AppVersionChanged,
  AppNameTaken,
  AppSlugTaken,
  AppNotFound,
  VersionBuildFailed,
  BuildMemoryExceeded,
  SkillDefinitionInvalid,
  SourceFiles,
  sourceErrors,
  StorageError,
} from "@executor-js/sdk/core";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { ApiError } from "@executor-js/utils/api-error";
import { withLegacyKeys } from "@executor-js/utils/legacy-keys";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";

/** Catalog installation is create-only: it cannot overwrite another app by name. */
export const InstallApp = Schema.Struct({ ...CatalogImport.fields, name: Schema.NonEmptyString });
/** Deploying source directly uses the same runtime as generated catalog apps. */
export const DeployApp = Schema.Struct({ name: Schema.NonEmptyString, files: SourceFiles });
const params = { organization: OrganizationReference };
const app = { ...params, app: AppId };
const deployErrors = [
  AppNotFound,
  AppVersionChanged,
  StorageError,
  VersionBuildFailed,
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
/** A catalog source held back for a manager to apply. */
export const CatalogAppUpdate = Schema.Struct({
  reconnect: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reasons: Schema.Array(Schema.Literals(["removed", "provider", "scope", "added", "cardinality"])),
  touched: Schema.Boolean,
});
export type CatalogAppUpdate = typeof CatalogAppUpdate.Type;
/** No catalog update is offered, the workspace has changes, or the app changed meanwhile. */
export const CatalogUpdateUnavailable = ApiError.define({
  tag: "CatalogUpdateUnavailable",
  status: 409,
  fields: { reason: Schema.Literals(["none", "edited", "changed"]) },
  message:
    "This catalog update can't be applied now: none is offered, the app's workspace has changes that are not deployed, or the app changed meanwhile. Reload the app and try again.",
});
export type CatalogUpdateUnavailable = typeof CatalogUpdateUnavailable.Type;
// Versions were called deployments. The former paths and field names stay accepted, and responses
// repeat the former field names, so API callers written before the rename keep working.
const versionsOptions = {
  params: app,
  success: Schema.Array(VersionSummary),
  error: [StorageError, AppNotFound, OrganizationForbidden],
};
const versionQuery = Schema.Struct({ version: Schema.optional(VersionId) }).pipe(
  withLegacyKeys({ version: "deployment" }),
);
const sourceDisplayFileOptions = {
  params: { ...app, version: VersionId },
  query: SourceDisplayFileQuery,
  success: SourceDisplayFile,
  error: [
    StorageError,
    AppNotFound,
    AppNotDeployed,
    VersionNotFound,
    OrganizationForbidden,
    ...sourceErrors,
  ],
};
/** Shared app routes; both hosts supply the same handlers. */
export const HostedApps = HttpApiGroup.make("apps")
  .add(
    HttpApiEndpoint.post("install", `${prefix}/install`, {
      params,
      payload: InstallApp,
      success: DeployedApp,
      error: [...deployErrors, CatalogImportFailed, CatalogUnavailable],
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        "Install a catalog entry as a new app. entry is the id of an entry organization.catalog lists. The app installs from its own published source; connect an account afterwards through its requirements (appAccounts.userConnect or appAccounts.appConnect). An entry the catalog does not list, or a server URL, is refused with entry_missing, and its recovery says what to call instead. To add a remote MCP server by its URL, use apps.importCustom.",
      ),
  )
  .add(
    HttpApiEndpoint.post("importCustom", `${prefix}/import`, {
      params,
      payload: Schema.Struct({ source: CustomAppInput }),
      success: DeployedApp,
      error: [...deployErrors, CatalogImportFailed],
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        "Add a remote MCP server by its URL as a new app, as the dashboard's Connect a service form does. Executor checks the server first and adds it when the server confirms it needs OAuth sign-in or no sign-in; connect an OAuth account afterwards with appAccounts.userConnect. A server that needs an API key or other setup is refused with agent_setup_required, and its recovery says how to write the app. Only MCP servers are added by URL.",
      ),
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
    HttpApiEndpoint.get("versions", `${prefix}/:app/versions`, versionsOptions).annotate(
      RequiredAction,
      "read",
    ),
  )
  .add(
    HttpApiEndpoint.get("deployments", `${prefix}/:app/deployments`, versionsOptions)
      .annotate(RequiredAction, "read")
      .annotate(OpenApi.Deprecated, true),
  )
  .add(
    HttpApiEndpoint.get("source", `${prefix}/:app/source`, {
      params: app,
      query: versionQuery,
      success: Version,
      error: [StorageError, AppNotFound, AppNotDeployed, VersionNotFound, OrganizationForbidden],
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.get("sourceDisplay", `${prefix}/:app/source/display`, {
      params: app,
      query: versionQuery,
      success: VersionDisplay,
      error: [StorageError, AppNotFound, AppNotDeployed, VersionNotFound, OrganizationForbidden],
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.get(
      "sourceDisplayFile",
      `${prefix}/:app/versions/:version/display/file`,
      sourceDisplayFileOptions,
    ).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.get(
      "legacySourceDisplayFile",
      `${prefix}/:app/deployments/:version/display/file`,
      sourceDisplayFileOptions,
    )
      .annotate(RequiredAction, "read")
      .annotate(OpenApi.Deprecated, true),
  )
  .add(
    HttpApiEndpoint.get("catalogUpdate", `${prefix}/:app/catalog-update`, {
      params: app,
      success: Schema.NullOr(CatalogAppUpdate),
      error: [StorageError, AppNotFound, OrganizationForbidden],
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        "A newer catalog source held back for this app, or null. Installed catalog apps update by themselves unless someone changed them or the update would leave linked accounts or requirements unusable: reconnect counts the linked accounts that stop working, reasons says why, and touched means applying it replaces a version someone deployed. apps.applyCatalogUpdate applies it.",
      ),
  )
  .add(
    HttpApiEndpoint.post("applyCatalogUpdate", `${prefix}/:app/catalog-update`, {
      params: app,
      success: App,
      error: [
        ...deployErrors,
        AppNotDeployed,
        VersionNotFound,
        CatalogImportFailed,
        CatalogUnavailable,
        CatalogUpdateUnavailable,
      ],
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        "Deploy the catalog source apps.catalogUpdate offers and make it this app's active version. The earlier version stays in the app's versions. Refused while the app's Git workspace has changes that are not deployed, when the app or the catalog source changed since the offer, or when no update is offered.",
      ),
  )
  .add(
    HttpApiEndpoint.post("activate", `${prefix}/:app/activate`, {
      params: app,
      payload: Schema.Struct({
        version: VersionId,
        expectedVersion: Schema.NullOr(VersionId),
      }).pipe(withLegacyKeys({ version: "deployment", expectedVersion: "expectedDeployment" })),
      success: App,
      error: [
        StorageError,
        AppNotFound,
        AppNotDeployed,
        VersionNotFound,
        AppVersionChanged,
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
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        "Rename an app and derive its new slug from the name; the app ID, accounts, links and data stay. The new slug changes the app's tool namespace, Git clone URL and the page address appUi.location returns, and the old address stops working. The name and slug must be unique in the organization.",
      ),
  )
  .middleware(RequireOrganization);
