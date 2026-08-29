// A zero-dependency fake `codex app-server`, for the `local` e2e project.
//
// The curated Codex plugin presets no longer spawn a plugin's MCP client
// directly — their service refuses tool calls from non-Codex hosts — so the
// scanner emits `codex app-server` recipes and the connector bridges MCP to
// the app-server protocol in process. This fixture stands in for the real
// binary with the same wire shapes (newline-delimited JSON-RPC, v2 protocol):
// `initialize`, the `initialized` notification, `thread/start`,
// `mcpServerStatus/list`, and `mcpServer/tool/call` against one MCP server
// named `messages`.
//
// Like stdio-mcp-server.mjs it gates a `saw_codex_home` tool on CODEX_HOME
// being present in this process's env, so a scenario can prove the declared
// env reached the spawned child through the bridge.

import { createInterface } from "node:readline";

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const THREAD_ID = "thread-e2e-1";

const TOOLS = {
  echo_tool: {
    name: "echo_tool",
    description: "Echoes the provided text back",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
};

if (process.env.CODEX_HOME !== undefined) {
  TOOLS.saw_codex_home = {
    name: "saw_codex_home",
    description: "Present only because CODEX_HOME is set in this server's environment",
    inputSchema: { type: "object", properties: {} },
  };
}

const handle = (msg) => {
  // Notifications (`initialized`) carry no id and expect no response.
  if (msg.id === undefined || msg.id === null) return;

  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "codex-e2e-fixture/0.0.0" } });
    return;
  }

  if (msg.method === "thread/start") {
    send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: THREAD_ID } } });
    return;
  }

  if (msg.method === "mcpServerStatus/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        data: [
          {
            name: "messages",
            runtimeStatus: "connected",
            pluginId: "messages",
            serverInfo: null,
            tools: TOOLS,
            resources: [],
            resourceTemplates: [],
            authStatus: "unsupported",
          },
        ],
        nextCursor: null,
      },
    });
    return;
  }

  if (msg.method === "mcpServer/tool/call") {
    const { server, tool } = msg.params ?? {};
    if (server !== "messages" || TOOLS[tool] === undefined) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32602, message: `unknown server or tool: ${server}/${tool}` },
      });
      return;
    }
    const text =
      tool === "echo_tool" ? String(msg.params?.arguments?.text ?? "") : "codex-home-present";
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  });
};

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- standalone zero-dep fixture: hand-rolled JSON-RPC framing, not product code
  try {
    // oxlint-disable-next-line executor/no-json-parse -- standalone zero-dep fixture: hand-rolled JSON-RPC framing, not product code
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  handle(msg);
});
