---
"@executor-js/host-selfhost": patch
"executor": patch
---

Repair connections that an older build saved with an empty string instead of NULL in a JSON column. Reading one back threw while mapping the row, so every toolkit MCP endpoint failed `initialize` with an internal error. A boot-time migration now sets those empty strings to NULL in every nullable JSON column the schema declares. It runs once, and rows written by a current build are left exactly as they are.
