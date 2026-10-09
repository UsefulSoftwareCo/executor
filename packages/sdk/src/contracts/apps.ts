import { UserFacingError, type ErrorPresentation } from "@executor-js/utils/user-facing-error";
import { ApiError } from "@executor-js/utils/api-error";
import { DeclaredRequirements } from "apps/contracts";
import { AppSlug } from "./app-slug.ts";
export { AppSlug, appSlug } from "./app-slug.ts";
/** Apps own deployed code and declared requirements. Profiles hold account selections. */
import { Schema } from "effect";
import { StorageError } from "./shared.ts";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { AccountId, AppCodeId, AppId, DeploymentId, OwnerId, ProviderId } from "./shared.ts";
import {
  AccountFieldsInput,
  AccountFieldsInvalid,
  AccountNotFound,
  CredentialCheck,
} from "./account.ts";
import { AuthMethodInvalid, AuthMethodName, ProviderDefinition } from "./provider.ts";
import {
  CommittedSource,
  GitCommit,
  SourceCommit,
  sourceErrors,
  SourceSnapshot,
} from "./source.ts";
import { PublicationReference, RegistryError } from "./registry.ts";
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
  /** This deployment's provider defines an account check for the slot. */
  health: Schema.optionalKey(Schema.Literal(true)),
});

export type AccountRequirement = typeof AccountRequirement.Type;

/** App-wide requirements, extracted from the deployed app's declaration. */
export const AppRequirements = Schema.Struct({
  capabilities: DeclaredRequirements.fields.capabilities,
  /** The document store of apps built before `sql`. Their retained builds still use it. */
  database: DeclaredRequirements.fields.database,
  sql: DeclaredRequirements.fields.sql,
  accounts: Schema.Record(Schema.NonEmptyString, AccountRequirement),
  /** The events the app emits, read without evaluating it. */
  events: DeclaredRequirements.fields.events,
});

export type AppRequirements = typeof AppRequirements.Type;

/** Whether the app owns a database, so its calls run in its data facet. */
export const ownsDatabase = (requirements: Pick<AppRequirements, "database" | "sql">) =>
  requirements.sql === true || requirements.database !== undefined;

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
  Schema.isPattern(/\S/u),
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

/** An undeployed app has source but no active executable deployment. */
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
export const AppNameTaken = ApiError.define({
  tag: "AppNameTaken",
  status: 409,
  fields: { owner: OwnerId, name: Schema.String },
  message:
    "An app with this name already exists. Choose another name, or deploy to the existing app by its ID.",
});
export type AppNameTaken = typeof AppNameTaken.Type;

/** Another configured app already owns this readable address for this owner. */
export const AppSlugTaken = ApiError.define({
  tag: "AppSlugTaken",
  status: 409,
  fields: {
    owner: OwnerId,
    slug: AppSlug,
    /** The app holding the address, when the caller may see it. Products decide visibility. */
    existing: Schema.optionalKey(Schema.Struct({ app: AppId, name: Schema.String })),
  },
  message: ({ slug, existing }) =>
    existing === undefined
      ? `Another app already uses the address “${slug}”, which this name also produces. Choose a different name.`
      : `The app “${existing.name}” (${existing.app}) already uses the address “${slug}”, which this name also produces. Choose a different name, or deploy to that app by its ID.`,
  recorded: () => "Another app already uses the address this name produces",
});
export type AppSlugTaken = typeof AppSlugTaken.Type;

/** A selection does not match the app's declared provider or cardinality. Each reason has its own recovery. */
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
  recorded: ({ reason }) => `Account selection does not match the app's requirements: ${reason}`,
  // Every reason except unknown_slot names a slot the app's current deployment declares, so the
  // slot is the app's own requirement name, not a value the caller chose.
  presentation: ({ slot, reason }) =>
    (
      ({
        unknown_slot: {
          title: "Account requirement not found",
          description:
            "The app’s current deployment doesn’t declare the account requirement that was selected.",
          recovery: {
            action: "Open Accounts and choose accounts for the requirements this app declares now.",
            instructions:
              "Read the app’s current account requirements; a redeploy may have renamed or removed one. Use a requirement name the app declares now, and drop saved choices for requirements it no longer declares. Never move an account to another requirement without the user’s choice. Verify tool discovery with the corrected selection.",
          },
        },
        expected_one: {
          title: "Choose one account",
          description: `The “${slot}” requirement takes one account, but a list was selected.`,
          recovery: {
            action: "Open Accounts and choose one account for this requirement.",
            instructions:
              "The app declares this requirement with one account. Select a single account ID, not a list. Ask the user which account to keep when it is unclear; never pick one automatically. Verify tool discovery with the corrected selection.",
          },
        },
        expected_many: {
          title: "Choose a list of accounts",
          description: `The “${slot}” requirement takes a list of accounts, but a single account was selected.`,
          recovery: {
            action: "Open Accounts and review the accounts selected for this requirement.",
            instructions:
              "The app declares this requirement with several accounts. Select the account IDs as a list, even when there is one. Keep the user’s existing choices. Verify tool discovery with the corrected selection.",
          },
        },
        provider_mismatch: {
          title: "Account belongs to another provider",
          description: `The account was connected for a different provider definition than the one this app now declares for “${slot}”. Changing a provider’s name, labels, fields or OAuth scopes makes it a new provider, and accounts connected for the old one don’t fit it.`,
          recovery: {
            action: "Open Accounts and connect a new account for this requirement.",
            instructions:
              "This account can’t be selected or reconnected for this requirement. Start a new connection for it without `account` (with the Executor app, accounts.connect without `account`), and give the user the returned URL. If the provider change was unintended, restore the previous definition and redeploy instead. Keep the old account; never substitute another identity automatically. Verify tool discovery once the new account is selected.",
          },
        },
        duplicate_account: {
          title: "Account selected twice",
          description: `The same account is selected more than once for “${slot}”.`,
          recovery: {
            action: "Open Accounts and remove the repeated account.",
            instructions:
              "Select each account ID once in this requirement’s list. Keep the user’s other choices. Verify tool discovery with the corrected selection.",
          },
        },
      }) satisfies Record<typeof reason, ErrorPresentation>
    )[reason],
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
export const AppWebhooksActive = ApiError.define({
  tag: "AppWebhooksActive",
  status: 409,
  fields: { app: AppId },
  message: "Remove the app's webhook subscriptions before deleting it.",
});
export type AppWebhooksActive = typeof AppWebhooksActive.Type;

/** A configured app owns active runs and cannot disappear while they execute. */
export const AppWorkflowsActive = ApiError.define({
  tag: "AppWorkflowsActive",
  status: 409,
  fields: { app: AppId },
  message: "Terminate the app's active workflow runs before deleting it.",
});
export type AppWorkflowsActive = typeof AppWorkflowsActive.Type;

/** Canonical operation inputs; Promise and HTTP callers use the same validators. */
export const AppInputs = {
  /** Credentials to check with the app's check for their provider; never saved. */
  checkCredentials: Schema.Struct({
    app: AppId,
    owner: Schema.optional(OwnerId),
    provider: ProviderId,
    method: AuthMethodName,
    fields: AccountFieldsInput,
  }),
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
    from: Schema.Union([AppId, AppCopySnapshot, PublicationReference]),
    owner: OwnerId,
    name: AppName,
  }),
  history: Schema.Struct({ app: AppId, owner: Schema.optional(OwnerId) }),
  revision: Schema.Struct({ app: AppId, owner: Schema.optional(OwnerId), commit: SourceCommit }),
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
    HttpApiEndpoint.post("checkCredentials", "/v1/apps/:app/credential-checks", {
      params: appParams,
      query: ownerQuery,
      payload: Schema.Struct({
        provider: AppInputs.checkCredentials.fields.provider,
        method: AppInputs.checkCredentials.fields.method,
        fields: AppInputs.checkCredentials.fields.fields,
      }),
      success: Schema.NullOr(CredentialCheck),
      error: [StorageError, AppNotFound, AuthMethodInvalid, AccountFieldsInvalid],
    }).annotate(
      OpenApi.Description,
      "Check credentials before saving them, with this app's check for their provider. Nothing is saved or recorded. Returns null when the app defines no check for the provider.",
    ),
  )
  .add(
    HttpApiEndpoint.post("create", "/v1/apps", {
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
      success: CommittedSource,
      error: [StorageError, ...sourceErrors, AppNotFound],
    }).annotate(
      OpenApi.Description,
      "Save a complete file list as a commit on the working branch without deploying it. Omitted files are deleted. Returns the new revision; the files are not echoed.",
    ),
    HttpApiEndpoint.get("history", "/v1/apps/:app/history", {
      params: appParams,
      query: ownerQuery,
      success: Schema.Array(GitCommit),
      error: [StorageError, ...sourceErrors, AppNotFound],
    }).annotate(OpenApi.Description, "Recent commits on the app's working branch."),
    HttpApiEndpoint.get("revision", "/v1/apps/:app/revisions/:commit", {
      params: { app: AppInputs.revision.fields.app, commit: AppInputs.revision.fields.commit },
      query: ownerQuery,
      success: SourceFiles,
      error: [StorageError, ...sourceErrors, AppNotFound],
    }).annotate(OpenApi.Description, "The complete files at one commit in the app's code lineage."),
    HttpApiEndpoint.post("copy", "/v1/apps/copies", {
      payload: AppInputs.copy,
      success: App,
      error: [
        StorageError,
        ...sourceErrors,
        RegistryError,
        AppNotFound,
        AppNameTaken,
        AppSlugTaken,
        DeploymentNotFound,
        AppNotDeployed,
        DeploymentBuildFailed,
        BuildMemoryExceeded,
        AccountNotFound,
        AccountSelectionInvalid,
      ],
    }),
    HttpApiEndpoint.post("deploy", "/v1/apps/deploy", {
      payload: AppInputs.deploy,
      success: Schema.Struct({ app: DeployedApp, deployment: DeploymentMetadata }),
      error: [
        ...sourceErrors,
        StorageError,
        DeploymentBuildFailed,
        BuildMemoryExceeded,
        AppNameTaken,
        AppSlugTaken,
        AppNotFound,
        AccountNotFound,
        AccountSelectionInvalid,
      ],
    }).annotate(
      OpenApi.Description,
      "Deploy app source files. index.ts exports defineApp from apps. Creates a new named app, or deploys files or an existing commit by app ID. Never writes Git. The newest successful deployment activates automatically. Returns the app and the new deployment's metadata; the files are not echoed. Discover tools in the next execute call.",
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
