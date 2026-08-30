---
"executor": patch
"@executor-js/plugin-mcp": patch
---

Adding a Codex plugin no longer asks for anything. `CODEX_HOME` is a path the
scanner already resolved, but it was passed on the channel that makes an
environment variable a credential — so the integration declared it as one, and
a person who reached the connect step was shown a masked field for a value
they should never have to know.

Stdio integrations can now carry non-secret environment as static
configuration, separate from declared secrets. The Codex plugins use it: they
declare no auth, and their connection is created for them.
