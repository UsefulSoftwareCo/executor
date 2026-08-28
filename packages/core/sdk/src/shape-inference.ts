/**
 * Runtime output-shape inference — the "muscle memory" half of code mode.
 *
 * Most tools declare no output schema, so `tools.describe.tool()` renders
 * `data: unknown` and the model guesses response shapes. This module infers a
 * lightweight shape from real tool results at dispatch time: field names and
 * broad types only, never values. Shapes merge across calls, so unions and
 * optional fields converge instead of thrashing.
 *
 * The output is a small JSON Schema subset (`type`, `properties`, `required`,
 * `items`, `additionalProperties`, `anyOf`) so it can be stored as plain JSON
 * and rendered through the same schema → TypeScript compiler that declared
 * schemas use.
 *
 * Every dimension is bounded — depth, object width, array sampling, union
 * width, serialized size — because inference runs on the hot dispatch path
 * against arbitrary upstream payloads.
 */

export type InferredShape = {
  readonly type?: "null" | "boolean" | "number" | "string" | "object" | "array";
  readonly properties?: Readonly<Record<string, InferredShape>>;
  readonly required?: readonly string[];
  readonly items?: InferredShape;
  readonly additionalProperties?: InferredShape;
  readonly anyOf?: readonly InferredShape[];
};

/** `{}` — matches anything; the "we know nothing beyond this point" shape. */
const UNKNOWN: InferredShape = {};

const MAX_DEPTH = 6;
/** Array elements sampled per call; later calls keep widening the merge. */
const MAX_ARRAY_SAMPLE = 5;
/**
 * An object with more own keys than this is treated as a map keyed by data
 * (ids, emails, dates) rather than a struct. Collapsing to
 * `additionalProperties` keeps data-bearing keys out of the shape — field
 * names of a struct are API surface, but map keys are values.
 */
const MAX_OBJECT_KEYS = 24;
/** Union width cap; beyond this the shape degrades to unknown. */
const MAX_ANYOF = 4;

const isUnknown = (shape: InferredShape): boolean =>
  shape.type === undefined && shape.anyOf === undefined;

/** Infer the shape of one observed value. Reads structure only, never values. */
export const inferShape = (value: unknown, depth = 0): InferredShape => {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "string") return { type: "string" };
  if (depth >= MAX_DEPTH) return UNKNOWN;

  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array" };
    const sampled = value
      .slice(0, MAX_ARRAY_SAMPLE)
      .map((item) => inferShape(item, depth + 1))
      .reduce((left, right) => mergeShapes(left, right));
    return { type: "array", items: sampled };
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_OBJECT_KEYS) {
      const merged = entries
        .slice(0, MAX_ARRAY_SAMPLE)
        .map(([, item]) => inferShape(item, depth + 1))
        .reduce((left, right) => mergeShapes(left, right));
      return { type: "object", additionalProperties: merged };
    }
    const properties: Record<string, InferredShape> = {};
    for (const [key, item] of entries) {
      properties[key] = inferShape(item, depth + 1);
    }
    return { type: "object", properties, required: entries.map(([key]) => key).sort() };
  }

  // function / symbol / bigint — nothing useful to say structurally.
  return UNKNOWN;
};

const mergeObjectShapes = (left: InferredShape, right: InferredShape): InferredShape => {
  // A map-shaped observation absorbs struct-shaped ones: once keys look like
  // data, later struct keys are data too.
  if (left.additionalProperties !== undefined || right.additionalProperties !== undefined) {
    const values = [
      left.additionalProperties,
      right.additionalProperties,
      ...Object.values(left.properties ?? {}),
      ...Object.values(right.properties ?? {}),
    ].filter((shape): shape is InferredShape => shape !== undefined);
    return {
      type: "object",
      additionalProperties:
        values.length === 0 ? UNKNOWN : values.reduce((a, b) => mergeShapes(a, b)),
    };
  }

  const leftProps = left.properties ?? {};
  const rightProps = right.properties ?? {};
  const keys = [...new Set([...Object.keys(leftProps), ...Object.keys(rightProps)])].sort();
  if (keys.length > MAX_OBJECT_KEYS) {
    const values = keys
      .slice(0, MAX_ARRAY_SAMPLE)
      .map((key) => leftProps[key] ?? rightProps[key])
      .filter((shape): shape is InferredShape => shape !== undefined);
    return {
      type: "object",
      additionalProperties:
        values.length === 0 ? UNKNOWN : values.reduce((a, b) => mergeShapes(a, b)),
    };
  }

  const properties: Record<string, InferredShape> = {};
  for (const key of keys) {
    const a = leftProps[key];
    const b = rightProps[key];
    properties[key] = a !== undefined && b !== undefined ? mergeShapes(a, b) : (a ?? b ?? UNKNOWN);
  }
  const leftRequired = new Set(left.required ?? []);
  const required = (right.required ?? []).filter((key) => leftRequired.has(key)).sort();
  return { type: "object", properties, required };
};

/**
 * Merge two observed shapes into the narrowest shape matching both.
 * Same-typed shapes merge structurally; differently-typed shapes union into
 * `anyOf`, degrading to unknown past `MAX_ANYOF` branches.
 */
export const mergeShapes = (left: InferredShape, right: InferredShape): InferredShape => {
  if (isUnknown(left) || isUnknown(right)) return UNKNOWN;

  if (left.anyOf !== undefined || right.anyOf !== undefined) {
    const branches = [...(left.anyOf ?? [left]), ...(right.anyOf ?? [right])];
    return branches.reduce((merged, branch) => addUnionBranch(merged, branch), {
      anyOf: [],
    } as InferredShape);
  }

  if (left.type !== right.type) return addUnionBranch({ anyOf: [left] }, right);

  if (left.type === "object") return mergeObjectShapes(left, right);
  if (left.type === "array") {
    if (left.items === undefined) return right;
    if (right.items === undefined) return left;
    return { type: "array", items: mergeShapes(left.items, right.items) };
  }
  return left;
};

const addUnionBranch = (union: InferredShape, branch: InferredShape): InferredShape => {
  if (isUnknown(union) || isUnknown(branch)) return UNKNOWN;
  const branches = [...(union.anyOf ?? [union])];
  const index = branches.findIndex((existing) => existing.type === branch.type);
  const next =
    index === -1
      ? [...branches, branch]
      : branches.map((existing, i) => (i === index ? mergeShapes(existing, branch) : existing));
  if (next.length > MAX_ANYOF) return UNKNOWN;
  return next.length === 1 ? (next[0] ?? UNKNOWN) : { anyOf: next };
};

/**
 * One tool's accumulated muscle memory: the merged shape plus enough
 * bookkeeping to judge freshness. Stored as plain JSON.
 */
export type ObservedShape = {
  readonly schema: InferredShape;
  readonly observations: number;
  readonly updatedAt: number;
};

/** Serialized-size ceiling per tool; a shape past this degrades to unknown
 *  children rather than growing without bound. */
const MAX_SHAPE_JSON_CHARS = 16_000;

const shrink = (shape: InferredShape, depth: number): InferredShape => {
  if (depth <= 0) return UNKNOWN;
  if (shape.anyOf) return { anyOf: shape.anyOf.map((branch) => shrink(branch, depth - 1)) };
  if (shape.type === "array" && shape.items) {
    return { type: "array", items: shrink(shape.items, depth - 1) };
  }
  if (shape.type === "object" && shape.additionalProperties) {
    return { type: "object", additionalProperties: shrink(shape.additionalProperties, depth - 1) };
  }
  if (shape.type === "object" && shape.properties) {
    const properties: Record<string, InferredShape> = {};
    for (const [key, child] of Object.entries(shape.properties)) {
      properties[key] = shrink(child, depth - 1);
    }
    return { ...shape, properties };
  }
  return shape;
};

/** Fold a new observation into an existing record, keeping the result bounded. */
export const observeShape = (
  previous: ObservedShape | null,
  value: unknown,
  now: number,
): ObservedShape => {
  const observed = inferShape(value);
  let schema = previous === null ? observed : mergeShapes(previous.schema, observed);
  for (
    let depth = MAX_DEPTH;
    depth > 0 && JSON.stringify(schema).length > MAX_SHAPE_JSON_CHARS;
    depth--
  ) {
    schema = shrink(schema, depth);
  }
  return {
    schema,
    observations: (previous?.observations ?? 0) + 1,
    updatedAt: now,
  };
};
