---
"executor": patch
---

**Stdio MCP integrations can be edited from the UI**

The integration Edit sheet showed stdio servers as read-only text and told you
to remove and recreate the integration to change its command. Fixing a typo in
an argument, moving a server to a new path, or adding a static environment
variable meant editing `executor.jsonc` by hand, or losing the integration's
connections and tool policies to a delete-and-re-add.

The sheet now edits the command, its arguments, the working directory, and the
declared environment map, staged and applied by the sheet's own Save like the
remote editor beside it. Arguments use the same quote-aware parsing as the add
flow, so an argument containing spaces survives a round trip.

The environment field edits the DECLARED static variables only. A stdio server
receives those plus a small fixed base set — it does not inherit executor's
environment — and secret values still belong to the connection, entered per
account against the server's declared `stdio_env` method.

Saving revises the integration config, which is already enough to rebuild the
tool catalog: connections whose catalog predates the revision re-list on their
next read, so an edited command's tools are correct without an explicit
refresh.
