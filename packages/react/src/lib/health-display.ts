// Shared display strings + colors for connection health. Several surfaces (the
// AccountRow status dot, the "Check now" result, the health-check editor preview)
// render the same `HealthStatus`, so the labels and indicator colors live here:
// a rename or palette change happens in one place. Mirrors the convention of
// `policy-display.ts`.

import type { HealthStatus } from "@executor-js/sdk/shared";

/** State form: badge text, indicator tooltips, "what is the current state". */
export const HEALTH_STATUS_LABEL: Record<HealthStatus, string> = {
  healthy: "Healthy",
  expired: "Expired",
  degraded: "Degraded",
  unknown: "Unchecked",
};

/** Text tone per status, for verdict lines and previews. Same per-status color
 *  decision as the indicator dots below; change them together. */
export const HEALTH_TEXT_CLASS: Record<HealthStatus, string> = {
  healthy: "text-emerald-600 dark:text-emerald-400",
  expired: "text-destructive",
  degraded: "text-amber-600 dark:text-amber-500",
  unknown: "text-muted-foreground",
};

/** Dot + ring color classes for the per-connection indicator. `unknown` is the
 *  neutral never-probed state; `expired` reuses the destructive token so it reads
 *  the same as a blocked policy. */
export const HEALTH_INDICATOR_COLOR: Record<
  HealthStatus,
  { readonly dot: string; readonly ring: string }
> = {
  healthy: { dot: "bg-emerald-500", ring: "ring-emerald-500/70" },
  expired: { dot: "bg-destructive", ring: "ring-destructive/70" },
  degraded: { dot: "bg-amber-500", ring: "ring-amber-500/70" },
  unknown: { dot: "bg-muted-foreground/40", ring: "ring-muted-foreground/40" },
};

/** Severity for worst-of aggregation. `unknown` is excluded on purpose: a
 *  never-probed connection carries no signal, so it must not drag a group
 *  verdict in either direction. */
const HEALTH_SEVERITY: Record<Exclude<HealthStatus, "unknown">, number> = {
  healthy: 1,
  degraded: 2,
  expired: 3,
};

/** Collapse many connection statuses to the group's worst: expired > degraded
 *  > healthy. `unknown` entries are ignored; when nothing else remains (empty
 *  input or all unknown) there is no verdict and the caller renders nothing. */
export const worstHealthStatus = (statuses: readonly HealthStatus[]): HealthStatus | null => {
  let worst: Exclude<HealthStatus, "unknown"> | null = null;
  for (const status of statuses) {
    if (status === "unknown") continue;
    if (worst === null || HEALTH_SEVERITY[status] > HEALTH_SEVERITY[worst]) worst = status;
  }
  return worst;
};

/** Badge variant per status: semantic color via the Badge component. */
export const HEALTH_BADGE_VARIANT: Record<
  HealthStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  healthy: "secondary",
  expired: "destructive",
  degraded: "outline",
  unknown: "outline",
};
