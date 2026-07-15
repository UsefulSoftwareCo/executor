import { Effect } from "effect";

import { makeInProcessAppToolExecutor } from "./app-tool-executor";

const bundle = `
  export default {
    "~executorAppTool": true,
    description: "Fast",
    input: undefined,
    handler() { return { ok: true }; },
  };
`;

await Effect.runPromise(
  makeInProcessAppToolExecutor().invoke(
    bundle,
    { toolName: "fast" },
    {},
    { call: async () => null },
    { timeoutMs: 30_000 },
  ),
);

process.stdout.write("invocation complete\n");
