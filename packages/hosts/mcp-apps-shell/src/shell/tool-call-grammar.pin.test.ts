import { describe, expect, it } from "@effect/vitest";
import { formatToolCallCode, parseToolCallCode } from "@executor-js/host-mcp/tool-call-code";

import { toolCallCode } from "./proxy";

// `execute-action` accepts exactly one grammar, and two packages have to agree
// on it: the shell EMITS it (`toolCallCode`) and the MCP host PARSES it
// (`parseToolCallCode`). They cannot import each other's implementation — the
// host must stay free of React — so this test is the pin. Loosen either side
// alone and it fails here rather than at runtime inside a user's widget.
describe("execute-action tool-call grammar", () => {
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly path: readonly string[];
    readonly args: readonly unknown[];
  }> = [
    { label: "no arguments", path: ["inventory", "org", "main", "listItems"], args: [] },
    {
      label: "a nested object argument",
      path: ["inventory", "org", "main", "updateDomainAutoRenew"],
      args: [{ domain: "openexecutor.com", body: { autoRenew: true } }],
    },
    {
      label: "strings needing escapes",
      path: ["github", "issues", "create"],
      args: [{ title: 'He said "hi"\nthen left', body: "a\\b" }],
    },
    {
      label: "a single-segment system tool",
      path: ["search"],
      args: [{ query: "github issues", limit: 12 }],
    },
    {
      label: "a hyphenated integration slug",
      path: ["cloudflare-bindings", "d1_database_query"],
      args: [{ database_id: "db", sql: "SELECT 1" }],
    },
    {
      label: "an argument with a $ in an identifier-ish key",
      path: ["mongo", "org", "main", "find"],
      args: [{ filter: { $gt: 3 } }],
    },
  ];

  for (const { label, path, args } of cases) {
    it(`round-trips ${label}`, () => {
      const parsed = parseToolCallCode(toolCallCode(path, args));
      expect(parsed).not.toBeNull();
      expect(parsed?.path).toEqual([...path]);
      expect(parsed?.args).toEqual(args[0] ?? {});
      expect(parsed?.role).toBeUndefined();
    });
  }

  // The role form: `tools.linear("prod").issues.list(args)`, an artifact using
  // two accounts of one integration. The role is a JSON string literal for the
  // same reason the args are, so a role containing a quote cannot break out.
  const roleCases: ReadonlyArray<{
    readonly label: string;
    readonly path: readonly string[];
    readonly role: string;
    readonly args: readonly unknown[];
  }> = [
    { label: "a role-tagged read", path: ["linear", "issues", "list"], role: "prod", args: [{}] },
    {
      label: "a role-tagged write with arguments",
      path: ["linear", "issues", "create"],
      role: "staging",
      args: [{ title: "Bug" }],
    },
    { label: "a role on a one-segment path", path: ["stripe"], role: "live", args: [] },
    {
      label: "a role needing escapes",
      path: ["linear", "issues", "list"],
      role: 'the "main" one',
      args: [{}],
    },
  ];

  for (const { label, path, role, args } of roleCases) {
    it(`round-trips ${label}`, () => {
      const parsed = parseToolCallCode(toolCallCode(path, args, role));
      expect(parsed).not.toBeNull();
      expect(parsed?.path).toEqual([...path]);
      expect(parsed?.role).toBe(role);
      expect(parsed?.args).toEqual(args[0] ?? {});
    });
  }

  it("formats a resolved hyphenated integration safely", () => {
    expect(formatToolCallCode(["cloudflare-bindings", "org", "default", "query"], {})).toBe(
      'return await tools["cloudflare-bindings"].org.default.query({})',
    );
  });

  it("refuses to emit a path that would not parse", () => {
    expect(() => toolCallCode([], [])).toThrow("Invalid tool path.");
    expect(() => toolCallCode(["github", "issues; drop"], [])).toThrow("Invalid tool path.");
    expect(() => toolCallCode(["github", "1bad"], [])).toThrow("Invalid tool path.");
    expect(() => toolCallCode(["github", "issues"], [], "")).toThrow("Invalid tool role.");
  });

  // The point of constraining the wire: an iframe posting straight at
  // `execute-action` cannot get anything wider through it.
  it("rejects code the proxy could never have produced", () => {
    const smuggled = [
      "return await tools.a.b(); await tools.c.d()",
      "for (let i = 0; i < 40; i++) { await tools.a.b({ page: i }) }",
      "const me = await tools.github.users.me(); return me",
      "return await fetch('https://evil.example')",
      "return await tools.a.b({ x: 1 }) + 1",
      "return await tools.a.b(someVariable)",
      "return await tools.a.b({ x: undefined })",
      "return 42",
      "",
    ];
    for (const code of smuggled) {
      expect(parseToolCallCode(code), code).toBeNull();
    }
  });
});
