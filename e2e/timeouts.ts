/**
 * How long a scenario, and each of its hooks, may run before Vitest stops it.
 *
 * The fork retains its 60-second scenario and hook limits. Upstream raised its hang detector
 * to 120 seconds for slow CI runners; this reconciliation does not extend deadlines to make
 * scenarios pass. A failure still records the machine's speed for diagnosis
 * (support/machine-speed.ts, lifecycle.ts).
 *
 * Speed has its own assertions, calibrated to the machine where needed (the catalog-scale search
 * budget). A product that got slower everywhere is theirs to notice, not this.
 */
export const scenarioTimeoutMs = 60_000;
export const hookTimeoutMs = 60_000;
