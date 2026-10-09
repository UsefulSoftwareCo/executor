/**
 * Executor's OAuth Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document).
 * A hosted install that publishes one uses the document's URL as its OAuth client ID, so an
 * authorization server that supports these documents needs no dynamic client registration.
 */
import { Schema } from "effect";

/** Where a hosted install serves its document. The URL is the client's identity, so keep it. */
export const clientMetadataDocumentPath = "/oauth/client-metadata.json";

/** The name hosted installs give their OAuth client, in registrations and in the document. */
export const hostedOAuthClientName = "Executor";

/** The document a hosted install serves. Values follow the RFC 7591 client metadata registry. */
export interface ClientMetadataDocument {
  /** The document's own URL, compared as a plain string by the authorization server. */
  readonly client_id: string;
  readonly client_name: string;
  readonly client_uri: string;
  readonly logo_uri: string;
  /** Exactly the callback the host sends as `redirect_uri`. */
  readonly redirect_uris: readonly [string];
  readonly grant_types: readonly ["authorization_code", "refresh_token"];
  readonly response_types: readonly ["code"];
  /** A document cannot carry a shared secret, so the client is public. */
  readonly token_endpoint_auth_method: "none";
  readonly application_type: "web" | "native";
}

/**
 * `EXECUTOR_OAUTH_CLIENT_METADATA_URL` cannot identify this host. `format`: not an HTTPS URL on a
 * public host with a path, or not in the exact form compared as the client ID (no query,
 * fragment, credentials, dot segments or default port). `path`: on this host's own origin but
 * not where the host serves its document.
 */
export class ClientMetadataUrlInvalid extends Schema.TaggedError<ClientMetadataUrlInvalid>()(
  "ClientMetadataUrlInvalid",
  {
    reason: Schema.Literals(["format", "path"]),
    message: Schema.String,
  },
) {}
