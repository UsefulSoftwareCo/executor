import { describe, expect, it } from "@effect/vitest";

import { stripTypeScript } from "./strip-types";

describe("stripTypeScript", () => {
  it("removes variable type annotations", () => {
    const out = stripTypeScript('const x: string = "hello"; return x;');
    expect(out).not.toContain(": string");
    expect(out).toContain("const x");
    expect(out).toContain('"hello"');
  });

  it("removes function param and return type annotations", () => {
    const out = stripTypeScript("function f(x: number): number { return x + 1; } return f(5);");
    expect(out).not.toContain(": number");
    // Result must still parse as JS — verify by Function ctor.
    expect(() => new Function(out)).not.toThrow();
  });

  it("removes `as` casts", () => {
    const out = stripTypeScript("const x = (1 as number) + 2; return x;");
    expect(out).not.toContain("as number");
    expect(() => new Function(out)).not.toThrow();
  });

  it("removes generic type arguments on call expressions", () => {
    const out = stripTypeScript("const arr = Array.from<string>([]); return arr;");
    expect(out).not.toContain("<string>");
    expect(() => new Function(out)).not.toThrow();
  });

  it("removes interface declarations", () => {
    const out = stripTypeScript(
      "interface User { name: string; } const u = { name: 'a' }; return u;",
    );
    expect(out).not.toContain("interface User");
    expect(out).not.toContain(": string");
    expect(() => new Function(out)).not.toThrow();
  });

  it("removes type alias declarations", () => {
    const out = stripTypeScript("type Foo = string; const x = 'a'; return x;");
    expect(out).not.toContain("type Foo");
    expect(() => new Function(out)).not.toThrow();
  });

  it("preserves plain JavaScript unchanged in semantics", () => {
    const out = stripTypeScript("const x = 5; return x * 2;");
    expect(new Function(out)()).toBe(10);
  });

  it("rejects truly invalid syntax", () => {
    // No TS interpretation will save this — sucrase should throw.
    expect(() => stripTypeScript("const = 5;")).toThrow();
  });

  it("regression: customer's failure shape (`Unexpected token ':'`)", () => {
    // Closest reasonable shape to the trace at
    // axiom://7bf76f79c5d807272781e9554040aab3 — typed annotation in
    // a function expression.
    const code = `
      const fetchResources = async (sourceId: string): Promise<Array<{ id: string }>> => {
        const result = await tools.executor.sources.list();
        return result.items;
      };
      return fetchResources('example-source');
    `;
    const out = stripTypeScript(code);
    expect(out).not.toContain(": string");
    expect(out).not.toContain("Promise<");
    // Still parses as JS (we don't actually invoke `tools` here).
    expect(() => new Function(out)).not.toThrow();
  });
});
