---
"@executor-js/plugin-mcp": patch
---

**The add-MCP form stops dialling the server URL while it is still being typed**

The Server URL field auto-probes the endpoint after a 400ms pause. The only condition on that probe was that the trimmed value was non-empty, so every pause in typing dialled whatever was in the field: "h", "http://", the "a" in "http://a". Each of those probes failed, and the field dropped into a loading state and then an error with a retry button, for a value the user never meant to submit.

The probe now runs only when the value looks like a finished endpoint: it parses as a URL, its scheme is http or https, and its hostname is either a local development host or has a dot with a label on each side. The debounce is unchanged, so a completed URL is still probed without the user having to submit.

A probe that is superseded is also no longer allowed to answer. The field could previously report the outcome of a request for a URL that had since been edited, because each probe dispatched its result unconditionally. Editing the URL now invalidates any probe already in flight, and its reply is discarded rather than applied to the current value.
