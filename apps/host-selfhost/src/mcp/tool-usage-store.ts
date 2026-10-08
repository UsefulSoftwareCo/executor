import { createHmac } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";

export const TOOL_USAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const TOOL_USAGE_MAX_EVENTS = 100_000;
export const TOOL_USAGE_MAX_PENDING = 1024;

export interface ToolUsageEvent {
  readonly timestampMs: number;
  readonly memberHash: string;
  readonly mcpTool: "search" | "invoke" | "integrations" | "skills" | "execute";
  readonly targetTool: string | null;
  readonly integrationSlug: string | null;
  readonly trafficClass: "agent" | "benchmark" | "monitor";
  readonly status: "ok" | "error" | "blocked";
  readonly durationMs: number;
  readonly responseBytes: number;
}

export const usageInsert = (event: ToolUsageEvent): InStatement => ({
  sql: `INSERT INTO executor_tool_usage
    (timestamp_ms, member_hash, mcp_tool, target_tool, integration_slug, traffic_class,
     status, duration_ms, response_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  // Explicit projection: extra input properties can never reach storage.
  args: [
    event.timestampMs,
    event.memberHash,
    event.mcpTool,
    event.targetTool,
    event.integrationSlug,
    event.trafficClass,
    event.status,
    event.durationMs,
    event.responseBytes,
  ],
});

export const usageRetention = (now: number, maxEvents = TOOL_USAGE_MAX_EVENTS): InStatement[] => [
  {
    sql: "DELETE FROM executor_tool_usage WHERE timestamp_ms < ?",
    args: [now - TOOL_USAGE_RETENTION_MS],
  },
  {
    sql: `DELETE FROM executor_tool_usage WHERE id IN
      (SELECT id FROM executor_tool_usage ORDER BY id DESC LIMIT -1 OFFSET ?)`,
    args: [maxEvents],
  },
];

const USAGE_COLUMNS =
  "id, timestamp_ms, member_hash, mcp_tool, target_tool, integration_slug, traffic_class, status, duration_ms, response_bytes";

const usageTableDefinition = (name: string): string => `CREATE TABLE IF NOT EXISTS ${name} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp_ms INTEGER NOT NULL,
      member_hash TEXT NOT NULL,
      mcp_tool TEXT NOT NULL CHECK (mcp_tool IN ('search','invoke','integrations','skills','execute')),
      target_tool TEXT CHECK (length(target_tool) <= 512),
      integration_slug TEXT CHECK (length(integration_slug) <= 64),
      traffic_class TEXT NOT NULL CHECK (traffic_class IN ('agent','benchmark','monitor')),
      status TEXT NOT NULL CHECK (status IN ('ok','error','blocked')),
      duration_ms REAL NOT NULL CHECK (duration_ms >= 0),
      response_bytes INTEGER NOT NULL CHECK (response_bytes >= 0)
    )`;

/**
 * One-time rebuild for tables created before `execute` joined the `mcp_tool`
 * CHECK. SQLite cannot alter a CHECK in place, so copy every row (ids kept)
 * into a table with the current definition and swap it in. The state table
 * and its salt are untouched. Runs inside the initialization write batch.
 */
const usageMigration = async (client: Client): Promise<string[]> => {
  const existing = await client.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'executor_tool_usage'",
    args: [],
  });
  const definition = existing.rows[0]?.sql;
  if (typeof definition !== "string" || definition.includes("'execute'")) return [];
  return [
    usageTableDefinition("executor_tool_usage_new"),
    `INSERT INTO executor_tool_usage_new (${USAGE_COLUMNS})
      SELECT ${USAGE_COLUMNS} FROM executor_tool_usage ORDER BY id`,
    // Preserve AUTOINCREMENT history, including a deleted highest id or an empty table.
    `INSERT INTO sqlite_sequence (name, seq)
      SELECT 'executor_tool_usage_new', seq FROM sqlite_sequence
      WHERE name = 'executor_tool_usage' AND NOT EXISTS
        (SELECT 1 FROM sqlite_sequence WHERE name = 'executor_tool_usage_new')`,
    `UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE(
      (SELECT seq FROM sqlite_sequence WHERE name = 'executor_tool_usage'), 0))
      WHERE name = 'executor_tool_usage_new'`,
    "DROP TABLE executor_tool_usage",
    "ALTER TABLE executor_tool_usage_new RENAME TO executor_tool_usage",
  ];
};

export const initializeToolUsage = async (client: Client): Promise<string> => {
  await client.batch(
    [
      ...(await usageMigration(client)),
      usageTableDefinition("executor_tool_usage"),
      "CREATE INDEX IF NOT EXISTS executor_tool_usage_time ON executor_tool_usage(timestamp_ms)",
      `CREATE TABLE IF NOT EXISTS executor_tool_usage_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), salt TEXT NOT NULL,
      dropped_events INTEGER NOT NULL DEFAULT 0, write_failures INTEGER NOT NULL DEFAULT 0
    )`,
      "INSERT OR IGNORE INTO executor_tool_usage_state (id, salt) VALUES (1, lower(hex(randomblob(32))))",
      ...usageRetention(Date.now()),
    ],
    "write",
  );
  const result = await client.execute("SELECT salt FROM executor_tool_usage_state WHERE id = 1");
  return String(result.rows[0]!.salt);
};

/** This salt is a local pseudonymization key, not a service credential. */
export const hashUsageMember = (salt: string, organizationId: string, accountId: string): string =>
  createHmac("sha256", salt)
    .update(JSON.stringify([organizationId, accountId]))
    .digest("hex");

/** Bounded queue on the shared DB client; no awaited writes in MCP dispatch. */
export const makeToolUsageRecorder = (client: Client) => {
  let salt: string | null = null;
  let pending: ToolUsageEvent[] = [];
  let dropped = 0;
  let writeFailures = 0;
  let flushing: Promise<void> | null = null;
  let closed = false;
  const ready = (async () => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: telemetry setup must not prevent MCP serving
    try {
      salt = await initializeToolUsage(client);
    } catch {
      console.warn("[executor:tool-usage] storage unavailable; metrics disabled");
    }
  })();

  const record = (event: ToolUsageEvent): void => {
    if (closed || salt === null) return;
    if (pending.length >= TOOL_USAGE_MAX_PENDING) {
      dropped++;
      return;
    }
    // Copy only fields from the storage contract, never retain caller objects.
    pending.push({
      timestampMs: event.timestampMs,
      memberHash: event.memberHash,
      mcpTool: event.mcpTool,
      targetTool: event.targetTool,
      integrationSlug: event.integrationSlug,
      trafficClass: event.trafficClass,
      status: event.status,
      durationMs: event.durationMs,
      responseBytes: event.responseBytes,
    });
  };

  const flush = (): Promise<void> => {
    if (flushing) return flushing;
    flushing = (async () => {
      await ready;
      if (salt === null) return;
      const batch = pending;
      pending = [];
      const droppedCount = dropped;
      const failureCount = writeFailures;
      dropped = 0;
      writeFailures = 0;
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a failed metrics transaction must not fail tool calls or shutdown
      try {
        await client.batch(
          [
            ...batch.map(usageInsert),
            ...usageRetention(Date.now()),
            {
              sql: `UPDATE executor_tool_usage_state SET dropped_events = dropped_events + ?,
              write_failures = write_failures + ? WHERE id = 1`,
              args: [droppedCount, failureCount],
            },
          ],
          "write",
        );
      } catch {
        dropped += droppedCount + batch.length;
        writeFailures += failureCount + 1;
        console.warn("[executor:tool-usage] metrics write failed; events dropped");
      }
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  };
  // Flush only when needed. Idle pruning still runs once per hour.
  const flushTimer = setInterval(() => {
    if (pending.length || dropped || writeFailures) void flush();
  }, 1000);
  const retentionTimer = setInterval(
    () => {
      void flush();
    },
    60 * 60 * 1000,
  );
  flushTimer.unref();
  retentionTimer.unref();
  return {
    ready,
    record,
    drop: () => {
      if (!closed && salt !== null) dropped++;
    },
    memberHash: (organizationId: string, accountId: string): string | null =>
      salt === null ? null : hashUsageMember(salt, organizationId, accountId),
    flush,
    close: async () => {
      closed = true;
      clearInterval(flushTimer);
      clearInterval(retentionTimer);
      await flushing;
      await flush();
    },
  };
};

export type ToolUsageRecorder = ReturnType<typeof makeToolUsageRecorder>;
