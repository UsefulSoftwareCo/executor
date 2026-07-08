export type IntegrationDetailSearchTab = "accounts" | "source" | "tools";
export type IntegrationDetailInternalTab = "accounts" | "tools";

export const integrationDetailTabForAddCompletion = (
  pluginKey: string,
): IntegrationDetailSearchTab | undefined => (pluginKey === "apps" ? "source" : undefined);

export const integrationDetailInternalTabFromSearch = (
  tab: IntegrationDetailSearchTab | undefined,
): IntegrationDetailInternalTab => (tab === "tools" ? "tools" : "accounts");

export const integrationDetailSearchTabForInternal = (
  integrationKind: string | undefined,
  tab: IntegrationDetailInternalTab,
): IntegrationDetailSearchTab =>
  tab === "tools" ? "tools" : integrationKind === "apps" ? "source" : "accounts";
