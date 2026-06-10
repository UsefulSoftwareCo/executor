// ---------------------------------------------------------------------------
// MCP ↔ generic auth-template converter.
//
// The shared add-time `AuthTemplateEditor` / `AuthMethodListEditor` speak the
// plugin-agnostic `AuthTemplateEditorValue`; the hub speaks `AuthMethod`. MCP
// stores a slugged `authenticationTemplate` array (`none` / `header` /
// `oauth2`, one method per entry — a header method carries a single header,
// not an array). These converters live with the MCP plugin because they touch
// the transport-specific `McpAuthMethod` types.
// ---------------------------------------------------------------------------

import { AuthTemplateSlug } from "@executor-js/sdk/shared";
import type { AuthTemplateEditorValue } from "@executor-js/react/components/auth-template-editor";
import type { AuthMethod, Placement } from "@executor-js/react/lib/auth-placements";

import type { McpAuthMethod, McpAuthMethodInput } from "../sdk/types";

/** Convert a generic editor value into one MCP auth-method input (no slug —
 *  the backend assigns kind-based slugs). An apiKey method maps to a `header`
 *  method using its FIRST named header placement, preserving the prefix; an
 *  apiKey value with no usable header placement falls back to `none`. */
export function mcpAuthMethodInputFromEditorValue(
  value: AuthTemplateEditorValue,
): McpAuthMethodInput {
  if (value.kind === "oauth") return { kind: "oauth2" };
  if (value.kind === "apikey") {
    const header = value.placements.find(
      (placement) => placement.carrier === "header" && placement.name.trim().length > 0,
    );
    if (!header) return { kind: "none" };
    return {
      kind: "header",
      headerName: header.name.trim(),
      ...(header.prefix ? { prefix: header.prefix } : {}),
    };
  }
  return { kind: "none" };
}

/** Convert one stored MCP method into the generic editor value. */
export function editorValueFromMcpAuthMethod(method: McpAuthMethod): AuthTemplateEditorValue {
  if (method.kind === "oauth2") {
    return { kind: "oauth", authorizationUrl: "", tokenUrl: "", scopes: [] };
  }
  if (method.kind === "header") {
    return {
      kind: "apikey",
      placements: [{ carrier: "header", name: method.headerName, prefix: method.prefix ?? "" }],
    };
  }
  return { kind: "none" };
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
    const source: "spec" | "custom" = method.slug.startsWith("custom_") ? "custom" : "spec";
    const template = AuthTemplateSlug.make(method.slug);
    if (method.kind === "oauth2") {
      return {
        id: method.slug,
        label: "OAuth",
        kind: "oauth",
        source,
        template,
        placements: [],
        oauth: { discoveryUrl: endpoint, supportsDynamicRegistration: true },
      };
    }
    if (method.kind === "header") {
      return {
        id: method.slug,
        label: `API key (${method.headerName})`,
        kind: "apikey",
        source,
        template,
        placements: [{ carrier: "header", name: method.headerName, prefix: method.prefix ?? "" }],
      };
    }
    return {
      id: method.slug,
      label: "No authentication",
      kind: "none",
      source,
      template,
      placements: [],
    };
  });
}

/** Build MCP header-method inputs for a custom method from generic placements.
 *  MCP carries one header per method, so only the FIRST named header placement
 *  is used (query placements have no MCP credential carrier). Empty when no
 *  usable header placement exists. */
export function mcpAuthMethodInputsFromPlacements(
  placements: readonly Placement[],
): McpAuthMethodInput[] {
  const header = placements.find(
    (placement: Placement) => placement.carrier === "header" && placement.name.trim().length > 0,
  );
  if (!header) return [];
  return [
    {
      kind: "header",
      headerName: header.name.trim(),
      ...(header.prefix ? { prefix: header.prefix } : {}),
    },
  ];
}
