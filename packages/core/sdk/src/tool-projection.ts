// ---------------------------------------------------------------------------
// Tool projections — a narrowed view over one executor's catalog.
//
// The default MCP endpoint serves the whole catalog under the workspace's
// policies. A projection serves a SUBSET of that catalog (a toolkit, a set of
// integrations, one tool) through the SAME executor, the same policies, and
// the same enforcement. It is a filter plus an optional policy overlay, never
// a different rule source: a projection can only narrow what the workspace
// already allows.
//
// Resolution for one tool id:
//   1. If no `visible` pattern matches, the tool is blocked (outside the
//      projection's capability boundary).
//   2. Otherwise the projection's own `rules` resolve to an action (or fall
//      through to the plugin default), and that action is combined with the
//      workspace policy under least privilege: block > require_approval >
//      approve.
//
// Pure functions; the executor stitches them into `tools.list`, `tools.schema`,
// `execute`, `connections.list`, and `integrations.list`.
// ---------------------------------------------------------------------------

import { Match } from "effect";

import type { ToolPolicyAction } from "./core-schema";
import { matchPattern, type EffectivePolicy } from "./policies";

/** One ordered rule in a projection overlay. Same grammar as tool policies. */
export interface ToolProjectionRule {
  readonly id: string;
  readonly pattern: string;
  readonly action: ToolPolicyAction;
  /** Fractional-indexing key. Lower lex order = higher precedence. */
  readonly position: string;
}

/** The resolved shape of a projection, as core consumes it. */
export interface ToolProjection {
  /**
   * Patterns naming the tools this projection exposes. A tool outside every
   * pattern is blocked. An empty list exposes nothing.
   */
  readonly visible: readonly string[];
  /** Ordered overlay rules resolved on top of the workspace policy. */
  readonly rules: readonly ToolProjectionRule[];
  /**
   * When true, tools owned by the acting member (`<integration>.user.…`) are
   * blocked even if a `visible` pattern names them. An org-owned toolkit must
   * not leak a member's personal connections to whoever holds its URL.
   */
  readonly excludePersonal?: boolean;
}

/** The projection that exposes every tool under the workspace policy alone. */
export const fullToolProjection: ToolProjection = { visible: ["*"], rules: [] };

const isPersonalToolId = (toolId: string): boolean => toolId.split(".")[1] === "user";

const blockedOutsideProjection: EffectivePolicy = {
  action: "block",
  source: "user",
  pattern: "*",
};

const compareRule = (a: ToolProjectionRule, b: ToolProjectionRule): number => {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const actionRank = (action: ToolPolicyAction): number =>
  Match.value(action).pipe(
    Match.when("block", () => 3),
    Match.when("require_approval", () => 2),
    Match.when("approve", () => 1),
    Match.exhaustive,
  );

/**
 * Combine the workspace's answer with the projection's under least privilege.
 *
 * Only user-authored rules are guardrails. When BOTH sides carry one, the more
 * restrictive action wins (ties keep the workspace's rule, so the outer
 * guardrail stays attributable). When only ONE side carries a rule, that rule
 * decides: a plugin's default `requiresApproval` is a default, not a policy,
 * so an explicit toolkit "approve" may still lift it, exactly as an explicit
 * workspace "approve" does. When neither side has a rule both fall through to
 * the same plugin default.
 */
export const mostRestrictivePolicy = (
  workspace: EffectivePolicy,
  overlay: EffectivePolicy,
): EffectivePolicy => {
  const workspaceExplicit = workspace.source === "user";
  const overlayExplicit = overlay.source === "user";
  if (workspaceExplicit && overlayExplicit) {
    return actionRank(overlay.action) > actionRank(workspace.action) ? overlay : workspace;
  }
  if (overlayExplicit) return overlay;
  return workspace;
};

/** Whether `toolId` falls inside the projection's capability boundary. */
export const isVisibleInProjection = (projection: ToolProjection, toolId: string): boolean => {
  if (projection.excludePersonal && isPersonalToolId(toolId)) return false;
  return projection.visible.some((pattern) => matchPattern(pattern, toolId));
};

/**
 * Resolve the projection's OWN answer for a tool: its first matching overlay
 * rule, else the plugin default. Does not consult the workspace policy; see
 * {@link resolveProjectedPolicy} for the combined answer.
 */
export const resolveProjectionRule = (
  projection: ToolProjection,
  toolId: string,
  defaultRequiresApproval?: boolean,
): EffectivePolicy => {
  for (const rule of [...projection.rules].sort(compareRule)) {
    if (!matchPattern(rule.pattern, toolId)) continue;
    return { action: rule.action, source: "user", pattern: rule.pattern, policyId: rule.id };
  }
  return defaultRequiresApproval
    ? { action: "require_approval", source: "plugin-default" }
    : { action: "approve", source: "plugin-default" };
};

/**
 * The effective policy for `toolId` as seen through `projection`, given the
 * workspace's own answer for that tool. Outside the projection the tool is
 * blocked; inside it the projection's rule and the workspace's rule combine
 * under least privilege.
 */
export const resolveProjectedPolicy = (
  projection: ToolProjection,
  toolId: string,
  workspace: EffectivePolicy,
  defaultRequiresApproval?: boolean,
): EffectivePolicy => {
  if (!isVisibleInProjection(projection, toolId)) return blockedOutsideProjection;
  return mostRestrictivePolicy(
    workspace,
    resolveProjectionRule(projection, toolId, defaultRequiresApproval),
  );
};
