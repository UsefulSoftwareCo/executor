---
"@executor-js/plugin-mcp": patch
"@executor-js/plugin-openapi": patch
---

**Supabase joins the well-known integration catalogs**

The MCP plugin's preset catalog now includes Supabase's hosted MCP server
(`https://mcp.supabase.com/mcp`, OAuth-authenticated) for Postgres queries,
auth, storage, edge functions, and project management. The OpenAPI plugin's
catalog additionally includes the Supabase Management API
(`https://api.supabase.com/api/v1-json`, access-token auth) for projects,
organizations, databases, and billing. Both endpoints are already exercised by
the plugin's probe/health-check paths.
