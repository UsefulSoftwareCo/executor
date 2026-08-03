export interface McpRemotePreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly url: string;
  readonly endpoint: string;
  readonly icon?: string;
  readonly featured?: boolean;
  readonly transport?: undefined;
}

export interface McpStdioPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly icon?: string;
  readonly featured?: boolean;
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export type McpPreset = McpRemotePreset | McpStdioPreset;

export const mcpPresets: readonly McpPreset[] = [
  {
    id: "emulate-mcp",
    name: "Emulate MCP",
    summary: "Deterministic MCP fixtures for validating native text and image content.",
    url: "https://emulators.dev/mcp/query/mcp?token=demo-token",
    endpoint: "https://emulators.dev/mcp/query/mcp?token=demo-token",
    icon: "https://integrations.sh/logo/emulators.dev",
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    summary: "Search and read documentation from any GitHub repo.",
    url: "https://mcp.deepwiki.com/mcp",
    endpoint: "https://mcp.deepwiki.com/mcp",
    icon: "https://integrations.sh/logo/deepwiki.com",
    featured: true,
  },
  {
    id: "slack",
    name: "Slack",
    summary: "Search messages, read canvases, and write Slack updates via MCP.",
    url: "https://mcp.slack.com/mcp",
    endpoint: "https://mcp.slack.com/mcp",
    icon: "https://integrations.sh/logo/slack.com",
    featured: true,
  },
  {
    id: "context7",
    name: "Context7",
    summary: "Up-to-date docs and code examples for any library.",
    url: "https://mcp.context7.com/mcp",
    endpoint: "https://mcp.context7.com/mcp",
    icon: "https://integrations.sh/logo/context7.com",
    featured: true,
  },
  {
    id: "browserbase",
    name: "Browserbase",
    summary: "Cloud browser sessions for web scraping and automation.",
    url: "https://mcp.browserbase.com/mcp",
    endpoint: "https://mcp.browserbase.com/mcp",
    icon: "https://integrations.sh/logo/browserbase.com",
    featured: true,
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    summary: "Crawl and scrape websites into structured data.",
    url: "https://mcp.firecrawl.dev/mcp",
    endpoint: "https://mcp.firecrawl.dev/mcp",
    icon: "https://integrations.sh/logo/firecrawl.dev",
    featured: true,
  },
  {
    id: "neon",
    name: "Neon",
    summary: "Serverless Postgres — branches, queries, and management.",
    url: "https://mcp.neon.tech/mcp",
    endpoint: "https://mcp.neon.tech/mcp",
    icon: "https://integrations.sh/logo/neon.tech",
    featured: true,
  },
  {
    id: "axiom",
    name: "Axiom",
    summary: "Query, analyze, and monitor your logs and event data.",
    url: "https://mcp.axiom.co/mcp",
    endpoint: "https://mcp.axiom.co/mcp",
    icon: "https://integrations.sh/logo/axiom.co",
    featured: true,
  },
  {
    id: "stripe",
    name: "Stripe",
    summary: "Manage payments, subscriptions, and billing via MCP.",
    url: "https://mcp.stripe.com",
    endpoint: "https://mcp.stripe.com",
    icon: "https://integrations.sh/logo/stripe.com",
    featured: true,
  },
  {
    id: "linear",
    name: "Linear",
    summary: "Issues, projects, teams, and cycles via MCP.",
    url: "https://mcp.linear.app/mcp",
    endpoint: "https://mcp.linear.app/mcp",
    icon: "https://integrations.sh/logo/linear.app",
    featured: true,
  },
  {
    id: "notion",
    name: "Notion",
    summary: "Databases, pages, blocks, and search via MCP.",
    url: "https://mcp.notion.com/mcp",
    endpoint: "https://mcp.notion.com/mcp",
    icon: "https://integrations.sh/logo/notion.com",
    featured: true,
  },
  {
    id: "sentry",
    name: "Sentry",
    summary: "Error monitoring, issues, and performance data.",
    url: "https://mcp.sentry.dev/mcp",
    endpoint: "https://mcp.sentry.dev/mcp",
    icon: "https://svgl.app/library/sentry.svg",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    summary: "Workers, KV, D1, R2, and DNS management via MCP.",
    url: "https://mcp.cloudflare.com/mcp",
    endpoint: "https://mcp.cloudflare.com/mcp",
    icon: "https://integrations.sh/logo/cloudflare.com",
  },
  {
    id: "chrome-devtools",
    name: "Chrome DevTools",
    summary: "Debug a live Chrome browser session via local stdio.",
    icon: "https://integrations.sh/logo/chrome.com",
    featured: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest"],
  },
];
