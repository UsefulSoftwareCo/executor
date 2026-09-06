import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { McpConnection, McpConnector } from "./connection";
import { discoverTools } from "./discover";

const discoveryClient = (): McpConnection["client"] =>
  Object.assign(Object.create(null) as McpConnection["client"], {
    listTools: () => Promise.resolve({ tools: [] }),
    getServerVersion: () => ({ name: "hanging-close", version: "1.0.0" }),
    getInstructions: () => undefined,
    setRequestHandler: () => undefined,
  });

const hangingCloseConnector = (state: { closeStarted: boolean }): McpConnector =>
  Effect.succeed({
    client: discoveryClient(),
    close: () => {
      state.closeStarted = true;
      return new Promise<void>(() => {});
    },
  });

describe("MCP discovery teardown", () => {
  it.live("does not strand discovery when close never settles", () =>
    Effect.gen(function* () {
      const state = { closeStarted: false };
      const manifest = yield* discoverTools(hangingCloseConnector(state));

      expect(state.closeStarted).toBe(true);
      expect(manifest.server).toEqual({
        name: "hanging-close",
        version: "1.0.0",
        instructions: null,
      });
      expect(manifest.tools).toEqual([]);
    }),
  );
});
