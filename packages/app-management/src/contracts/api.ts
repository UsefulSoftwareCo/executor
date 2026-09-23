/** Shared app wire contracts; browser imports never load HTTP route or Git adapters. */
import { Context, Schema } from "effect";
import {
  AppNameTaken,
  AppSlugTaken,
  AppNotFound,
  AppNotDeployed,
  DeploymentNotFound,
  AppDeploymentChanged,
  AccountNotFound,
  AccountSelectionInvalid,
  DeploymentBuildFailed,
  SkillDefinitionInvalid,
  sourceErrors,
  SourceSnapshot,
  StorageError,
} from "@executor-js/sdk/core";
import { PublicationReadiness, RegistryError } from "@executor-js/app-registry/contracts";

/** Authentication failures never expose whether another owner's app exists. */
export class AppAccessDenied extends Schema.TaggedError<AppAccessDenied>()(
  "AppAccessDenied",
  { reason: Schema.Literals(["authentication", "forbidden"]) },
  { httpApiStatus: 403 },
) {}
/** Expected operation failures are shared unchanged across the product transports. */
export const appOperationErrors = [
  StorageError,
  ...sourceErrors,
  RegistryError,
  AppAccessDenied,
  AppNotFound,
  AppNotDeployed,
  DeploymentNotFound,
  AppNameTaken,
  AppSlugTaken,
  AppDeploymentChanged,
  AccountNotFound,
  AccountSelectionInvalid,
  DeploymentBuildFailed,
  SkillDefinitionInvalid,
] as const;
/** Wire errors remain typed in browser, CLI, and agent clients. */
export const AppOperationError = Schema.Union(appOperationErrors);
/** Authoring controls need product permissions and clone metadata, without reading Git contents. */
const authoringFields = {
  namespace: Schema.NullOr(Schema.String),
  gitPath: Schema.String,
  canEdit: Schema.Boolean,
};
/** Permissions and clone location for controls that do not need a source snapshot. */
export const AppAuthoringMetadata = Schema.Struct({
  ...authoringFields,
  canPublish: Schema.Boolean,
});
/** The editable snapshot carries the same server-authorized authoring metadata. */
export const AppSourceView = Schema.Struct({
  ...SourceSnapshot.fields,
  ...authoringFields,
  publication: Schema.NullOr(PublicationReadiness),
});

import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  OpenApi,
} from "effect/unstable/httpapi";
import {
  App,
  AppId,
  AppName,
  DeployedApp,
  Deployment,
  OwnerId,
  SourceCommit,
  SourceFiles,
} from "@executor-js/sdk/core";
import {
  Publication,
  PackageName,
  PublicationReference,
} from "@executor-js/app-registry/contracts";
import { GitCommit } from "@executor-js/app-source/contracts";
/** Both public and owned copies use this one request and result contract. */
export const CopyApp = Schema.Struct({
  from: Schema.Union([Schema.Struct({ app: AppId }), PublicationReference]),
  name: AppName,
});
/** Hosts choose owners from verified credentials and membership, never caller payloads. */
export class AppIdentity extends Context.Service<
  AppIdentity,
  {
    readonly owner: OwnerId;
    /** null is the explicitly authorized local root scope; hosted callers always supply an owner. */
    readonly readOwner: OwnerId | null;
    readonly scope: string;
    readonly namespace: string | null;
    readonly canWrite: boolean;
    readonly appIds?: ReadonlyArray<AppId> | undefined;
    readonly protectedApps: ReadonlyArray<AppId>;
    /** Hosted principals are individual users; local pairing may omit an actor. */
    readonly actor?: string | undefined;
  }
>()("apps/Identity") {}
/** Product policy separates discovery, source management, execution-sensitive edits, and credential metadata. */
export interface AppCapabilities {
  readonly visible: boolean;
  readonly manage: boolean;
  readonly edit: boolean;
}
/** App UI and API access reuse the host's current pairing or organization boundary. */
export class AppAccess extends HttpApiMiddleware.Service<AppAccess, { provides: AppIdentity }>()(
  "apps/Access",
  { error: AppAccessDenied },
) {}
/** Shared app IDs and operation contracts across native and hosted products. */
export const appManagementApi = <I extends HttpApiMiddleware.AnyId, S>(
  prefix: "/api" | "/api/organizations/:organization",
  access: Context.Key<I, S>,
) => {
  const tenant =
    prefix === "/api" ? Schema.Struct({}) : Schema.Struct({ organization: Schema.NonEmptyString });
  const app = Schema.Struct({ ...tenant.fields, app: AppId });
  return HttpApi.make("app-management").add(
    HttpApiGroup.make("appManagement")
      .add(
        HttpApiEndpoint.get("list", "/apps", {
          params: tenant,
          success: Schema.Array(App),
          error: appOperationErrors,
        }),
        HttpApiEndpoint.post("create", "/apps/drafts", {
          params: tenant,
          payload: Schema.Struct({ name: AppName, files: SourceFiles }),
          success: App,
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Create a draft in Apps from its complete source file list. It keeps its app identity when deployed. Saving source does not run the app.",
        ),
        HttpApiEndpoint.get("authoring", "/apps/:app/authoring", {
          params: app,
          success: AppAuthoringMetadata,
          error: appOperationErrors,
        }),
        HttpApiEndpoint.get("source", "/apps/:app/workspace", {
          params: app,
          success: AppSourceView,
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Read private working source and its Git revision. Read this before editing. Returns source permissions and authenticated clone metadata.",
        ),
        HttpApiEndpoint.post("commit", "/apps/:app/commits", {
          params: app,
          payload: Schema.Struct({
            expected: SourceCommit,
            files: SourceFiles,
            message: Schema.NonEmptyString,
          }),
          success: SourceSnapshot,
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Save the complete file list as a Git commit. Omitted files are removed. expected must match the revision read before editing. A commit does not deploy.",
        ),
        HttpApiEndpoint.post("deploy", "/apps/:app/deploy", {
          params: app,
          payload: Schema.Union([
            Schema.Struct({ files: SourceFiles, commit: Schema.optional(Schema.Never) }),
            Schema.Struct({ commit: SourceCommit, files: Schema.optional(Schema.Never) }),
          ]),
          success: Schema.Struct({ app: DeployedApp, deployment: Deployment }),
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Deploy complete files or an immutable Git commit without changing the working branch. App identity, data, and compatible account selections are retained.",
        ),
        HttpApiEndpoint.post("copy", "/apps/copies", {
          params: tenant,
          payload: CopyApp,
          success: App,
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Make an independent copy with fresh Git history. Owned apps copy running source; unfinished apps copy working source. Public packages copy the reviewed published commit. Running and public copies deploy automatically. Accounts and app data are not copied.",
        ),
        HttpApiEndpoint.get("git", "/apps/:app/git", {
          params: app,
          success: Schema.Struct({ path: Schema.String }),
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Read the authenticated Git clone path. Ordinary Git pushes update source but do not deploy it.",
        ),
        HttpApiEndpoint.post("publish", "/apps/:app/publication", {
          params: app,
          payload: Schema.Struct({ commit: SourceCommit }),
          success: Publication,
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Publish this Git commit as the current public app listing. package.json supplies a scoped name and optional description. Installs own their source copies; existing copies do not update. Git history, accounts, and app data stay private.",
        ),
        HttpApiEndpoint.get("history", "/apps/:app/history", {
          params: app,
          success: Schema.Array(GitCommit),
          error: appOperationErrors,
        }).annotate(OpenApi.Description, "Read recent commits in this app's private Git history."),
        HttpApiEndpoint.get("catalog", "/app-publications", {
          params: tenant,
          query: { name: Schema.optional(PackageName) },
          success: Schema.Array(Publication),
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Discover public app listings and their selected Git commits.",
        ),
        HttpApiEndpoint.get("published", "/app-publications/published", {
          params: tenant,
          success: Schema.Array(Publication),
          error: appOperationErrors,
        }).annotate(OpenApi.Description, "List this publishing account's public apps."),
        HttpApiEndpoint.post("unpublish", "/app-publications/unpublish", {
          params: tenant,
          payload: Schema.Struct({ package: PackageName }),
          success: Schema.Struct({ name: PackageName }),
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Remove a public listing. Existing installed copies remain independent and usable.",
        ),
      )
      .prefix(prefix)
      .middleware(access),
  );
};
