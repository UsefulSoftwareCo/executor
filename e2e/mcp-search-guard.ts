import { scenarios } from "./test-plan.ts";

export const mcpSearchPaths: ReadonlyArray<string> = [
  "packages/mcp/",
  "packages/sdk/src/implementation/tool-search*.ts",
  "packages/sdk/src/implementation/listings.ts",
  "packages/sdk/src/implementation/tools.ts",
  "apps/hosted/server/src/implementation/mcp*.ts",
  "apps/hosted/server/src/implementation/tools.ts",
];

export const mcpSearchScenarios: ReadonlyArray<keyof typeof scenarios> = [
  "cloudMcpDiscoveryListings",
  "cloudMcpParallelCalls",
  "cloudMcpAbandonedStatement",
  "cloudMcpObjectConnections",
  "cloudMcpObjectConnectRetry",
  "cloudMcpObjectPool",
  "mcpBackgroundListingCloud",
  "mcpStoppedListingCloud",
  "mcpStoppedRenewalCloud",
  "cloudMcpSessionTiming",
  "cloudMcpSessionRouting",
  "cloudMcpSessionRestore",
  "cloudMcpStreamLifetime",
  "cloudMcpCallBatch",
];

export const mcpSearchTitles: ReadonlySet<string> = new Set(
  mcpSearchScenarios.map((key) => scenarios[key].title),
);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const matchesPath = (entry: string, file: string) =>
  entry.endsWith("/")
    ? file.startsWith(entry)
    : new RegExp(`^${entry.split("*").map(escape).join("[^/]*")}$`).test(file);

export const mcpSearchChanged = (files: ReadonlyArray<string>) =>
  files.some((file) => mcpSearchPaths.some((entry) => matchesPath(entry, file)));
