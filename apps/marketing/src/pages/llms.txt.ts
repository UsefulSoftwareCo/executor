import type { APIRoute } from "astro";

import { siteOrigin } from "../content/site-origin.ts";

const body = `# Executor

> The cloud for agent apps.

Deploy personal software for your agents. Start with an MCP server, a tool, or a skill.

Everything’s an app. Add the Axiom MCP or PostHog MCP and use it from your agent. Add custom approval rules, caching, or a UI when you need them. It is still the same app.

Just want to teach your agent how to do something? Start with a skill. You can add tools or scheduled work later.

An app is a tool, a skill, a UI, or a few pieces working together.

Apps can include:

- Tools: MCP, OpenAPI, GraphQL. It’s all just JavaScript.
- Skills: give your agent instructions it can use again.
- UI: a page for your app, at its own URL.
- Storage: keep data and state between runs.
- Triggers: run on a schedule or respond to webhooks.
- Workflows: durable work across multiple steps.

Build with Claude. Use the same apps from Codex, Cursor, or another connected agent, with the same accounts and rules.

Executor hosts your apps, connects your accounts, and keeps the source and deployment history. Start small and keep improving them.

## Docs

- [Documentation](${siteOrigin}/docs): Executor documentation.

## Product

- [Website](${siteOrigin}): product overview and getting started.
- [Pricing](${siteOrigin}/pricing): plans for Executor Cloud.
- [Install](${siteOrigin}/#install): install the CLI and connect your first agent.

## For agents

Markdown representations of the pages above, for machines rather than browsers.

- [/index.md](${siteOrigin}/index.md): the homepage as Markdown — what Executor is, how it works, what you get, ways to run it, pricing, and FAQ.
- [/setup-prompt.md](${siteOrigin}/setup-prompt.md): a prompt to paste into a coding agent. It connects over MCP and helps build and deploy a first app.
- [/pricing.md](${siteOrigin}/pricing.md): the Executor Cloud plans as Markdown.

## Source

- [GitHub](https://github.com/UsefulSoftwareCo/executor): source for the integration layer, plugins, and hosts.

## Community

- [Discord](https://discord.gg/eF29HBHwM6): support and discussion.
`;

/** Serve the agent index with links belonging to this deployment. */
export const GET: APIRoute = () =>
  new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
