import { UserFacingError, type ErrorPresentation } from "@executor-js/utils/user-facing-error";
import { ApiError } from "@executor-js/utils/api-error";
import { withLegacyKeys } from "@executor-js/utils/legacy-keys";
import { DeclaredRequirements } from "apps/contracts";
import { AppSlug } from "./app-slug.ts";
export { AppSlug, appSlug } from "./app-slug.ts";
/** Apps own deployed code and declared requirements. Callers choose accounts for each operation. */
import { Effect, Schema } from "effect";
import { StorageError } from "./shared.ts";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { AccountId, AppCodeId, AppId, VersionId, OwnerId, ProviderId } from "./shared.ts";
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
  AppVersionChanged,
  Version,
  VersionMetadata,
  VersionBuildFailed,
  BuildMemoryExceeded,
  VersionNotFound,
  VersionSummary,
  SourceFiles,
} from "./version.ts";

/**
 * Whose accounts fill a requirement. An `app` requirement is filled by the app links, which the
 * app's managers make for every caller and for the app's background work; a `user` requirement by
 * each caller's own links. A requirement name is used in one scope only.
 */
export const AccountScope = Schema.Literals(["app", "user"]);
export type AccountScope = typeof AccountScope.Type;

/**
 * A host-resolved account requirement. Available before accounts are selected
 * and before the dynamic factory runs. Provider metadata is data, not JS code.
 */
export const AccountRequirement = Schema.Struct({
  /** Recorded at deploy. Versions saved before scopes declared only user requirements. */
  scope: AccountScope.pipe(Schema.withDecodingDefaultKey(Effect.succeed("user" as const))),
  provider: ProviderId,
  definition: ProviderDefinition,
  cardinality: Schema.Literals(["one", "many"]),
  /** This version's provider defines an account check for the slot. */
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
  /** The icons the app declares on `defineApp`, recorded at build without evaluating it. */
  icons: DeclaredRequirements.fields.icons,
});

export type AppRequirements = typeof AppRequirements.Type;

/** Whether the app owns a database, so its calls run in its data facet. */
export const ownsDatabase = (requirements: Pick<AppRequirements, "database" | "sql">) =>
  requirements.sql === true || requirements.database !== undefined;

/** A retained version's build metadata and the requirements its code declares. */
export const RetainedVersion = Schema.Struct({
  ...VersionMetadata.fields,
  requirements: AppRequirements,
});
export type RetainedVersion = typeof RetainedVersion.Type;

/**
 * Requirement name -> one account ID for a plain requirement, or account IDs for many(). The
 * shape that captured background work stores, matching the requirement's cardinality.
 */
export const SelectedAccounts = Schema.Record(
  Schema.NonEmptyString,
  Schema.Union([AccountId, Schema.Array(AccountId)]),
);

export type SelectedAccounts = typeof SelectedAccounts.Type;

/** One scope's accounts: requirement name -> account IDs. */
export const ScopeAccounts = Schema.Record(Schema.NonEmptyString, Schema.Array(AccountId));
export type ScopeAccounts = typeof ScopeAccounts.Type;

/**
 * The accounts an operation runs with, by scope: requirement name -> account IDs. Products resolve
 * `app` from the app links and `user` from the caller's user links; callers never choose
 * them. Every declared requirement is named in its scope. A plain requirement takes exactly one
 * account; many() takes zero or more. Without `user` the operation runs without a caller, as app
 * schedules and app-account webhooks do: with the app's accounts only, and a context without
 * `user`.
 */
export const AppAccounts = Schema.Struct({
  app: ScopeAccounts,
  user: Schema.optionalKey(ScopeAccounts),
});

export type AppAccounts = typeof AppAccounts.Type;

/** Each requirement an invocation names with its accounts, across both scopes. */
export const invocationEntries = (
  accounts: AppAccounts,
): ReadonlyArray<readonly [string, ReadonlyArray<AccountId>]> => [
  ...Object.entries(accounts.app),
  ...Object.entries(accounts.user ?? {}),
];
/**
 * The same scope and the same accounts for each requirement, in any order; requirements without
 * accounts name none.
 */
export const sameAccounts = (left: AppAccounts, right: AppAccounts) => {
  const named = (accounts: AppAccounts) =>
    new Map(
      invocationEntries(accounts)
        .filter(([, ids]) => ids.length > 0)
        .map(([slot, ids]) => [slot, new Set(ids)] as const),
    );
  const a = named(left);
  const b = named(right);
  return (
    (left.user === undefined) === (right.user === undefined) &&
    a.size === b.size &&
    [...a].every(([slot, ids]) => {
      const other = b.get(slot);
      return (
        other !== undefined && other.size === ids.size && [...ids].every((id) => other.has(id))
      );
    })
  );
};
/** AppAccounts in a GET query: JSON text, so an empty requirement survives as []. */
export const AppAccountsQuery = Schema.optional(Schema.fromJsonString(AppAccounts));

// The API document publishes the pattern; Effect publishes only `u`-flag patterns, which JSON
// Schema reads with Unicode semantics. It uses code-unit ranges rather than `\p{…}` classes, so it
// also means the same without the flag and in engines, such as Python's, that reject `\p{…}`.
/** Control characters and line or paragraph separators. */
const breaks = "\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029";
/** Spaces that are not line breaks. */
const blanks = " \\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000";
/** Format characters, which render as nothing, such as zero-width spaces and joiners. */
const invisible =
  "\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u0890\\u0891\\u08E2\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB";
/** Blanks and invisible characters, then a visible one, then anything on the same line. */
const oneVisibleLine = new RegExp(
  `^[${blanks}${invisible}]*[^${breaks}${blanks}${invisible}][^${breaks}]*$`,
  "u",
);

/**
 * Display names are one bounded line with a visible character; they do not replace stable app
 * identities. Control characters are refused because storage cannot hold NUL, and names made only
 * of invisible characters would list as blank. Names already stored are read with `NonEmptyString`,
 * so this only narrows what new writes accept.
 */
export const AppName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
  Schema.isPattern(oneVisibleLine),
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
/** The fields of an app, before its wire encoding. */
export const AppFields = Schema.Struct({
  id: AppId,
  slug: AppSlug,
  code: AppCodeId,
  repository: Schema.NullOr(AppCodeId),
  owner: OwnerId,
  name: Schema.NonEmptyString,
  activeVersion: Schema.NullOr(VersionId),
  copiedFrom: Schema.NullOr(AppCopyOrigin),
  requirements: AppRequirements,
  createdAt: Schema.Date,
});
/**
 * One independent app, its source repository and optional active version. Callers written before
 * versions were named read `activeDeployment`.
 */
export const App = AppFields.pipe(withLegacyKeys({ activeVersion: "activeDeployment" }));

export type App = typeof App.Type;

const DeployedAppFields = AppFields.mapFields((fields) => ({
  ...fields,
  activeVersion: VersionId,
}));
/** Operations that just deployed code can return a non-null active version. */
export const DeployedApp = DeployedAppFields.pipe(
  withLegacyKeys({ activeVersion: "activeDeployment" }),
);
export type DeployedApp = typeof DeployedApp.Type;

/** Deploy complete files or read an existing commit; deploying never edits Git. */
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

/** An undeployed app has source but no active executable version. */
export const AppNotDeployed = UserFacingError.define({
  tag: "AppNotDeployed",
  status: 409,
  fields: { app: AppId },
  title: "This app is not deployed",
  description: "The app has no active version to load.",
  recovery: {
    action: "Open Source and deploy the app before using its tools or accounts.",
    instructions:
      "Check the current app’s source and active version. Resolve any build errors and deploy the intended source through the supported app flow. Verify tool discovery after deploying.",
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
  // Every reason except unknown_slot names a slot the app's current version declares, so the
  // slot is the app's own requirement name, not a value the caller chose.
  presentation: ({ slot, reason }) =>
    (
      ({
        unknown_slot: {
          title: "Account requirement not found",
          description:
            "The app’s current version doesn’t declare the account requirement that was selected.",
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
          description: `The account was connected for a different provider definition than the one this app now declares for “${slot}”. Changing a provider’s name, methods, fields or OAuth scopes makes it a new provider, and accounts connected for the old one don’t fit it. Changing only display text, such as a method’s label, doesn’t.`,
          recovery: {
            action: "Open Accounts and connect a new account for this requirement.",
            instructions:
              "This account can’t be selected or reconnected for this requirement. Start a new connection for it without `account` (with the Executor app, appAccounts.userConnect or appAccounts.appConnect for the requirement, without `account`), and give the user the returned URL. If the provider change was unintended, restore the previous definition and redeploy instead. Keep the old account; never substitute another identity automatically. Verify tool discovery once the new account is selected.",
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

/**
 * A plain requirement has no linked account: a user requirement none the caller linked, an app
 * requirement no app link. A new app can be set up before it can run. Only people who can edit the
 * app link an app requirement's account, so the recovery names who can fix it.
 */
export const AccountRequired = UserFacingError.define({
  tag: "AccountRequired",
  status: 409,
  fields: { app: AppId, version: VersionId, slot: Schema.String, scope: AccountScope },
  presentation: ({ slot, scope }) =>
    scope === "app"
      ? {
          title: "Someone who can edit this app needs to link an account",
          description: `This app needs its own “${slot}” account, which someone who can edit the app links for everyone who uses it. None is linked yet.`,
          recovery: {
            action: "Ask someone who can edit this app to link an account on its Accounts tab.",
            instructions:
              "This is an app account requirement: it is linked for everyone, and only people who can edit the app link it. If the user can edit the app, guide them to link an account they can use for this requirement, or connect a new one for it (with the Executor app, appAccounts.appGet lists the accounts they could link, then appAccounts.appLink or appAccounts.appConnect). Otherwise tell the user that someone who can edit the app must link it. Verify tool discovery once it is linked.",
          },
        }
      : {
          title: "Link an account to continue",
          description: "This app needs an account that is not linked to it yet.",
          recovery: {
            action:
              "Open the app's Accounts tab and connect or link an account for each requirement.",
            instructions:
              "Read the current app’s account requirements and the accounts linked to it (with the Executor app, appAccounts.userGet lists the accounts the user could link for a requirement). Guide the user to connect or link the intended account for each missing requirement (appAccounts.userLink or appAccounts.userConnect). Keep the accounts already linked and verify tool discovery when every requirement has an account.",
          },
        },
});
/** A plain requirement with no linked account. */
export type AccountRequired = typeof AccountRequired.Type;

/** A linked account, named by its saved label. */
export const AccountChoice = Schema.Struct({ id: AccountId, label: Schema.String });
export type AccountChoice = typeof AccountChoice.Type;

/**
 * A caller named accounts for one call, such as `$accounts` on an MCP tool input. Calls no longer
 * choose accounts: each runs with the accounts the caller linked to the app.
 */
export const AccountChoiceUnsupported = UserFacingError.define({
  tag: "AccountChoiceUnsupported",
  status: 400,
  fields: { app: AppId },
  title: "Accounts are not chosen per call",
  description:
    "Accounts are not chosen per call. Each app uses the accounts you linked to it: one for each plain requirement, and every linked account for a many() requirement.",
  recovery: {
    action: "Call again without choosing accounts. Change the app's accounts in its Accounts tab.",
    instructions:
      "Remove the account choice from the call and call again. To use a different account, ask the user to link it in the app's Accounts tab; linking another account for a plain requirement replaces the one linked before.",
  },
});
/** A call that tried to choose its accounts. */
export type AccountChoiceUnsupported = typeof AccountChoiceUnsupported.Type;

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
  }),
  activate: Schema.Struct({
    app: AppId,
    version: VersionId,
    owner: Schema.optional(OwnerId),
    expectedVersion: Schema.optional(Schema.NullOr(VersionId)),
  }),
  rename: Schema.Struct({
    app: AppId,
    owner: Schema.optional(OwnerId),
    name: AppName,
  }),
  source: Schema.Struct({
    app: AppId,
    owner: Schema.optional(OwnerId),
    versionOwner: Schema.optional(OwnerId),
    version: Schema.optional(VersionId),
  }),
  // `versionOwner` is separate from `owner`: owner selects the configured app.
  versions: Schema.Struct({
    app: AppId,
    owner: Schema.optional(OwnerId),
    versionOwner: Schema.optional(OwnerId),
  }),
};
const appParams = { app: AppInputs.get.fields.app };
const ownerQuery = { owner: AppInputs.get.fields.owner };
// Versions were called deployments. Requests may still use those field names and responses repeat
// them, so callers written before the rename keep working.
const versionQuery = Schema.Struct({
  owner: AppInputs.source.fields.owner,
  versionOwner: AppInputs.source.fields.versionOwner,
  version: AppInputs.source.fields.version,
}).pipe(withLegacyKeys({ versionOwner: "deploymentOwner", version: "deployment" }));
const versionsQuery = Schema.Struct({
  owner: AppInputs.versions.fields.owner,
  versionOwner: AppInputs.versions.fields.versionOwner,
}).pipe(withLegacyKeys({ versionOwner: "deploymentOwner" }));
const versionsOptions = {
  params: appParams,
  query: versionsQuery,
  success: Schema.Array(VersionSummary),
  error: [StorageError, AppNotFound],
};
const versionOptions = {
  params: appParams,
  query: versionQuery,
  success: RetainedVersion,
  error: [StorageError, AppNotFound, AppNotDeployed, VersionNotFound],
};

/**
 * Former paths of the version endpoints. Served beside them for callers written before versions
 * were named, and left out of the Executor interface.
 */
export const LegacyVersionEndpoints = ["deployments", "deployment"] as const;

/** Creating and deploying share a build pipeline; copies own independent source. */
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
      "Save a complete file list as a commit on the working branch without deploying it. Omitted files are deleted. Returns the new revision and `removed`: how many files this save deleted and the first of their paths; the files are not echoed. A deleted file stays at the `expected` revision (`GET /v1/apps/:app/revisions/:commit`): to keep it, commit again against the new revision with it before deploying. A file path cannot also be a folder (`a` and `a/b`); such a save fails with SourcePathConflict and saves nothing. Paths must be valid Unicode; a lone surrogate fails with SourcePathNotUnicode.",
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
        VersionNotFound,
        AppNotDeployed,
        VersionBuildFailed,
        BuildMemoryExceeded,
        AccountNotFound,
        AccountSelectionInvalid,
      ],
    }),
    HttpApiEndpoint.post("deploy", "/v1/apps/deploy", {
      payload: AppInputs.deploy,
      success: Schema.Struct({ app: DeployedApp, version: VersionMetadata }).pipe(
        withLegacyKeys({ version: "deployment" }),
      ),
      error: [
        ...sourceErrors,
        StorageError,
        VersionBuildFailed,
        BuildMemoryExceeded,
        AppNameTaken,
        AppSlugTaken,
        AppNotFound,
        AccountNotFound,
        AccountSelectionInvalid,
      ],
    }).annotate(
      OpenApi.Description,
      "Deploy app source files. index.ts exports defineApp from apps. Creates a new named app, or deploys files or an existing commit by app ID. Never writes Git. The newest successful version activates automatically. Returns the app and the new version's metadata; the files are not echoed. Discover tools in the next execute call.",
    ),
  )
  .add(
    HttpApiEndpoint.get("get", "/v1/apps/:app", {
      params: appParams,
      query: ownerQuery,
      success: App,
      error: [StorageError, AppNotFound],
    }).annotate(OpenApi.Description, "Inspect an app and its account requirements."),
  )
  .add(
    HttpApiEndpoint.get("list", "/v1/apps", {
      query: {
        owner: AppInputs.list.fields.owner,
        name: AppInputs.list.fields.name,
        slug: AppInputs.list.fields.slug,
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
      "Delete one app, its schedules and its webhook sources. Saved accounts, retained versions and other copies are kept. Repeating removal is safe.",
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
        version: AppInputs.activate.fields.version,
        expectedVersion: AppInputs.activate.fields.expectedVersion,
      }).pipe(withLegacyKeys({ version: "deployment", expectedVersion: "expectedDeployment" })),
      success: App,
      // Same code lineage only. Managed webhooks re-register for the new version.
      error: [
        StorageError,
        AppNotFound,
        VersionNotFound,
        AppNotDeployed,
        AppVersionChanged,
        AccountNotFound,
        AccountSelectionInvalid,
      ],
    }).annotate(
      OpenApi.Description,
      "Activate a retained version in the same code lineage. Managed webhooks re-register for it, except that a manual one whose setup the version still serves keeps its callback URL and secret; calls validate their accounts against the active requirements. expectedVersion rejects a concurrent activation. The former field names `deployment` and `expectedDeployment` are still accepted.",
    ),
  )
  .add(
    HttpApiEndpoint.get("versions", "/v1/apps/:app/versions", versionsOptions).annotate(
      OpenApi.Description,
      "List retained versions in the app code lineage.",
    ),
  )
  .add(
    HttpApiEndpoint.get("version", "/v1/apps/:app/version", versionOptions).annotate(
      OpenApi.Description,
      "Read a retained version's build metadata and account requirements without fetching source files.",
    ),
  )
  .add(
    HttpApiEndpoint.get("deployments", "/v1/apps/:app/deployments", versionsOptions)
      .annotate(OpenApi.Description, "Former path of `GET /v1/apps/:app/versions`.")
      .annotate(OpenApi.Deprecated, true),
  )
  .add(
    HttpApiEndpoint.get("deployment", "/v1/apps/:app/deployment", versionOptions)
      .annotate(OpenApi.Description, "Former path of `GET /v1/apps/:app/version`.")
      .annotate(OpenApi.Deprecated, true),
  )
  .add(
    HttpApiEndpoint.get("source", "/v1/apps/:app/source", {
      params: { app: AppId },
      query: versionQuery,
      success: Version,
      error: [StorageError, AppNotFound, AppNotDeployed, VersionNotFound],
    }).annotate(
      OpenApi.Description,
      "Read source files for a retained version in the app code lineage.",
    ),
  );
