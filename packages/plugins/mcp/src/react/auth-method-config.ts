// ---------------------------------------------------------------------------
// MCP ↔ generic auth-method converters — a thin oauth adapter over the shared
// codec (`@executor-js/react/lib/shared-auth-method-codec`). The apikey/none
// paths (multi-placement, multi-variable) live in the shared codec; MCP only
// contributes its oauth flavor: endpoint-less methods whose metadata is
// discovered at connect time (`discoveryUrl` = the MCP endpoint).
// ---------------------------------------------------------------------------

import { AuthTemplateSlug } from "@executor-js/sdk/shared";
import type { AuthTemplateEditorValue } from "@executor-js/react/components/auth-template-editor";
import type { AuthMethod, Placement } from "@executor-js/react/lib/auth-placements";
import {
  authMethodFromSharedTemplate,
  editorValueFromSharedMethod,
  sharedMethodInputFromEditorValue,
  wirePlacementsFromEditor,
} from "@executor-js/react/lib/shared-auth-method-codec";

import { wireAuthInputFromShared } from "@executor-js/react/lib/shared-auth-method-codec";
import type {
  McpAuthMethod,
  McpAuthMethodInput,
  McpCanonicalAuthMethodInput,
  McpStdioEnvMethod,
} from "../sdk/types";

/** Stdio env method → generic hub `AuthMethod`: one `env`-carrier placement per
 *  declared var, so the account form collects one secret per env var. Mirrors
 *  the server's `describeMcpAuthMethods`. */
const stdioEnvAuthMethod = (method: McpStdioEnvMethod): AuthMethod => ({
  id: method.slug,
  label: "Environment variables",
  kind: "apikey",
  source: "spec",
  template: AuthTemplateSlug.make(method.slug),
  placements: method.vars.map((name) => ({ carrier: "env", name, prefix: "", variable: name })),
});

/** Stdio env method → editor value (apikey over env placements). */
const stdioEnvEditorValue = (method: McpStdioEnvMethod): AuthTemplateEditorValue => ({
  kind: "apikey",
  placements: method.vars.map((name) => ({ carrier: "env", name, prefix: "", variable: name })),
});

/** Serialize a canonical method into the wire input union (apikey → the
 *  request-shaped dialect; none/oauth2 pass through). */
export const mcpWireAuthInput = (
  method: McpAuthMethod | McpCanonicalAuthMethodInput,
): McpAuthMethodInput => wireAuthInputFromShared(method) as McpAuthMethodInput;

const oauthAuthMethod = (slug: string, endpoint: string): AuthMethod => ({
  id: slug,
  label: "OAuth",
  kind: "oauth",
  source: slug.startsWith("custom_") ? "custom" : "spec",
  template: AuthTemplateSlug.make(slug),
  placements: [],
  oauth: { discoveryUrl: endpoint, supportsDynamicRegistration: true },
});

/** Convert a generic editor value into one MCP auth-method input (no slug —
 *  the backend assigns carrier-derived slugs). An apikey value keeps every
 *  named placement (headers and query params mix freely); one with no usable
 *  placement falls back to `none`. */
export function mcpAuthMethodInputFromEditorValue(
  value: AuthTemplateEditorValue,
): McpCanonicalAuthMethodInput {
  if (value.kind === "oauth") return { kind: "oauth2" };
  return (sharedMethodInputFromEditorValue(value) ?? {
    kind: "none",
  }) as McpCanonicalAuthMethodInput;
}

/** Convert one stored MCP method into the generic editor value. */
export function editorValueFromMcpAuthMethod(method: McpAuthMethod): AuthTemplateEditorValue {
  if (method.kind === "oauth2") {
    return { kind: "oauth", authorizationUrl: "", tokenUrl: "", scopes: [] };
  }
  if (method.kind === "stdio_env") return stdioEnvEditorValue(method);
  return editorValueFromSharedMethod(method);
}

/** Project the stored methods into the generic `AuthMethod[]` the hub renders.
 *  Mirrors the server's `describeMcpAuthMethods`; `custom_` slugs mark
 *  user-created methods (removable from the hub). `endpoint` feeds the oauth
 *  method's probe-at-connect `discoveryUrl`. */
export function authMethodsFromConfig(
  methods: readonly McpAuthMethod[],
  endpoint: string,
): AuthMethod[] {
  return methods.map((method: McpAuthMethod): AuthMethod => {
    if (method.kind === "oauth2") return oauthAuthMethod(method.slug, endpoint);
    if (method.kind === "stdio_env") return stdioEnvAuthMethod(method);
    return authMethodFromSharedTemplate(method);
  });
}

/** Build the MCP method input for a custom method from generic placements —
 *  ONE method carrying every named placement (header + query mix in a single
 *  method; each placement renders from its own input variable, or shares one).
 *  Empty when no placement is usable. */
export function mcpAuthMethodInputsFromPlacements(
  placements: readonly Placement[],
): McpCanonicalAuthMethodInput[] {
  const wire = wirePlacementsFromEditor(placements);
  if (wire.length === 0) return [];
  return [{ kind: "apikey", placements: wire }];
}
