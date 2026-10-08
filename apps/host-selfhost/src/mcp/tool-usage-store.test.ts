import { afterEach, describe, expect, it } from "@effect/vitest";
import { createClient, type Client } from "@libsql/client";
import {
  hashUsageMember,
  initializeToolUsage,
  makeToolUsageRecorder,
  TOOL_USAGE_MAX_PENDING,
  TOOL_USAGE_RETENTION_MS,
  usageInsert,
  usageRetention,
  type ToolUsageEvent,
} from "./tool-usage-store";
import { toolUsageSummaryQuery, integrationUsageSummaryQuery } from "./tool-usage-summary";

const clients: Client[] = [];
const stores: ReturnType<typeof makeToolUsageRecorder>[] = [];
const database = () => {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  return client;
};
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  for (const client of clients.splice(0)) client.close();
});
const event = (overrides: Partial<ToolUsageEvent> = {}): ToolUsageEvent => ({
  timestampMs: Date.now(),
  memberHash: "a".repeat(64),
  mcpTool: "invoke",
  targetTool: "tools.sample.org.test.read",
  integrationSlug: "sample",
  trafficClass: "agent",
  status: "ok",
  durationMs: 10,
  responseBytes: 123,
  ...overrides,
});

describe("tool usage storage", () => {
  it("stores only the metadata contract, with stable, tenant-specific member hashes", async () => {
    const client = database();
    const store = makeToolUsageRecorder(client);
    stores.push(store);
    await store.ready;
    const memberHash = store.memberHash("org-identity", "account-identity")!;
    expect(memberHash).toMatch(/^[a-f0-9]{64}$/);
    const hostileInput = {
      ...event({ memberHash }),
      arguments: { secret: "payload-secret" },
      results: { token: "result-secret" },
      headers: { authorization: "bearer-secret" },
    };
    store.record(hostileInput);
    store.record(hostileInput);
    await store.flush();
    const rows = await client.execute("SELECT * FROM executor_tool_usage");
    expect(rows.rows).toHaveLength(2);
    expect(Object.keys(rows.rows[0]!).sort()).toEqual(
      [
        "id",
        "timestamp_ms",
        "member_hash",
        "mcp_tool",
        "target_tool",
        "integration_slug",
        "traffic_class",
        "status",
        "duration_ms",
        "response_bytes",
      ].sort(),
    );
    expect(JSON.stringify(rows.rows)).not.toMatch(
      /payload-secret|result-secret|bearer-secret|org-identity|account-identity|arguments|results|headers/,
    );
    const salt = await initializeToolUsage(client);
    expect(hashUsageMember(salt, "org-identity", "account-identity")).toBe(memberHash);
    expect(hashUsageMember(salt, "other-org", "account-identity")).not.toBe(memberHash);
  });

  it("prunes old calls, caps rows, and preserves retention boundary calls", async () => {
    const client = database();
    await initializeToolUsage(client);
    const now = Date.now();
    await client.batch(
      [
        usageInsert(event({ timestampMs: now - TOOL_USAGE_RETENTION_MS - 1 })),
        usageInsert(event({ timestampMs: now - TOOL_USAGE_RETENTION_MS })),
        usageInsert(event({ timestampMs: now, status: "error" })),
        usageInsert(event({ timestampMs: now, status: "blocked" })),
        ...usageRetention(now, 3),
      ],
      "write",
    );
    let rows = await client.execute(
      "SELECT timestamp_ms, status FROM executor_tool_usage ORDER BY id",
    );
    expect(rows.rows.map((row) => row.status)).toEqual(["ok", "error", "blocked"]);
    expect(rows.rows[0]!.timestamp_ms).toBe(now - TOOL_USAGE_RETENTION_MS);
    await client.batch(usageRetention(now, 2), "write");
    rows = await client.execute("SELECT status FROM executor_tool_usage ORDER BY id");
    expect(rows.rows.map((row) => row.status)).toEqual(["error", "blocked"]);
  });

  it("reports overflow instead of keeping an unbounded queue and flushes at close", async () => {
    const client = database();
    const store = makeToolUsageRecorder(client);
    await store.ready;
    for (let i = 0; i < TOOL_USAGE_MAX_PENDING + 3; i++) store.record(event());
    await store.close();
    expect((await client.execute("SELECT COUNT(*) AS n FROM executor_tool_usage")).rows[0]!.n).toBe(
      TOOL_USAGE_MAX_PENDING,
    );
    expect(
      (await client.execute("SELECT dropped_events FROM executor_tool_usage_state")).rows[0]!
        .dropped_events,
    ).toBe(3);
  });

  it("counts failed writes without logging their errors or retaining lost payloads", async () => {
    const client = database();
    const store = makeToolUsageRecorder(client);
    stores.push(store);
    await store.ready;
    store.record(event());
    await client.execute("DROP TABLE executor_tool_usage");
    await store.flush();
    await initializeToolUsage(client);
    await store.flush();
    expect(
      (await client.execute("SELECT dropped_events, write_failures FROM executor_tool_usage_state"))
        .rows[0],
    ).toMatchObject({ dropped_events: 1, write_failures: 1 });
    expect((await client.execute("SELECT COUNT(*) AS n FROM executor_tool_usage")).rows[0]!.n).toBe(
      0,
    );
  });

  it("does not fail serving when telemetry initialization fails", async () => {
    const client = database();
    client.close();
    const store = makeToolUsageRecorder(client);
    stores.push(store);
    await store.ready;
    expect(store.memberHash("org", "member")).toBeNull();
    expect(() => store.record(event())).not.toThrow();
    await store.flush();
  });
});

describe("tool usage summary", () => {
  it("ranks repeated calls and calculates nearest-rank percentiles for a half-open window", async () => {
    const client = database();
    await initializeToolUsage(client);
    const now = Date.now();
    await client.batch(
      [
        ...Array.from({ length: 20 }, (_, index) =>
          usageInsert(
            event({
              timestampMs: now,
              durationMs: index + 1,
              status: index === 0 ? "blocked" : index === 1 ? "error" : "ok",
            }),
          ),
        ),
        usageInsert(
          event({
            timestampMs: now,
            targetTool: "tools.other.org.test.read",
            integrationSlug: "other",
            durationMs: 7,
          }),
        ),
        usageInsert(event({ timestampMs: now - 1, durationMs: 999 })),
        usageInsert(event({ timestampMs: now + 1, durationMs: 999 })),
        usageInsert(event({ timestampMs: now, durationMs: 999, trafficClass: "benchmark" })),
      ],
      "write",
    );
    const result = await client.execute(
      toolUsageSummaryQuery({ fromMs: now, toMs: now + 1, trafficClass: "agent", limit: 20 }),
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      calls: 20,
      ok: 18,
      error: 1,
      blocked: 1,
      p50_ms: 10,
      p95_ms: 19,
      response_bytes: 2460,
    });
    expect(result.rows[1]).toMatchObject({ calls: 1, p50_ms: 7, p95_ms: 7 });
    const all = await client.execute(
      toolUsageSummaryQuery({ fromMs: now, toMs: now + 1, trafficClass: "all", limit: 1 }),
    );
    expect(all.rows[0]).toMatchObject({ calls: 21, p50_ms: 11, p95_ms: 20 });
    const empty = await client.execute(
      toolUsageSummaryQuery({ fromMs: now + 2, toMs: now + 3, trafficClass: "agent", limit: 20 }),
    );
    expect(empty.rows).toHaveLength(0);
    await client.execute(
      usageInsert(
        event({ timestampMs: now, targetTool: "tools.sample.org.test.write", durationMs: 50 }),
      ),
    );
    const integrations = await client.execute(
      integrationUsageSummaryQuery({
        fromMs: now,
        toMs: now + 1,
        trafficClass: "agent",
        limit: 20,
      }),
    );
    expect(integrations.rows[0]).toMatchObject({
      integration_slug: "sample",
      calls: 21,
      p50_ms: 11,
      p95_ms: 20,
    });
    expect(integrations.rows[1]).toMatchObject({ integration_slug: "other", calls: 1, p50_ms: 7 });
  });
});
