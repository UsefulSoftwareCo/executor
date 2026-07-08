---
"executor": patch
---

Throw a guidance error when sandbox code enumerates the `tools` proxy (`Object.keys`, spread, `for...in`) instead of returning an empty list, pointing agents at `tools.search()`.
