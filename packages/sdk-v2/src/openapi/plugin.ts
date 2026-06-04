import { definePlugin, type IntegrationPlugin } from "../plugin";
import type { OpenAPIIntegration } from "./types";

/* ─────────────────────────  openapi plugin  ────────────────────────────
 * The openapi integration kind as a plugin — the v2 home of what v1 exposed as
 * the bare `add(integration: OpenAPIIntegration)`. Reframed as a plugin it's
 * just one member of the generic `add` union; adding a future graphql/mcp kind
 * is a new plugin in the tuple, not a new method on the SDK.
 */

/** Add-input for the openapi kind — the catalog fields plus the `kind`
 *  discriminant the generic `add` dispatches on. */
export type OpenAPIAddInput = OpenAPIIntegration & { readonly kind: "openapi" };

export const openapiPlugin: IntegrationPlugin<"openapi", OpenAPIAddInput, OpenAPIIntegration> =
  definePlugin({
    kind: "openapi",
    add: ({ kind: _kind, ...integration }) => integration,
  });

/** Convenience tuple for an executor that only wants the openapi kind. */
export type OpenAPIPlugins = readonly [typeof openapiPlugin];
export const openapiPlugins: OpenAPIPlugins = [openapiPlugin];
