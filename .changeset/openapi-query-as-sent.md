---
"apps": patch
"@executor-js/telemetry": patch
---

OpenAPI tools and the fetch a tool receives now send a query string exactly as built. Commas in
unexploded lists, %20 spaces, slashes and colons are no longer re-encoded as form fields. A
reserved query value containing # is refused, because it would cut the query short.
