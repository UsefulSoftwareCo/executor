/**
 * Context-acquisition fleet for the Open Agents architecture-foundations design.
 * Spawns parallel scouts, each distilling one slice of the system into a briefing
 * file under tmp/briefings/ that the conductor (Claude) reads afterwards.
 *
 * Run from the executor repo root:
 *   bun /home/dana/projects/pi/agent/extensions/agent-sessions/program/conductor/runner.ts ./tmp/architecture-context.ts
 */

import type { Conductor, SeedAsset } from "/home/dana/projects/pi/agent/extensions/agent-sessions/program/conductor/index.js";

const REPO = "/home/dana/projects/augment/agents/executor";

const COMMON = [
  `Repo under study: ${REPO} (work with absolute paths; you may be started in a different cwd).`,
  "Read docs/open-agents-operations-handoff.md first for orientation.",
  "Your briefing is consumed by an architect designing major refactors: be dense, evidence-backed, cite exact file paths and table/column/type names.",
  "Spending tokens on real file reads is OK and expected. Do NOT speculate — verify in source.",
  "End the briefing with a section 'GAPS' listing anything you could not verify.",
].join("\n");

interface ScoutSpec {
  key: string;
  task: string;
  instructions: string;
}

const SCOUTS: ScoutSpec[] = [
  {
    key: "data-model",
    task: [
      "Map the ENTIRE persistence + auth layer of the Open Agents app (apps/open-agents).",
      "Cover: every DB table (schema files, migrations), how users are modeled (better-auth config, providers), any existing org/team/group/membership concepts,",
      "ownership columns on sessions/chats/agent_library_items/skills/tools/docs/automations, how Slack users map to app users,",
      "eve_chat_session_states / eve_chat_events shape, and where DB access helpers live.",
      "Also note which tables have NO ownership/scoping today.",
    ].join("\n"),
    instructions: [
      COMMON,
      "Focus dirs: apps/open-agents/lib/db/, apps/open-agents/lib/auth* , migrations/drizzle dirs, agent/lib/open-agents-profile.ts.",
      "Pin the 2-4 most load-bearing schema/auth files.",
    ].join("\n"),
  },
  {
    key: "eve-runtime",
    task: [
      "Map the Eve agent runtime in agent/ of the repo.",
      "Cover: agent/agent.ts model+compaction config, channels (eve.ts auth, slack.ts flow), dynamic capabilities (defineDynamic usage in agent/tools/ and agent/instructions/),",
      "how the DB-backed agent/skill/tool profile is resolved (agent/lib/open-agents-profile.ts), how a Slack turn runs (agent/lib/open-agents-slack-session.ts),",
      "and what Eve primitives are available in the installed eve package for MULTI-AGENT patterns: sub-agents, handoffs, multiple agent slots, agent-to-agent calls, routers.",
      "Check node_modules/eve/dist/src/**/*.d.ts and node_modules/eve/README.md for agent definition APIs, session APIs, and anything about handoff/delegation.",
    ].join("\n"),
    instructions: [
      COMMON,
      "Pin agent/agent.ts, agent/lib/open-agents-profile.ts and the most relevant eve .d.ts file(s).",
      "Explicitly answer: can one Eve deployment host multiple named agents, and can an agent invoke another agent as a tool or handoff? Cite the type signatures.",
    ].join("\n"),
  },
  {
    key: "automations",
    task: [
      "Map the CURRENT automations feature end to end.",
      "Cover: where automations are defined/stored (DB tables, files), trigger types (cron? events? webhooks?), what actions they can take,",
      "how they execute (which runtime, which agent), their UI surfaces, and any trace/observability data available that a trace-mining automation could read",
      "(eve_chat_events, telemetry, memory-metrics, otel).",
      "Also inventory anything that already opens PRs or drives sandboxes autonomously.",
    ].join("\n"),
    instructions: [
      COMMON,
      "Search broadly: rg for 'automation', 'cron', 'schedule', 'trigger' across apps/open-agents and agent/.",
      "Pin the core automation implementation files if they exist; if the feature is thin/absent, say so plainly.",
    ].join("\n"),
  },
  {
    key: "web-ui",
    task: [
      "Map the Next.js UI + API surface of apps/open-agents.",
      "Cover: the app/ route tree (pages + API routes), session/chat UI composition, use-session-chat-runtime.ts flow and its persistence queue,",
      "how auth gates pages/APIs (middleware? per-route?), any existing sharing/visibility/permissions UI, the agent/skill/tool library UI (agent_library_items editing),",
      "any markdown/doc editing or comments features, and the sandbox API routes.",
      "Note which API routes check ownership and how (userId equality? nothing?).",
    ].join("\n"),
    instructions: [
      COMMON,
      "Focus: apps/open-agents/app/**, apps/open-agents/lib/**, apps/open-agents/middleware*.",
      "Pin the session page, the chat runtime hook, and the main auth helper.",
    ].join("\n"),
  },
  {
    key: "platform-research",
    task: [
      "Research the EXTERNAL capabilities we would build on, using web fetches of current docs plus installed package types.",
      "1) Eve: sessions/runs/streaming model, hooks, skills, channels (Slack), dynamic capabilities, whether multiple concurrent clients can attach to one Eve session (multiplayer), and any multi-agent/handoff guidance. https://eve.dev/docs/*",
      "2) TipTap: current (2026) collaboration story — Hocuspocus/@tiptap-cloud vs self-hosted Yjs websocket server, comments extension licensing (free vs Pro), what a self-hosted Notion-like editor needs.",
      "3) Yjs persistence patterns with Postgres (y-postgres? storing updates + snapshots).",
      "4) Slack: reading channel membership (conversations.members) scopes needed, and mapping Slack users to app users at scale.",
      "5) Vercel: websocket support status for Next.js/Vercel Services in 2026 (can we host a Yjs ws server there, or do we need a separate service / partykit-style host?).",
    ].join("\n"),
    instructions: [
      "This scout is research-only: web + node_modules reads, no repo mapping needed beyond node_modules/eve.",
      "Cite doc URLs for every claim. Flag anything uncertain in a GAPS section.",
      "Be current: it is July 2026; prefer docs over stale blog posts.",
    ].join("\n"),
  },
];

export default async function contextFleet(c: Conductor): Promise<unknown> {
  const results: Record<string, { briefingPath?: string; pins: string[]; source: string; chars: number } | { error: string }> = {};

  await Promise.all(
    SCOUTS.map(async (spec) => {
      try {
        const asset: SeedAsset = await c.prime(
          { name: "scout" },
          spec.task,
          {
            name: `oa-arch-${spec.key}`,
            briefingPath: `tmp/briefings/${spec.key}.md`,
            keepAlive: false,
            timeoutMs: 900_000,
            instructions: spec.instructions,
          },
        );
        results[spec.key] = {
          briefingPath: asset.briefingPath,
          pins: asset.pins,
          source: asset.sourceSessionId,
          chars: asset.briefing.length,
        };
        process.stderr.write(`[oa-arch] DONE ${spec.key} chars=${asset.briefing.length} pins=${asset.pins.length}\n`);
      } catch (error) {
        results[spec.key] = { error: error instanceof Error ? error.message : String(error) };
        process.stderr.write(`[oa-arch] FAIL ${spec.key} ${String(error)}\n`);
      }
    }),
  );

  const report = c.ledger();
  process.stderr.write(`\n[oa-arch] ledger:\n${report.render()}\n`);
  return { results, totalCost: report.total.cost.total };
}
