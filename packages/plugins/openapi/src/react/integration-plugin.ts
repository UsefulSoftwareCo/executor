import { lazy } from "react";
import type { IntegrationPlugin, IntegrationPreset } from "@executor-js/sdk/client";
import { openApiPresets } from "../sdk/presets";

const importAdd = () => import("./AddOpenApiIntegration");
const importEditSheet = () => import("./UpdateSpecSection");
const importAccounts = () => import("./OpenApiAccountsPanel");

export interface OpenApiClientConfig {
  readonly presets?: readonly IntegrationPreset[];
}

export const createOpenApiIntegrationPlugin = (
  config?: OpenApiClientConfig,
): IntegrationPlugin => ({
  key: "openapi",
  label: "OpenAPI",
  add: lazy(importAdd),
  editSheet: lazy(importEditSheet),
  accounts: lazy(importAccounts),
  presets: [...openApiPresets, ...(config?.presets ?? [])],
  preload: () => {
    void importAdd();
    void importEditSheet();
    void importAccounts();
  },
});

export const openApiIntegrationPlugin: IntegrationPlugin = createOpenApiIntegrationPlugin();
