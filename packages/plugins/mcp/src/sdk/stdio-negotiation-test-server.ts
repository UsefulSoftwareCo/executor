// Stdio MCP fixture for stdio-negotiation.test.ts, spawned as a child process
// with `bun run <this file>`. Serves both protocol eras by default;
// `--legacy-reject` refuses the 2025 `initialize` opening so only a client
// probing `server/discover` (spec 2026-07-28) can connect — the shape of an
// SDK v2 server running with its legacy compatibility lane disabled.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

serveStdio(
  () => {
    const server = new McpServer(
      { name: "stdio-negotiation-fixture", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.registerTool(
      "add",
      { description: "Add two numbers", inputSchema: z.object({ a: z.number(), b: z.number() }) },
      async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
    );
    return server;
  },
  { legacy: process.argv.includes("--legacy-reject") ? "reject" : "serve" },
);
