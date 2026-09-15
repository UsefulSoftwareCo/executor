import { CURATED_CODEX_PLUGINS } from "./codex-plugin-presets";

export interface McpRemotePreset {
  /** Image to show when `icon` cannot be resolved on this machine. */
  readonly fallbackIcon?: string;
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly url: string;
  readonly endpoint: string;
  readonly icon?: string;
  readonly featured?: boolean;
  readonly family?: string;
  readonly transport?: undefined;
}

export interface McpStdioPreset {
  /** Image to show when `icon` cannot be resolved on this machine. */
  readonly fallbackIcon?: string;
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly icon?: string;
  readonly featured?: boolean;
  readonly family?: string;
  /** Integration slug this preset registers as, for favicon resolution. */
  readonly defaultSlug?: string;
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export type McpPreset = McpRemotePreset | McpStdioPreset;

// Codex plugin presets — searchable catalog entries ("imessage", "computer
// use", …). `command` is deliberately empty: the real spawn recipe is
// machine-specific and comes from the server-side scanner
// (`codex-plugins.ts`); picking one of these opens the focused Codex add
// screen. The icon uses the `executor:` scheme (see integration-favicon.tsx): the
// plugin's own icon is a machine-local file, so it is served by the local API
// and resolved with the auth header — a static URL cannot reach it.
const codexPluginPresets: readonly McpStdioPreset[] = CURATED_CODEX_PLUGINS.map((plugin) => ({
  id: plugin.id,
  name: plugin.name,
  summary: plugin.summary,
  icon: `executor:/mcp/codex-plugins/${plugin.id}/icon`,
  // The plugin's own icon lives in the user's Codex install, so a machine
  // without Codex has none to read. Fall back to the provider's mark from the
  // same logo service every other preset uses, rather than vendoring OpenAI's
  // artwork into this repo.
  fallbackIcon: plugin.publicIcon ?? "https://integrations.sh/logo/openai.com",
  family: "codex",
  defaultSlug: plugin.slug,
  transport: "stdio",
  command: "",
}));

export const mcpPresets: readonly McpPreset[] = [
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
    // `codemode=false` opts out of Cloudflare's code mode, which replaces the
    // tool catalog with a single code-execution tool. Executor is already a
    // code-execution surface, so nesting it would hide every real tool.
    url: "https://mcp.cloudflare.com/mcp?codemode=false",
    endpoint: "https://mcp.cloudflare.com/mcp?codemode=false",
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
  ...codexPluginPresets,
];
