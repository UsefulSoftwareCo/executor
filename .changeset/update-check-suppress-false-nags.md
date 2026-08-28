---
"executor": patch
---

**Fix: stop the update check from claiming a newer version is available on builds it cannot compare**

A build stamped with the placeholder 0.0.0 version always compared as older
than the latest release, and a prerelease on a channel with no matching
dist-tag (rc, alpha, and similar) always lost the comparison too. Both cases
now short-circuit to "no update available" before the check reaches the
registry.

This applies wherever the update check runs, so the CLI check and the sidebar
update card both stop showing an update prompt that a user could never act on.
