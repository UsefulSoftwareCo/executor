import { UserFacingError } from "@executor-js/utils/user-facing-error";
/**
 * OAuth clients that sign accounts in through a browser (authorization code). A client is a
 * resource of its owner, like an app: registered by a person, or registered automatically through
 * dynamic registration, then referenced by each connection that uses it. A client belongs to the
 * authorization server it was issued by (its issuer), not to an app's provider definition, so
 * every app of the owner that signs in at that server is offered it. A client metadata
 * document and the operator's own clients are host configuration and are never stored here.
 * Machine (client credentials) clients are never stored either; they are the account itself and
 * live only on its grant. Who may use a client is the host's decision.
 */
import { Schema, type Effect } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { AuthMethodName, ProviderNotFound } from "./provider.ts";
import { CredentialsError, HttpUrl, OwnerId, ProviderId, StorageError } from "./shared.ts";
import {
  OAuthClientId,
  OAuthClientInput,
  OAuthClientSetup,
  OAuthClientSource,
  OAuthSetupFailed,
} from "./oauth.ts";

/**
 * The authorization server a client belongs to: its RFC 8414 issuer, as discovered or declared,
 * or, for a provider that declares endpoints without an issuer, its token endpoint URL. A sign-in
 * is offered the owner's clients whose issuer is the one its own discovery found.
 */
export const OAuthClientIssuer = HttpUrl;

/** Client metadata. The secret is write-only: no operation returns it. */
export const OAuthClient = Schema.Struct({
  id: OAuthClientId,
  owner: OwnerId,
  /**
   * The authorization server the client signs in at. Null only for a client stored before 4.0.12
   * whose server has not been recorded yet (data step `8_oauth_clients_by_issuer`); such a client
   * is offered to no sign-in, but its credentials stay its own.
   */
  issuer: Schema.NullOr(OAuthClientIssuer),
  /** The service's public client identifier. */
  clientId: Schema.NonEmptyString,
  /** `manual` clients were entered by a person; `registered` ones were registered automatically. */
  source: OAuthClientSource,
  hasSecret: Schema.Boolean,
  createdAt: Schema.Date,
});
export type OAuthClient = typeof OAuthClient.Type;

/** A stored client for this connection to use. */
export const OAuthClientReference = Schema.Struct({ id: OAuthClientId });

/**
 * The connection owner's automatic client for this sign-in: a dynamically registered client it
 * already has, the operator's own client, the host's client metadata document, or a client
 * registered now. It is found or created from the sign-in's own discovery, so the service is
 * discovered once.
 */
export const OAuthAutomaticClient = Schema.Struct({ automatic: Schema.Literal(true) });

/**
 * The client a connection signs in with: a stored client of its owner, the automatic client, or
 * one entered for this connection alone. An entered client lives only on the account's grant
 * unless `save` registers it, under the connection's owner, once sign-in succeeds. Client
 * credentials connections always enter theirs, and never save it.
 */
export const OAuthClientChoice = Schema.Union([
  OAuthClientReference,
  OAuthAutomaticClient,
  Schema.Struct({ ...OAuthClientInput.fields, save: Schema.optional(Schema.Boolean) }),
]);
export type OAuthClientChoice = typeof OAuthClientChoice.Type;

/** What a person picks in a connect form. */
export const OAuthClientSelection = Schema.Union([
  OAuthClientReference,
  OAuthAutomaticClient,
  OAuthClientInput,
]);
export type OAuthClientSelection = typeof OAuthClientSelection.Type;

/**
 * A connect form's choices: the method's setup, with the stored clients for its issuer that the
 * caller may use. The setup's fields stay where callers of the setup check read them.
 */
const clients = { clients: Schema.Array(OAuthClient) };
export const OAuthConnectOptions = Schema.Union([
  Schema.Struct({ ...OAuthClientSetup.members[0].fields, ...clients }),
  Schema.Struct({ ...OAuthClientSetup.members[1].fields, ...clients }),
]);
export type OAuthConnectOptions = typeof OAuthConnectOptions.Type;

/**
 * Unknown clients, another owner's, and another authorization server's have the same result, as do clients
 * the host no longer lets the caller use. `client` is the ID the caller named; a client a sign-in
 * found by itself, from a grant's copy or entered credentials, is refused without its ID, so a
 * refusal never reveals a client the caller cannot list.
 */
export const OAuthClientNotFound = UserFacingError.define({
  tag: "OAuthClientNotFound",
  status: 404,
  fields: { client: Schema.optional(OAuthClientId) },
  title: "OAuth client no longer available",
  description: "This OAuth client is not available for this service.",
  recovery: {
    action: "Choose another OAuth client, or ask an administrator to register one.",
    instructions:
      "List the OAuth clients registered for this service's authorization server (its issuer) and select one that exists. Do not reuse a removed client's ID or substitute a client registered for another authorization server.",
  },
});
/** Parsed OAuthClientNotFound failure. */
export type OAuthClientNotFound = typeof OAuthClientNotFound.Type;

/** Only clients entered by a person change; automatic ones keep what the service issued. */
export const OAuthClientNotEditable = UserFacingError.define({
  tag: "OAuthClientNotEditable",
  status: 409,
  fields: { client: OAuthClientId },
  title: "This OAuth client can’t be edited",
  description:
    "This client was created automatically, so it keeps the registration the service issued.",
  recovery: {
    action: "Register a client from the service’s developer settings to use other details.",
    instructions:
      "Only clients with source `manual` can be updated. Register a new client with the details instead of editing an automatic one.",
  },
});
/** Parsed OAuthClientNotEditable failure. */
export type OAuthClientNotEditable = typeof OAuthClientNotEditable.Type;

/**
 * Credentials are one client per owner and authorization server: another client holds them, or
 * held them before its details were edited. Registering them twice would leave who may use them
 * undecided.
 */
export const OAuthClientExists = UserFacingError.define({
  tag: "OAuthClientExists",
  status: 409,
  fields: { client: OAuthClientId },
  title: "These client details are already registered",
  description:
    "Another OAuth client for this service has this client ID and secret, now or before its details were edited.",
  recovery: {
    action: "Use the existing client, or enter the details of a different client.",
    instructions:
      "The `client` field names the stored client that holds or held these credentials. Use it, or register a client with another client ID or secret. Credentials of a removed client can be registered again.",
  },
});
/** Parsed OAuthClientExists failure. */
export type OAuthClientExists = typeof OAuthClientExists.Type;

/** The provider has no browser sign-in method, so it signs in at no server a client serves. */
export const OAuthClientsUnsupported = UserFacingError.define({
  tag: "OAuthClientsUnsupported",
  status: 422,
  fields: { provider: ProviderId },
  title: "This service does not use OAuth clients",
  description: "None of this service’s sign-in methods uses an OAuth client that can be shared.",
  recovery: {
    action: "Connect accounts for this service directly from its app.",
    instructions:
      "Inspect the provider definition's auth methods. Only OAuth authorization code methods use registered clients; client credentials are entered for each account.",
  },
});
/** Parsed OAuthClientsUnsupported failure. */
export type OAuthClientsUnsupported = typeof OAuthClientsUnsupported.Type;

/** Canonical decoded inputs shared by HTTP contracts and the Promise facade. */
export const OAuthClientInputs = {
  register: Schema.Struct({
    owner: OwnerId,
    issuer: OAuthClientIssuer,
    ...OAuthClientInput.fields,
  }),
  list: Schema.Struct({ owner: OwnerId, issuer: Schema.optional(OAuthClientIssuer) }),
  issuers: Schema.Struct({ provider: ProviderId }),
  get: Schema.Struct({ client: OAuthClientId, owner: OwnerId }),
  remove: Schema.Struct({ client: OAuthClientId, owner: OwnerId }),
  /** An omitted field keeps its current value; there is no way to drop a secret. */
  update: Schema.Struct({
    client: OAuthClientId,
    owner: OwnerId,
    clientId: Schema.optional(OAuthClientInput.fields.clientId),
    clientSecret: OAuthClientInput.fields.clientSecret,
  }),
} as const;

const clientParams = { client: OAuthClientId };

/** The authorization server one browser sign-in method of a provider uses. */
export const OAuthMethodIssuer = Schema.Struct({
  method: AuthMethodName,
  issuer: OAuthClientIssuer,
});
export type OAuthMethodIssuer = typeof OAuthMethodIssuer.Type;

/** Stored OAuth clients, independent of any product's sharing policy. */
export const OAuthClientsGroup = HttpApiGroup.make("oauthClients")
  .add(
    HttpApiEndpoint.post("register", "/v1/oauth-clients", {
      payload: OAuthClientInputs.register,
      success: OAuthClient,
      error: [StorageError, CredentialsError, OAuthClientExists],
    }).annotate(
      OpenApi.Description,
      "Register an OAuth client created in the service's developer settings, for browser sign-in at one authorization server (`issuer`; see oauthClients.issuers for a provider's). Every app of the owner that signs in at that server is offered it. Returns metadata only; the secret is never returned. Connections name the client with `client: { id }`. Credentials another client of the owner holds for that server, or held before an edit, fail with OAuthClientExists.",
    ),
  )
  .add(
    HttpApiEndpoint.get("list", "/v1/oauth-clients", {
      query: OAuthClientInputs.list.fields,
      success: Schema.Array(OAuthClient),
      error: [StorageError],
    }).annotate(
      OpenApi.Description,
      "List the owner's OAuth clients, optionally for one authorization server (`issuer`).",
    ),
  )
  .add(
    HttpApiEndpoint.get("issuers", "/v1/oauth-client-issuers", {
      query: OAuthClientInputs.issuers.fields,
      success: Schema.Array(OAuthMethodIssuer),
      error: [StorageError, ProviderNotFound, OAuthClientsUnsupported, OAuthSetupFailed],
    }).annotate(
      OpenApi.Description,
      "The authorization server (issuer) each browser sign-in method of a provider uses, discovered as a sign-in discovers it. Register a client under one of these to offer it to every app that signs in there.",
    ),
  )
  .add(
    HttpApiEndpoint.get("get", "/v1/oauth-clients/:client", {
      params: clientParams,
      query: { owner: OwnerId },
      success: OAuthClient,
      error: [StorageError, OAuthClientNotFound],
    }).annotate(OpenApi.Description, "Read an OAuth client's metadata."),
  )
  .add(
    HttpApiEndpoint.patch("update", "/v1/oauth-clients/:client", {
      params: clientParams,
      payload: Schema.Struct({
        owner: OwnerId,
        clientId: OAuthClientInputs.update.fields.clientId,
        clientSecret: OAuthClientInputs.update.fields.clientSecret,
      }),
      success: OAuthClient,
      error: [
        StorageError,
        CredentialsError,
        OAuthClientNotFound,
        OAuthClientNotEditable,
        OAuthClientExists,
      ],
    }).annotate(
      OpenApi.Description,
      "Change a registered client's ID or secret. An omitted field keeps its current value, and the secret is never returned. New connections and reconnects use the change; accounts already connected keep renewing with the copy their grant holds, and a reconnect with that copy is still this client, under its current details. Automatic clients fail with OAuthClientNotEditable; credentials another client holds or held fail with OAuthClientExists.",
    ),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/v1/oauth-clients/:client", {
      params: clientParams,
      query: { owner: OwnerId },
      success: Schema.Struct({ client: OAuthClientId }),
      error: [StorageError, OAuthClientNotFound],
    }).annotate(
      OpenApi.Description,
      "Remove an OAuth client so no new connection can use it. Accounts already connected with it keep the copy their grant holds and keep renewing, but cannot sign in with its credentials again: a reconnect needs another client.",
    ),
  );

/**
 * Host-only: moving the saved clients of earlier versions, and recording the authorization server
 * of clients stored before 4.0.12, outside the HTTP and Promise facades.
 */
export const SavedOAuthClientsHost = Symbol("executor.SavedOAuthClients");

/** What moving one saved client did, as a data step reports it. */
export type SavedClientOutcome =
  | "moved"
  | "already_moved"
  | "duplicate"
  | "would_move"
  | "absent"
  | "no_account"
  | "machine_client"
  | "ambiguous_owner"
  | "unreadable"
  | "unavailable";

/** One saved client and the owner it moves to, when exactly one owner's accounts hold it. */
export interface SavedClientItem {
  readonly id: string;
  readonly owner: OwnerId | undefined;
  /**
   * Why no one owner holds it, for a report to group by, when holders of several owners or
   * providers do: `ambiguous:owners=<n>,providers=<n>,secret=<yes|no>,source=<...>,`
   * `resolvable_by_key=<yes|no|several>,provider_ids=<a|b>`.
   */
  readonly bucket?: string | undefined;
  /** Moves the client with `apply`; otherwise reports what moving would do. Never fails. */
  readonly move: (apply: boolean) => Effect.Effect<SavedClientOutcome>;
}

/** What moving one saved client to its owner's client for its issuer did. */
export type SavedClientByIssuerOutcome = SavedClientOutcome | "ambiguous_issuer";

/** One saved client, moved to its owner's client for its authorization server. */
export interface SavedClientByIssuerItem {
  readonly id: string;
  readonly owner: OwnerId | undefined;
  /** Moves the client with `apply`; otherwise reports what moving would do. Never fails. */
  readonly move: (apply: boolean) => Effect.Effect<SavedClientByIssuerOutcome>;
}

/** What recording one pre-4.0.12 stored client's authorization server did. */
export type ClientIssuerOutcome =
  | "migrated"
  | "would_migrate"
  | "merged"
  | "would_merge"
  | "already_migrated"
  | "absent"
  | "issuer_unknown"
  | "access_conflict"
  | "unreadable"
  | "unavailable";

/** One stored client without an issuer. */
export interface ClientIssuerItem {
  readonly id: string;
  readonly owner: string;
  /** Records its issuer with `apply`; otherwise reports what doing so would do. Never fails. */
  readonly migrate: (apply: boolean) => Effect.Effect<ClientIssuerOutcome>;
}

/** The saved clients of versions before 4.0.10; see `6_stored_oauth_clients`. */
export interface SavedOAuthClients {
  readonly items: Effect.Effect<ReadonlyArray<SavedClientItem>, StorageError | CredentialsError>;
  /** Stored clients without an issuer; see `8_oauth_clients_by_issuer`. */
  readonly issuerItems: Effect.Effect<
    ReadonlyArray<ClientIssuerItem>,
    StorageError | CredentialsError
  >;
  /** The saved clients again, by owner and issuer; see `9_saved_oauth_clients_by_issuer`. */
  readonly itemsByIssuer: Effect.Effect<
    ReadonlyArray<SavedClientByIssuerItem>,
    StorageError | CredentialsError
  >;
}
