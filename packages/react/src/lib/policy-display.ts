// Shared display strings + colors for tool policy actions. Three views
// (Tools tree row dot, Tool detail header badge, Policies page row badge
// + select) need to render the same action consistently — keeping the
// labels here lets a rename ("Auto-approve" → "Always run") happen in
// one place. Splitting `state` vs `action` labels because `block` reads
// as "Blocked" when describing current state, "Block" as a verb in menus.

import type { ToolPolicyAction } from "@executor-js/sdk/shared";

/** Verb form — menus, select items, "what should this rule do". */
export const POLICY_ACTION_LABEL: Record<ToolPolicyAction, string> = {
  approve: "Always run",
  require_approval: "Require approval",
  block: "Block",
};

/** State form — badges, indicator tooltips, "what is the current
 *  state". Diverges from the verb form for `block` only. */
export const POLICY_STATE_LABEL: Record<ToolPolicyAction, string> = {
  ...POLICY_ACTION_LABEL,
  block: "Blocked",
};

/** Badge variant per action — semantic color via the Badge component. */
export const POLICY_BADGE_VARIANT: Record<
  ToolPolicyAction,
  "default" | "secondary" | "outline" | "destructive"
> = {
  approve: "secondary",
  require_approval: "outline",
  block: "destructive",
};

/** Dot + ring color classes for the per-row indicator in `ToolTree`.
 *  Filled dot = user-authored rule; ring-only = plugin default. */
export const POLICY_INDICATOR_COLOR: Record<
  ToolPolicyAction,
  { readonly dot: string; readonly ring: string }
> = {
  approve: { dot: "bg-foreground", ring: "ring-foreground/40" },
  require_approval: { dot: "bg-muted-foreground", ring: "ring-muted-foreground/40" },
  block: { dot: "bg-destructive", ring: "ring-destructive/70" },
};

/** Canonical display order for select items / menu options. */
export const POLICY_ACTIONS_IN_ORDER: ReadonlyArray<ToolPolicyAction> = [
  "approve",
  "require_approval",
  "block",
];
