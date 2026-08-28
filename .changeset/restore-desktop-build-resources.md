---
"executor": patch
---

Desktop: restore the macOS signing entitlements and app icon that were accidentally removed from the build inputs, and fail fast at PR time and before publishing when any configured build resource is missing. The v1.6.1 desktop build could not be signed; this release supersedes it.
