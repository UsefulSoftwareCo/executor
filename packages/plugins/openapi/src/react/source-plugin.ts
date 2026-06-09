import { lazy } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";
import { openApiPresets } from "../sdk/presets";

const importAdd = () => import("./AddOpenApiSource");
const importEdit = () => import("./EditOpenApiSource");
const importAccounts = () => import("./OpenApiAccountsPanel");

export const openApiIntegrationPlugin: IntegrationPlugin = {
  key: "openapi",
  label: "OpenAPI",
  add: lazy(importAdd),
  edit: lazy(importEdit),
  accounts: lazy(importAccounts),
  presets: openApiPresets,
  preload: () => {
    void importAdd();
    void importEdit();
    void importAccounts();
  },
};
