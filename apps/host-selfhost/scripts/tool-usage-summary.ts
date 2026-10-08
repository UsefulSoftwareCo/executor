import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { TOOL_USAGE_MAX_EVENTS, TOOL_USAGE_RETENTION_MS } from "../src/mcp/tool-usage-store";
import {
  toolUsageSummaryQuery,
  integrationUsageSummaryQuery,
  type ToolUsageWindow,
} from "../src/mcp/tool-usage-summary";

const args = process.argv.slice(2);
const option = (name: string, fallback?: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1]!.startsWith("--"))
    throw new Error(`Missing ${name} value`);
  return args[index + 1];
};
if (args.includes("--help")) {
  console.log(
    "bun run apps/host-selfhost/scripts/tool-usage-summary.ts --db PATH [--from ISO] [--to ISO] [--traffic agent|benchmark|monitor|all] [--limit 20]",
  );
  process.exit(0);
}
const dbPath = option("--db");
if (!dbPath) throw new Error("--db PATH is required");
const toMs = Date.parse(option("--to", new Date().toISOString())!);
const fromMs = Date.parse(
  option("--from", new Date(toMs - TOOL_USAGE_RETENTION_MS).toISOString())!,
);
const traffic = option("--traffic", "agent");
const limit = Number(option("--limit", "20"));
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs)
  throw new Error("Invalid time window");
if (!["agent", "benchmark", "monitor", "all"].includes(traffic!))
  throw new Error("Invalid traffic class");
if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
  throw new Error("--limit must be 1..1000");
const window = {
  fromMs,
  toMs,
  trafficClass: traffic as ToolUsageWindow["trafficClass"],
  limit,
};
const query = toolUsageSummaryQuery(window);
const integrationQuery = integrationUsageSummaryQuery(window);
const db = new Database(resolve(dbPath), { readonly: true });
try {
  console.log(
    JSON.stringify(
      {
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        traffic,
        retentionDays: TOOL_USAGE_RETENTION_MS / (24 * 60 * 60 * 1000),
        maxEvents: TOOL_USAGE_MAX_EVENTS,
        coverage: db
          .query(`SELECT COUNT(*) AS retained_calls, MIN(timestamp_ms) AS oldest_timestamp_ms,
      MAX(timestamp_ms) AS newest_timestamp_ms FROM executor_tool_usage`)
          .get(),
        losses: db
          .query(
            "SELECT dropped_events, write_failures FROM executor_tool_usage_state WHERE id = 1",
          )
          .get(),
        tools: db.query(query.sql).all(fromMs, toMs, traffic!, traffic!, limit),
        integrations: db.query(integrationQuery.sql).all(fromMs, toMs, traffic!, traffic!, limit),
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
