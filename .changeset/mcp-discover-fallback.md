---
"executor": patch
---

keep `executor mcp` connections open when clients probe the unsupported `server/discover` method, allowing them to fall back to the legacy `initialize` handshake.
