// The e2e worker's per-org hourly execution cap (EXECUTION_RATE_LIMIT_PER_HOUR).
// One constant with two consumers, the boot recipe env (cloud.boot.ts) and the
// rate-limit backstop scenario (cloud/mcp-execution-limits.test.ts), so they
// cannot drift apart.
//
// Picking the value is a squeeze from both sides. It must be LOW enough that
// the backstop scenario can exhaust it with real sequential executions (prod's
// 1000/hour cannot be reached in a test), and HIGH enough that no other
// scenario trips it: the counter is per organization and every `execute` a
// scenario runs counts against its org, so this must exceed the busiest
// single-org scenario's execute count (currently toolkits-mcp at ~8) with
// comfortable headroom. If a scenario ever fails with the rate-limit backstop
// message, it outgrew this cap: raise it here, never in the boot env alone.
export const E2E_EXECUTION_RATE_LIMIT = 20;

// The e2e worker's counter-check budget (EXECUTION_RATE_LIMIT_CHECK_TIMEOUT_MS),
// same two consumers as the cap above.
//
// This exists to make the OVERRIDE ITSELF observable end to end. The budget is
// stamped on the `rate_limit.check` span, so a value that differs from the
// compiled-in default (RATE_LIMIT_CHECK_TIMEOUT_MS = 2000) is the difference
// between "the worker read the env var" and "the worker fell back to the
// constant and nobody noticed". A knob nothing reads is worse than no knob.
//
// It is deliberately LONGER than the default, not shorter: a shorter budget
// would time the check out and fail open on every execution, which would take
// the backstop scenario down with it. Longer only means a genuinely wedged
// counter stalls an execution 3s instead of 2s, which no scenario depends on.
export const E2E_EXECUTION_RATE_LIMIT_CHECK_TIMEOUT_MS = 3000;
