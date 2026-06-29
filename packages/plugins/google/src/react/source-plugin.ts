import { lazy } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";
import { googleOpenApiBundlePreset, googlePhotosOpenApiBundlePreset } from "../sdk/presets";

const importAdd = () => import("./AddGoogleSource");
const importAccounts = () => import("./GoogleAccountsPanel");

export const googleIntegrationPlugin: IntegrationPlugin = {
  key: "google",
  label: "Google",
  add: lazy(importAdd),
  accounts: lazy(importAccounts),
  presets: [googleOpenApiBundlePreset, googlePhotosOpenApiBundlePreset],
  preload: () => {
    void importAdd();
    void importAccounts();
  },
};
