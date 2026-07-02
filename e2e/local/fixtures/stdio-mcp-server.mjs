// A zero-dependency MCP server over stdio, for the `local` e2e project.
//
// The real `@modelcontextprotocol/sdk` stdio server pulls in the whole SDK and
// is awkward to resolve from an arbitrary spawn cwd under bun's node_modules
// layout. The MCP stdio framing is just newline-delimited JSON-RPC, so we hand-
// roll the three methods a tool-discovery + invoke round-trip needs:
// `initialize`, `tools/list`, `tools/call` (plus `ping`). This keeps the
// fixture a single self-contained file the executor server can launch as
// `node <thisfile>` with nothing to install.
//
// It exposes one tool, `echo_tool`, and (when EXECUTOR_E2E_SECRET is set in the
// child env) a second `whoami` tool that returns that env value — so a scenario
// can prove a per-connection secret env var actually reached the subprocess.

import { createInterface } from "node:readline";

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const TOOLS = [
  {
    name: "echo_tool",
    description: "Echoes the provided text back",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

if (process.env.EXECUTOR_E2E_SECRET) {
  TOOLS.push({
    name: "whoami",
    description: "Returns the secret env value the server was launched with",
    inputSchema: { type: "object", properties: {} },
  });
}

const handle = (msg) => {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        // Echo the client's protocol version so we never fail version
        // negotiation against whatever SDK build is on the other end.
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "executor-e2e-stdio", version: "1.0.0" },
      },
    });
    return;
  }

  // Notifications carry no id and expect no response.
  if (msg.id === undefined || msg.id === null) return;

  if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    return;
  }

  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const text =
      name === "whoami"
        ? (process.env.EXECUTOR_E2E_SECRET ?? "")
        : String(msg.params?.arguments?.text ?? "");
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text }] },
    });
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
