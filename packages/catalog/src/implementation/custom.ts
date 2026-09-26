/** A user-supplied MCP URL becomes ordinary deployable source once its connection is confirmed. */
import { catalogStage } from "./diagnostics.ts";
import type { CustomAppInput } from "../contracts/imports.ts";
import { generateMcpApp } from "./mcp.ts";
import { applyMcpUrlDefaults } from "./overrides.ts";
import type { HostEgress } from "@executor-js/utils/url-policy";

/**
 * Account credentials are supplied later through the shared account connection flow. Only the
 * connection URL gains provider defaults; OAuth discovery keeps the entered URL.
 */
export const generateCustomApp = (input: CustomAppInput, egress: HostEgress) => {
  const url = applyMcpUrlDefaults(input.url);
  return generateMcpApp(
    { name: input.name, url, oauthDiscoveryUrl: url === input.url ? undefined : input.url },
    egress,
  ).pipe(catalogStage("custom"));
};
