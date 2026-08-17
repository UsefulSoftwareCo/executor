---
"executor": patch
---

**Fix: native MCP elicitation now reaches clients on the local HTTP endpoint instead of timing out**

The local daemon's Streamable HTTP transport ran with `enableJsonResponse: true`, which buffers a `tools/call` into a single JSON body and leaves no open stream for the server to write on. A server-to-client `elicitation/create` raised during that call was therefore never delivered, and approval-gated tools failed with a `-32001` request timeout even though the session had negotiated `elicitation_mode=native` and the client's `elicitation.form` capability. The transport now uses the spec-default SSE streaming, so the reverse request rides the originating tool call's stream — matching the Cloudflare host's behaviour.
