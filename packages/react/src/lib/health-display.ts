// Shared display strings + colors for connection health. Several surfaces (the
// AccountRow status dot, the "Check now" result, the health-check editor preview)
// render the same `HealthStatus`, so the labels and indicator colors live here:
// a rename or palette change happens in one place. Mirrors the convention of
// `policy-display.ts`.

import type { HealthStatus } from "@executor-js/sdk/shared";

/** State form — badge text, indicator tooltips, "what is the current state". */
export const HEALTH_STATUS_LABEL: Record<HealthStatus, string> = {
  healthy: "Healthy",
  expired: "Expired",
  degraded: "Degraded",
  unknown: "Unchecked",
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

/** Badge variant per status — semantic color via the Badge component. */
export const HEALTH_BADGE_VARIANT: Record<
  HealthStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  healthy: "secondary",
  expired: "destructive",
  degraded: "outline",
  unknown: "outline",
};
