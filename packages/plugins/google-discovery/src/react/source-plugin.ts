import { lazy } from "react";
import type { SourcePlugin } from "@executor-js/sdk/client";
import { googleDiscoveryPresets } from "../sdk/presets";

const importAdd = () => import("./AddGoogleDiscoverySource");
const importEdit = () => import("./EditGoogleDiscoverySource");
const importSummary = () => import("./GoogleDiscoverySourceSummary");

export const googleDiscoverySourcePlugin: SourcePlugin = {
  key: "googleDiscovery",
  label: "Google Discovery",
  add: lazy(importAdd),
  edit: lazy(importEdit),
  summary: lazy(importSummary),
  presets: googleDiscoveryPresets,
  preload: () => {
    void importAdd();
    void importEdit();
    void importSummary();
  },
};
