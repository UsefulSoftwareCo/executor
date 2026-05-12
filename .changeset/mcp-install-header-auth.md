---
"executor": patch
---

`McpInstallCard` emits Basic auth via a `--header 'Authorization: Basic …'` flag on the generated `npx add-mcp` command instead of embedding `executor:<password>@` credentials in the URL. The desktop's local HTTP MCP endpoint is no longer a wall of base64 stuck into a hostname; the install command reads as a plain `http://127.0.0.1:<port>/mcp` URL with a separate header line.
