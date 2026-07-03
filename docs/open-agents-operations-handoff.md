# Open Agents Operations Handoff

This repo is a proof-of-concept merge of Executor and Vercel Open Agents, now rebuilt around Eve and Vercel Services. Treat the code as clay. Do not add compatibility bridges or type shims unless a user explicitly asks for them. Delete stale code and replace it with the library primitive that owns the behavior.

The production app is:

- Stable URL: `https://openagents-one.vercel.app`
- Vercel project: `openagents`
- Vercel team/context: `goaugment`
- Current known-good deployment from this migration: `dpl_Dg7SUzAA1RoVKp4mMmVQw6qpjez3`
- Current known-good deployment URL: `https://openagents-6ztuukyxa-goaugment.vercel.app`

## Architecture

The deployment is a Vercel Services project. `vercel.json` defines two services:

- `web`: `apps/open-agents`, framework `nextjs`, build command `bun run build`.
- `eve`: `apps/open-agents`, framework `eve`, build command `bun run scripts/verify-eve-vercel-output-patch.ts && eve build && bun run scripts/patch-eve-vercel-output.ts`.

Public routing is:

- `/eve/v1/(.*)` to the Eve service.
- `/.well-known/workflow/(.*)` to the Eve service.
- Everything else to the Next.js web service.

The Next config wraps the app with `withBotId`, `withWorkflow`, and `withEve` in `apps/open-agents/next.config.ts`. The Eve max-duration patch in `apps/open-agents/scripts/patch-eve-vercel-output.ts` is important. It patches the generated Eve function configs to `maxDuration: 300`; without it, long Slack/sandbox turns time out.

The main source areas are:

- `apps/open-agents/agent/`: Eve-authored agent, channels, tools, instructions, and dynamic capabilities.
- `apps/open-agents/`: Next.js UI, auth, session DB, sandbox APIs, and Eve chat persistence.
- `packages/open-agents/sandbox`: Vercel Sandbox adapter and repo clone logic.
- `packages/plugins/*`, `packages/react`, `packages/core/*`: Executor runtime, plugins, and embedded admin UI.

## Eve Runtime Shape

Use Eve primitives as the source of truth:

- Static agent slots are loaded by file convention from `apps/open-agents/agent/`.
- Dynamic session capabilities use `defineDynamic`.
- UI chat uses `eve/react` and `useEveAgent`.
- Server-side Slack continuation uses `eve/client` `Client`.
- Durable chat state is Eve session state plus Eve stream events persisted in Postgres.

The key DB tables are:

- `sessions`: Open Agents session row, sandbox state, default workspace repos, selected agent.
- `chats`: chat rows inside a session.
- `eve_chat_session_states`: persisted Eve `SessionState` per chat.
- `eve_chat_events`: persisted Eve stream events per chat and stream index.
- `slack_user_links`: Slack user to Open Agents user mapping.
- `slack_thread_sessions`: Slack thread to Open Agents session/chat mapping.

Important implementation files:

- `apps/open-agents/agent/agent.ts`: model, compaction, Eve build externals.
- `apps/open-agents/agent/channels/eve.ts`: web/local/OIDC auth for Eve HTTP requests.
- `apps/open-agents/agent/channels/slack.ts`: Slack app mentions and direct messages.
- `apps/open-agents/agent/lib/open-agents-slack-session.ts`: Slack thread session creation, sandbox init, Eve client turns, DB persistence.
- `apps/open-agents/agent/tools/open_agents_profile.ts`: dynamic tools loaded at `session.started`.
- `apps/open-agents/agent/instructions/open_agents_profile.ts`: dynamic instructions loaded at `session.started`.
- `apps/open-agents/agent/lib/open-agents-profile.ts`: DB-backed agent/skill/tool profile resolution.
- `apps/open-agents/app/sessions/[sessionId]/chats/[chatId]/hooks/use-session-chat-runtime.ts`: browser Eve runtime and persistence queue.
- `apps/open-agents/lib/db/eve-chat-sessions.ts`: Eve state/event persistence helpers.

Dynamic tools and instructions should be resolved at the start of the Eve session. We do not need per-turn mechanics for the normal Open Agents tool set. If an agent's DB-authored definition changes, start a new session.

## Executor Role

Executor is embedded for integration configuration and plugin runtime. It is not the workspace shell. The old path where the model called an executor OpenAPI operation to inspect the sandbox was wrong and caused Vercel SSO HTML responses. Keep workspace inspection on direct Eve workspace tools: `bash`, `glob`, `grep`, `read_file`, `write_file`.

Prefer Eve native connections for new MCP/OpenAPI capabilities when possible:

- Eve MCP connections: `https://eve.dev/docs/connections/mcp`
- Eve OpenAPI connections: `https://eve.dev/docs/connections/openapi`

Keep Executor where we need its UI/config/plugin surface.

The Linear OAuth "Failed to parse auth file" fix is in `packages/plugins/file-secrets/src/index.ts`. File-secret storage is an external persistence boundary. The code rewrites old scoped `auth.json` storage into the current flat provider-item-id storage once; malformed files still fail. Do not add in-app type bridges for stale shapes.

## Default Slack Workspace

Slack-created sessions without an explicit repo URL use the default hook workspace repos from `apps/open-agents/lib/workspace-repos.ts`:

- `GoAugment/augment-web`, branch `staging`, directory `augment-web`.
- `GoAugment/augment-services`, branch `main`, directory `augment-services`.
- `GoAugment/augment-voice`, branch `main`, directory `augment-voice`.

Override with `OPEN_AGENTS_HOOK_WORKSPACE_REPOS` using entries like:

```bash
GoAugment/augment-web#staging:augment-web,GoAugment/augment-services#main:augment-services
```

## Local Development

Use devstack from the repo root:

```bash
devstack stack up
devstack stack status
```

The app stack is defined in `devstack.toml`. It runs:

- Postgres on `127.0.0.1:54329`.
- Redis on `127.0.0.1:63799`.
- Open Agents web on port `3000`.

Open the local app with either:

```bash
http://pi:3000
http://localhost:3000
```

The devstack-facing `http://pi:3000` URL is often the least surprising in browser automation.

Useful local commands:

```bash
devstack memory observe
devstack memory logs --service web --since 10m --last 200
devstack memory logs --service web --since 10m "slack-session"
devstack stack diagnose
devstack stack restart web
devstack stack exec -- bun run --cwd apps/open-agents typecheck
```

Do not debug local failures by staring at HMR websocket reconnects. HMR reconnects are often noise. Check server logs and DB state first.

Local auth mode is configured by `devstack.toml`:

```bash
OPEN_AGENTS_AUTH_MODE=local
OPEN_AGENTS_GITHUB_AUTH_MODE=gh-cli
```

GitHub clone access comes from local `gh`:

```bash
gh auth status
```

Vercel Sandbox needs Vercel/OIDC env. Pull development env when sandbox creation starts failing around OIDC:

```bash
bunx vercel env pull apps/open-agents/.env.development.local --environment=development --yes
```

For a local smoke:

```bash
devstack stack up
curl -sS http://localhost:3000/api/health
```

Then use browser automation to create a session, wait for the sandbox, ask the agent to inspect `pwd && ls -la`, and verify the response is based on actual sandbox output.

## Local Browser Testing

For local app testing, either devstack browser or agent-browser is fine.

Devstack owns an agent browser window and shares the human profile/auth:

```bash
devstack computer browser open http://pi:3000
devstack computer browser see
devstack computer browser click @e5
devstack computer browser read
devstack computer browser screenshot
```

`browser see` gives `@eN` refs. Refresh refs after navigation or a major UI update.

Use `agent-browser` when you need direct CDP control, screenshots, snapshots, or the user's existing Chrome tabs:

```bash
agent-browser connect 9222
agent-browser tab list
agent-browser tab t17
agent-browser snapshot -i
agent-browser screenshot --annotate
agent-browser fill @e12 "message"
agent-browser click @e18
```

Stable tab IDs such as `t17` are stable within the connected browser session. Always run `agent-browser tab list` first, then keep using the same tab ID. Do not navigate over the user's active work tab by accident.

During the final verified prod run in this session, the useful tabs were:

- `t17`: Slack `#dana-bot-test`.
- `t18`: Open Agents session UI.
- `t14`: Slack app config.
- `t6`: Linear integration settings.

Those IDs can change if the agent-browser daemon reconnects, so treat them as last-known examples, not constants.

If Open Agents needs login, use the existing work-auth Chrome profile/tab and click "Sign in with Vercel". Do not switch to a personal Google/Vercel profile. If Google auth is involved, use the current work-auth Google/Calendar tab, not a personal tab.

## Production Deploy

Check the linked project:

```bash
cat .vercel/project.json
bunx vercel whoami
bunx vercel list --yes --format=json | jq '.contextName, .deployments[0].url'
```

The linked project should be `openagents` under `goaugment`. `vercel list` resolves correctly from this repo. Some CLI subcommands, especially `inspect`, `logs`, and `alias`, may default to the personal context. If they say `danaasbury-1517s-projects`, add `--scope goaugment`.

Before deploying, pull and verify production env:

```bash
bunx vercel env pull .vercel/.env.production.local --environment=production --yes
bun run apps/open-agents/scripts/verify-production-env.ts --env-file=.vercel/.env.production.local
```

The verifier checks:

- Project name `openagents`.
- Framework `services`.
- Node `24.x`.
- Vercel Services config and rewrites.
- Required storage, auth, and app runtime env.
- `OPEN_AGENTS_AUTH_MODE=oauth`.
- Production storage does not point at shared Augment resources.
- Optional Braintrust, Datadog Pup, and Snowflake CLI secret JSON shapes when non-empty values are available locally.

Deploy production from the repo root:

```bash
bunx vercel deploy --prod --yes --meta actor=codex
```

If the prod alias does not move automatically, set it explicitly:

```bash
bunx vercel alias set <deployment-url> openagents-one.vercel.app --scope goaugment
```

Inspect the deployment and confirm Eve function duration:

```bash
bunx vercel inspect <deployment-url> --scope goaugment --format=json | jq '.id, .readyState, .aliases, [.output[]? | select(.path | contains("eve")) | {path, timeout: .lambda.timeout}]'
```

Expected Eve lambda timeout is `300`.

Health checks:

```bash
bunx vercel curl /api/health --deployment https://openagents-one.vercel.app --json --yes
bunx vercel curl /eve/v1/health --deployment https://openagents-one.vercel.app --json --yes
```

Runtime logs:

```bash
bunx vercel logs <deployment-url> --scope goaugment --since 30m --json
bunx vercel logs <deployment-url> --scope goaugment --since 30m --json --query "slack-session"
bunx vercel logs <deployment-url> --scope goaugment --follow --json
```

Build logs:

```bash
bunx vercel inspect <deployment-url> --scope goaugment --logs
```

Production env inventory:

```bash
bunx vercel env list production --format=json | jq -r '.envs[].key' | sort
```

Important production env keys include:

- `ANTHROPIC_API_KEY`
- `OPEN_AGENTS_GITHUB_TOKEN`
- `OPEN_AGENTS_PUBLIC_URL`
- `OPEN_AGENTS_AUTH_MODE`
- `BETTER_AUTH_URL`
- `BETTER_AUTH_SECRET`
- `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID`
- `VERCEL_APP_CLIENT_SECRET`
- `OPEN_AGENTS_BRAINTRUST_CLI_SECRET`
- `OPEN_AGENTS_DATADOG_PUP_CLI_SECRET`
- `OPEN_AGENTS_SNOWFLAKE_CLI_SECRET`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `SLACK_CLIENT_SECRET`
- Postgres and Redis/KV env groups

The Slack and session CLI keys are optional for platform boot. When the CLI keys are present with non-empty local values, `prod:verify-env` validates that their JSON shape matches the sandbox installers before deployment. Vercel may pull sensitive production values as empty placeholders.

If Sonnet sessions fail immediately, check `ANTHROPIC_API_KEY` first. After changing env, redeploy.

## Slack Production Testing

Only test Slack in `#dana-bot-test`.

Slack's Event Subscriptions Request URL should be:

```text
https://openagents-one.vercel.app/eve/v1/slack
```

If the stable URL changes, Slack will still hit the old configured URL until the Slack app config is updated. In the Slack portal, editing the URL may require clicking out of the input and deleting/re-adding a character to trigger validation. If Slack says interactive events are not configured, keep interactive events disabled for now. Tool approvals in Slack are not part of the current required flow.

Good prod smoke prompt:

```text
@Voice Bot prod smoke 2026-07-03 HH:MM CT. Start an Open Agents triage workspace with default repos augment-web, augment-services, and augment-voice. Inspect the sandbox directories and reply with the session link plus one top-level package/app from each repo.
```

Expected Slack behavior:

1. Immediate threaded reply with `Started Open Agents session: https://openagents-one.vercel.app/sessions/.../chats/...`.
2. A later `Workspace sandbox is ready.` reply.
3. A final assistant reply based on actual sandbox inspection.

Then open the session link in the Open Agents UI and send a follow-up:

```text
UI follow-up smoke: using the existing sandbox, run pwd and reply with only the working directory.
```

Expected UI answer:

```text
/vercel/sandbox
```

This proves Slack-created sessions are durable, visible in the UI, and continued with the same Eve session/sandbox.

During the final verified run:

- Session: `QA0BZSTfsuLLIJ9WiQCy1`
- Chat: `e3M2aL8GA8GEPXdZuCpaD`
- Eve session: `wrun_01KWJRP2BVMKR0HZP8Z1G3N0ZV`
- Initial Slack turn persisted 186 Eve events.
- UI follow-up continued the same Eve session and advanced to stream index 206.
- Tool use was `bash`, not the removed executor OpenAPI bridge.

Slack's thread side panel can visually lag in browser automation. Trust DB state, logs, and the Open Agents UI before assuming Slack failed.

## Production DB Probes

Pull prod env first:

```bash
bunx vercel env pull .vercel/.env.production.local --environment=production --yes
```

Use `bun` with `postgres` for quick probes:

```bash
bun --env-file=.vercel/.env.production.local -e '
import postgres from "postgres";
const sql = postgres(process.env.POSTGRES_URL!, { max: 1 });
const rows = await sql`
  select created_at, slack_team_id, slack_channel_id, slack_thread_ts, session_id, chat_id, link_posted_at
  from slack_thread_sessions
  order by created_at desc
  limit 5
`;
console.log(JSON.stringify(rows, null, 2));
await sql.end();
'
```

Useful SQL snippets:

```sql
select id, lifecycle_state, lifecycle_error, sandbox_state, workspace_repos
from sessions
where id = '<sessionId>';

select state->>'sessionId' as eve_session_id, state->>'streamIndex' as stream_index, updated_at
from eve_chat_session_states
where chat_id = '<chatId>';

select stream_index, event_type, event->'data'->>'toolName' as tool_name, created_at
from eve_chat_events
where chat_id = '<chatId>'
order by stream_index desc
limit 40;

select stream_index, event->'data'->>'message' as message
from eve_chat_events
where chat_id = '<chatId>'
  and event_type = 'message.completed'
order by stream_index desc
limit 5;
```

Interpretation:

- No `slack_thread_sessions` row means Slack did not reach the app or user linking failed.
- Row exists but `link_posted_at` is null means the Slack handler failed before link posting.
- Session `lifecycle_state='failed'` means sandbox init failed; check `lifecycle_error`.
- `eve_chat_session_states` missing means `clientSession.send()` did not return or state was not persisted.
- Events present but no final assistant message means the Eve turn is still running, failed, or ended at a boundary without text.
- Latest event not a current-turn boundary means the chat is busy and Slack will reject concurrent thread replies.

## Logs That Matter

Slack logs from `apps/open-agents/agent/channels/slack.ts`:

- `[slack] received message`
- `[slack] started Open Agents session`
- `[slack] failed to start Open Agents session`
- `[slack] failed to initialize Open Agents sandbox`
- `[slack] Open Agents turn failed`

Slack/Eve persistence logs from `apps/open-agents/agent/lib/open-agents-slack-session.ts`:

- `[slack-session] initializing sandbox`
- `[slack-session] sandbox initialized`
- `[slack-session] starting Eve turn`
- `[slack-session] persisted Eve session cursor`
- `[slack-session] persisted Eve event`
- `[slack-session] completed Eve turn`

The most important migration lesson: do not wait for `response.result()` before persisting Slack events. Long Slack turns can run for minutes. Persist each streamed Eve event as it arrives and persist the session cursor immediately after `clientSession.send()` returns. This is what makes the UI able to open and continue a Slack-started session.

## Linear and OAuth Callback Testing

Eve connection callback routes are deployed under:

```text
/eve/v1/connections/[name]/callback/[token]
```

The current deployment inspection showed this route exists in the Eve service output. If an OAuth callback 404s:

1. Confirm `vercel.json` still rewrites `/eve/v1/(.*)` to service `eve`.
2. Inspect the deployment output for `services/eve/eve/v1/connections/[name]/callback/[token]`.
3. Confirm the external provider callback URL uses `https://openagents-one.vercel.app/eve/v1/connections/...`, not the web service or an old deployment URL.
4. Check Vercel logs with `--scope goaugment`.

For the Linear auth-file parse failure, check file-secrets tests:

```bash
bun run --cwd packages/plugins/file-secrets test
bun run --cwd packages/plugins/file-secrets typecheck
```

## Test Commands Before Deploy

Run focused tests instead of the entire monorepo unless the change has broad blast radius:

```bash
bun --env-file=.vercel/.env.local run --cwd apps/open-agents typecheck
bun test apps/open-agents/lib/db/eve-chat-sessions.test.ts apps/open-agents/app/api/sandbox/route.test.ts packages/react/src/plugins/oauth-sign-in.test.ts packages/plugins/file-secrets/src/index.test.ts
bun run --cwd packages/plugins/file-secrets test
bun run --cwd packages/plugins/file-secrets typecheck
```

Verify the Eve build and max-duration patch locally:

```bash
set -a
source .vercel/.env.local
set +a
bunx eve build
bun run apps/open-agents/scripts/patch-eve-vercel-output.ts
```

Expected output includes:

```text
[open-agents] patched Eve Vercel function maxDuration=300s
```

## Common Failure Modes

Slack message does not start a session:

- Check Slack app Event Subscriptions URL points at `https://openagents-one.vercel.app/eve/v1/slack`.
- Check Vercel logs for `[slack] received message`.
- Check `slack_user_links` has the Slack user/team mapping.
- Check `slack_thread_sessions` for a new row.

Slack starts a session but no link appears:

- Link posting should happen before sandbox initialization.
- Check `link_posted_at` in `slack_thread_sessions`.
- Check Slack bot token/signing secret env.

Slack link appears but no UI session:

- Check `sessions`, `chats`, and `slack_thread_sessions` rows.
- Open the session URL from DB directly.
- Check auth in the work Chrome tab; sign in with Vercel if needed.

Slack final answer never appears:

- Check `eve_chat_events` count and latest `event_type`.
- Check `eve_chat_session_states.state.streamIndex`.
- Check Vercel logs for Eve function timeouts.
- Confirm Eve lambda timeout is `300` in deployment output.

Agent inspects the web app instead of the sandbox:

- Remove any OpenAPI/connection/tool that exposes `/api/eve/executor` or Vercel SSO as a workspace inspection path.
- Keep `agent/instructions.md` and `agent/instructions/open_agents_profile.ts` explicit about using `bash`, `glob`, `grep`, and `read_file`.

Default listed agent errors:

- Reproduce with the real UI and browser, not a token assertion.
- Check the selected `sessions.agent_name` and matching `agent_library_items` row.
- Dynamic profile resolution is in `apps/open-agents/agent/lib/open-agents-profile.ts`.

Sonnet sessions error:

- Check `ANTHROPIC_API_KEY` in production env.
- Re-deploy after changing env.

App redirect is invalid:

- Use work-auth Chrome tabs.
- Check `BETTER_AUTH_URL` and `OPEN_AGENTS_PUBLIC_URL` are the stable prod URL.
- Check Vercel app client ID/secret env.
- Check the Vercel OAuth app redirect config matches the stable prod URL.

HMR websocket reconnects:

- Usually not the root cause.
- Read devstack/Vercel server logs and DB state before changing client code.

## Important Docs

Eve:

- Introduction: `https://eve.dev/docs/introduction`
- Project layout: `https://eve.dev/docs/reference/project-layout`
- TypeScript API: `https://eve.dev/docs/reference/typescript-api`
- Dynamic capabilities: `https://eve.dev/docs/guides/dynamic-capabilities`
- Sessions, runs, and streaming: `https://eve.dev/docs/concepts/sessions-runs-and-streaming`
- Frontend overview: `https://eve.dev/docs/guides/frontend/overview`
- TypeScript client SDK: `https://eve.dev/docs/guides/client/overview`
- Hooks: `https://eve.dev/docs/guides/hooks`
- Skills: `https://eve.dev/docs/skills`
- Connections overview: `https://eve.dev/docs/connections`
- MCP connections: `https://eve.dev/docs/connections/mcp`
- OpenAPI connections: `https://eve.dev/docs/connections/openapi`
- Deployment: `https://eve.dev/docs/guides/deployment`
- Slack channel: `https://eve.dev/docs/channels/slack`
- Linear channel: `https://eve.dev/docs/channels/linear`
- GitHub channel: `https://eve.dev/docs/channels/github`

Vercel:

- CLI: `https://vercel.com/docs/cli`
- Services: `https://vercel.com/docs/services`
- Rewrites to a service: `https://vercel.com/docs/routing/rewrites`
- Project configuration: `https://vercel.com/docs/project-configuration`
- Functions: `https://vercel.com/docs/functions`
- AI Gateway: `https://vercel.com/docs/ai-gateway`

Local installed package references:

- `node_modules/eve/README.md`
- `node_modules/eve/dist/src/**/*.d.ts`
- `node_modules/workflow/README.md`
- `node_modules/workflow/dist/**/*.d.ts`

When docs and skills disagree, trust the installed package and current Eve docs. Some local skills can be stale across the v7/Eve upgrade.
