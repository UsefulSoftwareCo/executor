---
"executor": patch
---

**Saved integrations come back after an upgrade left an OAuth expiry in the old number format**

Some installs lost every saved integration from the MCP gateway at once. The credentials were never deleted — the gateway simply could not read the table they live in, so it served an empty tool list and restarting did not help.

The `connection.expires_at` column records when an OAuth access token expires. It used to be a plain number; it now holds the value's digits, because a millisecond timestamp is larger than a 32-bit integer. SQLite does not rewrite rows when a column's type changes, so a connection saved by an older build still held the old form. Reading one back failed, and because the failure happened while mapping the row, it failed the whole query rather than that one field — one stale row was enough to hide every integration.

A boot-time migration now converts those values to the current form. It runs before anything reads the table, so the integrations are back on the first restart after upgrading. It only touches values still in the old numeric form: rows already written by a current build are left exactly as they are, and it runs once.
