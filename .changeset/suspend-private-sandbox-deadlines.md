---
"@executor-js/runtime-dynamic-worker": patch
"@executor-js/runtime-deno-subprocess": patch
---

Suspend sandbox execution deadlines while tool calls await the host, and reset the autonomous-compute budget after each dispatch returns.
