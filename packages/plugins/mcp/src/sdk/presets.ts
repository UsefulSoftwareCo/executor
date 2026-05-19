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
    id: "deepwiki",
    name: "DeepWiki",
    summary: "Search and read documentation from any GitHub repo.",
    url: "https://mcp.deepwiki.com/mcp",
    endpoint: "https://mcp.deepwiki.com/mcp",
    icon: "https://deepwiki.com/favicon.ico",
    featured: true,
  },
  {
    id: "context7",
    name: "Context7",
    summary: "Up-to-date docs and code examples for any library.",
    url: "https://mcp.context7.com/mcp",
    endpoint: "https://mcp.context7.com/mcp",
    icon: "https://context7.com/favicon.ico",
    featured: true,
  },
  {
    id: "browserbase",
    name: "Browserbase",
    summary: "Cloud browser sessions for web scraping and automation.",
    url: "https://mcp.browserbase.com/mcp",
    endpoint: "https://mcp.browserbase.com/mcp",
    icon: "https://www.browserbase.com/favicon.ico",
    featured: true,
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    summary: "Crawl and scrape websites into structured data.",
    url: "https://mcp.firecrawl.dev/mcp",
    endpoint: "https://mcp.firecrawl.dev/mcp",
    icon: "https://www.firecrawl.dev/favicon.ico",
    featured: true,
  },
  {
    id: "neon",
    name: "Neon",
    summary: "Serverless Postgres — branches, queries, and management.",
    url: "https://mcp.neon.tech/mcp",
    endpoint: "https://mcp.neon.tech/mcp",
    icon: "https://neon.tech/favicon/favicon.ico",
    featured: true,
  },
  {
    id: "axiom",
    name: "Axiom",
    summary: "Query, analyze, and monitor your logs and event data.",
    url: "https://mcp.axiom.co/mcp",
    endpoint: "https://mcp.axiom.co/mcp",
    icon: "https://axiom.co/favicon.ico",
    featured: true,
  },
  {
    id: "stripe",
    name: "Stripe",
    summary: "Manage payments, subscriptions, and billing via MCP.",
    url: "https://mcp.stripe.com",
    endpoint: "https://mcp.stripe.com",
    icon: "https://stripe.com/favicon.ico",
    featured: true,
  },
  {
    id: "linear",
    name: "Linear",
    summary: "Issues, projects, teams, and cycles via MCP.",
    url: "https://mcp.linear.app/mcp",
    endpoint: "https://mcp.linear.app/mcp",
    icon: "https://linear.app/favicon.ico",
    featured: true,
  },
  {
    id: "notion",
    name: "Notion",
    summary: "Databases, pages, blocks, and search via MCP.",
    url: "https://mcp.notion.com/mcp",
    endpoint: "https://mcp.notion.com/mcp",
    icon: "https://www.notion.com/front-static/favicon.ico",
    featured: true,
  },
  {
    id: "sentry",
    name: "Sentry",
    summary: "Error monitoring, issues, and performance data.",
    url: "https://mcp.sentry.dev/mcp",
    endpoint: "https://mcp.sentry.dev/mcp",
    icon: "https://sentry-brand.storage.googleapis.com/sentry-glyph-black.png",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    summary: "Workers, KV, D1, R2, and DNS management via MCP.",
    url: "https://mcp.cloudflare.com/mcp",
    endpoint: "https://mcp.cloudflare.com/mcp",
    icon: "https://cloudflare.com/favicon.ico",
  },
  {
    id: "chrome-devtools",
    name: "Chrome DevTools",
    summary: "Debug a live Chrome browser session via local stdio.",
    icon: "https://www.google.com/chrome/static/images/favicons/favicon-32x32.png",
    featured: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest"],
  },
];
