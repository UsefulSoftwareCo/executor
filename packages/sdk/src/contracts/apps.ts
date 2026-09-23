import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { DeclaredRequirements } from "apps/contracts";
import { AppSlug } from "./app-slug.ts";
export { AppSlug, appSlug } from "./app-slug.ts";
/** Apps own deployed code and declared requirements. Profiles hold account selections. */
import { Schema } from "effect";
import { SkillDefinitionInvalid } from "./skill-source.ts";
import { StorageError } from "./shared.ts";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { AccountId, AppCodeId, AppId, DeploymentId, OwnerId, ProviderId } from "./shared.ts";
import { AccountNotFound } from "./account.ts";
import { ProviderDefinition } from "./provider.ts";
import { SourceCommit, sourceErrors, SourceSnapshot } from "./source.ts";
import {
  AppDeploymentChanged,
  Deployment,
  DeploymentMetadata,
  DeploymentBuildFailed,
  BuildMemoryExceeded,
  DeploymentNotFound,
  DeploymentSummary,
  SourceFiles,
} from "./deployment.ts";

/**
 * A host-resolved account requirement. Available before accounts are selected
 * and before the dynamic factory runs. Provider metadata is data, not JS code.
 */
export const AccountRequirement = Schema.Struct({
  provider: ProviderId,
  definition: ProviderDefinition,
  cardinality: Schema.Literals(["one", "many"]),
});

export type AccountRequirement = typeof AccountRequirement.Type;

/** App-wide requirements, extracted from the deployed app's declaration. */
export const AppRequirements = Schema.Struct({
  database: DeclaredRequirements.fields.database,
  accounts: Schema.Record(Schema.NonEmptyString, AccountRequirement),
});

export type AppRequirements = typeof AppRequirements.Type;

/** Saved slot -> account ID or account IDs. Empty arrays explicitly select zero for many(). */
export const SelectedAccounts = Schema.Record(
  Schema.NonEmptyString,
  Schema.Union([AccountId, Schema.Array(AccountId)]),
);

export type SelectedAccounts = typeof SelectedAccounts.Type;

/** Display names are nonblank and bounded; they do not replace stable app identities. */
export const AppName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
  Schema.isPattern(/\S/),
);

/** Informational origin captured when a copy is made. It never grants access or drives updates. */
export const AppCopyOrigin = Schema.Struct({
  reference: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  commit: Schema.NullOr(SourceCommit),
});
export type AppCopyOrigin = typeof AppCopyOrigin.Type;
/** A host-resolved snapshot. Hosts authorize its origin before invoking the SDK. */
export const AppCopySnapshot = Schema.Struct({
  files: SourceFiles,
  origin: AppCopyOrigin,
  activation: Schema.Literals(["deploy", "save"]),
});
export type AppCopySnapshot = typeof AppCopySnapshot.Type;
/** One independent app, its source repository and optional active deployment. */
export const App = Schema.Struct({
  id: AppId,
  slug: AppSlug,
  code: AppCodeId,
  repository: Schema.NullOr(AppCodeId),
  owner: OwnerId,
  name: Schema.NonEmptyString,
  activeDeployment: Schema.NullOr(DeploymentId),
  copiedFrom: Schema.NullOr(AppCopyOrigin),
  requirements: AppRequirements,
  createdAt: Schema.Date,
});

export type App = typeof App.Type;

/** Operations that just deployed code can return a non-null active deployment. */
export const DeployedApp = App.mapFields((fields) => ({
  ...fields,
  activeDeployment: DeploymentId,
}));
export type DeployedApp = typeof DeployedApp.Type;

/** Deploy complete files or read an existing commit; deployment never edits Git. */
export const DeployAppInput = Schema.Union([
  Schema.Struct({
    owner: OwnerId,
    name: AppName,
    files: SourceFiles,
    app: Schema.optional(Schema.Never),
    commit: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    owner: OwnerId,
    app: AppId,
    files: SourceFiles,
    commit: Schema.optional(Schema.Never),
    name: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    owner: OwnerId,
    app: AppId,
    commit: SourceCommit,
    files: Schema.optional(Schema.Never),
    name: Schema.optional(Schema.Never),
  }),
]);

export type DeployAppInput = typeof DeployAppInput.Type;

/** No app matched the ID and any supplied owner constraint. */
export const AppNotFound = UserFacingError.define({
  tag: "AppNotFound",
  status: 404,
  fields: { app: AppId },
  title: "App no longer available",
  description: "Executor could not find the requested app.",
  recovery: {
    action: "Return to Apps and open an available app.",
    instructions:
      "Check whether the app was removed or is unavailable in the current organization. Find the intended accessible app and reopen its account setup. Do not redirect the connection to a different app without the user’s choice.",
  },
});
/** Parsed AppNotFound failure. */
export type AppNotFound = typeof AppNotFound.Type;

/** A draft has source but no active executable deployment. */
export const AppNotDeployed = UserFacingError.define({
  tag: "AppNotDeployed",
  status: 409,
  fields: { app: AppId },
  title: "This app is not deployed",
  description: "The app has no active deployment to load.",
  recovery: {
    action: "Open Source and deploy the app before using its tools or accounts.",
    instructions:
      "Check the current app’s source and deployment status. Resolve any build errors and deploy the intended source through the supported app flow. Verify tool discovery after deployment.",
  },
});
/** Parsed undeployed-app failure. */
export type AppNotDeployed = typeof AppNotDeployed.Type;

/** Adding a configured copy must not overwrite an existing app with that name. */
export class AppNameTaken extends Schema.TaggedError<AppNameTaken>()(
  "AppNameTaken",
  { owner: OwnerId, name: Schema.String },
  { httpApiStatus: 409, description: "An app already uses this name for this owner." },
) {}

/** Another configured app already owns this readable address for this owner. */
export class AppSlugTaken extends Schema.TaggedError<AppSlugTaken>()(
  "AppSlugTaken",
  {
    owner: OwnerId,
    slug: AppSlug,
  },
  {
    httpApiStatus: 409,
    description: "Another app name produces this address. Choose a different name.",
  },
) {}

/** A saved selection does not match the app's declared provider or cardinality. */
export const AccountSelectionInvalid = UserFacingError.define({
  tag: "AccountSelectionInvalid",
  status: 422,
  fields: {
    app: AppId,
    slot: Schema.String,
    reason: Schema.Literals([
      "unknown_slot",
      "expected_one",
      "expected_many",
      "provider_mismatch",
      "duplicate_account",
    ]),
  },
  title: "Account selection needs attention",
  description: "The selected accounts do not match this app’s requirements.",
  recovery: {
    action: "Open Accounts and review the selected profile’s account choices.",
    instructions:
      "Compare the current app requirements with the selected profile’s saved account bindings. Identify the missing slot, wrong provider, duplicate account, or incorrect number of accounts. Ask for the intended account choice when it is unclear; never substitute another identity automatically. Verify tool discovery with the corrected selection.",
  },
});
/** Parsed invalid account selection. */
export type AccountSelectionInvalid = typeof AccountSelectionInvalid.Type;

/** A required account selection is missing; a new app can be configured before it can run. */
export const AccountRequired = UserFacingError.define({
  tag: "AccountRequired",
  status: 409,
  fields: { app: AppId, deployment: DeploymentId, slot: Schema.String },
  title: "Choose an account to continue",
  description: "This app needs an account that has not been selected yet.",
  recovery: {
    action: "Open Accounts and connect or select an account for each requirement.",
    instructions:
      "Read the current app’s account requirements and selected profile. Guide the user to connect or select the intended account for each missing requirement. Preserve existing choices and verify tool discovery when the selection is complete.",
  },
});
/** Parsed missing account selection. */
export type AccountRequired = typeof AccountRequired.Type;

/** Stop and clean up webhook subscriptions before deleting their configured app. */
export class AppWebhooksActive extends Schema.TaggedError<AppWebhooksActive>()(
  "AppWebhooksActive",
  { app: AppId },
  { httpApiStatus: 409, description: "Remove the app's webhook subscriptions before deleting it." },
) {}

/** A configured app owns active runs and cannot disappear while they execute. */
export class AppWorkflowsActive extends Schema.TaggedError<AppWorkflowsActive>()(
  "AppWorkflowsActive",
  { app: AppId },
  {
    httpApiStatus: 409,
    description: "Terminate the app's active workflow runs before deleting it.",
  },
) {}

/** Canonical operation inputs; Promise and HTTP callers use the same validators. */
export const AppInputs = {
  create: Schema.Struct({ owner: OwnerId, name: AppName, files: SourceFiles }),
  workspace: Schema.Struct({ app: AppId, owner: Schema.optional(OwnerId) }),
  commit: Schema.Struct({
    app: AppId,
    owner: Schema.optional(OwnerId),
    expected: Schema.NullOr(SourceCommit),
    files: SourceFiles,
    message: Schema.NonEmptyString,
  }),
  copy: Schema.Struct({
    from: Schema.Union([AppId, AppCopySnapshot]),
    owner: OwnerId,
    name: AppName,
  }),
  deploy: DeployAppInput,
  get: Schema.Struct({ app: AppId, owner: Schema.optional(OwnerId) }),
  // Omitted IDs select all apps for the owner; an empty list selects none.
  list: Schema.Struct({
    owner: Schema.optional(OwnerId),
    ids: Schema.optional(Schema.Array(AppId)),
    name: Schema.optional(AppName),
    slug: Schema.optional(AppSlug),
    account: Schema.optional(AccountId),
  }),
  activate: Schema.Struct({
    app: AppId,
    deployment: DeploymentId,
    owner: Schema.optional(OwnerId),
    expectedDeployment: Schema.optional(Schema.NullOr(DeploymentId)),
  }),
  rename: Schema.Struct({
    app: AppId,
    owner: Schema.optional(OwnerId),
    name: AppName,
  }),
  source: Schema.Struct({
    app: AppId,
    owner: Schema.optional(OwnerId),
    deploymentOwner: Schema.optional(OwnerId),
    deployment: Schema.optional(DeploymentId),
  }),
  // `deploymentOwner` is separate from `owner`: owner selects the configured app.
  deployments: Schema.Struct({
    app: AppId,
    owner: Schema.optional(OwnerId),
    deploymentOwner: Schema.optional(OwnerId),
  }),
};
const appParams = { app: AppInputs.get.fields.app };
const ownerQuery = { owner: AppInputs.get.fields.owner };

/** Creation and deployment share a build pipeline; copies own independent source. */
export const AppsGroup = HttpApiGroup.make("apps")
  .add(
    HttpApiEndpoint.post("create", "/v1/apps/drafts", {
      payload: AppInputs.create,
      success: App,
      error: [StorageError, ...sourceErrors, AppNameTaken, AppSlugTaken],
    }),
    HttpApiEndpoint.get("workspace", "/v1/apps/:app/workspace", {
      params: appParams,
      query: ownerQuery,
      success: SourceSnapshot,
      error: [StorageError, ...sourceErrors, AppNotFound],
    }),
    HttpApiEndpoint.post("commit", "/v1/apps/:app/commits", {
      params: appParams,
      payload: AppInputs.commit.mapFields((fields) => ({
        expected: fields.expected,
        files: fields.files,
        message: fields.message,
        owner: fields.owner,
      })),
      success: SourceSnapshot,
      error: [StorageError, ...sourceErrors, AppNotFound],
    }),
    HttpApiEndpoint.post("copy", "/v1/apps/copies", {
      payload: AppInputs.copy,
      success: App,
      error: [
        StorageError,
        ...sourceErrors,
        AppNotFound,
        AppNameTaken,
        AppSlugTaken,
        DeploymentNotFound,
        AppNotDeployed,
        DeploymentBuildFailed,
        BuildMemoryExceeded,
        SkillDefinitionInvalid,
        AccountNotFound,
        AccountSelectionInvalid,
      ],
    }),
    HttpApiEndpoint.post("deploy", "/v1/apps/deploy", {
      payload: AppInputs.deploy,
      success: Schema.Struct({ app: DeployedApp, deployment: Deployment }),
      error: [
        ...sourceErrors,
        StorageError,
        DeploymentBuildFailed,
        BuildMemoryExceeded,
        SkillDefinitionInvalid,
        AppNameTaken,
        AppSlugTaken,
        AppNotFound,
        AccountNotFound,
        AccountSelectionInvalid,
      ],
    }).annotate(
      OpenApi.Description,
      "Deploy app source files. index.ts exports defineApp from apps. Creates a new named app, or deploys files or an existing commit by app ID. Never writes Git. The newest successful deployment activates automatically. Discover tools in the next execute call.",
    ),
  )
  .add(
    HttpApiEndpoint.get("get", "/v1/apps/:app", {
      params: appParams,
      query: ownerQuery,
      success: App,
      error: [StorageError, AppNotFound],
    }).annotate(
      OpenApi.Description,
      "Inspect an app and its account requirements. Read profiles for saved selections.",
    ),
  )
  .add(
    HttpApiEndpoint.get("list", "/v1/apps", {
      query: {
        owner: AppInputs.list.fields.owner,
        name: AppInputs.list.fields.name,
        slug: AppInputs.list.fields.slug,
        account: AppInputs.list.fields.account,
        // A JSON query value preserves [] instead of dropping it as an absent query parameter.
        ids: Schema.optional(Schema.fromJsonString(Schema.Array(AppId))),
      },
      success: Schema.Array(App),
      error: [StorageError],
    }).annotate(
      OpenApi.Description,
      "List apps and their requirements. Owner is an optional lookup filter.",
    ),
  )
  // Idempotent removal of one configured copy; accounts and retained code are independent.
  .add(
    HttpApiEndpoint.delete("remove", "/v1/apps/:app", {
      params: appParams,
      query: ownerQuery,
      success: Schema.Struct({ app: AppId }),
      error: [StorageError, AppWebhooksActive, AppWorkflowsActive],
    }).annotate(
      OpenApi.Description,
      "Delete one app and its profiles. Saved accounts, retained deployments and other copies are kept. Repeating removal is safe.",
    ),
  )
  .add(
    HttpApiEndpoint.patch("rename", "/v1/apps/:app/name", {
      params: appParams,
      query: ownerQuery,
      payload: Schema.Struct({
        name: AppInputs.rename.fields.name,
      }),
      success: App,
      error: [StorageError, AppNotFound, AppNameTaken, AppSlugTaken],
    }).annotate(
      OpenApi.Description,
      "Rename an app and derive its new slug. The name and normalized slug must be unique within its owner.",
    ),
  )
  .add(
    HttpApiEndpoint.post("activate", "/v1/apps/:app/activate", {
      params: appParams,
      query: ownerQuery,
      payload: Schema.Struct({
        deployment: AppInputs.activate.fields.deployment,
        expectedDeployment: AppInputs.activate.fields.expectedDeployment,
      }),
      success: App,
      // Same code lineage only. Profile setup becomes pending; selections remain unchanged.
      error: [
        StorageError,
        AppNotFound,
        DeploymentNotFound,
        AppNotDeployed,
        AppDeploymentChanged,
        AccountNotFound,
        AccountSelectionInvalid,
      ],
    }).annotate(
      OpenApi.Description,
      "Activate a retained deployment in the same code lineage. Profile setup becomes pending; calls validate selections against the active requirements. expectedDeployment rejects a concurrent activation.",
    ),
  )
  .add(
    HttpApiEndpoint.get("deployments", "/v1/apps/:app/deployments", {
      params: appParams,
      query: {
        owner: AppInputs.deployments.fields.owner,
        deploymentOwner: AppInputs.deployments.fields.deploymentOwner,
      },
      success: Schema.Array(DeploymentSummary),
      error: [StorageError, AppNotFound],
    }).annotate(OpenApi.Description, "List retained deployments in the app code lineage."),
  )
  .add(
    HttpApiEndpoint.get("deployment", "/v1/apps/:app/deployment", {
      params: appParams,
      query: {
        owner: AppInputs.source.fields.owner,
        deploymentOwner: AppInputs.source.fields.deploymentOwner,
        deployment: AppInputs.source.fields.deployment,
      },
      success: DeploymentMetadata,
      error: [StorageError, AppNotFound, AppNotDeployed, DeploymentNotFound],
    }).annotate(OpenApi.Description, "Read retained build metadata without fetching source files."),
  )
  .add(
    HttpApiEndpoint.get("source", "/v1/apps/:app/source", {
      params: { app: AppId },
      query: {
        owner: AppInputs.source.fields.owner,
        deploymentOwner: AppInputs.source.fields.deploymentOwner,
        deployment: AppInputs.source.fields.deployment,
      },
      success: Deployment,
      error: [StorageError, AppNotFound, AppNotDeployed, DeploymentNotFound],
    }).annotate(
      OpenApi.Description,
      "Read source files for a retained deployment in the app code lineage.",
    ),
  );
