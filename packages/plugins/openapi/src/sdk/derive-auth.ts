// Spec-detected auth → stored `Authentication` templates, shared by every add
// path. The React add flow derives templates from the preview before calling
// `addSpec`; `addSpec` itself falls back to the same derivation when the
// caller omits `authenticationTemplate` (the agentic/API path has no client
// to do it). One implementation so the web UI and headless callers cannot
// drift: an integration added over MCP gets the same auth methods the add
// page would have produced.
import * as Option from "effect/Option";

import { AuthTemplateSlug, type OAuthAuthentication } from "@executor-js/sdk/shared";

import type { HeaderPreset, OAuth2Preset, SpecPreview, SpecPreviewSummary } from "./preview";
import type { APIKeyAuthentication, Authentication } from "./types";
import { resolveServerUrl } from "./openapi-utils";

type PreviewAuthMetadata = SpecPreview | SpecPreviewSummary;

// ---------------------------------------------------------------------------
// OpenAPI url helpers — specs sometimes ship relative OAuth endpoints; resolve
// them against the chosen base URL so the stored auth template is absolute.
// ---------------------------------------------------------------------------

export function resolveOAuthUrl(url: string, baseUrl: string): string {
  if (!url) return url;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL constructor normalizes provider metadata URLs
  try {
    new URL(url);
    return url;
  } catch {
    if (!baseUrl) return url;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL constructor resolves relative provider metadata URLs
    try {
      return new URL(url, baseUrl).toString();
    } catch {
      return url;
    }
  }
}

const standardOidcIdentityScopes = ["openid", "email", "profile"] as const;

const identityScopesForPreset = (
  identityScopes: OAuth2Preset["identityScopes"],
): readonly string[] => {
  if (identityScopes === false) return [];
  return identityScopes === "auto" ? standardOidcIdentityScopes : identityScopes;
};

export const resolvedOAuthScopes = (
  apiScopes: Iterable<string>,
  identityScopes: OAuth2Preset["identityScopes"],
): string[] => {
  const merged = new Set(apiScopes);
  for (const scope of identityScopesForPreset(identityScopes)) merged.add(scope);
  return [...merged];
};

// ---------------------------------------------------------------------------
// Auth-template builders — turn a preview preset into the integration's stored
// `Authentication` template (v2). A single-header preset becomes an `apiKey`
// template whose secret header value renders from the conventional `token`
// input. A multi-header preset gets one input per header, matching OpenAPI's
// security-strategy semantics where multiple schemes in one object are required
// together. The oauth2 preset becomes an `oauth` template carrying the provider
// endpoints.
// ---------------------------------------------------------------------------

const headerPrefix = (preset: HeaderPreset, headerName: string): string | undefined => {
  const label = preset.label.toLowerCase();
  if (headerName.toLowerCase() === "authorization") {
    if (label.includes("bearer")) return "Bearer ";
    if (label.includes("basic")) return "Basic ";
  }
  return undefined;
};

const slugifyVariable = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const variablesForHeaders = (headerNames: readonly string[]): ReadonlyMap<string, string> => {
  const variables = new Map<string, string>();
  if (headerNames.length <= 1) return variables;

  const taken = new Set<string>();
  for (const headerName of headerNames) {
    const base = slugifyVariable(headerName) || "input";
    let variable = base;
    for (let suffix = 2; taken.has(variable); suffix += 1) {
      variable = `${base}_${suffix}`;
    }
    taken.add(variable);
    variables.set(headerName, variable);
  }
  return variables;
};

const apiKeyTemplateFromHeaderPreset = (
  preset: HeaderPreset,
  slug: AuthTemplateSlug,
): APIKeyAuthentication => {
  const variables = variablesForHeaders(preset.secretHeaders);
  return {
    slug,
    kind: "apikey",
    placements: preset.secretHeaders.map((headerName) => {
      const prefix = headerPrefix(preset, headerName);
      const variable = variables.get(headerName);
      return {
        carrier: "header" as const,
        name: headerName,
        ...(prefix ? { prefix } : {}),
        ...(variable ? { variable } : {}),
      };
    }),
  };
};

const oauthTemplateFromPreset = (
  preset: OAuth2Preset,
  baseUrl: string,
  slug: AuthTemplateSlug,
  scopes: readonly string[],
): OAuthAuthentication => ({
  slug,
  kind: "oauth2",
  authorizationUrl: resolveOAuthUrl(
    Option.getOrElse(preset.authorizationUrl, () => ""),
    baseUrl,
  ),
  tokenUrl: resolveOAuthUrl(preset.tokenUrl, baseUrl),
  resource: Option.getOrUndefined(preset.resource) ?? null,
  scopes: [...scopes],
  ...(preset.supportsClientIdMetadataDocument === true
    ? { supportsClientIdMetadataDocument: true }
    : {}),
});

// ---------------------------------------------------------------------------
// All spec-detected auth methods → the union of stored `Authentication`
// templates. Header presets become apiKey templates; each oauth2 preset becomes
// an oauth template (with its declared API scopes plus, for auth-code flows,
// the standard identity scopes). Slugs stay deterministic per method so the
// stored template is stable across previews of the same spec.
// ---------------------------------------------------------------------------

export const detectedAuthenticationTemplates = (
  headerPresets: readonly HeaderPreset[],
  oauth2Presets: readonly OAuth2Preset[],
  baseUrl: string,
): readonly Authentication[] => {
  const templates: Authentication[] = [];
  headerPresets.forEach((preset, index) => {
    templates.push(
      apiKeyTemplateFromHeaderPreset(preset, AuthTemplateSlug.make(`apikey-${index}`)),
    );
  });
  for (const preset of oauth2Presets) {
    const scopes = resolvedOAuthScopes(Object.keys(preset.scopes), preset.identityScopes);
    templates.push(
      oauthTemplateFromPreset(
        preset,
        baseUrl,
        AuthTemplateSlug.make(`oauth-${preset.securitySchemeName}`),
        scopes,
      ),
    );
  }
  return templates;
};

export const firstBaseUrlForPreview = (preview: PreviewAuthMetadata): string => {
  const firstServer = preview.servers[0];
  return firstServer
    ? resolveServerUrl(firstServer.url, Option.getOrUndefined(firstServer.variables), {})
    : "";
};

/** The fallback `addSpec` uses when no explicit template was passed: every
 *  spec-detected method, resolved against the integration's base URL. */
export const deriveAuthenticationTemplateFromPreview = (
  preview: PreviewAuthMetadata,
  baseUrl: string | undefined,
): readonly Authentication[] =>
  detectedAuthenticationTemplates(
    preview.headerPresets,
    preview.oauth2Presets,
    baseUrl ?? firstBaseUrlForPreview(preview),
  );
