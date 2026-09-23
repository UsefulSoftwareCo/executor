/** A real, dependency-free stdio peer. Process startup must not dominate the short active-call budget. */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

const journal = process.argv[2];
if (journal === undefined) throw new Error("A journal is required");
const record = (event: string) =>
  appendFileSync(journal, JSON.stringify({ pid: process.pid, event }) + "\n");
const write = (message: object) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
type Call = {
  readonly id: string | number;
  readonly marker: string;
  readonly value: string;
  readonly responses: unknown[];
};
let call: Call | undefined;
const question = (call: Call) =>
  write({
    id: `question-${call.responses.length}`,
    method: "elicitation/create",
    params: {
      mode: "form",
      message: `${call.value}:${call.responses.length + 1}`,
      requestedSchema: {
        type: "object",
        properties: { answer: { type: "string", minLength: 1 } },
        required: ["answer"],
      },
      _meta: {
        origin: "https://fixture.example",
        persist: ["session", "always"],
        marker: call.marker,
      },
    },
  });
const input = createInterface({ input: process.stdin });
record("started");
input.on("close", () => {
  record("closed");
  process.exit(0);
});
input.on("line", (line) => {
  const message: unknown = JSON.parse(line);
  assert.ok(typeof message === "object" && message !== null && !Array.isArray(message));
  if (!("id" in message)) return;
  const id = message.id;
  assert.ok(typeof id === "string" || typeof id === "number");
  if ("result" in message) {
    assert.ok(call);
    assert.equal(id, `question-${call.responses.length}`);
    const response = message.result;
    assert.ok(typeof response === "object" && response !== null && "action" in response);
    call.responses.push(response);
    record(`answer:${String(response.action)}`);
    if (response.action === "accept" && call.responses.length < 2) question(call);
    else {
      record(`done:${call.value}`);
      write({
        id: call.id,
        result: {
          content: [{ type: "text", text: "Answered" }],
          structuredContent: { marker: call.marker, value: call.value, responses: call.responses },
        },
      });
      call = undefined;
    }
    return;
  }
  assert.ok("method" in message);
  switch (message.method) {
    case "initialize":
      write({
        id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "stdio-input-fixture", version: "1" },
        },
      });
      break;
    case "tools/list":
      record("list");
      write({
        id,
        result: {
          tools: [
            {
              name: "ask",
              description: "Ask inside a running process",
              inputSchema: { type: "object", properties: { value: { type: "string" } } },
            },
          ],
        },
      });
      break;
    case "tools/call": {
      const params = "params" in message ? message.params : undefined;
      assert.ok(typeof params === "object" && params !== null);
      const args = "arguments" in params ? params.arguments : undefined;
      const value =
        typeof args === "object" && args !== null && "value" in args
          ? String(args.value)
          : "fixture";
      call = { id, marker: crypto.randomUUID(), value, responses: [] };
      record(`call:${value}`);
      question(call);
      break;
    }
    default:
      write({ id, result: {} });
  }
});
