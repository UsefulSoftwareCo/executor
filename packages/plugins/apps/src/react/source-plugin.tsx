import { lazy } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";

import {
  CUSTOM_TOOLS_LABEL,
  CUSTOM_TOOLS_PLUGIN_KEY,
  type AppSourceKind,
} from "./custom-tools-client";

const importAccounts = () => import("./CustomToolsAccountsPanel");

export const makeAppsIntegrationPlugin = (config?: {
  readonly sourceKinds?: readonly AppSourceKind[];
}): IntegrationPlugin => {
  const sourceKinds = config?.sourceKinds ?? ["git"];
  const Add = lazy(async () => {
    const mod = await import("./AddCustomToolsSource");
    const AddCustomToolsSource = mod.default;
    return {
      default: (props: Parameters<typeof mod.default>[0]) => (
        <AddCustomToolsSource {...props} sourceKinds={sourceKinds} />
      ),
    };
  });
  const Accounts = lazy(importAccounts);
  return {
    key: CUSTOM_TOOLS_PLUGIN_KEY,
    label: CUSTOM_TOOLS_LABEL,
    add: Add,
    accounts: Accounts,
    preload: () => {
      void import("./AddCustomToolsSource");
      void importAccounts();
    },
  };
};
