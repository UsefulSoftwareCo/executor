// Cross-target: the MCP surface — connect with fully headless OAuth (DCR →
// consent → code → token) and run code in the sandbox, exactly as an MCP
// client (Claude, Cursor, …) would.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";

scenario(
  "MCP · OAuth connect, then execute code in the sandbox",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const session = mcp.session(identity);

    const tools = yield* session.listTools();
    expect(tools, "the execute tool is advertised").toContain("execute");

    const result = yield* session.call("execute", { code: "return 6 * 7;" });
    expect(result.text, "the sandbox returns the value").toBe("42");
  }),
);
