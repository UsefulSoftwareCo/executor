import { lazy, type ComponentProps, type ComponentType } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";
import { mcpPresets } from "../sdk/presets";

const importAdd = () => import("./AddMcpSource");
const importEditSheet = () => import("./EditMcpSource");
const importAccounts = () => import("./McpAccountsPanel");

const LazyAddMcpSource = lazy(importAdd);
const LazyEditMcpSheet = lazy(importEditSheet);
const LazyMcpAccountsPanel = lazy(importAccounts);

type AddProps = ComponentProps<IntegrationPlugin["add"]>;

export const createMcpIntegrationPlugin = (): IntegrationPlugin => {
  const AddWithFlag: ComponentType<AddProps> = (props) => (
    <LazyAddMcpSource {...props} />
  );

  return {
    key: "mcp",
    label: "MCP",
    add: AddWithFlag,
    editSheet: LazyEditMcpSheet,
    accounts: LazyMcpAccountsPanel,
    presets: mcpPresets,
    preload: () => {
      void importAdd();
      void importEditSheet();
      void importAccounts();
    },
  };
};

export const mcpIntegrationPlugin: IntegrationPlugin = createMcpIntegrationPlugin();
