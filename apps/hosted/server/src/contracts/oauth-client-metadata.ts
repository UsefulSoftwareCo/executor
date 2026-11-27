import { Schema } from "effect";

export const clientMetadataDocumentPath = "/oauth/client-metadata.json";

export const clientMetadataLogoPath = "/favicon.png";

/** The document a hosted install serves. Values follow the RFC 7591 client metadata registry. */
export interface ClientMetadataDocument {
  readonly client_id: string;
  readonly client_name: string;
  readonly client_uri: string;
  readonly logo_uri: string;
  readonly redirect_uris: readonly [string];
  readonly grant_types: readonly ["authorization_code", "refresh_token"];
  readonly response_types: readonly ["code"];
  readonly token_endpoint_auth_method: "none";
  readonly application_type: "web" | "native";
}

export class ClientMetadataUrlInvalid extends Schema.TaggedError<ClientMetadataUrlInvalid>()(
  "ClientMetadataUrlInvalid",
  {
    reason: Schema.Literals(["format", "path"]),
    message: Schema.String,
  },
) {}

export class FirstPartyOAuthClientsInvalid extends Schema.TaggedError<FirstPartyOAuthClientsInvalid>()(
  "FirstPartyOAuthClientsInvalid",
  { message: Schema.String, problems: Schema.Array(Schema.String) },
) {}
