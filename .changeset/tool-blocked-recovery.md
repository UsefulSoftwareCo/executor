---
"@executor-js/sdk": patch
"@executor-js/hosted-web": patch
"@executor-js/local-web": patch
---

Explain calls an app's approval policy denies. MCP `execute` returned only `ToolBlocked`; it now
says the app's policy refused the call, not to retry it unchanged, to meet what the policy
requires or change it with the user's agreement, or to use another tool. The hosted and local dashboard tool runners show the same explanation.
