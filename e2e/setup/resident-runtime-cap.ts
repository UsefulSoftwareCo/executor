// The e2e worker's isolate-wide resident-runtime soft cap
// (MCP_RESIDENT_RUNTIME_SOFT_CAP). One constant with two consumers, the boot
// recipe env (cloud.boot.ts) and the cap-eviction scenario
// (cloud/mcp-session-cap-eviction.test.ts), so they cannot drift apart.
//
// Same squeeze as EXECUTION_RATE_LIMIT_PER_HOUR (execution-limits.ts). It must
// be LOW enough that the cap-eviction scenario can cross it with a bounded
// number of real sessions opened under one identity (prod's 32 is reachable
// but wasteful to open on every run), and HIGH enough that no OTHER cloud
// scenario's incidental concurrent MCP-session count trips it: this is an
// isolate-wide counter, not per-org, and the dev server is shared across the
// whole cloud e2e run (`fileParallelism: false` keeps files serial, but a
// single busy file can still open a double-digit number of sessions before
// any of them idle out). The busiest current file (mcp-protocol.test.ts) opens
// on the order of a dozen sessions across its scenarios; this stays well above
// that with headroom. If a scenario ever incidentally trips a cap eviction (a
// span with `mcp.session.dispose_reason: "cap"` for a session it didn't
// expect), that is not a correctness bug — eviction is designed to be
// transparent, restoring on the next call — but it means this constant needs
// to grow: raise it here, never by special-casing a scenario against it.
export const E2E_MCP_RESIDENT_RUNTIME_SOFT_CAP = 24;
