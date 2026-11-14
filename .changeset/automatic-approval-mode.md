---
"@executor-js/mcp": patch
"@executor-js/mcp-auth": patch
"@executor-js/ui": patch
"@executor-js/app-templates": patch
---

New `automatic` approval mode. Executor approves tool calls at once, and the
agent's own permission prompt for `call` or `execute` is the check. Questions a
running tool asks still reach the agent, as in `model` mode. The sign-in page
now preselects it for the plain `/mcp` URL, on hosted and local; local's
sign-in page now offers the approval choice too. Existing grants keep their
mode, and personal access tokens still use `model` mode at the plain URL. Use
`?elicitation_mode=automatic` to choose it with a token.
