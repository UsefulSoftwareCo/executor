import { lazy } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";
import { graphqlPresets } from "../sdk/presets";

const importAdd = () => import("./AddGraphqlSource");
const importAccounts = () => import("./GraphqlAccountsPanel");

// No `editSheet`: GraphQL has no plugin-specific configuration beyond auth
// methods, which the Accounts hub already owns ("+ Custom method").
export const graphqlIntegrationPlugin: IntegrationPlugin = {
  key: "graphql",
  label: "GraphQL",
  add: lazy(importAdd),
  accounts: lazy(importAccounts),
  presets: graphqlPresets,
  preload: () => {
    void importAdd();
    void importAccounts();
  },
};
