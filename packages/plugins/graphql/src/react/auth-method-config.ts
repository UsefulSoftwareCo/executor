// ---------------------------------------------------------------------------
// GraphQL ↔ generic auth-method converters — a thin oauth adapter over the
// shared codec (`@executor-js/react/lib/shared-auth-method-codec`). The
// apikey/none paths (multi-placement, multi-variable) live in the shared
// codec; GraphQL only contributes its oauth flavor: endpoint-less methods that
// render the connection's access token as a bearer header at invoke time
// (optionally overriding the header name / prefix).
// ---------------------------------------------------------------------------

import { AuthTemplateSlug } from "@executor-js/sdk/shared";
import type { AuthTemplateEditorValue } from "@executor-js/react/components/auth-template-editor";
import type { AuthMethod, Placement } from "@executor-js/react/lib/auth-placements";
import {
  wireAuthInputFromShared,
  authMethodFromSharedTemplate,
  editorValueFromSharedMethod,
  sharedMethodInputFromEditorValue,
  wirePlacementsFromEditor,
} from "@executor-js/react/lib/shared-auth-method-codec";

import type {
  GraphqlAuthMethod,
  GraphqlAuthMethodInput,
  GraphqlCanonicalAuthMethodInput,
  GraphqlOAuthMethod,
} from "../sdk/types";

const oauthAuthMethod = (method: GraphqlOAuthMethod): AuthMethod => ({
  id: method.slug,
  label: "OAuth",
  kind: "oauth",
  source: method.slug.startsWith("custom_") ? "custom" : "spec",
  template: AuthTemplateSlug.make(method.slug),
  placements: [],
  // Mirror the server's describeGraphqlAuthMethods: surface stored endpoints +
  // defaults so the connect UI can register + mint a client_credentials app.
  // Endpoint-less methods emit an empty oauth object (prior behavior).
  oauth: {
    ...(method.authorizationUrl !== undefined ? { authorizationUrl: method.authorizationUrl } : {}),
    ...(method.tokenUrl !== undefined ? { tokenUrl: method.tokenUrl } : {}),
    ...(method.resource !== undefined ? { resource: method.resource } : {}),
    ...(method.scopes !== undefined ? { scopes: method.scopes } : {}),
    ...(method.defaultGrant !== undefined ? { defaultGrant: method.defaultGrant } : {}),
    ...(method.defaultTokenEndpointAuthMethod !== undefined
      ? { defaultTokenEndpointAuthMethod: method.defaultTokenEndpointAuthMethod }
      : {}),
  },
});

/** Convert a generic editor value into one GraphQL auth-method input (no slug
 *  — the backend assigns carrier-derived slugs). An apikey value keeps every
 *  named placement (headers and query params mix freely); one with no usable
 *  placement falls back to `none`. */
export function graphqlAuthMethodInputFromEditorValue(
  value: AuthTemplateEditorValue,
): GraphqlAuthMethodInput {
  if (value.kind === "oauth") {
    // Preserve any endpoints/scopes the editor carries (an endpointful /
    // service-account method) so a read-modify-write round-trip does not
    // discard them. The integration-level defaultGrant /
    // defaultTokenEndpointAuthMethod are not surfaced by the generic editor and
    // are set via addIntegration / the agent config, not here.
    return {
      kind: "oauth2",
      ...(value.authorizationUrl ? { authorizationUrl: value.authorizationUrl } : {}),
      ...(value.tokenUrl ? { tokenUrl: value.tokenUrl } : {}),
      ...(value.scopes && value.scopes.length > 0 ? { scopes: [...value.scopes] } : {}),
    };
  }
  return (sharedMethodInputFromEditorValue(value) ?? { kind: "none" }) as GraphqlAuthMethodInput;
}

/** Convert one stored GraphQL method into the generic editor value. */
export function editorValueFromGraphqlAuthMethod(
  method: GraphqlAuthMethod,
): AuthTemplateEditorValue {
  if (method.kind === "oauth2") {
    // Endpointful methods seed the editor with their stored endpoints/scopes;
    // endpoint-less (bearer-render-only) methods yield empty fields as before.
    return {
      kind: "oauth",
      authorizationUrl: method.authorizationUrl ?? "",
      tokenUrl: method.tokenUrl ?? "",
      scopes: method.scopes ? [...method.scopes] : [],
    };
  }
  return editorValueFromSharedMethod(method);
}

/** Project the stored methods into the generic `AuthMethod[]` the hub renders.
 *  Mirrors the server's `describeGraphqlAuthMethods`; `custom_` slugs mark
 *  user-created methods (removable from the hub). */
export function authMethodsFromConfig(methods: readonly GraphqlAuthMethod[]): AuthMethod[] {
  return methods.map((method: GraphqlAuthMethod): AuthMethod => {
    if (method.kind === "oauth2") return oauthAuthMethod(method);
    return authMethodFromSharedTemplate(method);
  });
}

/** Build the GraphQL method input for a custom method from generic placements
 *  — ONE method carrying every named placement (header + query mix in a single
 *  method; each placement renders from its own input variable, or shares one).
 *  Empty when no placement is usable. */
export function graphqlAuthMethodInputsFromPlacements(
  placements: readonly Placement[],
): GraphqlAuthMethodInput[] {
  const wire = wirePlacementsFromEditor(placements);
  if (wire.length === 0) return [];
  return [graphqlWireAuthInput({ kind: "apikey", placements: wire })];
}

/** Serialize a canonical method into the wire input union (apikey → the
 *  request-shaped dialect; none/oauth2 pass through). */
export const graphqlWireAuthInput = (
  method: GraphqlAuthMethod | GraphqlCanonicalAuthMethodInput,
): GraphqlAuthMethodInput => wireAuthInputFromShared(method) as GraphqlAuthMethodInput;
