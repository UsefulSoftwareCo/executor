// ---------------------------------------------------------------------------
// OpenAPI ↔ generic auth-method converters — a thin oauth adapter over the
// shared codec (`@executor-js/react/lib/shared-auth-method-codec`). The
// apikey/none paths (multi-placement, multi-variable) live in the shared
// codec; OpenAPI only contributes its oauth flavor: stored endpoints + scopes
// (`kind: "oauth2"`, the core `OAuthAuthentication` shape) that pre-fill the client-registration form.
// ---------------------------------------------------------------------------

import { AuthTemplateSlug } from "@executor-js/sdk/shared";
import type { AuthMethod, Placement } from "@executor-js/react/lib/auth-placements";
import type { AuthTemplateEditorValue } from "@executor-js/react/components/auth-template-editor";
import {
  authMethodFromSharedTemplate,
  editorPlacementsFromWire,
  editorValueFromSharedMethod,
  wireAuthInputFromShared,
  wirePlacementsFromEditor,
} from "@executor-js/react/lib/shared-auth-method-codec";

import type { APIKeyAuthentication, Authentication, AuthenticationInput } from "../sdk/types";

/** Serialize a canonical method into the wire input union (apikey → the
 *  request-shaped dialect; oauth passes through). */
export const openApiWireAuthInput = (method: Authentication): AuthenticationInput =>
  method.kind === "oauth2" ? method : (wireAuthInputFromShared(method) as AuthenticationInput);

export const placementsFromApiKey = (template: APIKeyAuthentication): readonly Placement[] =>
  editorPlacementsFromWire(template.placements);

const oauthAuthMethod = (template: Extract<Authentication, { kind: "oauth2" }>): AuthMethod => {
  const slug = String(template.slug);
  return {
    id: slug,
    label: "OAuth2",
    kind: "oauth",
    source: slug.startsWith("custom_") ? "custom" : "spec",
    template: AuthTemplateSlug.make(slug),
    placements: [],
    // Carry the integration's declared endpoints/scopes so the
    // client-registration form pre-fills them.
    oauth: {
      authorizationUrl: template.authorizationUrl,
      tokenUrl: template.tokenUrl,
      resource: template.resource ?? null,
      scopes: template.scopes,
      supportsClientIdMetadataDocument: template.supportsClientIdMetadataDocument,
    },
  };
};

/** Map each stored auth template to a generic `AuthMethod`. */
export function authMethodsFromConfig(templates: readonly Authentication[]): AuthMethod[] {
  return templates.map((template: Authentication): AuthMethod => {
    if (template.kind === "oauth2") return oauthAuthMethod(template);
    return authMethodFromSharedTemplate(template);
  });
}

/** Build an apikey method from generic placements. When `slug` is omitted the
 *  backend assigns a `custom_<id>` slug. */
export function templateFromPlacements(
  placements: readonly Placement[],
  slug?: string,
): APIKeyAuthentication {
  return {
    slug: slug ?? "",
    kind: "apikey",
    placements: wirePlacementsFromEditor(placements),
  };
}

// ---------------------------------------------------------------------------
// Stored `Authentication` ⇆ generic `AuthTemplateEditorValue`.
// ---------------------------------------------------------------------------

/** Convert one stored `Authentication` template into a generic editor value. */
export function editorValueFromAuthentication(template: Authentication): AuthTemplateEditorValue {
  if (template.kind === "oauth2") {
    return {
      kind: "oauth",
      authorizationUrl: template.authorizationUrl ?? "",
      tokenUrl: template.tokenUrl ?? "",
      resource: template.resource ?? null,
      scopes: template.scopes ?? [],
      supportsClientIdMetadataDocument: template.supportsClientIdMetadataDocument,
    };
  }
  return editorValueFromSharedMethod(template);
}

/** Build an `OAuthAuthentication` template from a generic oauth editor value. */
const oauthTemplateFromEditorValue = (
  value: Extract<AuthTemplateEditorValue, { kind: "oauth" }>,
  slug?: string,
): Authentication => ({
  slug: AuthTemplateSlug.make(slug ?? ""),
  kind: "oauth2",
  authorizationUrl: value.authorizationUrl,
  tokenUrl: value.tokenUrl,
  resource: value.resource ?? null,
  scopes: [...value.scopes],
  ...(value.supportsClientIdMetadataDocument === true
    ? { supportsClientIdMetadataDocument: true }
    : {}),
});

/** Convert one generic editor value back into a stored `Authentication`, or
 *  `null` for `none` (no method to register). The optional `slug` names the
 *  template; when omitted the backend backfills `custom_<id>`. */
export function authenticationFromEditorValue(
  value: AuthTemplateEditorValue,
  slug?: string,
): Authentication | null {
  if (value.kind === "none") return null;
  if (value.kind === "oauth") return oauthTemplateFromEditorValue(value, slug);
  return templateFromPlacements(value.placements, slug);
}
