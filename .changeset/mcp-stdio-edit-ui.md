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

Persisting a new config now also re-runs discovery on the integration's
connections, for stdio and remote alike. The tool catalog is derived from the
config, so a changed command left the previously discovered tools advertised
until something else refreshed them. Rediscovery is best-effort: a server that
will not dial leaves the saved config in place and lists no tools until it does.
