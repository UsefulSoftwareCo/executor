# Open Agents + Executor local guide

This workspace combines two systems:

- **Open Agents** — the Next.js app in `apps/open-agents`. It owns auth, sessions, chats, Vercel Sandbox lifecycle, GitHub repo setup, skills, the chat UI, and the agent workflow.
- **Executor** — the integration/tool runtime in `packages/core/*`, `packages/plugins/*`, and `packages/react`. In this setup it is embedded inside Open Agents instead of running as a separate `executor web` process.

The goal is that a user can start an Open Agents session, attach a repository sandbox, configure external tools through Executor, and let the agent use both code tools and configured integration tools in one chat.

## Mental model

A chat turn has three layers:

1. **Open Agents app layer**
   - Routes, settings, sessions, chat UI, persistence, usage accounting, and workflow orchestration live in `apps/open-agents`.
   - The app runs on Next.js and uses Postgres for Open Agents data plus Executor data.

2. **Vercel Sandbox code layer**
   - Repository sessions create or resume a named Vercel Sandbox.
   - The sandbox clones the target GitHub repository, exposes bash/read/write/edit/grep/glob tools, and persists by session name.
   - Empty “New Chat” sessions do not attach a sandbox; repo “Start Session” sessions do.

3. **Executor integration layer**
   - Executor provides configured API/MCP/GraphQL/file-secret tools.
   - The agent calls these through its `executor` tool, which executes TypeScript against a typed `tools` object.
   - Executor is scoped per user and per session, so global personal tools and session-specific tools can coexist.

## Important paths

| Path | Purpose |
| --- | --- |
| `apps/open-agents` | Next.js Open Agents web app |
| `apps/open-agents/lib/chat` | Eve client runtime, message projection, and chat payload adapters |
| `apps/open-agents/lib/agents` | App-owned agent and skill library definitions |
| `packages/open-agents/sandbox` | Vercel Sandbox adapter and Git helpers |
| `apps/open-agents/lib/executor` | Embedded Executor config, runtime, schema, and API bridge |
| `apps/open-agents/app/settings/executor` | Personal Executor admin UI |
| `apps/open-agents/app/sessions/[sessionId]/executor` | Session-scoped Executor admin UI |
| `packages/core/*` | Executor SDK, API, execution engine, storage, config |
| `packages/plugins/*` | Executor source/secret plugins |
| `packages/react` | Reusable Executor admin UI components embedded by Open Agents |

## Local services

Use devstack from the repo root:

```bash
devstack up
```

The `app` stack in `devstack.toml` starts:

- Postgres on `127.0.0.1:54329`
- Redis on `127.0.0.1:63799`
- Open Agents web on port `3000`

The web command is:

```bash
bun run db:migrate:apply && bun run dev --hostname 0.0.0.0 --port $PORT
```

Useful commands:

```bash
devstack status
devstack logs web --follow --no-noise
devstack logs web --last 200 --no-noise
curl -sS http://pi:3000/api/health
```

Use `http://pi:3000` for browser testing. It goes through the devstack-facing host and matches the URLs emitted in logs. Avoid accidentally testing other devstack apps such as `localhost:5173`.

## Environment and auth

Devstack injects the service env from `devstack.toml`:

```toml
POSTGRES_URL = "postgres://open_agents:open_agents@127.0.0.1:54329/open_agents"
REDIS_URL = "redis://127.0.0.1:63799"
OPEN_AGENTS_RESOURCE_PROFILE = "hobby"
OPEN_AGENTS_AUTH_MODE = "local"
OPEN_AGENTS_GITHUB_AUTH_MODE = "gh-cli"
GH_CLI_PATH = "/snap/bin/gh"
```

Local auth mode signs you in as a local user. GitHub repo access uses the local GitHub CLI session. Check it with:

```bash
gh auth status
```

Vercel Sandbox needs local Vercel OIDC. This app is linked to the Augment Vercel project `openagents` in `apps/open-agents/.vercel/project.json`. Pull a development OIDC token with:

```bash
bunx vercel whoami
bunx vercel env pull .env.local --cwd apps/open-agents --yes
```

`VERCEL_OIDC_TOKEN` expires after roughly 12 hours. If sandbox creation starts failing with an OIDC/local context error, pull env again.

The app also expects model credentials such as `ANTHROPIC_API_KEY` in the normal Next.js env files under `apps/open-agents`.

## How an agent turn works

1. The user sends a chat message.
2. `apps/open-agents/app/sessions/[sessionId]/chats/[chatId]/hooks/use-session-chat-runtime.ts` runs the browser Eve session with `useEveAgent`.
3. Eve streams message and tool events directly to the UI while the app persists event patches through `/api/sessions/:sessionId/chats/:chatId/eve`.
4. Server routes hydrate chats from `eve_chat_events` plus `eve_chat_session_states`; the legacy message table and chat workflow runner are gone.
5. If the session has `cloneUrl` or workspace repos, `resolveChatSandboxRuntime` in `chat-sandbox-runtime.ts`:
   - verifies GitHub access,
   - mints short-lived clone credentials when needed,
   - creates or resumes the named Vercel Sandbox,
   - writes sandbox state back to the session,
   - installs global and bundled skills,
   - discovers skills from the sandbox.
6. Eve runs the agent session and emits text, reasoning, authorization, and dynamic tool parts.
7. Executor remains available through the app-owned Eve executor endpoint for configured API/MCP/GraphQL/file-secret tools.
8. The UI streams tool calls and assistant text. When the turn completes, Eve session state is persisted, sandbox activity is refreshed, and optional auto-commit / auto-PR work runs from the completed turn.

## Executor inside Open Agents

Executor is embedded through `apps/open-agents/lib/executor/runtime.ts`.

The Open Agents API route:

```text
/api/executor/**
/api/executor/session/:sessionId/**
```

forwards requests into an in-process Executor HTTP handler. The same plugin set is used by both the admin UI and the agent tool runtime:

```ts
openApiHttpPlugin()
mcpHttpPlugin({ dangerouslyAllowStdioMCP: false })
graphqlHttpPlugin()
fileSecretsPlugin({ directory: ".open-agents-executor" })
```

### Scopes

Executor scopes keep personal tools separate from session tools.

| Scope | ID shape | Where to configure |
| --- | --- | --- |
| Personal | `open-agents:user:<userId>` | `/settings/executor` |
| Session | `open-agents:session:<sessionId>` | `/sessions/<sessionId>/executor` |

During a session agent turn, the runtime includes both scopes. Session tools are the current scope; personal tools are also available through the scope stack.

### Configure tools manually

Personal tools:

1. Open `http://pi:3000/settings/executor`.
2. Use **Sources** to add an OpenAPI, MCP, or GraphQL source.
3. Use **Connections** and **Secrets** for credentials.
4. Use **Policies** to constrain tool use.
5. Use **Tools** to verify discovery and schemas.

Session-specific tools:

1. Open a session.
2. Click the tools/wrench entry in the session header, or navigate to `/sessions/<sessionId>/executor`.
3. Add sources exactly as above. These tools are tied to that session.

MCP stdio sources are intentionally disabled in the web app. Use remote HTTP/SSE MCP sources for Open Agents.

### How the agent uses Executor

The model gets an `executor` tool. It should not call external APIs with raw `fetch`; it should execute TypeScript against configured Executor tools:

```ts
const { items: matches } = await tools.search({
  query: "linear issue",
  limit: 12,
});
const path = matches[0]?.path;
if (!path) return "No matching tools found.";
const detail = await tools.describe.tool({ path });
return { path, input: detail.inputTypeScript };
```

Good manual prompt:

```text
Use the executor tool to list the configured sources and summarize which tools are available. Do not call any write tools.
```

## Skills

Skills are instructions, not API integrations. They live inside the Vercel Sandbox and are discovered before the model call.

Open Agents scans:

- `<sandbox workspace>/.claude/skills/*/SKILL.md`
- `<sandbox workspace>/.agents/skills/*/SKILL.md`
- `<sandbox home>/.agents/skills/*/SKILL.md`

A skill file looks like:

```md
---
name: my-skill
description: What this skill helps with
---

# Instructions
Use these steps...
```

The agent system prompt only gets skill names and descriptions. When the model uses the `skill` tool, Open Agents reads the full `SKILL.md`, strips the frontmatter, prepends the skill directory, substitutes `$ARGUMENTS`, and returns the instructions to the model.

### Global skills

Configure global skills in `/settings/preferences` under **Skills**. The UI stores refs like:

```text
source: vercel/ai
skill: ai-sdk
```

For each new sandbox setup, Open Agents installs them with:

```bash
npx skills add <owner/repo> --skill <skill-name> --agent amp -g -y --copy
```

Repo skills with the same name take precedence over global skills.

### Slash commands

Once a sandbox exists, the chat UI fetches `/api/sessions/<sessionId>/skills` and shows `/skill-name` suggestions. `user-invocable: false` hides a skill from slash suggestions but still lets the model use it automatically. `disable-model-invocation: true` prevents the model from invoking it.

`allowed-tools`, `context`, and `agent` frontmatter are parsed and cached, but the current implementation only enforces user/model invocation flags.

## Manual testing with agent-browser

Use `agent-browser` when testing the real UI. If Chrome is already open with remote debugging, connect to that browser and stay in the same tab/session:

```bash
agent-browser connect 9222
agent-browser tab
agent-browser tab 1
agent-browser open http://pi:3000/sessions
agent-browser snapshot -i
```

Do not spawn a second browser session unless you intentionally want isolated cookies/storage.

Common commands:

```bash
agent-browser snapshot -i
agent-browser click @e8
agent-browser fill @e38 "Read the code in this repo and summarize the package layout. Do not edit files."
agent-browser press Enter
agent-browser wait 5000
agent-browser get url
agent-browser errors
agent-browser console
```

### End-to-end repo sandbox smoke test

1. Open sessions:

   ```bash
   agent-browser open http://pi:3000/sessions
   agent-browser snapshot -i
   ```

2. Click **New Session**.
3. Choose **Start Session** and select a GitHub repo, or use the remembered repo if the dialog already has one.
4. Start the session.
5. In the chat input send:

   ```text
   Please read the code in this repo and summarize what files/packages you see. Do not edit any files.
   ```

6. Expected result:
   - UI shows `Setting up the workspace...` on the first repo turn.
   - The agent runs read-only tools such as `bash`, `glob`, `grep`, or `read`.
   - The assistant returns a repo/package summary.
   - The diff view remains empty.

Verify from the database if needed:

```bash
docker exec executor-postgres-1 psql -U open_agents -d open_agents \
  -c "select title, repo_owner, repo_name, lifecycle_state from sessions order by created_at desc limit 5;"

docker exec executor-postgres-1 psql -U open_agents -d open_agents \
  -c "select chat_id, event_type, stream_index from eve_chat_events order by created_at desc limit 5;"
```

### Executor smoke test

1. Add or verify a source in `/settings/executor`.
2. Open a chat session.
3. Send:

   ```text
   Use the executor tool to search configured tools for <intent>. Describe the best matching tool and its input schema. Do not call it.
   ```

4. Expected result:
   - The assistant calls `executor`.
   - The tool output includes structured Executor results.
   - No sandbox file diff is produced unless the prompt asked for code edits.

### Skills smoke test

1. Add a repo skill to the target repository at `.agents/skills/<name>/SKILL.md`, or configure a global skill in `/settings/preferences` before creating the session.
2. Create or resume a repo session so the sandbox exists.
3. Type `/` in the chat input.
4. Expected result:
   - The slash command dropdown lists user-invocable skills.
   - Sending `/skill-name ...` causes the first model tool call to be `skill`.

Force-refresh discovered skills:

```bash
curl -sS "http://pi:3000/api/sessions/<sessionId>/skills?refresh=1"
```

## Code-level checks

Run focused checks from the repo root:

```bash
bun run --cwd apps/open-agents typecheck
bun run --cwd packages/open-agents/sandbox typecheck
```

Run targeted Bun tests by file:

```bash
bun test apps/open-agents/app/api/sessions/route.test.ts
bun test apps/open-agents/app/api/sandbox/route.test.ts
bun test packages/open-agents/sandbox/vercel/sandbox.test.ts
```

The full repo also supports:

```bash
bun run typecheck
bun test
```

Use targeted checks while iterating; the full workspace can be slow.

## Troubleshooting

### Sandbox create fails with Vercel OIDC/local context errors

Refresh the local development token:

```bash
bunx vercel env pull .env.local --cwd apps/open-agents --yes
```

Confirm the app is linked:

```bash
cat apps/open-agents/.vercel/project.json
```

### GitHub repo access fails

Check local GitHub auth:

```bash
gh auth status
```

Devstack uses `OPEN_AGENTS_GITHUB_AUTH_MODE=gh-cli` and `GH_CLI_PATH=/snap/bin/gh`. Repo access is still verified before minting sandbox clone credentials.

### Agent-browser clicks do nothing

Use the app host at `http://pi:3000`, refresh the page, then take a new snapshot before clicking. Refs are invalid after navigation or reload.

```bash
agent-browser open http://pi:3000/sessions
agent-browser snapshot -i
```

### Skills do not show up

- The sandbox must exist first.
- The skill must be under `.claude/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md`, or global `$HOME/.agents/skills/<name>/SKILL.md` in the sandbox.
- Frontmatter must include `name` and `description`.
- Refresh `/api/sessions/<sessionId>/skills?refresh=1`.

### Executor tools do not show up

- Check whether you configured personal tools (`/settings/executor`) or session tools (`/sessions/<sessionId>/executor`).
- Inspect **Sources** and **Tools** in the Executor UI.
- Check auth in **Connections** and **Secrets**.
- Remember stdio MCP is disabled; use remote MCP.

### Need to inspect raw data

Postgres is available through Docker:

```bash
docker exec -it executor-postgres-1 psql -U open_agents -d open_agents
```

Executor secret files live under:

```text
apps/open-agents/.open-agents-executor
```

Do not commit local env files, `.vercel`, or `.open-agents-executor`.
