---
"@executor-js/sdk": patch
"@executor-js/ui": patch
"@executor-js/app-templates": patch
---

The OAuth setup check returns `userScopes` for Slack's `user_scope`, and the connect step shows how many permissions sign-in requests. MCP discovery without declared scopes still requests what the Bearer challenge names; for wider access, declare scopes on the provider, deploy, and connect a new account without `account`.
