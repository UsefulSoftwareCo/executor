import { lazy } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";
import { openApiPresets } from "../sdk/presets";

const importAdd = () => import("./AddOpenApiSource");
const importEditSheet = () => import("./UpdateSpecSection");
const importAccounts = () => import("./OpenApiAccountsPanel");

export const openApiIntegrationPlugin: IntegrationPlugin = {
  key: "openapi",
  label: "OpenAPI",
  add: lazy(importAdd),
  editSheet: lazy(importEditSheet),
  accounts: lazy(importAccounts),
  presets: openApiPresets,
  preload: () => {
    void importAdd();
    void importEditSheet();
    void importAccounts();
  },
};
