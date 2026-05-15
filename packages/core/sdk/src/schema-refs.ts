// ---------------------------------------------------------------------------
// JSON Schema $ref hoisting and re-attachment
//
// Core logic for deduplicating shared definitions across tools.
// Used by any ToolRegistry implementation (in-memory, database-backed, etc.)
//
// Only handles standard JSON Schema formats ($defs, definitions).
// Plugin-specific formats (e.g. OpenAPI components/schemas) must be
// normalized by the plugin before calling registerDefinitions/register.
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

/** Standard JSON Schema $ref patterns. */
const REF_PATTERN = /^#\/(?:\$defs|definitions)\/(.+)$/;

/** Extract the definition name from a standard $ref pointer. */
const parseRefName = (ref: string): string | undefined => ref.match(REF_PATTERN)?.[1];

/**
 * Recursively rewrite `#/definitions/<name>` pointers to `#/$defs/<name>`.
 * Returns the input unchanged if no rewrites are needed.
 */
export const normalizeRefs = (node: unknown): unknown => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((item) => {
      const n = normalizeRefs(item);
      if (n !== item) changed = true;
      return n;
    });
    return changed ? out : node;
  }

  const obj = node as Obj;

  if (typeof obj.$ref === "string") {
    const name = parseRefName(obj.$ref);
    if (name) {
      const canonical = `#/$defs/${name}`;
      return canonical !== obj.$ref ? { ...obj, $ref: canonical } : obj;
    }
    return obj;
  }

  let changed = false;
  const result: Obj = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = normalizeRefs(v);
    if (n !== v) changed = true;
    result[k] = n;
  }
  return changed ? result : obj;
};

/**
 * Extract `$defs` and `definitions` from a JSON Schema,
 * returning { stripped, defs } where `stripped` is the schema without local
 * definitions and `defs` is a flat map of definition name → schema.
 */
export const hoistDefinitions = (
  schema: unknown,
): { stripped: unknown; defs: Record<string, unknown> } => {
  if (schema == null || typeof schema !== "object") {
    return { stripped: schema, defs: {} };
  }
  const obj = schema as Obj;
  const defs: Record<string, unknown> = {};

  if (obj.$defs && typeof obj.$defs === "object") {
    for (const [k, v] of Object.entries(obj.$defs as Obj)) {
      defs[k] = v;
    }
  }

  if (obj.definitions && typeof obj.definitions === "object") {
    for (const [k, v] of Object.entries(obj.definitions as Obj)) {
      defs[k] = v;
    }
  }

  const { $defs: _a, definitions: _b, ...rest } = obj;
  return { stripped: rest, defs };
};

/**
 * Walk a schema and collect all $ref target names transitively.
 * e.g. "#/$defs/Address" → "Address", and if Address references City, both.
 */
export const collectRefs = (
  node: unknown,
  defs: ReadonlyMap<string, unknown>,
  found: Set<string> = new Set(),
): Set<string> => {
  if (node == null || typeof node !== "object") return found;
  const obj = node as Obj;

  if (typeof obj.$ref === "string") {
    const name = parseRefName(obj.$ref);
    if (name && !found.has(name)) {
      found.add(name);
      const def = defs.get(name);
      if (def) collectRefs(def, defs, found);
    }
    return found;
  }

  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      if (Array.isArray(v)) {
        for (const item of v) collectRefs(item, defs, found);
      } else {
        collectRefs(v, defs, found);
      }
    }
  }
  return found;
};

export const collectReferencedDefinitions = (
  roots: readonly unknown[],
  defs: ReadonlyMap<string, unknown>,
): Record<string, unknown> => {
  const refs = new Set<string>();
  for (const root of roots) {
    collectRefs(root, defs, refs);
  }

  const referenced: Record<string, unknown> = {};
  for (const name of refs) {
    const def = defs.get(name);
    if (def) referenced[name] = def;
  }
  return referenced;
};

/**
 * Re-attach only the referenced shared definitions into a schema,
 * so the caller gets a self-contained, usable JSON Schema.
 *
 * Assumes all `$ref` pointers and definitions have already been normalized
 * to `#/$defs/<name>` form at registration time.
 */
export const reattachDefs = (schema: unknown, defs: ReadonlyMap<string, unknown>): unknown => {
  if (schema == null || typeof schema !== "object") return schema;
  const attached = collectReferencedDefinitions([schema], defs);
  if (Object.keys(attached).length === 0) return schema;

  return { ...(schema as Record<string, unknown>), $defs: attached };
};
