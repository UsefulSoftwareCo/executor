import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { observeToolUsageServer } from "../src/mcp/tool-usage";
import { makeToolUsageRecorder } from "../src/mcp/tool-usage-store";

const dir = mkdtempSync(join(tmpdir(), "executor-usage-bench-"));
const samples = Number(process.env.BENCH_SAMPLES ?? 5000);
const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1]!;
const reports = [];
try {
  for (const bytes of [1024, 27 * 1024, 1024 * 1024]) {
    const phases = [];
    for (const enabled of [false, true]) {
      const db = createClient({ url: `file:${join(dir, `${bytes}-${enabled}.db`)}` });
      await db.execute("PRAGMA journal_mode = WAL");
      await db.execute("PRAGMA synchronous = NORMAL");
      const recorder = makeToolUsageRecorder(db);
      await recorder.ready;
      const server = new McpServer({ name: "usage-bench", version: "1" });
      const result = { content: [{ type: "text" as const, text: "x".repeat(bytes) }] };
      server.registerTool("search", {}, () => result);
      if (enabled)
        observeToolUsageServer(
          server,
          recorder.memberHash("bench-org", "bench-member")!,
          recorder.record,
        );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      // InMemoryTransport normally skips wire serialization. Include the same
      // JSON serialization cost in both phases, as HTTP transport does.
      const send = serverTransport.send.bind(serverTransport);
      serverTransport.send = async (message, options) => {
        JSON.stringify(message);
        await send(message, options);
      };
      const client = new Client({ name: "benchmark", version: "1" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      for (let i = 0; i < 1000; i++) {
        await client.callTool({ name: "search" });
        if ((i + 1) % 256 === 0) await recorder.flush();
      }
      await recorder.flush();
      const values = [];
      let flushMs = 0;
      for (let i = 0; i < samples; i++) {
        const start = performance.now();
        await client.callTool({ name: "search" });
        values.push(performance.now() - start);
        if (enabled && (i + 1) % 256 === 0) {
          const flushStart = performance.now();
          await recorder.flush();
          flushMs += performance.now() - flushStart;
        }
      }
      const flushStart = performance.now();
      await recorder.close();
      flushMs += performance.now() - flushStart;
      await client.close();
      await server.close();
      phases.push({
        enabled,
        samples,
        p50Ms: quantile(values, 0.5),
        p95Ms: quantile(values, 0.95),
        flushMsPerCall: flushMs / samples,
        lost: (await db.execute("SELECT dropped_events FROM executor_tool_usage_state")).rows[0]!
          .dropped_events,
      });
      db.close();
    }
    reports.push({
      responseContentBytes: bytes,
      phases,
      overheadP50Ms: phases[1]!.p50Ms - phases[0]!.p50Ms,
      overheadP95Ms: phases[1]!.p95Ms - phases[0]!.p95Ms,
    });
  }
  console.log(
    JSON.stringify(
      {
        runtime: Bun.version,
        samples,
        method:
          "warm SDK in-memory MCP calls plus HTTP-equivalent JSON serialization; nearest-rank percentiles; WAL SQLite; flush each 256 calls outside request timing",
        reports,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
