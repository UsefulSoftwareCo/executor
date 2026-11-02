import { AccountProvisioned } from "@executor-js/sdk/core";
import {
  InteractiveRetirementBusy,
  InteractiveRetirementFailed,
  InteractiveReconnectUnsupported,
} from "@executor-js/sdk/core";
import { RequiredAction } from "./authorization.ts";
/**
 * The accounts linked to an app's requirements. An app link fills an app requirement for every
 * caller and the app's background work; a user link fills a user requirement for the member who
 * made it. Links are keyed by requirement in both scopes, and a link never shares the account
 * with anyone: an app link is used only through the app.
 */
import {
  Account,
  AccountHealth,
  AccountConnectionNotFound,
  AccountConnectionTargetChanged,
  AccountId,
  AccountNotFound,
  AccountWebhooksActive,
  AccountWorkflowsActive,
  AccountRequirement,
  AccountScope,
  AccountSelectionInvalid,
  AppId,
  AppNotFound,
  ProviderNotFound,
  StorageError,
} from "@executor-js/sdk/core";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { BrowserAccountConnection } from "./accounts.ts";
import { ConnectionDestination } from "./resource-access.ts";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";

const mismatch = {
  requirement: {
    title: "This app has no such account requirement here",
    description: (scope: AccountScope) =>
      scope === "app"
        ? "The app's active version doesn't declare this requirement as one of its own, linked for everyone."
        : "The app's active version doesn't declare this requirement as one each member links for themselves.",
    action: (scope: AccountScope) =>
      scope === "app"
        ? "Link the account to one of the app's own requirements, or link it for yourself if the requirement is a user one."
        : "Link the account to one of the requirements each member links, or ask someone who can edit the app to link it for everyone.",
  },
  app_bound: {
    title: "This account belongs to another app",
    description: () => "Only the app that acquired this account can use its reference.",
    action: () => "Connect a new account from this app.",
  },
  provider: {
    title: "This requirement uses another kind of account",
    description: () => "The account's provider is not the one this requirement uses.",
    action: () =>
      "Link an account from the provider this requirement names, or connect one for it.",
  },
} as const;
/**
 * The account cannot be linked to this requirement in this scope: the app's active version
 * does not declare the requirement in it (`requirement`), or the account's provider is not the
 * requirement's (`provider`).
 */
export const RequirementMismatch = UserFacingError.define({
  tag: "RequirementMismatch",
  status: 422,
  fields: {
    app: AppId,
    requirement: Schema.String,
    scope: AccountScope,
    reason: Schema.Literals(["requirement", "provider", "app_bound"]),
  },
  recorded: ({ scope, reason }) =>
    `The account cannot be linked to this ${scope} requirement: ${reason}`,
  presentation: ({ scope, reason }) => ({
    title: mismatch[reason].title,
    description: mismatch[reason].description(scope),
    recovery: {
      action: mismatch[reason].action(scope),
      instructions:
        "Read the app's account requirements and their scopes with appAccounts.appList or appAccounts.userList, and the accounts a requirement takes with appAccounts.appGet or appAccounts.userGet. Link only accounts of the provider the requirement names, in the requirement's own scope. Do not change the app's requirements to fit an account.",
    },
  }),
});
/** Parsed RequirementMismatch failure. */
export type RequirementMismatch = typeof RequirementMismatch.Type;

/**
 * A linked account's saved sign-in state, so people learn it must be reconnected. Only the state
 * and a non-renewable grant's expiry leave the host.
 */
export const LinkedAccountSignIn = Schema.Union([
  Schema.Struct({ state: Schema.Literal("saved"), reconnectAt: Schema.NullOr(Schema.Date) }),
  Schema.Struct({ state: Schema.Literals(["reconnect", "unavailable"]) }),
]);
export type LinkedAccountSignIn = typeof LinkedAccountSignIn.Type;

/**
 * One account linked to one of the app's requirements, with its sign-in and checks by this app.
 * Members who cannot edit the app read app links without the upstream identity checks reported
 * (`health.info` is null).
 */
export const AppAccountLink = Schema.Struct({
  requirement: Schema.NonEmptyString,
  account: Account,
  createdAt: Schema.Date,
  signIn: LinkedAccountSignIn,
  canReconnect: Schema.Boolean,
  health: Schema.optionalKey(AccountHealth),
});
export type AppAccountLink = typeof AppAccountLink.Type;

/** One account a requirement lists: linked to it, or one the caller could link. */
export const RequirementAccount = Schema.Struct({
  account: Account,
  linked: Schema.Boolean,
});
export type RequirementAccount = typeof RequirementAccount.Type;

/**
 * One requirement of the app in one scope: its linked accounts, oldest first, then the other
 * accounts of its provider the caller can use and could link.
 */
export const AppAccountRequirement = Schema.Struct({
  requirement: Schema.NonEmptyString,
  scope: AccountScope,
  provider: AccountRequirement.fields.provider,
  cardinality: AccountRequirement.fields.cardinality,
  accounts: Schema.Array(RequirementAccount),
});
export type AppAccountRequirement = typeof AppAccountRequirement.Type;

const app = { organization: OrganizationReference, app: AppId };
const requirement = { ...app, requirement: Schema.NonEmptyString };
const link = { ...requirement, account: AccountId };
const prefix = "/api/organizations/:organization/apps/:app/accounts";
const errors = [
  AccountProvisioned,
  InteractiveRetirementBusy,
  InteractiveRetirementFailed,
  StorageError,
  AppNotFound,
  AccountNotFound,
  RequirementMismatch,
  AccountWebhooksActive,
  AccountWorkflowsActive,
  OrganizationForbidden,
] as const;
const connectErrors = [
  InteractiveReconnectUnsupported,
  ...errors,
  ProviderNotFound,
  AccountSelectionInvalid,
  AccountConnectionNotFound,
  AccountConnectionTargetChanged,
] as const;
const connectPayload = Schema.Struct({
  destination: Schema.optional(ConnectionDestination),
  /** Replace this account's credentials instead of adding an account. */
  account: Schema.optional(AccountId),
});
const connectDescription =
  "Completing it links the new account to this requirement. redirectUri is the callback to register when the service needs the user's own OAuth client. For an OAuth method of the returned provider, accounts.oauthSetup with provider.id and the method name lists the permissions sign-in will request. Pass account to replace an existing account's credentials instead.";

/** The `/:scope` routes of one scope, named `appAccounts.<scope><Action>` for tools, such as `appAccounts.appList`. */
const scopeEndpoints = <const S extends AccountScope>(scope: S) => {
  const path = `${prefix}/${scope}` as const;
  const forEveryone = scope === "app";
  return [
    HttpApiEndpoint.get(`${scope}List`, path, {
      params: app,
      success: Schema.Array(AppAccountLink),
      error: errors,
    })
      .annotate(RequiredAction, "read")
      .annotate(
        OpenApi.Description,
        forEveryone
          ? "List the accounts linked to this app's own requirements, oldest first per requirement, with each account's sign-in state and checks by this app. Every caller and the app's background work use them; a plain requirement uses its one linked account. Anyone who can use the app can read them; only people who can edit the app see the identity checks reported."
          : "List the accounts you linked to this app's user requirements and can still use, oldest first per requirement, with each account's sign-in state and checks by this app. Your calls use them: a plain requirement uses your one linked account, and many() every one.",
      ),
    HttpApiEndpoint.get(`${scope}Get`, `${path}/:requirement`, {
      params: requirement,
      success: AppAccountRequirement,
      error: errors,
    })
      .annotate(RequiredAction, "read")
      .annotate(
        OpenApi.Description,
        forEveryone
          ? "Read one of this app's own requirements: the accounts linked to it, then the other accounts of its provider you can use and could link, each marked linked or not. Needs edit access to the app."
          : "Read one of this app's user requirements: the accounts you linked to it, then the other accounts of its provider you can use and could link, each marked linked or not. Choose from these accounts before linking.",
      ),
    HttpApiEndpoint.put(`${scope}Link`, `${path}/:requirement/:account`, {
      params: link,
      success: AppAccountLink,
      error: errors,
    })
      .annotate(RequiredAction, forEveryone ? "manage" : "run")
      .annotate(
        OpenApi.Description,
        forEveryone
          ? "Link an account to one of this app's own requirements, so every caller and the app's background work use it through the app, without access to the account itself. Needs edit access to the app and use of the account. Linking an account to a plain requirement replaces the account linked to it before; for many() it adds one. Linking again changes nothing. The replaced account stays saved."
          : "Link one of your accounts to one of this app's user requirements. Needs use of the app and of the account. Linking an account to a plain requirement replaces the account you linked to it before; for many() it adds one. Linking again changes nothing. The replaced account stays saved.",
      ),
    HttpApiEndpoint.delete(`${scope}Unlink`, `${path}/:requirement/:account`, {
      params: link,
      success: Schema.Struct({ requirement: Schema.NonEmptyString, account: AccountId }),
      error: errors,
    })
      .annotate(RequiredAction, forEveryone ? "manage" : "run")
      .annotate(
        OpenApi.Description,
        forEveryone
          ? "Stop this app using an account for one of its own requirements. Needs edit access to the app, not use of the account. Calls and background work that need the requirement fail until another account is linked, and the app's webhooks registered with the account are removed. The account stays saved."
          : "Stop using an account for one of this app's user requirements. The account and its other links stay unchanged.",
      ),
    HttpApiEndpoint.post(`${scope}Connect`, `${path}/:requirement/connections`, {
      params: requirement,
      payload: connectPayload,
      success: BrowserAccountConnection,
      error: connectErrors,
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        `${
          forEveryone
            ? "Connect a new account for one of this app's own requirements. Needs edit access to the app."
            : "Connect a new account of your own for one of this app's user requirements."
        } Returns the url of the browser form where the user enters credentials or signs in; give the user that url. ${connectDescription}`,
      ),
  ] as const;
};

/**
 * Links fill requirements by name, in the scope the route names: `app` routes link for everyone
 * and need edit access to the app (reading the list needs only use of it), `user` routes link the
 * caller's own accounts. A plain requirement keeps one link, and linking another replaces it;
 * many() keeps every one. Connection status and form steps stay under `accounts.connection`.
 */
const [appList, appGet, appLink, appUnlink, appConnect] = scopeEndpoints("app");
const [userList, userGet, userLink, userUnlink, userConnect] = scopeEndpoints("user");
export const HostedAppAccounts = HttpApiGroup.make("appAccounts")
  .add(appList)
  .add(appGet)
  .add(appLink)
  .add(appUnlink)
  .add(appConnect)
  .add(userList)
  .add(userGet)
  .add(userLink)
  .add(userUnlink)
  .add(userConnect)
  .middleware(RequireOrganization);
