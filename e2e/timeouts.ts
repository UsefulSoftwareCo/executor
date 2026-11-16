/**
 * How long a scenario, and each of its hooks, may run before Vitest stops it.
 *
 * This is a hang detector, not a performance bound. It is sized for CI's runners, which do the same
 * work up to about three times slower on weekday afternoons than at night or at weekends, on every
 * runner size. Of 24 scenarios that timed out at the earlier 60 s in a week of CI (9-16 Nov), 18 were
 * explained by a slow runner and passed easily at normal speed; 120 s covers them all. A healthy
 * scenario should never reach it. A scenario that does has hung, or is on a slow path to diagnose,
 * and its failure says how fast the machine was then (support/machine-speed.ts, lifecycle.ts).
 *
 * Speed has its own assertions, calibrated to the machine where needed (the catalog-scale search
 * budget). A product that got slower everywhere is theirs to notice, not this.
 */
export const scenarioTimeoutMs = 120_000;
export const hookTimeoutMs = 120_000;
