import { describe, expect, it } from "@effect/vitest";

import { sanitizeCliOutputText, shellQuoteArg } from "./tooling";

describe("shellQuoteArg", () => {
  it("quotes single quotes without breaking the shell argument", () => {
    expect(shellQuoteArg(`{"name":"owner's repo"}`)).toBe(`'{"name":"owner'"'"'s repo"}'`);
  });

  it("leaves simple values readable", () => {
    expect(shellQuoteArg("exec_123")).toBe("exec_123");
  });
});

describe("sanitizeCliOutputText", () => {
  it("removes terminal control sequences from tool metadata", () => {
    expect(sanitizeCliOutputText("safe\u001b[2J\u001b]0;title\u0007 text\u0000")).toBe("safe text");
  });

  it("preserves readable multiline content", () => {
    expect(sanitizeCliOutputText("type Input = {\n\tname: string\n}")).toBe(
      "type Input = {\n\tname: string\n}",
    );
  });
});
