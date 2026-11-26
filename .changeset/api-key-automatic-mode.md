---
"@executor-js/mcp-auth": patch
---

API keys at the plain `/mcp` URL now use `automatic` approval mode, as a new
sign-in there does: Executor accepts approvals at once and the agent's own
permission prompt is the check. A URL that names a mode keeps it; add
`?elicitation_mode=model`, `native` or `browser` to have approvals pause.
