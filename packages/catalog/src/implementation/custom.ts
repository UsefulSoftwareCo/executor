import { catalogStage, setupRecovery } from "./diagnostics.ts";
import { customSetupRecovery } from "../contracts/setup.ts";
import type { CatalogHost } from "../contracts/catalog.ts";
import type { CustomAppInput } from "../contracts/imports.ts";
import { generateMcpApp } from "./mcp.ts";
import { applyMcpUrlDefaults } from "./overrides.ts";

export const generateCustomApp = (input: CustomAppInput, host: CatalogHost) => {
  const url = applyMcpUrlDefaults(input.url);
  return generateMcpApp(
    { name: input.name, url, oauthDiscoveryUrl: url === input.url ? undefined : input.url },
    host,
  ).pipe(setupRecovery(customSetupRecovery), catalogStage("custom"));
};
