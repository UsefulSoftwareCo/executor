// "source" is still accepted from the URL so links minted while the apps
// plugin existed degrade to the accounts tab instead of failing validation.
export type IntegrationDetailSearchTab = "accounts" | "source" | "tools";
export type IntegrationDetailInternalTab = "accounts" | "tools";

export const integrationDetailInternalTabFromSearch = (
  tab: IntegrationDetailSearchTab | undefined,
): IntegrationDetailInternalTab => (tab === "tools" ? "tools" : "accounts");
