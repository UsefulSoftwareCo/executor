import { lazy, useCallback, type ComponentProps, type ComponentType } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import type {
  IntegrationPlugin,
  IntegrationQuickAddInput,
  IntegrationQuickAddResult,
} from "@executor-js/sdk/client";
import { placementFromHeaderPattern } from "@executor-js/react/lib/auth-placements";
import { slugifyNamespace } from "@executor-js/react/plugins/integration-identity";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { mcpPresets } from "../sdk/presets";
import { addMcpServer, probeMcpEndpoint } from "./atoms";
import {
  mcpAuthMethodInputFromEditorValue,
  mcpDetectedAuthSeeds,
  mcpWireAuthInput,
} from "./auth-method-config";

const importAdd = () => import("./AddMcpIntegration");
const importEditSheet = () => import("./EditMcpIntegration");
const importAccounts = () => import("./McpAccountsPanel");

const LazyAddMcpIntegration = lazy(importAdd);
const LazyEditMcpSheet = lazy(importEditSheet);
const LazyMcpAccountsPanel = lazy(importAccounts);

type AddProps = ComponentProps<IntegrationPlugin["add"]>;

/** One-click add for a registry MCP row: probe, declare the auth methods the
 *  add page would have seeded (same policy — `mcpDetectedAuthSeeds`), and
 *  register. A failed probe means the configuration screen's job — it renders
 *  the failure with retry UX — so quick add reports `{ok: false}` instead of
 *  guessing. */
function useMcpQuickAdd(): (input: IntegrationQuickAddInput) => Promise<IntegrationQuickAddResult> {
  const doProbe = useAtomSet(probeMcpEndpoint, { mode: "promiseExit" });
  const doAddServer = useAtomSet(addMcpServer, { mode: "promiseExit" });
  return useCallback(
    async (input) => {
      const probeExit = await doProbe({ payload: { endpoint: input.url } });
      if (Exit.isFailure(probeExit)) return { ok: false, reason: "probe failed" };
      const probe = probeExit.value;
      const seeds = mcpDetectedAuthSeeds(probe, {
        placement: input.authHeader ? placementFromHeaderPattern(input.authHeader) : null,
        kind: input.authKind,
      });
      const methods = seeds.map((seed) =>
        mcpWireAuthInput(mcpAuthMethodInputFromEditorValue(seed.value)),
      );
      const slug = input.slug ? slugifyNamespace(input.slug) : undefined;
      const addExit = await doAddServer({
        payload: {
          transport: "remote" as const,
          name: input.name,
          endpoint: input.url,
          ...(slug ? { slug } : {}),
          ...(probe.instructions ? { description: probe.instructions } : {}),
          authenticationTemplate: methods.length > 0 ? methods : [{ kind: "none" as const }],
          // The probe reports when only legacy negotiation worked (a server
          // that echoes the modern revision but breaks its contract); pin it
          // so refreshes and tool calls use the same handshake.
          ...(probe.versionNegotiation === "legacy"
            ? { versionNegotiation: "legacy" as const }
            : {}),
        },
        reactivityKeys: integrationWriteKeys,
      });
      if (Exit.isFailure(addExit)) return { ok: false, reason: "add failed" };
      return { ok: true, slug: String(addExit.value.slug) };
    },
    [doProbe, doAddServer],
  );
}

export interface McpIntegrationPluginOptions {
  /**
   * Enable the stdio transport in the add-integration UI (tab + presets).
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
    <LazyAddMcpIntegration {...props} allowStdio={allowStdio} />
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
    editSheet: LazyEditMcpSheet,
    accounts: LazyMcpAccountsPanel,
    presets,
    preload: () => {
      void importAdd();
      void importEditSheet();
      void importAccounts();
    },
    useQuickAdd: useMcpQuickAdd,
  };
};

/** @deprecated Use `createMcpIntegrationPlugin({ allowStdio })` instead. */
export const mcpIntegrationPlugin: IntegrationPlugin = createMcpIntegrationPlugin();
