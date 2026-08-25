---
"@executor-js/plugin-mcp": patch
---

**Interrupted stdio dials no longer strand the spawned child process**

Cancelling an in-flight health check or tool discovery (a UI refresh aborting the request, or the 15s discovery timeout) abandoned the MCP connect handshake without closing the transport, leaving the spawned stdio child running indefinitely: for `docker run -i --rm` integrations, one stranded container per interrupted dial. The connect handshake now aborts on interruption (the SDK closes the transport, ending stdin and escalating to SIGTERM/SIGKILL), and tool discovery closes the connection even when the interrupt lands between the handshake completing and discovery starting.
