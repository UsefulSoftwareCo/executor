import { describe, expect, it } from "@effect/vitest";

import { ToolResult } from "./tool-result";
import { applyResultEncoding, normalizeMcpCallToolResult } from "./tool-result-normalization";

const text = (value: string) => ({ type: "text", text: value });
const image = { type: "image", data: "aGk=", mimeType: "image/png" };

describe("normalizeMcpCallToolResult", () => {
  it("serves structuredContent as data and suppresses its serialized duplicate", () => {
    const structured = { issues: [{ id: 1, title: "a" }], total: 1 };
    const normalized = normalizeMcpCallToolResult({
      content: [text(JSON.stringify(structured))],
      structuredContent: structured,
    });
    expect(normalized.data).toEqual(structured);
    expect(normalized.content).toBeUndefined();
  });

  it("suppresses a key-order-shuffled duplicate but keeps genuine extra prose", () => {
    const structured = { a: 1, b: { c: [1, 2] } };
    const normalized = normalizeMcpCallToolResult({
      content: [text('{"b":{"c":[1,2]},"a":1}'), text("2 results, capped at 100.")],
      structuredContent: structured,
    });
    expect(normalized.data).toEqual(structured);
    expect(normalized.content).toEqual([text("2 results, capped at 100.")]);
  });

  it("keeps media blocks beside structured data", () => {
    const normalized = normalizeMcpCallToolResult({
      content: [image],
      structuredContent: { name: "chart.png" },
    });
    expect(normalized.data).toEqual({ name: "chart.png" });
    expect(normalized.content).toEqual([image]);
  });

  it("parses a lone exact-JSON text block into data", () => {
    const normalized = normalizeMcpCallToolResult({
      content: [text('  {"issues":[{"id":7}],"total":1} ')],
    });
    expect(normalized.data).toEqual({ issues: [{ id: 7 }], total: 1 });
  });

  it("parses a lone JSON array text block", () => {
    expect(normalizeMcpCallToolResult({ content: [text("[1,2,3]")] }).data).toEqual([1, 2, 3]);
  });

  it("keeps prose, fenced JSON, bare literals, and broken JSON as strings", () => {
    expect(normalizeMcpCallToolResult({ content: [text("No incidents found.")] }).data).toBe(
      "No incidents found.",
    );
    expect(normalizeMcpCallToolResult({ content: [text('```json\n{"a":1}\n```')] }).data).toBe(
      '```json\n{"a":1}\n```',
    );
    expect(normalizeMcpCallToolResult({ content: [text("42")] }).data).toBe("42");
    expect(normalizeMcpCallToolResult({ content: [text('"quoted"')] }).data).toBe('"quoted"');
    expect(normalizeMcpCallToolResult({ content: [text('{"a":')] }).data).toBe('{"a":');
  });

  it("returns null for an empty result", () => {
    expect(normalizeMcpCallToolResult({ content: [] }).data).toBeNull();
  });

  it("returns the ordered block array for multi-block and media-only results", () => {
    const blocks = [text("caption"), image];
    expect(normalizeMcpCallToolResult({ content: blocks }).data).toEqual(blocks);
    expect(normalizeMcpCallToolResult({ content: [image] }).data).toEqual([image]);
  });

  it("preserves unknown future block types", () => {
    const exotic = { type: "hologram", payload: "??" };
    expect(normalizeMcpCallToolResult({ content: [text("x"), exotic] }).data).toEqual([
      text("x"),
      exotic,
    ]);
  });

  it("moves _meta beside data", () => {
    const normalized = normalizeMcpCallToolResult({
      content: [text('{"a":1}')],
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "s" } },
    });
    expect(normalized.data).toEqual({ a: 1 });
    expect(normalized.meta).toEqual({ "io.modelcontextprotocol/serverInfo": { name: "s" } });
  });

  it("passes non-envelope values through untouched", () => {
    expect(normalizeMcpCallToolResult({ rows: [1] }).data).toEqual({ rows: [1] });
    expect(normalizeMcpCallToolResult("plain").data).toBe("plain");
    expect(normalizeMcpCallToolResult(null).data).toBeNull();
  });
});

describe("applyResultEncoding", () => {
  it("leaves direct results and failures untouched", () => {
    const ok = ToolResult.ok({ content: [text("looks like an envelope but is direct data")] });
    expect(applyResultEncoding("direct", ok)).toBe(ok);
    const fail = ToolResult.fail({ code: "mcp_tool_error", message: "boom" });
    expect(applyResultEncoding("mcp-call-tool-result-v2", fail)).toBe(fail);
  });

  it("normalizes v2-encoded successes into semantic data with side channels", () => {
    const applied = applyResultEncoding(
      "mcp-call-tool-result-v2",
      ToolResult.ok({
        content: [image],
        structuredContent: { ok: true },
        _meta: { trace: 1 },
      }),
    );
    expect(applied).toEqual({
      ok: true,
      data: { ok: true },
      content: [image],
      meta: { trace: 1 },
    });
  });
});
