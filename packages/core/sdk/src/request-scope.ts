// ---------------------------------------------------------------------------
// Request scope — vocabulary-neutral per-request catalog and tool policy
// overlay. Plugins contribute `RequestScope` data via `resolveRequestScope`;
// core enforces it centrally across list/get/schema/execute surfaces.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import type { Connection } from "./connection";
import type { Integration } from "./integration";
import type { PluginCtx } from "./plugin";
import type { ToolPolicyRow, ToolPolicyAction } from "./core-schema";
import { resolveEffectivePolicy, type EffectivePolicy } from "./policies";
import type { Tool } from "./tool";

export type ScopeDecision = "allow" | "require_approval" | "block";

export interface RequestScope {
  readonly inheritOrgPolicies: boolean;
  decideTool(tool: Tool): ScopeDecision;
  allowsConnection(connection: Connection): boolean;
  allowsIntegration(integration: Integration): boolean;
  decideStaticTool?(tool: Tool): ScopeDecision;
}

/** Fail-closed empty slice — no connections, integrations, or runnable tools. */
export const EMPTY_REQUEST_SCOPE: RequestScope = {
  inheritOrgPolicies: true,
  decideTool: () => "block",
  allowsConnection: () => false,
  allowsIntegration: () => false,
  decideStaticTool: () => "block",
};

const ACTION_RESTRICTION_RANK: Record<ToolPolicyAction, number> = {
  block: 3,
  require_approval: 2,
  approve: 1,
};
const actionRestrictionRank = (action: ToolPolicyAction): number => ACTION_RESTRICTION_RANK[action];

const DECISION_TO_POLICY_ACTION: Record<ScopeDecision, ToolPolicyAction> = {
  block: "block",
  require_approval: "require_approval",
  allow: "approve",
};

export const scopeDecisionToPolicyAction = (decision: ScopeDecision): ToolPolicyAction =>
  DECISION_TO_POLICY_ACTION[decision];

const moreRestrictiveAction = (
  current: ToolPolicyAction,
  candidate: ToolPolicyAction,
): ToolPolicyAction =>
  actionRestrictionRank(candidate) > actionRestrictionRank(current) ? candidate : current;

/** Catalog-reading static tools allowed under scope; mutations blocked by default. */
const CATALOG_READ_STATIC_ADDRESSES = new Set([
  "executor.coreTools.integrations.list",
  "executor.coreTools.connections.list",
]);

export const defaultDecideStaticTool = (tool: Tool): ScopeDecision =>
  CATALOG_READ_STATIC_ADDRESSES.has(String(tool.address)) ? "allow" : "block";

export const decideStaticToolForScope = (scope: RequestScope, tool: Tool): ScopeDecision =>
  scope.decideStaticTool?.(tool) ?? defaultDecideStaticTool(tool);

export const filterPolicyRowsForScope = (
  rows: readonly ToolPolicyRow[],
  scope: RequestScope,
): readonly ToolPolicyRow[] =>
  scope.inheritOrgPolicies
    ? rows
    : rows.filter(
        (row) => row.owner !== "org" || row.action === "block" || row.action === "require_approval",
      );

export const resolveScopedEffectivePolicy = (
  toolId: string,
  tool: Tool,
  scope: RequestScope,
  policies: readonly ToolPolicyRow[],
  ownerRank: (row: Pick<ToolPolicyRow, "owner">) => number,
  defaultRequiresApproval?: boolean,
): EffectivePolicy => {
  const filtered = filterPolicyRowsForScope(policies, scope);
  const base = resolveEffectivePolicy(toolId, filtered, ownerRank, defaultRequiresApproval);
  const scopeDecision = tool.static
    ? decideStaticToolForScope(scope, tool)
    : scope.decideTool(tool);
  const scopeAction = scopeDecisionToPolicyAction(scopeDecision);
  const merged = moreRestrictiveAction(base.action, scopeAction);
  if (merged === scopeAction && merged !== base.action) {
    return { action: merged, source: "user", pattern: "request-scope" };
  }
  return {
    action: merged,
    source: base.source,
    pattern: base.pattern,
    policyId: base.policyId,
  };
};

export const toolVisibleUnderScope = (tool: Tool, scope: RequestScope): boolean => {
  const decision = tool.static ? decideStaticToolForScope(scope, tool) : scope.decideTool(tool);
  return decision !== "block";
};

/** Narrow plugin ctx catalog reads for request-time static tool handlers. */
export const scopePluginCtx = <TStore>(
  ctx: PluginCtx<TStore>,
  scope: RequestScope,
): PluginCtx<TStore> => ({
  ...ctx,
  core: {
    ...ctx.core,
    integrations: {
      ...ctx.core.integrations,
      list: () =>
        ctx.core.integrations
          .list()
          .pipe(Effect.map((items) => items.filter((i) => scope.allowsIntegration(i)))),
      get: (slug) =>
        ctx.core.integrations
          .get(slug)
          .pipe(
            Effect.map((record) => (record && scope.allowsIntegration(record) ? record : null)),
          ),
    },
  },
  connections: {
    ...ctx.connections,
    list: (filter) =>
      ctx.connections
        .list(filter)
        .pipe(Effect.map((items) => items.filter((c) => scope.allowsConnection(c)))),
    get: (ref) =>
      ctx.connections
        .get(ref)
        .pipe(
          Effect.map((connection) =>
            connection && scope.allowsConnection(connection) ? connection : null,
          ),
        ),
  },
});
