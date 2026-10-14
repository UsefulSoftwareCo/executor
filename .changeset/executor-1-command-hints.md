---
"@executor-js/local-server": patch
---

Executor 1 commands such as `executor web`, `executor daemon run`, `executor service install`,
`executor mcp` and `executor server list` now name the Executor 2 command to run instead of failing
as unknown subcommands or suggesting `serve`, including with Executor 1 flags such as
`executor web --foreground`. They stay out of `--help` and typo suggestions.
