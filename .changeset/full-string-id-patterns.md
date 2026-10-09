---
"@executor-js/sdk": patch
"@executor-js/mcp": patch
---

Advertise ID patterns that match the whole string, such as `^dpl_[\s\S]+$`, in MCP tool schemas. Validators that apply `pattern` as a full match, including the OpenAI connector used by Codex, now accept the deployment, profile and request IDs that Executor returns. Server-side ID validation is unchanged.
