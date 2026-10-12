// How often the e2e worker's resident MCP sessions re-read their org's move to
// v2 (MCP_V2_MOVED_RECHECK_MS; production waits five minutes). One constant
// with two consumers, the boot recipe env (cloud.boot.ts) and the v2-moved
// scenario (cloud/v2-moved-notice.test.ts), so they cannot drift apart. Short
// enough for a scenario to wait out, and well under the e2e idle timeout, so a
// session that is still resident re-reads instead of being restored.
export const E2E_MCP_V2_MOVED_RECHECK_MS = 1_000;
