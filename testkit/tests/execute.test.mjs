import { mcpTarget, mcpTest, cookieConsentStrategy } from "../src/testkit.mjs";

// the per-host seam: self-host dev + headless OAuth (no browser, runs in CI)
export const selfhost = mcpTarget({
  name: "selfhost",
  server: "http://localhost:5173/mcp",
  consent: cookieConsentStrategy({
    appBaseUrl: "http://localhost:5173",
    email: "admin@demo.test",
    password: "demo-password-12345",
  }),
});

mcpTest("execute runs code in the sandbox and returns its value", selfhost, async (mcp) => {
  mcp.say("Confirm the sandbox evaluates a program and returns the value.");
  const tools = await mcp.listTools();
  mcp.expect(tools).toContain("execute");
  const r = await mcp.call("execute", { code: "return 6 * 7;" });
  mcp.expect(r.text).toBe("42");
});

mcpTest("execute can use string operations", selfhost, async (mcp) => {
  const r = await mcp.call("execute", { code: "return 'mcp'.toUpperCase();" });
  mcp.expect(r.text).toBe("MCP");
});
