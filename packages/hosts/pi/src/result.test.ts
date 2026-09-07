import { describe, expect, it } from "@effect/vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { resultText, toPiContent } from "./result";

const result = (content: CallToolResult["content"]): CallToolResult => ({ content });

describe("toPiContent", () => {
  it("passes text through", () => {
    expect(toPiContent(result([{ type: "text", text: "ran: 1 + 1" }]))).toEqual([
      { type: "text", text: "ran: 1 + 1" },
    ]);
  });

  it("passes images through — Pi renders them", () => {
    expect(toPiContent(result([{ type: "image", data: "aGk=", mimeType: "image/png" }]))).toEqual([
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ]);
  });

  it("keeps the text of an inline text resource", () => {
    expect(
      toPiContent(
        result([
          { type: "resource", resource: { uri: "file:///notes.txt", text: "hello from a file" } },
        ]),
      ),
    ).toEqual([{ type: "text", text: "hello from a file" }]);
  });

  it("names what it dropped for content Pi cannot carry", () => {
    const content = toPiContent(
      result([
        { type: "audio", data: "aGk=", mimeType: "audio/mpeg" },
        {
          type: "resource",
          resource: { uri: "file:///clip.bin", mimeType: "application/octet-stream", blob: "aGk=" },
        },
      ]),
    );
    // Executor precedes each binary block with its own "File output: …" line,
    // so the model still knows what exists; only the bytes are gone.
    expect(content).toEqual([
      {
        type: "text",
        text: "[audio/mpeg audio omitted — Pi tool results carry text and images only]",
      },
      {
        type: "text",
        text: "[resource file:///clip.bin omitted — Pi tool results carry text and images only]",
      },
    ]);
  });

  it("never returns empty content", () => {
    expect(toPiContent(result([]))).toEqual([
      { type: "text", text: "Executor returned no content." },
    ]);
  });
});

describe("resultText", () => {
  it("joins the text blocks, which is all a thrown error can carry", () => {
    expect(
      resultText(
        result([
          { type: "text", text: "Error: policy blocked github.createIssue" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
          { type: "text", text: "Ask the user to approve it." },
        ]),
      ),
    ).toBe("Error: policy blocked github.createIssue\nAsk the user to approve it.");
  });

  it("is empty when there is no text to report", () => {
    expect(resultText(result([{ type: "image", data: "aGk=", mimeType: "image/png" }]))).toBe("");
  });
});
