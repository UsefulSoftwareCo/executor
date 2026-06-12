---
"@executor-js/execution": patch
"@executor-js/host-mcp": patch
---

Make paused-execution resume reliable: `resume` is now idempotent (a retried
resume replays the recorded outcome instead of failing with "No paused
execution"), execution ids are globally unique so a rebuilt engine can never
re-mint an id a stale client still holds, pauses abandoned by a dead sandbox
are dropped and their terminal outcome kept for late resumes, and an expired
or lost pause now returns recovery guidance (re-run execute) instead of a bare
miss.
