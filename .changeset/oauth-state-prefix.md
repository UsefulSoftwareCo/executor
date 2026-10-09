---
"@executor-js/sdk": patch
---

OAuth options take a `statePrefix`, put before the random part of every sign-in's
`state`, so a proxy in front of a shared callback URL can route a host's callbacks
without a lookup.
