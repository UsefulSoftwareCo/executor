/** User-supplied protocol URLs become ordinary deployable app source. */
import { catalogStage, setupRecovery } from "./diagnostics.ts";
import { customSetupRecovery } from "../contracts/setup.ts";
import type { CatalogHost } from "../contracts/catalog.ts";
import type { CustomAppInput } from "../contracts/imports.ts";
import { generateMcpApp } from "./mcp.ts";
import { applyMcpUrlDefaults } from "./overrides.ts";
import { generateApiApp } from "./api.ts";

/**
 * Account credentials are supplied later through the shared account connection flow. Only the
 * connection URL gains provider defaults; OAuth discovery keeps the entered URL.
 */
export const generateCustomApp = (input: CustomAppInput, host: CatalogHost) => {
  if (input.kind !== "mcp") return generateApiApp(input, host).pipe(catalogStage("custom"));
  const url = applyMcpUrlDefaults(input.url);
  return generateMcpApp(
    { name: input.name, url, oauthDiscoveryUrl: url === input.url ? undefined : input.url },
    host,
  ).pipe(setupRecovery(customSetupRecovery), catalogStage("custom"));
};
