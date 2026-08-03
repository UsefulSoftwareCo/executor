#!/usr/bin/env node

// Reads the start message with raw fd reads instead of a stdin stream: only
// an unwatched fd can be closed here, since libuv aborts the process when
// fd 0 is closed while a stream watcher is attached, and a stream destroy()
// never closes the underlying stdio fd, so the host's writes would keep
// succeeding instead of failing with EPIPE.

import { closeSync, readSync } from "node:fs";

let buffered = "";
const chunk = Buffer.alloc(4096);
while (!buffered.includes("\n")) {
  try {
    const bytesRead = readSync(0, chunk, 0, chunk.length);
    if (bytesRead <= 0) break;
    buffered += chunk.toString("utf8", 0, bytesRead);
  } catch (error) {
    if (error.code === "EAGAIN") continue;
    throw error;
  }
}

const { nonce } = JSON.parse(buffered.slice(0, buffered.indexOf("\n")));

closeSync(0);
process.stdout.write(
  `@@executor-ipc@@${JSON.stringify({
    type: "tool_call",
    nonce,
    requestId: "request-1",
    toolPath: "test.call",
    args: {},
  })}\n`,
);

setTimeout(() => process.exit(0), 5_000);
