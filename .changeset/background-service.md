---
"@executor-js/local-server": minor
"@executor-js/app-management": patch
"@executor-js/desktop": minor
"@executor-js/app-templates": patch
---

`executor` now starts one background Executor per data directory, shared by the command line,
`executor apps` and the desktop app, and exits once the dashboard opens; the background Executor
runs until `executor service stop`. `executor service` starts, stops and configures it, and
`executor upgrade` stops it and starts it again on the new version. `executor apps` commands
without `--host` or `EXECUTOR_HOST` use it and need no API key, as the app-authoring skill now says.
Executor 1's `executor service install` and `executor service uninstall` name what to run instead.

Executor desktop no longer runs its own server: it starts or joins the same background Executor and
uses the command line's data directory, `~/.executor/v2/cli`. Its first launch moves the data of an
earlier desktop release there, once. Command-line data already in that directory, with its apps and
accounts, moves to `~/.executor/v2/backups/cli-data-<time>`, which the desktop names; nothing is
merged or deleted. The command line's settings carry over, except its port and the `env` variables
that belong to the replaced data, and the desktop says which changed.
