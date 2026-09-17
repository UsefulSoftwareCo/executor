---
"executor": patch
---

**Fix: an MCP server refusing a tool call with a 4xx HTTP response (for example Stripe's `422` when `stripe_context` is missing) surfaced as `Internal tool error [id]`.** When the body is a JSON object naming the problem, the call now returns a typed `mcp_tool_error` failure with the server's message and status, so the model can fix the arguments instead of reading an outage.
