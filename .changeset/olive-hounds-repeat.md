---
"@executor-js/pi": minor
---

Add `@executor-js/pi`, a first-party extension that connects the Pi coding agent to Executor.

Pi ships no MCP client, so Pi users previously needed a third-party bridge to reach Executor. This package registers Executor's core tools — `executor_execute`, `executor_skills`, and `executor_resume` — as native Pi tools and forwards each call over MCP.

Install it with `pi install npm:@executor-js/pi`, then point it at Executor with `EXECUTOR_MCP_URL` and a bearer: `EXECUTOR_API_KEY` for a hosted Executor, or `EXECUTOR_AUTH_TOKEN` for a local or desktop one. `/executor` reports the resolved endpoint and checks the connection.
