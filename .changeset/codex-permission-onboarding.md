---
"executor": patch
"@executor-js/plugin-mcp": patch
---

Explain macOS permissions for Codex plugins instead of failing with an opaque
error. A refused grant used to surface as `Internal tool error [id]` — the
plugin reports "Unknown error" and only a numeric code says what happened, so
neither the user nor the model could tell that macOS was the blocker.

The bridge now recognises those codes and answers with the grant to enable and
where to find it. Each plugin's add screen also states what macOS will ask for
before anything runs, with a link straight to the right Privacy pane — macOS
asks once, and a dismissed prompt never returns.
