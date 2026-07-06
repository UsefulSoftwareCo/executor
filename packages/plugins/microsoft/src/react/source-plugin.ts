import { lazy } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";
import {
  microsoftGraphPreset,
  microsoftGraphScopePresets,
  microsoftServiceSlug,
} from "../sdk/presets";

const importAdd = () => import("./AddMicrosoftSource");
const importAccounts = () => import("./MicrosoftAccountsPanel");

// Each per-workload integration (microsoft_mail, microsoft_calendar, …) is
// keyed by the slug the fan-out registers, mapped to the workload's own glyph.
const microsoftServiceIcons = microsoftGraphScopePresets.flatMap((preset) =>
  preset.icon ? [{ slug: microsoftServiceSlug(preset.id), icon: preset.icon }] : [],
);

export const microsoftIntegrationPlugin: IntegrationPlugin = {
  key: "microsoft",
  label: "Microsoft",
  add: lazy(importAdd),
  accounts: lazy(importAccounts),
  presets: [microsoftGraphPreset],
  serviceIcons: microsoftServiceIcons,
  preload: () => {
    void importAdd();
    void importAccounts();
  },
};
