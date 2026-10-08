import type { InStatement } from "@libsql/client";

export interface ToolUsageWindow {
  readonly fromMs: number;
  readonly toMs: number;
  readonly trafficClass: "agent" | "benchmark" | "monitor" | "all";
  readonly limit: number;
}

const summaryQuery = (
  window: ToolUsageWindow,
  dimension: "tool" | "integration",
): Exclude<InStatement, string> => {
  const columns =
    dimension === "tool" ? "mcp_tool, target_tool, integration_slug" : "integration_slug";
  const filter =
    dimension === "integration"
      ? "AND mcp_tool IN ('invoke','execute') AND integration_slug IS NOT NULL"
      : "";
  return {
    sql: `WITH ranked AS (
      SELECT ${columns}, status, duration_ms, response_bytes,
        ROW_NUMBER() OVER (PARTITION BY ${columns} ORDER BY duration_ms) AS rank,
        COUNT(*) OVER (PARTITION BY ${columns}) AS calls
      FROM executor_tool_usage
      WHERE timestamp_ms >= ? AND timestamp_ms < ? AND (? = 'all' OR traffic_class = ?) ${filter}
    )
    SELECT ${columns}, MAX(calls) AS calls,
      SUM(status = 'ok') AS ok, SUM(status = 'error') AS error, SUM(status = 'blocked') AS blocked,
      MAX(CASE WHEN rank = (calls + 1) / 2 THEN duration_ms END) AS p50_ms,
      MAX(CASE WHEN rank = (calls * 95 + 99) / 100 THEN duration_ms END) AS p95_ms,
      SUM(response_bytes) AS response_bytes
    FROM ranked GROUP BY ${columns}
    ORDER BY calls DESC, ${columns} LIMIT ?`,
    args: [window.fromMs, window.toMs, window.trafficClass, window.trafficClass, window.limit],
  };
};

/** Nearest-rank percentiles over retained calls in [fromMs, toMs). */
export const toolUsageSummaryQuery = (window: ToolUsageWindow): Exclude<InStatement, string> =>
  summaryQuery(window, "tool");

/** Combine all attempted invoke and sandbox execute targets for each integration. */
export const integrationUsageSummaryQuery = (
  window: ToolUsageWindow,
): Exclude<InStatement, string> => summaryQuery(window, "integration");
