// Fixture for mcp-liveness-second-spawn.test.ts. A stdio MCP server that
// models a SINGLE-INSTANCE local server — the shape Chrome DevTools MCP,
// Playwright MCP and anything else that owns a browser, a debug port or a
// lock file has: a second concurrent process cannot start, and says so on
// stderr before exiting non-zero.
//
// argv[2] is the lock file, argv[3] a spawn log the test reads to count how
// many child processes a code path created. Every spawn appends its PID, so
// "did the health probe reuse a connection or start a new process?" is
// answerable from the file alone.

import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const lockFile = process.argv[2];
const spawnLog = process.argv[3];
if (lockFile === undefined || spawnLog === undefined) {
  process.stderr.write("usage: stdio-single-instance-test-server.ts <lock-file> <spawn-log>\n");
  process.exit(2);
}

appendFileSync(spawnLog, `${process.pid}\n`);

const isAlive = (pid: number): boolean => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: standalone non-Effect fixture process; kill(pid, 0) reports "gone" only by throwing
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

if (existsSync(lockFile)) {
  const holder = Number(readFileSync(lockFile, "utf8").trim());
  if (Number.isFinite(holder) && holder !== process.pid && isAlive(holder)) {
    // Exactly what a single-instance local server does when something already
    // owns the resource: refuse to start and exit non-zero.
    process.stderr.write(
      `single-instance server: another instance (${holder}) is already running\n`,
    );
    process.exit(1);
  }
}

writeFileSync(lockFile, String(process.pid));

const release = (): void => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: fixture teardown must not throw on an already-removed lock
  try {
    if (existsSync(lockFile) && readFileSync(lockFile, "utf8").trim() === String(process.pid)) {
      unlinkSync(lockFile);
    }
  } catch {
    // already gone
  }
};
process.on("exit", release);
process.on("SIGTERM", () => {
  release();
  process.exit(0);
});

const respond = (message: object): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const handle = (line: string): void => {
  if (!line.trim()) return;
  let request: {
    id?: number;
    method?: string;
    params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
  };
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: standalone fixture process; a malformed frame is dropped like a real server would
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: hand-rolled JSON-RPC framing is the fixture's entire purpose
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method === "initialize") {
    respond({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "stdio-single-instance-test-server", version: "0.0.0" },
      },
    });
  } else if (request.method === "tools/list") {
    respond({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "whoami",
            description: "whoami",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      },
    });
  } else if (request.method === "tools/call") {
    respond({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: `served by ${process.pid}` }],
        isError: false,
      },
    });
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
process.stdin.on("end", () => {
  release();
  process.exit(0);
});
