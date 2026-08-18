---
"@executor-js/plugin-mcp": patch
"@executor-js/plugin-openapi": patch
---

**Cloudflare ships as MCP-only, with code mode opted out**

The Cloudflare OpenAPI preset is gone from the default catalog; the MCP preset is the one Cloudflare entry. Its endpoint now pins `?codemode=false` because Cloudflare's MCP server otherwise hides the tool catalog behind a single code-execution tool, and executor already provides the code-execution surface. Hand-entered `mcp.cloudflare.com` URLs missing the opt-out get an inline warning in the add flow telling the user to append `?codemode=false`.
