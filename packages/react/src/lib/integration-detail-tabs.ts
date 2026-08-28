// "source" is still accepted from the URL so links minted while the apps
// plugin existed degrade to the accounts tab instead of failing validation.
export type IntegrationDetailSearchTab = "accounts" | "source" | "tools";
export type IntegrationDetailInternalTab = "accounts" | "tools";

export const integrationDetailInternalTabFromSearch = (
  tab: IntegrationDetailSearchTab | undefined,
): IntegrationDetailInternalTab => (tab === "tools" ? "tools" : "accounts");

export const toolSelectionSearch = (toolId: string | null): { readonly tool?: string } =>
  toolId === null ? { tool: undefined } : { tool: toolId };

export const toolSelectionFromSearch = (
  search: Readonly<Record<string, unknown>> | undefined,
): string | null =>
  typeof search?.tool === "string" && search.tool.length > 0 ? search.tool : null;
