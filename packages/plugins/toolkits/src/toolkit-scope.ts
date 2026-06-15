// ---------------------------------------------------------------------------
// Toolkit scope — pure data mapping from a resolved toolkit slice to core's
// vocabulary-neutral `RequestScope`. Core owns enforcement; this module only
// derives allow/block/require_approval decisions from toolkit entries and
// per-toolkit policy rules.
// ---------------------------------------------------------------------------

import type { Connection } from "@executor-js/sdk";
import { defaultDecideStaticTool, type RequestScope, type ScopeDecision } from "@executor-js/sdk";

import type { ToolkitAccess, ToolkitPolicyAction } from "./shared";

export interface ToolkitPolicyRule {
  /** Glob over `<integration>.<connection>.<tool>` — `*` matches one segment,
   *  a trailing `*` matches the rest, and `*` inside a segment globs. */
  readonly pattern: string;
  readonly action: ToolkitPolicyAction;
}

export interface ToolkitScopeEntry {
  readonly integration: string;
  /** A pinned connection name, or "*" to track every connection of the integration. */
  readonly connection: string;
  readonly access: ToolkitAccess;
}

export interface ResolvedToolkitScope {
  readonly entries: readonly ToolkitScopeEntry[];
  /** Per-toolkit policy rules — `block` excludes tools; `require_approval`
   *  tightens execution via core's stricter-wins merge with org policies. */
  readonly policies: readonly ToolkitPolicyRule[];
  readonly inheritOrgPolicies: boolean;
}

/** Empty slice — exposes no connection tools. Applied fail-closed when a
 *  selector resolves to no toolkit (unknown or not visible to the caller). */
export const EMPTY_TOOLKIT_SCOPE: ResolvedToolkitScope = {
  entries: [],
  policies: [],
  inheritOrgPolicies: true,
};

/** Glob match over dot segments: `*` matches one segment, a trailing bare `*`
 *  matches the rest, and `*` inside a segment globs within it. */
const matchPattern = (pattern: string, target: string): boolean => {
  const p = pattern.toLowerCase().trim().split(".");
  const a = target.toLowerCase().split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*" && i === p.length - 1) return true;
    if (a[i] === undefined) return false;
    const re = new RegExp(
      "^" + p[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    if (!re.test(a[i])) return false;
  }
  return p.length === a.length;
};

const accessFor = (
  scope: ResolvedToolkitScope,
  integration: string,
  connection: string,
): ToolkitAccess => {
  for (const e of scope.entries) {
    if (e.integration === integration && e.connection === connection) return e.access;
  }
  for (const e of scope.entries) {
    if (e.integration === integration && e.connection === "*") return e.access;
  }
  return "off";
};

const policyDecisionForTool = (
  scope: ResolvedToolkitScope,
  integration: string,
  connection: string,
  name: string,
): ScopeDecision | null => {
  const target = `${integration}.${connection}.${name}`;
  for (const rule of scope.policies) {
    if (!matchPattern(rule.pattern, target)) continue;
    if (rule.action === "block") return "block";
    if (rule.action === "require_approval") return "require_approval";
  }
  return null;
};

/** Map a resolved toolkit slice to core's `RequestScope` overlay. */
export const toolkitScopeToRequestScope = (scope: ResolvedToolkitScope): RequestScope => {
  const allowedIntegrations = new Set(
    scope.entries.filter((e) => e.access !== "off").map((e) => e.integration),
  );

  return {
    inheritOrgPolicies: scope.inheritOrgPolicies,
    allowsIntegration: (integration) => allowedIntegrations.has(String(integration.slug)),
    allowsConnection: (connection: Connection) =>
      accessFor(scope, String(connection.integration), String(connection.name)) !== "off",
    decideTool: (tool) => {
      const integration = String(tool.integration);
      const connection = String(tool.connection);
      const name = String(tool.name);

      const fromPolicy = policyDecisionForTool(scope, integration, connection, name);
      if (fromPolicy === "block") return "block";

      const access = accessFor(scope, integration, connection);
      if (access === "off") return "block";
      if (access === "read" && tool.annotations?.readOnly !== true) return "block";

      if (fromPolicy === "require_approval") return "require_approval";
      return "allow";
    },
    decideStaticTool: defaultDecideStaticTool,
  };
};
