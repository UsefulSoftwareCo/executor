import { ApiError } from "@executor-js/utils/api-error";
import { RequiredAction } from "./authorization.ts";
import {
  Account,
  AccountHealth,
  Provider,
  AppId,
  AccountId,
  ProviderId,
  AccountScope,
  AccountConnectionId,
  ProviderNotFound,
  StorageError,
  AccountSelectionInvalid,
  AccountNotFound,
  AppNotFound,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Principal } from "./auth.ts";
import { GroupId } from "./groups.ts";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
  AppScreenRecord,
} from "./organization.ts";

export const AccessRevision = Schema.NonEmptyString.pipe(Schema.brand("AccessRevision"));
export const GroupAudience = Schema.Struct({
  kind: Schema.Literal("groups"),
  groups: Schema.Array(GroupId).check(
    Schema.isMaxLength(1000),
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
});
export const SharedAudience = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("everyone") }),
  GroupAudience,
]);
export const AppAudience = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("private") }),
  SharedAudience,
]);
export const AppAccess = Schema.Struct({
  app: AppId,
  creator: Schema.NullOr(Principal.fields.userId),
  audience: AppAudience,
  revision: AccessRevision,
  canManage: Schema.Boolean,
  canUse: Schema.Boolean,
});
export const ConnectionAccess = Schema.Struct({
  connection: AccountConnectionId,
  creator: Principal.fields.userId,
  target: Schema.Struct({
    app: AppId,
    requirement: Schema.NonEmptyString,
    scope: AccountScope.pipe(Schema.withDecodingDefaultKey(Effect.succeed("user" as const))),
  }),
});
const accessConflicts = {
  changed: "Sharing changed since it was read. Read it again and reapply the edit.",
  groups_changed:
    "A selected group was removed or you left it. Choose current groups and try again.",
  creator_unavailable: "Only me needs the app's creator, who is no longer in this organization.",
} as const;
export const AccessConflict = ApiError.define({
  tag: "AccessConflict",
  status: 409,
  fields: {
    reason: Schema.Literals(["changed", "groups_changed", "creator_unavailable"]),
  },
  message: ({ reason }) => accessConflicts[reason],
  recorded: ({ reason }) => accessConflicts[reason],
});
export type AccessConflict = typeof AccessConflict.Type;
const organization = { organization: OrganizationReference };
const app = { ...organization, app: AppId };
const errors = [
  OrganizationForbidden,
  ProviderNotFound,
  StorageError,
  AccessConflict,
  AccountSelectionInvalid,
  AccountNotFound,
  AppNotFound,
];
export const ResourceDirectory = Schema.Struct({
  pendingApp: Schema.Boolean,
  apps: Schema.Array(
    Schema.Struct({
      app: AppScreenRecord,
      access: AppAccess,
      linkedAccounts: Schema.Array(AccountId),
      appLinks: Schema.Array(
        Schema.Struct({
          requirement: Schema.String,
          account: AccountId,
          provider: ProviderId,
          label: Schema.String,
        }),
      ),
    }),
  ),
  accounts: Schema.Array(
    Schema.Struct({
      account: Account,
      provider: Provider,
      health: Schema.optionalKey(AccountHealth),
    }),
  ),
});
export const HostedResourceAccess = HttpApiGroup.make("resourceAccess")
  .add(
    HttpApiEndpoint.get("directory", "/api/organizations/:organization/resources", {
      params: organization,
      query: { view: Schema.optional(Schema.Literals(["available", "managed"])) },
      success: ResourceDirectory,
      error: errors,
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.get("app", "/api/organizations/:organization/apps/:app/access", {
      params: app,
      success: AppAccess,
      error: errors,
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.patch("shareApp", "/api/organizations/:organization/apps/:app/access", {
      params: app,
      payload: Schema.Struct({ audience: AppAudience, revision: AccessRevision }),
      success: AppAccess,
      error: errors,
    }).annotate(RequiredAction, "manage"),
  )
  .middleware(RequireOrganization);
