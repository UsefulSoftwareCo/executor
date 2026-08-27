import { describe, expect, it } from "@effect/vitest";

import { typeCheckOutputTypeScript } from "./tool-output-contract";

describe("typeCheckOutputTypeScript", () => {
  it("accepts runtime output that matches the described TypeScript contract", () => {
    // Semantic data contract: `data` IS the payload; supplemental blocks ride
    // in `content` beside it.
    const diagnostics = typeCheckOutputTypeScript(
      {
        outputTypeScript: "{ ok: true; data: Payload; content?: readonly Block[] }",
        typeScriptDefinitions: {
          Payload: "{ answer: string }",
          Block: '{ type: "text"; text: string }',
        },
      },
      {
        ok: true,
        data: { answer: "done" },
        content: [{ type: "text", text: "done" }],
      },
      {
        consumerSource: "const answer: string = invokedOutput.data.answer; answer;",
      },
    );

    expect(diagnostics).toEqual([]);
  });

  it("reports when runtime output does not match the described payload", () => {
    const diagnostics = typeCheckOutputTypeScript(
      {
        outputTypeScript: "{ ok: true; data: { answer: string } }",
      },
      {
        ok: true,
        data: { reply: "done" },
      },
    );

    expect(diagnostics.join("\n")).toContain("answer");
  });

  it("reports missing output TypeScript contracts", () => {
    expect(typeCheckOutputTypeScript({}, { ok: true })).toEqual(["missing outputTypeScript"]);
  });
});
