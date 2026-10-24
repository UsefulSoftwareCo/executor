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
        "Add a remote MCP server by its URL as a new app, or add a public OpenAPI JSON/YAML definition or GraphQL endpoint. Use this quick add when the app catalog has no matching entry. Set source.kind to mcp, openapi, or graphql, and provide name and url. OpenAPI derives authentication from the definition; baseUrl optionally overrides its server. GraphQL has no authentication discovery: omit auth for a public API, or set auth to {kind: 'bearer'} or {kind: 'apiKey', header}. Connect credentials afterwards with appAccounts.userConnect, never in the URL or source. Public APIs are checked before installation; protected GraphQL schemas are read after connecting an account. MCP imports still require confirmed anonymous access or discoverable OAuth; other MCP setup returns agent_setup_required.",
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
