/**
 * v1's tool name for each operation of a stored OpenAPI document, as v1 compiled it. v1 bound a
 * tool it stored no `operation` row for by compiling the document at call time and finding the
 * operation by this name, so an integration with no rows still exposed these names. Ported
 * unchanged from v1's `planToolPaths` (`plugins/openapi/src/sdk/definitions.ts`) and its inputs
 * from `extract` (`sdk/extract.ts`): v2's planner names differently, and v1's names must be kept.
 */

import { type Entries, mapEntries, noEntries } from "./stored-document.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const methods = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

const splitWords = (value: string): string[] =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z0-9]+)/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);

const toCamelCase = (value: string): string => {
  const words = splitWords(value).map((word) => word.toLowerCase());
  const [first, ...rest] = words;
  if (first === undefined) return "tool";
  return `${first}${rest.map((p) => `${p[0]?.toUpperCase() ?? ""}${p.slice(1)}`).join("")}`;
};

const toPascalCase = (value: string): string => {
  const camel = toCamelCase(value);
  return `${camel[0]?.toUpperCase() ?? ""}${camel.slice(1)}`;
};

const versionSegment = /^v\d+(?:[._-]\d+)?$/i;
const ignoredSegments = new Set(["api"]);

const pathSegments = (pathTemplate: string): string[] =>
  pathTemplate
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const isParameter = (segment: string): boolean => segment.startsWith("{") && segment.endsWith("}");

const normalizeGroupSegment = (value: string | undefined): string | null => {
  const candidate = value?.trim();
  if (!candidate) return null;
  return toCamelCase(candidate);
};

const deriveVersionSegment = (pathTemplate: string): string | undefined =>
  pathSegments(pathTemplate)
    .map((s) => s.toLowerCase())
    .find((s) => versionSegment.test(s));

const derivePathGroup = (pathTemplate: string): string => {
  for (const segment of pathSegments(pathTemplate)) {
    const lower = segment.toLowerCase();
    if (versionSegment.test(lower)) continue;
    if (ignoredSegments.has(lower)) continue;
    if (isParameter(segment)) continue;
    return normalizeGroupSegment(segment) ?? "root";
  }
  return "root";
};

const deriveLeafSeed = (operationId: string, group: string): string => {
  const segments = operationId
    .split(/[/.]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const [first, ...rest] = segments;
  if (first !== undefined && rest.length > 0 && (normalizeGroupSegment(first) ?? first) === group)
    return rest.join(" ");
  return operationId;
};

const fallbackLeafSeed = (method: string, pathTemplate: string, group: string): string => {
  const suffix = pathSegments(pathTemplate)
    .filter((s) => !versionSegment.test(s.toLowerCase()))
    .filter((s) => !ignoredSegments.has(s.toLowerCase()))
    .filter((s) => !isParameter(s))
    .map((s) => normalizeGroupSegment(s) ?? s)
    .filter((s) => s !== group)
    .map((s) => toPascalCase(s))
    .join("");
  return `${method}${suffix || "Operation"}`;
};

const deriveLeaf = (operationId: string, method: string, pathTemplate: string, group: string) => {
  const preferred = toCamelCase(deriveLeafSeed(operationId, group));
  if (preferred.length > 0 && preferred !== group) return preferred;
  return toCamelCase(fallbackLeafSeed(method, pathTemplate, group));
};

/** v1's hash: its keys, sorted, are the replacer's property list. */
const stableHash = (value: Json): string => {
  const text = JSON.stringify(value, Object.keys(value).sort());
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36).padStart(8, "0");
};

/** A string extension value v1 reads, trimmed, when it is not blank. */
const extension = (operation: Json, key: string) => {
  const value = operation[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

interface Planned {
  /** `<method> <document path>`, the operation's place in the stored document. */
  readonly key: string;
  toolPath: string;
  readonly group: string;
  readonly leaf: string;
  readonly version: string | undefined;
  readonly method: string;
  readonly hash: string;
}

/**
 * v1's tool name for every operation of the document, by `<method> <document path>`. Collisions are
 * refined over the whole document, as v1 did, so the input must be the full stored document; it is
 * read one path item at a time.
 */
export const v1ToolPaths = (document: Entries): ReadonlyMap<string, string> => {
  const planned: Planned[] = [];
  const paths = mapEntries(document.get("paths")) ?? noEntries;
  for (const documentPath of paths.keys) {
    const item = paths.get(documentPath);
    if (!isObject(item)) continue;
    for (const method of methods) {
      const operation = item[method];
      if (!isObject(operation)) continue;
      // v1 derived a missing operationId from the document's path, but planned with the resolved
      // template.
      const operationId =
        typeof operation.operationId === "string"
          ? operation.operationId
          : `${method}_${documentPath.replace(/[^a-zA-Z0-9]+/g, "_")}`.replace(/^_+|_+$/g, "") ||
            `${method}_operation`;
      const pathTemplate = extension(operation, "x-executor-pathTemplate") ?? documentPath;
      const tags = Array.isArray(operation.tags)
        ? operation.tags.filter(
            (tag): tag is string => typeof tag === "string" && tag.trim().length > 0,
          )
        : [];
      const explicit = extension(operation, "x-executor-toolPath");
      const hash = stableHash({ method, path: pathTemplate, operationId });
      const version = deriveVersionSegment(pathTemplate);
      const key = `${method} ${documentPath}`;
      if (explicit !== undefined) {
        const [group = "root", ...leafParts] = explicit.split(".").filter(Boolean);
        planned.push({
          key,
          toolPath: explicit,
          group,
          leaf: leafParts.join(".") || group,
          version,
          method,
          hash,
        });
        continue;
      }
      const group = normalizeGroupSegment(tags[0]) ?? derivePathGroup(pathTemplate);
      const leaf = deriveLeaf(operationId, method, pathTemplate, group);
      planned.push({ key, toolPath: `${group}.${leaf}`, group, leaf, version, method, hash });
    }
  }

  // v1's collision rounds: the version segment, then the method, then the hash.
  const refine = (rename: (item: Planned) => string) => {
    const buckets = new Map<string, Planned[]>();
    for (const item of planned)
      buckets.set(item.toolPath, [...(buckets.get(item.toolPath) ?? []), item]);
    for (const bucket of buckets.values())
      if (bucket.length > 1) for (const item of bucket) item.toolPath = rename(item);
  };
  const prefix = (item: Planned) => (item.version ? `${item.group}.${item.version}` : item.group);
  refine((item) => (item.version ? `${item.group}.${item.version}.${item.leaf}` : item.toolPath));
  refine((item) => `${prefix(item)}.${item.leaf}${toPascalCase(item.method)}`);
  refine(
    (item) => `${prefix(item)}.${item.leaf}${toPascalCase(item.method)}${item.hash.slice(0, 8)}`,
  );
  return new Map(planned.map((item) => [item.key, item.toolPath]));
};
