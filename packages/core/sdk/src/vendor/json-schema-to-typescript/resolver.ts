import type { JSONSchema } from "./types/JSONSchema";

export type DereferencedPaths = WeakMap<JSONSchema, string>;

type RefCache = Map<string, unknown>;
type SeenCache = WeakMap<object, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const decodePointerSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~");
  } catch {
    throw new ReferenceError(`Invalid JSON Pointer segment "${segment}" in $ref`);
  }
};

const encodePointerSegment = (segment: string): string =>
  segment.replace(/~/g, "~0").replace(/\//g, "~1");

const childPointer = (parent: string, key: string): string =>
  parent === "#" ? `#/${encodePointerSegment(key)}` : `${parent}/${encodePointerSegment(key)}`;

const normalizeLocalRef = (ref: string): string => {
  if (ref === "#") return ref;
  if (!ref.startsWith("#/")) {
    throw new ReferenceError(
      `Unsupported $ref "${ref}". Only same-document JSON Pointer refs are supported.`,
    );
  }
  return `#/${ref
    .slice(2)
    .split("/")
    .map(decodePointerSegment)
    .map(encodePointerSegment)
    .join("/")}`;
};

const resolvePointer = (root: unknown, ref: string): unknown => {
  const pointer = normalizeLocalRef(ref);
  if (pointer === "#") return root;

  let current = root;
  for (const rawSegment of pointer.slice(2).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    if (!isObject(current) || !(segment in current)) {
      throw new ReferenceError(`Unable to resolve $ref "${ref}"`);
    }
    current = current[segment];
  }
  return current;
};

const dereferenceNode = (
  root: JSONSchema,
  node: unknown,
  pointer: string,
  dereferencedPaths: DereferencedPaths,
  refCache: RefCache,
  seenCache: SeenCache,
): unknown => {
  if (!isObject(node)) return node;

  if (typeof node.$ref === "string") {
    const ref = normalizeLocalRef(node.$ref);
    const cached = refCache.get(ref);
    if (cached) {
      if (isObject(cached)) {
        dereferencedPaths.set(cached as JSONSchema, ref);
      }
      return cached;
    }

    const target = resolvePointer(root, ref);
    if (!isObject(target)) return target;

    const targetClone: Record<string, unknown> | unknown[] = Array.isArray(target) ? [] : {};
    refCache.set(ref, targetClone);
    seenCache.set(target, targetClone);
    dereferencedPaths.set(targetClone as JSONSchema, ref);

    const targetPointer = ref;
    for (const [key, value] of Object.entries(target)) {
      (targetClone as Record<string, unknown>)[key] = dereferenceNode(
        root,
        value,
        childPointer(targetPointer, key),
        dereferencedPaths,
        refCache,
        seenCache,
      );
    }
    return targetClone;
  }

  const seen = seenCache.get(node);
  if (seen) return seen;

  const clone: Record<string, unknown> | unknown[] = Array.isArray(node) ? [] : {};
  seenCache.set(node, clone);
  refCache.set(pointer, clone);

  if (Array.isArray(node)) {
    node.forEach((value, index) => {
      (clone as unknown[])[index] = dereferenceNode(
        root,
        value,
        childPointer(pointer, String(index)),
        dereferencedPaths,
        refCache,
        seenCache,
      );
    });
    return clone;
  }

  for (const [key, value] of Object.entries(node)) {
    (clone as Record<string, unknown>)[key] = dereferenceNode(
      root,
      value,
      childPointer(pointer, key),
      dereferencedPaths,
      refCache,
      seenCache,
    );
  }

  return clone;
};

export function dereference(schema: JSONSchema): {
  dereferencedPaths: DereferencedPaths;
  dereferencedSchema: JSONSchema;
} {
  const dereferencedPaths: DereferencedPaths = new WeakMap();
  const dereferencedSchema = dereferenceNode(
    schema,
    schema,
    "#",
    dereferencedPaths,
    new Map(),
    new WeakMap(),
  ) as JSONSchema;
  return { dereferencedPaths, dereferencedSchema };
}
