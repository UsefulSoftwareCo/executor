---
"executor": patch
---

Help, `executor apps`, the tool commands such as `executor search` and `executor call`, and
`executor service` start faster: each command now loads only the code it runs, instead of loading
the local server first. In the release executable a command starts about 0.3 seconds sooner. The
server itself starts as before. Commands, their output and their exit codes are unchanged.
