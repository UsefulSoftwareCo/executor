---
"@executor-js/plugin-mcp": patch
---

The MCP liveness probe now takes the invocation pool's connection instead of dialling a second one. A probe of a local stdio server previously started a second child process, and the common local servers permit one instance only — Chrome DevTools MCP owns a browser and a debug port, Playwright MCP the same, `docker run -i` a container. The second child could not start, so the health check reported the connection broken while the server was up and serving tool calls. Because the UI re-probes every non-healthy verdict on every mount, each page load started one more child. A probe now reuses the pooled session or child, and an interrupted probe still tears down whatever it acquired.
