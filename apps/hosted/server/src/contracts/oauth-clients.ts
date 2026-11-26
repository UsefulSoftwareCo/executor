import { RequiredAction } from "./authorization.ts";
import {
  CredentialsError,
  HttpUrl,
  OAuthClient,
  OAuthClientId,
  OAuthClientInput,
  OAuthClientExists,
  OAuthClientInputs,
  OAuthClientIssuer,
  OAuthClientNotEditable,
  OAuthClientNotFound,
  OAuthClientsUnsupported,
  ProviderId,
  ProviderNotFound,
  StorageError,
} from "@executor-js/sdk/core";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { Principal } from "./auth.ts";
import {
  OrganizationForbidden,
  OrganizationReference,
  RequireOrganization,
} from "./organization.ts";
import { AccessConflict, AccessRevision, AppAudience } from "./resource-access.ts";

export const OAuthClientAccess = Schema.Struct({
  client: OAuthClientId,
  creator: Schema.NullOr(Principal.fields.userId),
  audience: AppAudience,
  revision: AccessRevision,
  canManage: Schema.Boolean,
  canUse: Schema.Boolean,
});
export type OAuthClientAccess = typeof OAuthClientAccess.Type;

export const HostedOAuthClient = Schema.Struct({ client: OAuthClient, access: OAuthClientAccess });
export type HostedOAuthClient = typeof HostedOAuthClient.Type;

export const OAuthClientProvider = Schema.Struct({
  id: ProviderId,
  name: Schema.NonEmptyString,
});

export const OAuthClientService = Schema.Struct({
  issuer: OAuthClientIssuer,
  providers: Schema.NonEmptyArray(OAuthClientProvider),
});
export type OAuthClientService = typeof OAuthClientService.Type;

export const OAuthClientDirectory = Schema.Struct({
  clients: Schema.Array(HostedOAuthClient),
  services: Schema.Array(OAuthClientService),
  unresolved: Schema.Array(OAuthClientProvider),
  redirectUri: HttpUrl,
});
export type OAuthClientDirectory = typeof OAuthClientDirectory.Type;

const organization = { organization: OrganizationReference };
const client = { ...organization, client: OAuthClientId };
const errors = [
  OrganizationForbidden,
  StorageError,
  CredentialsError,
  ProviderNotFound,
  OAuthClientNotFound,
  OAuthClientNotEditable,
  OAuthClientsUnsupported,
  OAuthClientExists,
  AccessConflict,
];
const prefix = "/api/organizations/:organization/oauth-clients";

export const HostedOAuthClients = HttpApiGroup.make("oauthClients")
  .add(
    HttpApiEndpoint.get("list", prefix, {
      params: organization,
      success: OAuthClientDirectory,
      error: errors,
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post("register", prefix, {
      params: organization,
      payload: Schema.Struct({
        issuer: OAuthClientIssuer,
        ...OAuthClientInput.fields,
        audience: Schema.optional(AppAudience),
      }),
      success: HostedOAuthClient,
      error: errors,
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        "Register an OAuth client from the service's developer settings for one authorization server (`issuer`), with the audience that may sign in with it (everyone in the organization by default). Every app of the organization that signs in at that server offers it. Administrators only. The client and its audience are recorded together. The secret is never returned. Details another client of the organization holds, or held before an edit, fail with OAuthClientExists.",
      ),
  )
  .add(
    HttpApiEndpoint.delete("remove", `${prefix}/:client`, {
      params: client,
      success: Schema.Struct({ client: OAuthClientId }),
      error: errors,
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        "Remove an OAuth client so no new connection can use it. Accounts already connected with it keep working, but a reconnect needs another client: the removed client's details are withdrawn.",
      ),
  )
  .add(
    HttpApiEndpoint.patch("update", `${prefix}/:client`, {
      params: client,
      payload: Schema.Struct({
        clientId: OAuthClientInputs.update.fields.clientId,
        clientSecret: OAuthClientInputs.update.fields.clientSecret,
        audience: Schema.optional(AppAudience),
        revision: AccessRevision,
      }),
      success: HostedOAuthClient,
      error: errors,
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        "Edit a registered client's ID, secret and audience together, in one transaction, from the access revision the edit started with. Omitted fields keep their current values, and the secret is never returned. New connections use the change; accounts already connected keep the client their grant holds, and reconnect with its current details under its audience. Administrators only. Automatic clients fail with OAuthClientNotEditable; details another client holds or held fail with OAuthClientExists.",
      ),
  )
  .middleware(RequireOrganization);
