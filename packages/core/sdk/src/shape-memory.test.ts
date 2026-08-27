import { describe, expect, it } from "@effect/vitest";

import { inferShape } from "./shape-inference";
import { hasShapeSlots, SHAPE_SLOT_KEY, spliceObservedSlots } from "./shape-memory";

// The MCP CallToolResult envelope shape: declared structure around one
// synthesized placeholder slot.
const envelope = {
  type: "object",
  properties: {
    content: { type: "array", items: { type: "object" } },
    structuredContent: { type: "object", [SHAPE_SLOT_KEY]: true },
    isError: { const: false },
  },
  required: ["content"],
};

describe("hasShapeSlots", () => {
  it("finds a marked slot nested in properties", () => {
    expect(hasShapeSlots(envelope)).toBe(true);
  });

  it("reports false for unmarked schemas", () => {
    expect(hasShapeSlots({ type: "object", properties: { a: { type: "string" } } })).toBe(false);
    expect(hasShapeSlots(undefined)).toBe(false);
  });
});

describe("spliceObservedSlots", () => {
  it("fills the marked slot from the observed counterpart and strips the marker", () => {
    const observed = inferShape({
      content: [{ type: "text", text: "x" }],
      structuredContent: { value: "x", length: 1, ok: true },
    });
    const { schema, filled } = spliceObservedSlots(envelope, observed);
    expect(filled).toBe(1);
    const out = schema as { properties: Record<string, Record<string, unknown>> };
    expect(out.properties["structuredContent"]?.[SHAPE_SLOT_KEY]).toBeUndefined();
    expect(out.properties["structuredContent"]).toMatchObject({
      type: "object",
      properties: {
        value: { type: "string" },
        length: { type: "number" },
        ok: { type: "boolean" },
      },
    });
    // The declared structure around the slot is untouched.
    expect(out.properties["content"]).toEqual(envelope.properties.content);
    expect(out.properties["isError"]).toEqual(envelope.properties.isError);
  });

  it("keeps the placeholder and reports zero when the observation lacks the slot", () => {
    const observed = inferShape({ content: [{ type: "text", text: "x" }] });
    const { schema, filled } = spliceObservedSlots(envelope, observed);
    expect(filled).toBe(0);
    const out = schema as { properties: Record<string, Record<string, unknown>> };
    expect(out.properties["structuredContent"]?.[SHAPE_SLOT_KEY]).toBeUndefined();
    expect(out.properties["structuredContent"]?.["type"]).toBe("object");
  });

  it("strips markers even with no observation at all", () => {
    const { schema, filled } = spliceObservedSlots(envelope, null);
    expect(filled).toBe(0);
    expect(JSON.stringify(schema)).not.toContain(SHAPE_SLOT_KEY);
  });

  it("descends through items to reach nested slots", () => {
    const declared = {
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object", [SHAPE_SLOT_KEY]: true } },
      },
    };
    const observed = inferShape({ rows: [{ id: 7 }] });
    const { schema, filled } = spliceObservedSlots(declared, observed);
    expect(filled).toBe(1);
    const out = schema as {
      properties: { rows: { items: Record<string, unknown> } };
    };
    expect(out.properties.rows.items).toMatchObject({
      type: "object",
      properties: { id: { type: "number" } },
    });
  });
});
