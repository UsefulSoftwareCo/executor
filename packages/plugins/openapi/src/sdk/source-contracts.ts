import { Schema } from "effect";

import { ConfiguredHeaderValue, OAuth2SourceConfig } from "./types";

export const StoredSourceSchema = Schema.Struct({
  namespace: Schema.String,
  scope: Schema.String,
  name: Schema.String,
  config: Schema.Struct({
    spec: Schema.optional(Schema.String),
    sourceUrl: Schema.optional(Schema.String),
    googleDiscoveryUrls: Schema.optional(Schema.Array(Schema.String)),
    baseUrl: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    headers: Schema.optional(Schema.Record(Schema.String, ConfiguredHeaderValue)),
    queryParams: Schema.optional(Schema.Record(Schema.String, ConfiguredHeaderValue)),
    specFetchCredentials: Schema.optional(
      Schema.Struct({
        headers: Schema.optional(Schema.Record(Schema.String, ConfiguredHeaderValue)),
        queryParams: Schema.optional(Schema.Record(Schema.String, ConfiguredHeaderValue)),
      }),
    ),
    // Canonical source-owned OAuth config. Concrete client credentials
    // and connection ids live in OpenAPI-owned scoped binding rows.
    oauth2: Schema.optional(OAuth2SourceConfig),
  }),
}).annotate({ identifier: "OpenApiStoredSource" });
export type StoredSourceSchema = typeof StoredSourceSchema.Type;

export type StoredSourceSchemaType = typeof StoredSourceSchema.Type;

const slugifySlotPart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";

export const headerBindingSlot = (headerName: string): string =>
  `header:${slugifySlotPart(headerName)}`;

export const queryParamBindingSlot = (name: string): string =>
  `query_param:${slugifySlotPart(name)}`;

export const specFetchHeaderBindingSlot = (headerName: string): string =>
  `spec_fetch_header:${slugifySlotPart(headerName)}`;

export const specFetchQueryParamBindingSlot = (name: string): string =>
  `spec_fetch_query_param:${slugifySlotPart(name)}`;

export const oauth2ClientIdSlot = (securitySchemeName: string): string =>
  `oauth2:${slugifySlotPart(securitySchemeName)}:client-id`;

export const oauth2ClientSecretSlot = (securitySchemeName: string): string =>
  `oauth2:${slugifySlotPart(securitySchemeName)}:client-secret`;

export const oauth2ConnectionSlot = (securitySchemeName: string): string =>
  `oauth2:${slugifySlotPart(securitySchemeName)}:connection`;
