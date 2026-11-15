/**
 * A floor under a pull request's `e2e` block for the code MCP search and MCP sessions run through
 * (e2e/ci-selection.ts). Cloud's Worker is not profiled (e2e/coverage.ts), so no coverage says which
 * Cloud scenarios a change to this code reaches, and the Cloud scenarios that exercise search and
 * sessions under locks and load live in spec files whose names do not say so:
 * cloud-database-placement.spec.ts and mcp-catalog-scale.spec.ts. When any of `mcpSearchPaths`
 * differs from main, every scenario in `mcpSearchScenarios` runs in its own Cloud job, besides what
 * the block names. It removes nothing, and a scenario the block already selects runs once.
 *
 * Add a path when MCP search or a session's calls start running through another file, and a
 * scenario when one is written for this code: the cases in e2e/tests/ci-selection.spec.ts fail for
 * a path no file matches, a scenario no longer scheduled on Cloud, and a Cloud MCP session scenario
 * left out.
 */
import { scenarios } from "./test-plan.ts";

/**
 * The files search and session calls run through, from the repository root. An entry ending in `/`
 * is a directory and everything under it; a `*` in an entry's last segment stands for any characters
 * but `/`; any other entry is one file.
 */
export const mcpSearchPaths: ReadonlyArray<string> = [
  "packages/mcp/",
  // Search rows, their store and the listings they are kept from.
  "packages/sdk/src/implementation/tool-search*.ts",
  "packages/sdk/src/implementation/listings.ts",
  // The SDK's tool reads, which search and execute make for every app they reach.
  "packages/sdk/src/implementation/tools.ts",
  // The hosted MCP server and the searchable tools it reads for each app.
  "apps/hosted/server/src/implementation/mcp*.ts",
  "apps/hosted/server/src/implementation/tools.ts",
];

/** The Cloud scenarios that run when one of `mcpSearchPaths` changes, by their test-plan keys. */
export const mcpSearchScenarios: ReadonlyArray<keyof typeof scenarios> = [
  // cloud-database-placement.spec.ts: session objects' calls against held locks and connections.
  "cloudMcpDiscoveryListings",
  "cloudMcpParallelCalls",
  "cloudMcpAbandonedStatement",
  "cloudMcpObjectConnections",
  "cloudMcpObjectConnectRetry",
  "cloudMcpObjectPool",
  // mcp-catalog-scale.spec.ts: slow and stalled listings and aged search rows on Cloud.
  "mcpBackgroundListingCloud",
  "mcpStoppedListingCloud",
  "mcpStoppedRenewalCloud",
  // The session objects' own spec files.
  "cloudMcpSessionTiming",
  "cloudMcpSessionRouting",
  "cloudMcpSessionRestore",
  "cloudMcpStreamLifetime",
  "cloudMcpCallBatch",
];

/** The titles of `mcpSearchScenarios`. */
export const mcpSearchTitles: ReadonlySet<string> = new Set(
  mcpSearchScenarios.map((key) => scenarios[key].title),
);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `file`, a path from the repository root, is matched by the path entry `entry`. */
export const matchesPath = (entry: string, file: string) =>
  entry.endsWith("/")
    ? file.startsWith(entry)
    : new RegExp(`^${entry.split("*").map(escape).join("[^/]*")}$`).test(file);

/** Whether any of `files` is one search and session calls run through. */
export const mcpSearchChanged = (files: ReadonlyArray<string>) =>
  files.some((file) => mcpSearchPaths.some((entry) => matchesPath(entry, file)));
