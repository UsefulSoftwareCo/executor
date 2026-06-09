// Cross-target: the MCP surface — connect with fully headless OAuth (DCR →
// consent → code → token) and run code in the sandbox, exactly as an MCP
// client (Claude, Cursor, …) would. The whole OAuth lifecycle lands in the
// transcript as auth turns.
import { Effect } from "effect";

import { scenario } from "../src/scenario";

scenario("MCP · OAuth connect, then execute code in the sandbox", { needs: ["mcp-oauth"] }, (ctx) =>
  Effect.gen(function* () {
    ctx.rec.say("Connect an MCP client (headless OAuth) and confirm the sandbox evaluates code.");
    const identity = yield* ctx.target.newIdentity();
    const session = ctx.mcp.session(identity);

    const tools = yield* session.listTools();
    ctx.rec.expect(tools, "the execute tool is advertised").toContain("execute");

    const result = yield* session.call("execute", { code: "return 6 * 7;" });
    ctx.rec.expect(result.text, "the sandbox returns the value").toBe("42");
  }),
);
