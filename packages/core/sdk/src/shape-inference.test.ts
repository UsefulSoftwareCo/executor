import { describe, expect, it } from "@effect/vitest";

import { inferShape, mergeShapes, observeShape, type InferredShape } from "./shape-inference";

describe("inferShape", () => {
  it("infers primitives without recording values", () => {
    expect(inferShape("secret token")).toEqual({ type: "string" });
    expect(inferShape(42)).toEqual({ type: "number" });
    expect(inferShape(true)).toEqual({ type: "boolean" });
    expect(inferShape(null)).toEqual({ type: "null" });
    expect(inferShape(undefined)).toEqual({ type: "null" });
  });

  it("infers object structure with all keys required", () => {
    expect(inferShape({ id: "abc", count: 3 })).toEqual({
      type: "object",
      properties: { id: { type: "string" }, count: { type: "number" } },
      required: ["count", "id"],
    });
  });

  it("merges sampled array elements into one item shape", () => {
    expect(inferShape([{ id: 1 }, { id: 2, label: "x" }])).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "number" }, label: { type: "string" } },
        required: ["id"],
      },
    });
  });

  it("keeps an empty array itemless", () => {
    expect(inferShape([])).toEqual({ type: "array" });
  });

  it("collapses wide objects to a map so data-bearing keys never persist", () => {
    const byEmail = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`user${i}@example.com`, { active: true }]),
    );
    const shape = inferShape(byEmail);
    expect(shape.properties).toBeUndefined();
    expect(shape.additionalProperties).toEqual({
      type: "object",
      properties: { active: { type: "boolean" } },
      required: ["active"],
    });
  });

  it("degrades to unknown past the depth bound", () => {
    let value: unknown = "leaf";
    for (let i = 0; i < 10; i++) value = { child: value };
    const json = JSON.stringify(inferShape(value));
    expect(json).toContain("{}");
  });
});

describe("mergeShapes", () => {
  it("makes fields missing from one observation optional", () => {
    const merged = mergeShapes(inferShape({ id: "a", email: "x@y.z" }), inferShape({ id: "b" }));
    expect(merged).toEqual({
      type: "object",
      properties: { id: { type: "string" }, email: { type: "string" } },
      required: ["id"],
    });
  });

  it("unions differing primitive types", () => {
    expect(mergeShapes({ type: "string" }, { type: "number" })).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
  });

  it("merges same-typed union branches instead of duplicating them", () => {
    const union = mergeShapes({ type: "string" }, { type: "null" });
    const widened = mergeShapes(union, inferShape({ id: 1 }));
    const again = mergeShapes(widened, inferShape({ id: 2, extra: true }));
    expect(again.anyOf).toHaveLength(3);
    const objectBranch = again.anyOf?.find((branch) => branch.type === "object");
    expect(objectBranch?.required).toEqual(["id"]);
  });

  it("degrades to unknown when the union grows past its cap", () => {
    const wide = [
      { type: "string" } as const,
      { type: "number" } as const,
      { type: "boolean" } as const,
      { type: "null" } as const,
      { type: "array" } as const,
    ].reduce<InferredShape>((left, right) => mergeShapes(left, right), { type: "string" });
    expect(wide).toEqual({});
  });

  it("merges array item shapes across calls", () => {
    const merged = mergeShapes(inferShape([{ id: 1 }]), inferShape([{ id: 2, done: false }]));
    expect(merged).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "number" }, done: { type: "boolean" } },
        required: ["id"],
      },
    });
  });
});

describe("observeShape", () => {
  it("starts a record from the first observation", () => {
    const record = observeShape(null, { ok: true }, 1000);
    expect(record.observations).toBe(1);
    expect(record.updatedAt).toBe(1000);
    expect(record.schema.type).toBe("object");
  });

  it("accumulates observations by merging", () => {
    const first = observeShape(null, { id: "a", email: "x@y.z" }, 1000);
    const second = observeShape(first, { id: "b" }, 2000);
    expect(second.observations).toBe(2);
    expect(second.updatedAt).toBe(2000);
    expect(second.schema.required).toEqual(["id"]);
    expect(Object.keys(second.schema.properties ?? {}).sort()).toEqual(["email", "id"]);
  });

  it("stays under the serialized size bound for adversarial payloads", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 24 }, (_, i) => [
        `field_with_a_rather_long_name_${i}`,
        Object.fromEntries(
          Array.from({ length: 24 }, (_, j) => [`nested_property_name_${j}`, { deep: { x: 1 } }]),
        ),
      ]),
    );
    const record = observeShape(null, wide, 1000);
    expect(JSON.stringify(record.schema).length).toBeLessThanOrEqual(16_000);
  });
});
