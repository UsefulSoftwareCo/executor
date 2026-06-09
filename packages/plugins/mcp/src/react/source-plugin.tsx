import { lazy, type ComponentProps, type ComponentType } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";
import { mcpPresets } from "../sdk/presets";

const importAdd = () => import("./AddMcpSource");
const importEdit = () => import("./EditMcpSource");
const importAccounts = () => import("./McpAccountsPanel");

const LazyAddMcpSource = lazy(importAdd);
const LazyEditMcpSource = lazy(importEdit);
const LazyMcpAccountsPanel = lazy(importAccounts);

type AddProps = ComponentProps<IntegrationPlugin["add"]>;

export interface McpIntegrationPluginOptions {
  /**
   * Enable the stdio transport in the add-source UI (tab + presets).
   *
   * Off by default — stdio is a high-risk transport on any server deployment
   * (see `dangerouslyAllowStdioMCP` on the server-side plugin). Only enable in
   * trusted local contexts where the server has the matching flag set.
   */
  readonly allowStdio?: boolean;
}

export const createMcpIntegrationPlugin = (
  options?: McpIntegrationPluginOptions,
): IntegrationPlugin => {
  const allowStdio = options?.allowStdio ?? false;

  const AddWithFlag: ComponentType<AddProps> = (props) => (
    <LazyAddMcpSource {...props} allowStdio={allowStdio} />
  );

  const presets = allowStdio
    ? mcpPresets
    : mcpPresets.filter(
        (p) => !("transport" in p && (p as { transport?: string }).transport === "stdio"),
      );

  return {
    key: "mcp",
    label: "MCP",
    add: AddWithFlag,
    edit: LazyEditMcpSource,
    accounts: LazyMcpAccountsPanel,
    presets,
    preload: () => {
      void importAdd();
      void importEdit();
      void importAccounts();
    },
  };
};

/** @deprecated Use `createMcpIntegrationPlugin({ allowStdio })` instead. */
export const mcpIntegrationPlugin: IntegrationPlugin = createMcpIntegrationPlugin();
