// The user-facing messages a blocked execution surfaces to the MCP client, kept
// in their own Cloudflare-free module so the e2e suite can import them as
// ground truth without pulling the guards' `cloudflare:workers` dependencies
// into its (worker-types-free) typecheck. The guard modules re-export these, so
// production call sites are unchanged.

export const EXECUTION_LIMIT_BLOCKED_MESSAGE =
  "Execution limit reached: your plan's included executions for this billing period are used up. Upgrade your plan or wait for the reset to continue.";

export const RATE_LIMIT_BLOCKED_MESSAGE =
  "Rate limit exceeded: too many executions this hour. This is an abuse backstop — contact support if you hit this legitimately.";
