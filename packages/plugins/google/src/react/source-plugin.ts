import { lazy } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";
import {
  googleOpenApiBundlePreset,
  googleOpenApiPresets,
  googlePhotosOpenApiBundlePreset,
  googleServiceSlug,
} from "../sdk/presets";

const importAdd = () => import("./AddGoogleSource");
const importAccounts = () => import("./GoogleAccountsPanel");

// Each per-service integration (google_calendar, google_gmail, …) is keyed by
// the slug the fan-out registers, mapped to the preset's own product glyph.
const googleServiceIcons = googleOpenApiPresets.flatMap((preset) =>
  preset.icon ? [{ slug: googleServiceSlug(preset.id), icon: preset.icon }] : [],
);

export const googleIntegrationPlugin: IntegrationPlugin = {
  key: "google",
  label: "Google",
  add: lazy(importAdd),
  accounts: lazy(importAccounts),
  presets: [googleOpenApiBundlePreset, googlePhotosOpenApiBundlePreset],
  serviceIcons: googleServiceIcons,
  preload: () => {
    void importAdd();
    void importAccounts();
  },
};
