// Fixture for stdio-interrupt-cleanup.test.ts. A minimal legacy-handshake MCP
// server that stands in for a `docker run -i --rm` stdio integration: it
// writes its PID to the file named by argv so the test can observe process
// lifetime, and it exits only when stdin closes or it is signalled (the same
// exit contract as the docker CLI). The mode argument controls the initialize
// reply: "fast" answers immediately, "slow" answers after 3s (keeps the
// handshake in flight so the test can interrupt mid-connect), "never" withholds
// it (a wedged server, for the discovery-timeout path).

import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
const mode = process.argv[3] ?? "fast";
if (pidFile === undefined) {
  process.stderr.write("usage: stdio-interrupt-test-server.ts <pid-file> [fast|slow|never]\n");
  process.exit(2);
}
writeFileSync(pidFile, String(process.pid));

const respond = (message: object): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const handle = (line: string): void => {
  if (!line.trim()) return;
  let request: { id?: number; method?: string; params?: { protocolVersion?: string } };
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: standalone non-Effect fixture process; a malformed frame is silently dropped like a real server would
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: hand-rolled JSON-RPC framing is the fixture's entire purpose (it must control handshake timing below the SDK)
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method === "initialize") {
    const reply = () =>
      respond({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "stdio-interrupt-test-server", version: "0.0.0" },
        },
      });
    if (mode === "slow") setTimeout(reply, 3_000);
    else if (mode !== "never") reply();
  } else if (request.method === "tools/list") {
    respond({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
  } else if (request.id !== undefined) {
    respond({ jsonrpc: "2.0", id: request.id, result: {} });
  }
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    handle(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
