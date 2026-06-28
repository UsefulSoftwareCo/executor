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

scenario(
  "MCP · a syntax error returns a descriptive message, not an opaque internal error",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const session = mcp.session(identity);

    // A genuine parse error (a `const` with no binding) is the user's own
    // mistake, surfaced before the code ever runs. The model needs the real
    // reason to self-correct, so the sandbox must report it descriptively
    // instead of collapsing it to "Internal tool error [id]".
    const result = yield* session.call("execute", {
      code: "const = 5; return 1;",
    });

    expect(result.ok, "a syntax error is reported as an error result").toBe(false);
    expect(result.text, "the parser's reason reaches the model").toContain("Unexpected");
    expect(result.text, "the opaque mask is not used for syntax errors").not.toContain(
      "Internal tool error",
    );
  }),
);
