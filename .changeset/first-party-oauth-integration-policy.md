---
"@executor-js/sdk": patch
"@executor-js/react": patch
---

Enforce optional first-party OAuth integration allow-lists in client selection, authorization start, and callback completion. Restrict the cloud GitHub App to its configured GitHub REST integration so shared OAuth endpoints cannot silently select it for GitHub MCP. Existing credentials continue to refresh; other integrations can use their own OAuth app.
