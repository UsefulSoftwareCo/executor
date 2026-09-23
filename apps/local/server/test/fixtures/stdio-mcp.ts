/** Real subprocess fixture. The parent supplies a private journal directory and synthetic credentials. */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

const journal = process.argv[2];
if (journal === undefined) throw new Error("A journal is required");
const record = (event: string) =>
  appendFileSync(
    join(journal, "processes.jsonl"),
    JSON.stringify({ pid: process.pid, event }) + "\n",
  );
const mode = process.env.MODE ?? "normal";
const account = process.env.TEST_TOKEN ?? "public";
const input = createInterface({ input: process.stdin });
// Keep this fake server dependency-free so its startup does not consume the
// transport deadline, especially when several account processes start together.
function parseMessage(line: string) {
  const value: unknown = JSON.parse(line);
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  assert.ok("method" in value && typeof value.method === "string");
  const id = "id" in value ? value.id : undefined;
  assert.ok(id === undefined || typeof id === "string" || typeof id === "number");
  const params = "params" in value ? value.params : undefined;
  assert.ok(
    params === undefined ||
      (typeof params === "object" && params !== null && !Array.isArray(params)),
  );
  return { id, method: value.method, params };
}
const metadata = {
  name: account,
  title: "Account identity",
  description: "Reports this process's selected account",
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  outputSchema: {
    type: "object",
    properties: { account: { type: "string" } },
    required: ["account"],
  },
  annotations: { readOnlyHint: true },
  _meta: { fixture: true },
};
record("started");
if (mode === "stubborn") {
  process.on("SIGTERM", () => record("sigterm"));
  setInterval(() => {}, 1000);
}
input.on("close", () => {
  record("stdin-closed");
  if (mode !== "stubborn") process.exit(0);
});
input.on("line", (line) => {
  const message = parseMessage(line);
  if (message.id === undefined) return;
  record(message.method);
  let result: unknown;
  switch (message.method) {
    case "initialize":
      if (mode === "hang-initialize" || mode === "stubborn") return;
      if (mode === "exit") {
        process.exit(1);
        return;
      }
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "stdio fixture", version: "1" },
      };
      break;
    case "tools/list":
      if (mode === "hang-list") return;
      result =
        message.params === undefined || !("cursor" in message.params)
          ? { tools: [metadata], nextCursor: "next" }
          : {
              tools: [
                {
                  name: "failure",
                  description: "MCP failure result",
                  inputSchema: { type: "object" },
                },
              ],
              ...(mode === "cursor-loop" ? { nextCursor: "next" } : {}),
            };
      break;
    case "tools/call":
      if (mode === "hang-call") return;
      result =
        message.params !== undefined &&
        "name" in message.params &&
        message.params.name === "failure"
          ? { content: [{ type: "text", text: "Expected failure" }], isError: true }
          : {
              content: [{ type: "text", text: "Connected" }],
              structuredContent: {
                account,
                cwd: process.cwd(),
                argument: process.argv[3],
                hostSecretPresent: process.env.EXECUTOR_STDIO_TEST_SECRET !== undefined,
              },
              _meta: { fixture: true },
            };
      break;
    default:
      result = {};
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
