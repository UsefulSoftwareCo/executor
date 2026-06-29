/**
 * Derives structured `group.leaf` tool paths from extracted OpenAPI operations.
 *
 * Ported from the v3 executor's `definitions.ts`. Turns flat operation IDs like
 * `zones_listZones` into nested paths like `zones.listZones` that the tree UI
 * can render with proper nesting.
 */

import { Option } from "effect";

import type { ExtractedOperation } from "./types";

// ---------------------------------------------------------------------------
// Word / case utilities
// ---------------------------------------------------------------------------

const splitWords = (value: string): string[] =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z0-9]+)/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);

const normalizeWord = (value: string): string => value.toLowerCase();

const toCamelCase = (value: string): string => {
  const words = splitWords(value).map(normalizeWord);
  if (words.length === 0) return "tool";
  const [first, ...rest] = words;
  return `${first}${rest.map((p) => `${p[0]?.toUpperCase() ?? ""}${p.slice(1)}`).join("")}`;
};

const toPascalCase = (value: string): string => {
  const camel = toCamelCase(value);
  return `${camel[0]?.toUpperCase() ?? ""}${camel.slice(1)}`;
};

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

const VERSION_SEGMENT_REGEX = /^v\d+(?:[._-]\d+)?$/i;
const IGNORED_PATH_SEGMENTS = new Set(["api"]);

const pathSegmentsFromTemplate = (pathTemplate: string): string[] =>
  pathTemplate
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const isPathParameterSegment = (segment: string): boolean =>
  segment.startsWith("{") && segment.endsWith("}");

const normalizeGroupSegment = (value: string | undefined): string | null => {
  const candidate = value?.trim();
  if (!candidate) return null;
  return toCamelCase(candidate);
};

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

const deriveVersionSegment = (pathTemplate: string): string | undefined =>
  pathSegmentsFromTemplate(pathTemplate)
    .map((s) => s.toLowerCase())
    .find((s) => VERSION_SEGMENT_REGEX.test(s));

const derivePathGroup = (pathTemplate: string): string => {
  for (const segment of pathSegmentsFromTemplate(pathTemplate)) {
    const lower = segment.toLowerCase();
    if (VERSION_SEGMENT_REGEX.test(lower)) continue;
    if (IGNORED_PATH_SEGMENTS.has(lower)) continue;
    if (isPathParameterSegment(segment)) continue;
    return normalizeGroupSegment(segment) ?? "root";
  }
  return "root";
};

const splitOperationIdSegments = (value: string): string[] =>
  value
    .split(/[/.]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const deriveLeafSeed = (operationId: string, group: string): string => {
  const segments = splitOperationIdSegments(operationId);
  if (segments.length > 1) {
    const [first, ...rest] = segments;
    if ((normalizeGroupSegment(first) ?? first) === group && rest.length > 0) {
      return rest.join(" ");
    }
  }
  return operationId;
};

const fallbackLeafSeed = (method: string, pathTemplate: string, group: string): string => {
  const relevantSegments = pathSegmentsFromTemplate(pathTemplate)
    .filter((s) => !VERSION_SEGMENT_REGEX.test(s.toLowerCase()))
    .filter((s) => !IGNORED_PATH_SEGMENTS.has(s.toLowerCase()))
    .filter((s) => !isPathParameterSegment(s))
    .map((s) => normalizeGroupSegment(s) ?? s)
    .filter((s) => s !== group);

  const segmentSuffix = relevantSegments.map((s) => toPascalCase(s)).join("");
  return `${method}${segmentSuffix || "Operation"}`;
};

const deriveLeaf = (
  operationId: string,
  method: string,
  pathTemplate: string,
  group: string,
): string => {
  const preferred = toCamelCase(deriveLeafSeed(operationId, group));
  if (preferred.length > 0 && preferred !== group) return preferred;
  return toCamelCase(fallbackLeafSeed(method, pathTemplate, group));
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  /** Dot-separated path like `zones.listZones` */
  readonly toolPath: string;
  /** The group segment */
  readonly group: string;
  /** The leaf segment */
  readonly leaf: string;
  /** Index into the original operations array */
  readonly operationIndex: number;
  /** The original operation */
  readonly operation: ExtractedOperation;
}

/**
 * The minimal per-operation metadata the tool-path planner needs. Kept
 * deliberately light (no schemas) so the streaming compile path can plan paths
 * for tens of thousands of operations without holding the full extracted
 * operations in memory.
 */
export interface OperationPathInput {
  readonly operationId: string;
  readonly explicitToolPath: string | undefined;
  readonly method: string;
  readonly pathTemplate: string;
  /** The first non-empty tag, used to seed the group segment. */
  readonly tag0: string | undefined;
}

/** A resolved tool path plus its index back into the input operations array. */
export interface PlannedToolPath {
  readonly toolPath: string;
  readonly group: string;
  readonly leaf: string;
  readonly operationIndex: number;
}

// ---------------------------------------------------------------------------
// Collision resolution
// ---------------------------------------------------------------------------

interface RawToolPath {
  toolPath: string;
  group: string;
  leaf: string;
  versionSegment: string | undefined;
  method: string;
  operationHash: string;
  operationIndex: number;
}

const resolveCollisions = (definitions: RawToolPath[]): PlannedToolPath[] => {
  // Mutable — we progressively refine toolPath on collision
  const staged = definitions.map((d) => ({ ...d }));

  const applyFactory = (items: typeof staged, factory: (d: (typeof staged)[number]) => string) => {
    const byPath = new Map<string, typeof staged>();
    for (const item of items) {
      const bucket = byPath.get(item.toolPath) ?? [];
      bucket.push(item);
      byPath.set(item.toolPath, bucket);
    }
    for (const bucket of byPath.values()) {
      if (bucket.length < 2) continue;
      for (const d of bucket) {
        d.toolPath = factory(d);
      }
    }
  };

  // Round 1: add version segment
  applyFactory(staged, (d) =>
    d.versionSegment ? `${d.group}.${d.versionSegment}.${d.leaf}` : d.toolPath,
  );

  // Round 2: add method suffix
  applyFactory(staged, (d) => {
    const prefix = d.versionSegment ? `${d.group}.${d.versionSegment}` : d.group;
    return `${prefix}.${d.leaf}${toPascalCase(d.method)}`;
  });

  // Round 3: add hash suffix
  applyFactory(staged, (d) => {
    const prefix = d.versionSegment ? `${d.group}.${d.versionSegment}` : d.group;
    return `${prefix}.${d.leaf}${toPascalCase(d.method)}${d.operationHash.slice(0, 8)}`;
  });

  return staged.map((d) => ({
    toolPath: d.toolPath,
    group: d.group,
    leaf: d.leaf,
    operationIndex: d.operationIndex,
  }));
};

// ---------------------------------------------------------------------------
// Stable hash (simple, deterministic)
// ---------------------------------------------------------------------------

const stableHash = (value: unknown): string => {
  const str = JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).padStart(8, "0");
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Plan structured `group.leaf` tool paths from lightweight per-operation
 * metadata. Path derivation + collision resolution need a global view of every
 * operation, but only its name/method/path/tag, never its schemas. Keeping this
 * pass schema-free lets the streaming compile path plan paths for a 16k-op spec
 * without materializing the full extracted operations.
 *
 * The returned `operationIndex` points back into the `inputs` array.
 */
export const planToolPaths = (inputs: readonly OperationPathInput[]): PlannedToolPath[] => {
  const raw: RawToolPath[] = inputs.map((op, index) => {
    const operationId = op.operationId;
    const operationHash = stableHash({
      method: op.method,
      path: op.pathTemplate,
      operationId,
    });
    const versionSegment = deriveVersionSegment(op.pathTemplate);

    if (op.explicitToolPath) {
      const [group = "root", ...leafParts] = op.explicitToolPath.split(".").filter(Boolean);
      const leaf = leafParts.join(".") || group;
      return {
        toolPath: op.explicitToolPath,
        group,
        leaf,
        versionSegment,
        method: op.method,
        operationHash,
        operationIndex: index,
      };
    }

    const group = normalizeGroupSegment(op.tag0) ?? derivePathGroup(op.pathTemplate);
    const leaf = deriveLeaf(operationId, op.method, op.pathTemplate, group);
    return {
      toolPath: `${group}.${leaf}`,
      group,
      leaf,
      versionSegment,
      method: op.method,
      operationHash,
      operationIndex: index,
    };
  });

  return resolveCollisions(raw).sort((a, b) => a.toolPath.localeCompare(b.toolPath));
};

/**
 * Compile extracted operations into tool definitions with structured
 * `group.leaf` paths suitable for tree rendering. Thin wrapper over
 * `planToolPaths` that re-attaches each operation by index.
 */
export const compileToolDefinitions = (
  operations: readonly ExtractedOperation[],
): ToolDefinition[] => {
  const plans = planToolPaths(
    operations.map((op) => ({
      operationId: op.operationId,
      explicitToolPath: Option.getOrUndefined(op.toolPath),
      method: op.method,
      pathTemplate: op.pathTemplate,
      tag0: op.tags[0],
    })),
  );

  return plans.map((plan) => ({
    toolPath: plan.toolPath,
    group: plan.group,
    leaf: plan.leaf,
    operationIndex: plan.operationIndex,
    operation: operations[plan.operationIndex]!,
  }));
};
