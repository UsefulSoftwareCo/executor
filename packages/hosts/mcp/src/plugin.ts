import { Effect } from "effect";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type * as Cause from "effect/Cause";

import type { AnyPlugin } from "@executor-js/sdk";
import type { ExecutionEngine } from "@executor-js/execution";

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type McpDebugLog = (event: string, data: Record<string, unknown>) => void;

export type McpRunToolEffect = <EffE>(
  effect: Effect.Effect<McpToolResult, EffE>,
) => Promise<McpToolResult>;

export type McpPluginRegisterContext<E extends Cause.YieldableError = Cause.YieldableError> = {
  readonly server: McpServer;
  readonly engine: ExecutionEngine<E>;
  readonly description: string;
  readonly debugLog: McpDebugLog;
  readonly runToolEffect: McpRunToolEffect;
  readonly executeCodeFromApp: (code: string) => Effect.Effect<McpToolResult, E>;
  readonly renderUiFallbackUrl?: (code: string) => string;
  readonly resumeExecution: (
    executionId: string,
    action: "accept" | "decline" | "cancel",
    content: Record<string, unknown> | undefined,
  ) => Effect.Effect<McpToolResult, E>;
  readonly parseJsonContent: (raw: string) => Record<string, unknown> | undefined;
};

export type McpPluginClientCapabilitiesContext = {
  readonly server: McpServer;
  readonly clientCapabilities: ClientCapabilities | undefined;
  readonly debugLog: McpDebugLog;
};

export type McpPluginContribution<E extends Cause.YieldableError = Cause.YieldableError> = {
  readonly id: string;
  readonly prepareExecuteDescription?: (description: string) => string;
  readonly register: (ctx: McpPluginRegisterContext<E>) => Effect.Effect<void>;
  readonly onClientCapabilitiesChanged?: (ctx: McpPluginClientCapabilitiesContext) => void;
};

export type McpPluginContributionFactory = () => McpPluginContribution;

export const defineMcpContribution = <T extends McpPluginContribution>(contribution: T): T =>
  contribution;

const isMcpContributionFactory = (value: unknown): value is McpPluginContributionFactory =>
  typeof value === "function";

export const collectMcpContributions = (
  plugins: readonly AnyPlugin[] | undefined,
): readonly McpPluginContribution[] =>
  (plugins ?? [])
    .map((plugin) => plugin.mcp)
    .filter(isMcpContributionFactory)
    .map((factory) => factory());
