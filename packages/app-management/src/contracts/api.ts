import { withLegacyKeys } from "@executor-js/utils/legacy-keys";
import {
  SourceDisplayEntries,
  SourceDisplayFile,
  SourceDisplayFileQuery,
} from "./source-display.ts";
import { ApiError } from "@executor-js/utils/api-error";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
/** Shared app wire contracts; browser imports never load HTTP route or Git adapters. */
import { Context, Schema } from "effect";
import {
  AppNameTaken,
  AppSlugTaken,
  AppNotFound,
  AppNotDeployed,
  VersionNotFound,
  AppVersionChanged,
  AccountNotFound,
  AccountSelectionInvalid,
  VersionBuildFailed,
  BuildMemoryExceeded,
  CommittedSource,
  sourceErrors,
  SourceSnapshot,
  StorageError,
  PublicationReadiness,
  RegistryError,
  RequestRejection,
} from "@executor-js/sdk/core";
export * from "./framework.ts";

/** Authentication failures never expose whether another owner's app exists. */
export const AppAccessDenied = ApiError.define({
  tag: "AppAccessDenied",
  status: 403,
  fields: { reason: Schema.Literals(["authentication", "forbidden"]) },
  message: ({ reason }) =>
    reason === "authentication"
      ? "This request is not authenticated for app management."
      : "This caller may not perform this app operation, or cannot access this app.",
  recorded: ({ reason }) =>
    reason === "authentication"
      ? "This request is not authenticated for app management."
      : "This caller may not perform this app operation, or cannot access this app.",
});
export type AppAccessDenied = typeof AppAccessDenied.Type;
/**
 * A client released before wire revisions asked to remove a listing by the short name it is shown,
 * `@acme/notes` for `@acme.executor.community/notes`. It states no commit, so the name cannot be
 * bound to the listing it was shown. Those clients print an error their contract lacks as the host
 * states it.
 */
export const FullListingNameRequired = UserFacingError.define({
  tag: "FullListingNameRequired",
  status: 400,
  fields: { name: PackageName, fullName: PackageName },
  recorded: () =>
    "A client without a wire revision asked to remove a public listing by its short name.",
  presentation: ({ name, fullName }) => ({
    title: "Remove this listing by its full name",
    description: `${name} is the short form of a public listing's name. It selects whichever listing holds that name when the request arrives, which may not be the one that was listed, so nothing was removed.`,
    recovery: {
      action: `Remove ${fullName} instead. Releases up to 2.0.0-beta.15 cannot send that name: install the current release first with npm i -g executor@beta --include=optional.`,
      instructions: `The request stated no executor-wire-revision header, so the host lists public packages to this client by short names such as ${name} and removes none by them. Run executor apps unpublish --package ${fullName}. If the CLI rejects that name, update it first with npm i -g executor@beta --include=optional. API callers send executor-wire-revision: 1.`,
    },
  }),
});
export type FullListingNameRequired = typeof FullListingNameRequired.Type;
/** Expected operation failures are shared unchanged across the product transports. */
export const appOperationErrors = [
  StorageError,
  ...sourceErrors,
  RegistryError,
  AppAccessDenied,
  AppNotFound,
  AppNotDeployed,
  VersionNotFound,
  AppNameTaken,
  AppSlugTaken,
  AppVersionChanged,
  AccountNotFound,
  AccountSelectionInvalid,
  VersionBuildFailed,
  BuildMemoryExceeded,
] as const;
/** Wire errors remain typed in browser, CLI, and agent clients. */
export const AppOperationError = Schema.Union(appOperationErrors);
/** Authoring controls need product permissions and clone metadata, without reading Git contents. */
const authoringFields = {
  namespace: Schema.NullOr(Schema.String),
  /** The remote's path. Clients released before `gitUrl` add it to the host they called. */
  gitPath: Schema.String,
  /** The absolute clone URL, on the origin where the host serves Git. */
  gitUrl: Schema.String,
  canEdit: Schema.Boolean,
};
/** Permissions and clone location for controls that do not need a source snapshot. */
export const AppAuthoringMetadata = Schema.Struct({
  ...authoringFields,
  canPublish: Schema.Boolean,
});
/** Working source and authoring metadata, with exact stored file contents for editing. */
export const AppSourceView = Schema.Struct({
  ...SourceSnapshot.fields,
  ...authoringFields,
  publication: Schema.NullOr(PublicationReadiness),
});
/** Working source for read-only inspection. Large files are listed without contents. */
export const AppSourceDisplay = Schema.Struct({
  ...AppSourceView.fields,
  files: SourceDisplayEntries,
});

import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  OpenApi,
} from "effect/http-api";
import {
  App,
  AppId,
  AppName,
  DeployedApp,
  VersionMetadata,
  GitCommit,
  OwnerId,
  SourceCommit,
  SourceFiles,
  Publication,
  PackageName,
  PublicationReference,
} from "@executor-js/sdk/core";
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
  const api = HttpApi.make("app-management").add(
    HttpApiGroup.make("appManagement")
      .add(
        HttpApiEndpoint.get("list", "/apps", {
          params: tenant,
          success: Schema.Array(App),
          error: appOperationErrors,
        }),
        HttpApiEndpoint.post("create", "/apps", {
          params: tenant,
          payload: Schema.Struct({
            name: AppName,
            files: SourceFiles.annotateKey({
              description:
                "The complete source: a root index.ts and a package.json whose dependencies.apps is the exact version framework.release returns.",
            }),
          }),
          success: App,
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Create an app from its complete source file list. It keeps its app identity when deployed. Saving source does not run the app.",
        ),
        HttpApiEndpoint.get("authoring", "/apps/:app/authoring", {
          params: app,
          success: AppAuthoringMetadata,
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Read whether you can edit and publish this app, and its Git clone location, without its files. For how to write apps, read the app-authoring skill with the skills tool.",
        ),
        HttpApiEndpoint.get("source", "/apps/:app/workspace", {
          params: app,
          success: AppSourceView,
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Read private working source and its Git revision. Read this before editing. Returns exact source text, source permissions and authenticated clone metadata. A file under ui/public/ that is not UTF-8 text, or does not fit beside the rest of the source, is listed as {path, object, size} without its bytes; send that entry back unchanged in a commit to keep the file, or clone the app to get it.",
        ),
        HttpApiEndpoint.get("sourceDisplay", "/apps/:app/workspace/display", {
          params: app,
          success: AppSourceDisplay,
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Read working source formatted for read-only inspection. Every file lists its path and stored size; large files omit content. Never edit from this view.",
        ),
        HttpApiEndpoint.get("sourceDisplayFile", "/apps/:app/commits/:commit/display/file", {
          params: Schema.Struct({ ...app.fields, commit: SourceCommit }),
          query: SourceDisplayFileQuery,
          success: SourceDisplayFile,
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Read one file of a Git commit formatted for read-only inspection. Never edit from this view.",
        ),
        HttpApiEndpoint.post("commit", "/apps/:app/commits", {
          params: app,
          payload: Schema.Struct({
            expected: SourceCommit,
            files: SourceFiles,
            message: Schema.NonEmptyString,
          }),
          success: CommittedSource,
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          'Save the complete file list as a Git commit. Omitted files are removed. Files under ui/public/ may be binary: send {path, content, encoding: "base64"}, or keep a listed {path, object, size} entry unchanged. Every other file is UTF-8 text. Push large public directories with Git instead. expected must match the revision read before editing. A commit does not deploy. Returns the new revision and `removed`: how many files this save removed and the first of their paths; the files are not echoed. If `removed.count > 0`, check it before deploying. A removed file stays at the `expected` revision: to keep it, commit again against the new revision with it. A file path cannot also be a folder (`a` and `a/b`); such a save fails with SourcePathConflict and saves nothing. Paths must be valid Unicode; a lone surrogate fails with SourcePathNotUnicode.',
        ),
        HttpApiEndpoint.post("deploy", "/apps/:app/deploy", {
          params: app,
          payload: Schema.Union([
            Schema.Struct({ files: SourceFiles, commit: Schema.optional(Schema.Never) }),
            Schema.Struct({ commit: SourceCommit, files: Schema.optional(Schema.Never) }),
          ]),
          success: Schema.Struct({ app: DeployedApp, version: VersionMetadata }).pipe(
            withLegacyKeys({ version: "deployment" }),
          ),
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Deploy complete files or an immutable Git commit without changing the working branch. App identity, data, and compatible account selections are retained. Returns the app and the new version's metadata; the files are not echoed.",
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
          // `path` stays for clients released before `url`, which add it to the host they called.
          success: Schema.Struct({ path: Schema.String, url: Schema.String }),
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Read the authenticated Git clone URL, which may be on another origin than this API, and its path. Ordinary Git pushes update source but do not deploy it.",
        ),
        HttpApiEndpoint.post("publish", "/apps/:app/publication", {
          params: app,
          payload: Schema.Struct({ commit: SourceCommit }),
          success: Publication,
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Publish this Git commit as the current public app listing. package.json supplies a name under the organization's current scope, such as @acme.executor.community/notes, and an optional description. Installs own their source copies; existing copies do not update. Git history, accounts, and app data stay private.",
        ),
        HttpApiEndpoint.get("history", "/apps/:app/history", {
          params: app,
          success: Schema.Array(GitCommit),
          error: appOperationErrors,
        }).annotate(OpenApi.Description, "Read recent commits in this app's private Git history."),
        HttpApiEndpoint.get("publishing", "/app-publications/status", {
          params: tenant,
          success: Schema.Struct({ publishing: Schema.Boolean }),
          error: appOperationErrors,
        }).annotate(
          OpenApi.Description,
          "Read whether this host publishes apps. When it does not, publish and unpublish are refused and public listings stay readable.",
        ),
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
          error: [...appOperationErrors, FullListingNameRequired],
        }).annotate(
          OpenApi.Description,
          "Remove a public listing. Existing installed copies remain independent and usable.",
        ),
      )
      .prefix(prefix)
      .middleware(access),
  );
  return api.middleware(RequestRejection);
};
