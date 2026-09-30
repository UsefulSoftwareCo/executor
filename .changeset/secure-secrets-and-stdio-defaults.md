---
"@executor-js/local-app": patch
"@executor-js/plugin-keychain": patch
"@executor-js/api": patch
---

fix: prefer the OS keychain for secrets, disable stdio MCP by default, and log approval-record failures

- The local app now registers the keychain credential provider before the file
  store, so minted OAuth tokens land in the OS keychain on platforms where it
  is durable (macOS/Windows). On headless/Linux hosts where the keychain probe
  fails, the file store remains the effective default — behavior is unchanged
  there, and a new `describeKeychainAvailability()` helper encodes the platform
  truth that drives the ordering.
- `dangerouslyAllowStdioMCP` now defaults to `false` in the shipped local
  config. Stdio MCP servers spawn local subprocesses; enabling the flag
  explicitly is required for trusted local contexts, and the MCP plugin
  already rejects stdio connections with a clear error when disabled.
- Approval-record persistence failures (the best-effort durable record behind
  artifact approvals) are no longer swallowed silently: the failure cause is
  captured through the host's error-capture channel so operators can see when
  the restart-recovery fallback degrades. Execution behavior is unchanged.
