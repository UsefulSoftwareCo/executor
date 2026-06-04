import type { IntegrationSlug } from "./ids";

/* Core knows only an integration's catalog identity — slug + description. The
 * type-specific shape (openapi auth templates + spec, an mcp url, …) lives in the
 * owning plugin and is what that plugin's `add` returns. An integration is one
 * API surface; multi-API providers (Google) are bundled into a single
 * integration by their plugin, so one credential covers the whole provider. */

export type Integration = {
  readonly slug: IntegrationSlug;
  readonly description: string;
};
