#!/usr/bin/env node

import { closeSync } from "node:fs";
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });

input.once("line", (line) => {
  const { nonce } = JSON.parse(line);

  input.close();
  process.stdin.destroy();
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
});
