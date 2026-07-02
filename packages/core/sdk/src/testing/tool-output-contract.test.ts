import { describe, expect, it } from "@effect/vitest";

import { typeCheckOutputTypeScript } from "./tool-output-contract";

describe("typeCheckOutputTypeScript", () => {
  it("accepts runtime output that matches the described TypeScript contract", () => {
    const diagnostics = typeCheckOutputTypeScript(
      {
        outputTypeScript: "{ ok: true; data: ResultData }",
        typeScriptDefinitions: {
          Payload: "{ answer: string }",
          ResultData:
            '{ content: readonly { type: "text"; text: string }[]; structuredContent: Payload }',
        },
      },
      {
        ok: true,
        data: {
          content: [{ type: "text", text: "done" }],
          structuredContent: { answer: "done" },
        },
      },
      {
        consumerSource:
          "const answer: string = invokedOutput.data.structuredContent.answer; answer;",
      },
    );

    expect(diagnostics).toEqual([]);
  });

  it("reports when the described contract omits the runtime output wrapper", () => {
    const diagnostics = typeCheckOutputTypeScript(
      {
        outputTypeScript: "{ ok: true; data: { answer: string } }",
      },
      {
        ok: true,
        data: {
          content: [{ type: "text", text: "done" }],
          structuredContent: { answer: "done" },
        },
      },
    );

    expect(diagnostics.join("\n")).toContain("answer");
  });

  it("reports missing output TypeScript contracts", () => {
    expect(typeCheckOutputTypeScript({}, { ok: true })).toEqual(["missing outputTypeScript"]);
  });
});
