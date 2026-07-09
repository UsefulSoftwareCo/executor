---
"executor": patch
---

Explain 401s from a hosted server as a sign-in problem with the exact `executor login` command to run, instead of surfacing a raw decode error. `executor login` now defaults to https://executor.sh when no server is specified, and profile plumbing stays out of messages unless you address servers by name.
