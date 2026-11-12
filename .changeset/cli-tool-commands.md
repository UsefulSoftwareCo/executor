---
"@executor-js/local-server": patch
"@executor-js/app-management": patch
"@executor-js/app-templates": patch
"@executor-js/hosted-cloud": patch
---

The `executor` CLI calls your tools from a shell. `executor login` signs in to hosted Executor, or
another host with `--host`, with a code approved in the browser; `executor logout` and
`executor whoami` sign out and show what the sign-in reaches. `executor search`, `describe`,
`call`, `execute`, `resume` and `skills` call the MCP tools of the same name and print JSON, and
`executor mcp` serves them to MCP clients over stdio, opening a new host session when the host
forgets its own. Client commands use `--host`, then
`EXECUTOR_HOST`, then the host signed in to last, then the local background Executor;
`executor apps login` now defaults to hosted Executor and is remembered too. Hosted Executor's API
host names its MCP endpoint, so `executor login` works with its default host.

`executor pair` and `executor rotate-key` move to `executor service pair` and
`executor service rotate-key`. `executor apps skills` is replaced by `executor skills`. Executor 1
command names no longer print a replacement; they are unknown commands.
