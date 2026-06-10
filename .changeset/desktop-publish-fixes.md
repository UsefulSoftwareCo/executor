---
"executor": patch
---

Desktop packaging follow-ups from the v1.5.2 release run:

- Fixed the Intel mac desktop build failing in CI (the cross-target dependency install was being glob-expanded by the shell).
- Fixed the first-launch data migration on Windows: renaming the previous database file could hit a transient `EBUSY` while the just-closed SQLite handle was released, so the move now retries briefly instead of failing startup.
