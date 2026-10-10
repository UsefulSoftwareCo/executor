---
"apps": patch
"@executor-js/app-cache": patch
---

An app cache lifetime longer than the cache's 7-day retention is shortened to
7 days, taking `staleFor` first, instead of failing the read.
