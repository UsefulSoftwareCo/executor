import { lazy } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";
import { microsoftGraphPreset } from "../sdk/presets";

const importAdd = () => import("./AddMicrosoftSource");
const importAccounts = () => import("./MicrosoftAccountsPanel");

export const microsoftIntegrationPlugin: IntegrationPlugin = {
  key: "microsoft",
  label: "Microsoft",
  add: lazy(importAdd),
  accounts: lazy(importAccounts),
  presets: [microsoftGraphPreset],
  preload: () => {
    void importAdd();
    void importAccounts();
  },
};
