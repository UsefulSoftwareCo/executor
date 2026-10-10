---
"@executor-js/app-templates": patch
---

The app-authoring skill lists app SQL's Durable Object limits, including 100
bound values per statement and the `json_each(?)` pattern for long lists, the
app cache's retention and size limits, and the deadlines that bound a call. It
checks conditional writes with `rowsWritten > 0`, since index writes count.
