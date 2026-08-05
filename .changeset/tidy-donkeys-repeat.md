---
"executor": patch
"@executor-js/local": patch
---

Report the real product surface and version in the integrations.sh registry user-agent. The daemon previously sent `local` with a version frozen at 1.4.4; it now reports `cli` or `desktop` (matching analytics surfaces) and `@executor-js/local` is versioned with the release train.
