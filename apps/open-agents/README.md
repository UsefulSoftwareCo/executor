# Open Agents app

This app is the Open Agents web surface for the combined Open Agents + Executor setup.

The full local guide lives at the repository root: [`../../README.md`](../../README.md). It covers:

- how devstack runs the app, Postgres, and Redis;
- Vercel Sandbox and GitHub local auth requirements;
- how Open Agents sessions, sandboxes, skills, and agent turns work;
- how Executor is embedded for personal and session-scoped tools;
- how to configure OpenAPI, MCP, GraphQL, secrets, connections, and policies;
- manual UI testing with `agent-browser`.

Quick start from the repo root:

```bash
devstack up
agent-browser open http://pi:3000/sessions
```

Useful app-local checks:

```bash
bun run --cwd apps/open-agents typecheck
bun test apps/open-agents/app/api/sessions/route.test.ts
bun test apps/open-agents/app/api/sandbox/route.test.ts
```
