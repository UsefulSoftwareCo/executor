import { Option, Schema } from "effect";
import {
  ApiKeyAuthMethod,
  TOKEN_VARIABLE,
  renderAuthPlacements,
  requiredPlacementVariables,
} from "@executor-js/sdk/http-auth";

import type { Authentication } from "./types";

// ---------------------------------------------------------------------------
// OpenAPI integration config — the opaque blob stored on the catalog
// `integration.config` column (D1). Core never parses it; the plugin writes it
// at register time and reads it back in `resolveTools` / `invokeTool`.
//
// In v2 there are NO credential bindings, NO per-source secret slots, and NO
// StoredSource credential config. The config carries only:
//   - the OpenAPI spec text (inlined) OR the source URL to (re)fetch from,
//   - the optional base URL override,
//   - the auth templates a connection's value is rendered through.
// ---------------------------------------------------------------------------

const OAuthAuthenticationSchema = Schema.Struct({
  slug: Schema.String,
  kind: Schema.Literal("oauth2"),
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  scopes: Schema.Array(Schema.String),
});

export const AuthenticationSchema = Schema.Union([OAuthAuthenticationSchema, ApiKeyAuthMethod]);

export const OpenApiIntegrationConfigSchema = Schema.Struct({
  /** Inlined OpenAPI document text (resolved + parsed source of truth). */
  spec: Schema.String,
  /** Origin URL the spec was fetched from, when known. Enables refresh. */
  sourceUrl: Schema.optional(Schema.String),
  /** Google Discovery bundle URLs, when the spec came from a Google bundle. */
  googleDiscoveryUrls: Schema.optional(Schema.Array(Schema.String)),
  /** Base URL override; falls back to the spec's first server. */
  baseUrl: Schema.optional(Schema.String),
  /** Static headers applied to every request (no secret material). */
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Static query params applied to every request (no secret material). */
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** The auth methods a connection's value can be applied through. */
  authenticationTemplate: Schema.optional(Schema.Array(AuthenticationSchema)),
});

export type OpenApiIntegrationConfig = Omit<
  typeof OpenApiIntegrationConfigSchema.Type,
  "authenticationTemplate"
> & {
  /** Branded over the schema's structural form so the template renderer can
   *  treat `slug` as an `AuthTemplateSlug`. */
  readonly authenticationTemplate?: readonly Authentication[];
};

const decodeConfig = Schema.decodeUnknownOption(OpenApiIntegrationConfigSchema);

/** Decode the opaque integration config blob into the openapi shape.
 *  Returns null when the blob is missing/incompatible. */
export const decodeOpenApiIntegrationConfig = (value: unknown): OpenApiIntegrationConfig | null =>
  Option.getOrNull(decodeConfig(value)) as OpenApiIntegrationConfig | null;

// ---------------------------------------------------------------------------
// Template rendering — "auth state derived into the auth-template format"
// (D11). An apiKey method renders through the shared placements renderer; an
// oauth template (no explicit placement) renders a bearer `authorization`
// header from the `token` input (the access token).
// ---------------------------------------------------------------------------

export interface RenderedAuth {
  readonly headers: Record<string, string>;
  readonly queryParams: Record<string, string>;
}

/** Render an auth template against a connection's resolved input `values`
 *  (`variable → value`). Each placement substitutes from its own entry, so a
 *  method with two distinct inputs (e.g. Datadog) fills each header from a
 *  different value. */
export const renderAuthTemplate = (
  template: Authentication,
  values: Record<string, string | null>,
): RenderedAuth => {
  if (template.kind === "oauth2") {
    return {
      headers: { authorization: `Bearer ${values[TOKEN_VARIABLE] ?? ""}` },
      queryParams: {},
    };
  }
  return renderAuthPlacements(template.placements, values);
};

/** The distinct input variables a template references — the inputs a connection
 *  must supply. An oauth template needs `token`; an apiKey method needs every
 *  variable across its placements. */
export const requiredTemplateVariables = (template: Authentication): readonly string[] => {
  if (template.kind === "oauth2") return [TOKEN_VARIABLE];
  return requiredPlacementVariables(template.placements);
};
