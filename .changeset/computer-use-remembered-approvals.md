---
"@executor-js/sdk": patch
"@executor-js/execution": patch
"@executor-js/plugin-mcp": patch
"@executor-js/api": patch
"@executor-js/react": patch
"@executor-js/host-mcp": patch
"@executor-js/cloudflare": patch
"executor": patch
---

Carry an approval's persistence choice through elicitation, so Codex Computer Use stops asking to use the same app on every call.

Computer Use offers `persist: ["session", "always"]` in the prompt's terms and remembers the app only when the answer names one. Executor dropped the offer on the way in (the terms projection kept strings only) and the choice on the way out (every adapter rebuilt the reply from `action` and `content`), so each accept was one-time. `ElicitationResponse` now has `meta.persist`; the MCP plugin, the app-server bridge, and the MCP host pass it through; the model-mode `resume` tool and the browser approval page let the approver pick from the offered scopes. Nothing is chosen automatically: a bare accept still approves once.
