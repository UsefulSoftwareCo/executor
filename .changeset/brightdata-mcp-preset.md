---
"@executor-js/plugin-mcp": patch
---

**Bright Data joins the well-known MCP preset catalog**

The MCP plugin's preset catalog now includes Bright Data's hosted MCP server
(`https://mcp.brightdata.com/mcp`), exposing 69 tools for web search, page
scraping, structured data extraction, and remote browser automation. The
connection flow authenticates with a Bright Data API token placed in the
server URL's `token` query parameter (the `query` API-key placement, already
supported by the plugin).
