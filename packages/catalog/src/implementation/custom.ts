/** A user-supplied MCP URL becomes ordinary deployable source once its connection is confirmed. */
import { catalogStage } from "./diagnostics.ts";
import type { CatalogHost } from "../contracts/catalog.ts";
import type { CustomAppInput } from "../contracts/imports.ts";
import { generateMcpApp } from "./mcp.ts";
import { applyMcpUrlDefaults } from "./overrides.ts";

/**
 * Account credentials are supplied later through the shared account connection flow. Only the
 * connection URL gains provider defaults; OAuth discovery keeps the entered URL.
 */
export const generateCustomApp = (input: CustomAppInput, host: CatalogHost) => {
  const url = applyMcpUrlDefaults(input.url);
  return generateMcpApp(
    { name: input.name, url, oauthDiscoveryUrl: url === input.url ? undefined : input.url },
    host,
  ).pipe(catalogStage("custom"));
};
