// Selfhost: emit() output actually reaches the MCP client's content blocks,
// not merely the `emitted` count in the envelope. Regression coverage for
// issue #1592 — a self-hosted user saw a non-zero `emitted` count but no
// content blocks in the tool result, only `logs` and the return value. There
// is cloud coverage for the envelope count
// (`e2e/cloud/execute-emit-envelope.test.ts`), but nothing that asserts on
// the wire-level `content` array on self-host, and nothing on either target
// that covers all three emit shapes from the report: a plain string, a
// ToolFile, and a structured/object value.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";

interface ContentBlock {
  readonly type: string;
  readonly text?: string;
}

// Mirrors the issue's repro exactly: a plain string emit, a ToolFile emit, a
// structured/object emit, then a return.
const EXECUTE_CODE = `
const attachment = {
  _tag: "ToolFile",
  name: "report.txt",
  mimeType: "text/plain",
  encoding: "base64",
  data: "aGVsbG8gZmlsZQ==",
  byteLength: 10,
};
emit("plain string emit");
emit(attachment);
emit({ hello: "object emit" });
return { returnedValue: "this is the return" };
`;

scenario(
  "Execute · emit() output reaches the MCP client's content blocks",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const session = mcp.session(identity);

    const result = yield* session.call("execute", { code: EXECUTE_CODE });
    expect(result.ok, `execute completed (got: ${result.text.slice(0, 300)})`).toBe(true);

    const structured = (result.raw as { structuredContent?: Record<string, unknown> })
      .structuredContent;
    expect(structured?.status, "the run completed").toBe("completed");
    expect(structured?.emitted, "the envelope counts all three emitted items").toBe(3);
    expect(structured?.result, "the return value still comes back to the caller").toEqual({
      returnedValue: "this is the return",
    });

    // The real assertion: the JSON-RPC tool result's `content` array — what
    // an MCP client actually renders — carries all three emitted items, not
    // just the `emitted` count.
    const content = (result.raw as { content?: ContentBlock[] }).content ?? [];
    expect(Array.isArray(content) && content.length > 0, "the wire result carries content").toBe(
      true,
    );

    expect(
      content.some((block) => block.type === "text" && block.text === "plain string emit"),
      `content carries the plain string emit; got: ${JSON.stringify(content)}`,
    ).toBe(true);

    // A text-mimetype ToolFile renders as a summary line plus its decoded
    // text content (see outputFileContent/toolFileContent in tool-server.ts).
    expect(
      content.some(
        (block) =>
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.includes("report.txt"),
      ),
      `content carries the ToolFile emit's summary line; got: ${JSON.stringify(content)}`,
    ).toBe(true);
    expect(
      content.some((block) => block.type === "text" && block.text === "hello file"),
      `content carries the ToolFile emit's decoded text; got: ${JSON.stringify(content)}`,
    ).toBe(true);

    // A plain object emit is not a ToolFile or an MCP content block, so it
    // falls back to a JSON text block.
    expect(
      content.some((block) => block.type === "text" && block.text === '{"hello":"object emit"}'),
      `content carries the structured/object emit; got: ${JSON.stringify(content)}`,
    ).toBe(true);
  }),
);
