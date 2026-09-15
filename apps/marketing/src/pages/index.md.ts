import type { APIRoute } from "astro";

import {
  capabilities,
  faqs,
  GITHUB_URL,
  markdownResponse,
  pricingTiers,
  tagline,
} from "../content/site-copy";
import { testimonials } from "../content/testimonials";

// ---------------------------------------------------------------------------
// `/index.md` — the homepage as Markdown, for agents.
//
// Same content as src/pages/index.astro, without the layout, scripts, or
// interactive demos: an agent that fetches this gets the whole product in one
// read, plus links to the other machine-readable surfaces.
//
// The copy comes from src/content/site-copy.ts so the HTML page and this page
// cannot drift apart.
// ---------------------------------------------------------------------------

const machineSummaries = [
  ["Docs", "https://executor.sh/docs"],
  ["Setup prompt", "https://executor.sh/setup-prompt.md"],
  ["Pricing", "https://executor.sh/pricing.md"],
  ["llms.txt", "https://executor.sh/llms.txt"],
  ["GitHub", GITHUB_URL],
  ["Cloud", "https://executor.sh/cloud"],
] as const;

const capabilityLines = capabilities.map(
  ({ title, body, comingSoon }, i) =>
    `${i + 1}. **${title}**${comingSoon ? " _(coming soon)_" : ""} — ${body}`,
);

const pricingLines = pricingTiers.map(({ name, price, audience, featuresLabel, features, cta }) =>
  [
    `### ${name} — ${price}`,
    "",
    audience,
    "",
    ...(featuresLabel === undefined ? [] : [`${featuresLabel}:`, ""]),
    ...features.map((f) => `- ${f}`),
    "",
    cta,
  ].join("\n"),
);

const faqLines = faqs.map(({ question, answer }) => `### ${question}\n\n${answer}`);

const body = `# Executor

> ${tagline}

## Machine summaries

${machineSummaries.map(([label, href]) => `- [${label}](${href})`).join("\n")}

## What Executor is

Executor is an open-source integration layer for AI agents. Configure every
integration once (MCP servers, OpenAPI specs, GraphQL APIs, custom sources)
with authentication and per-tool policies, then use that one catalog from any
MCP-compatible agent.

Wiring tools to agents is fiddly, per-client, and easy to get wrong. Executor
makes every tool, from any protocol, look the same: one name, one input schema,
one output schema, so any agent can call any of them the same way.

Connect everything you use and Executor still shows the model a single tool. It
searches your catalog and loads a tool's schema only when the code actually
calls it, so the prompt never balloons.

## How it works

- **Integration** — anything you add: an MCP server, an OpenAPI spec, a GraphQL
  API, or a Google Discovery document.
- **Connection** — one configured (optionally authenticated) instance of an
  integration. An integration can have many connections.
- **Policy** — whether each tool is always allowed, requires approval, or is
  blocked. Policies start from a sensible default derived from the imported
  spec (for example, GET requests on an OpenAPI spec are allowed by default).

Then use it from any MCP-compatible agent: one catalog of tools, shared across
every client.

## What you get

${capabilityLines.join("\n\n")}

## Ways to run it

All forms expose the same functionality, packaged differently.

### Cloud

Hosted Executor. Auth, sync, policies, and your whole team online in five
minutes. Free tier to start: https://executor.sh/cloud

### Desktop

A desktop app for Mac, Windows, and Linux that runs entirely on your machine.
Your integrations, credentials, and sessions never leave the device.

Downloads follow the latest GitHub release:

\`${GITHUB_URL}/releases/latest/download/executor-desktop-<platform>\`

- \`executor-desktop-mac-arm64.dmg\` — Mac (Apple silicon)
- \`executor-desktop-mac-x64.dmg\` — Mac (Intel)
- \`executor-desktop-win-x64.exe\` — Windows
- \`executor-desktop-linux-x86_64.AppImage\` — Linux

### CLI

Run Executor as a background service and drive it from your terminal. Best for
headless and server environments.

\`\`\`sh
npm i -g executor
\`\`\`

### Self-hosted

A Docker image: https://executor.sh/docs/hosted/docker

## Pricing

Start free, pay per member. Full details: https://executor.sh/pricing.md

${pricingLines.join("\n\n")}

## What people say

Public posts about Executor on X. Each line links to the original.

${testimonials.map((t) => `- ${t.name} (@${t.handle}): "${t.text}" https://x.com/${t.handle}/status/${t.id}`).join("\n")}

## FAQ

${faqLines.join("\n\n")}

## Source

Executor is open source: ${GITHUB_URL}
`;

export const GET: APIRoute = () => markdownResponse(body);
