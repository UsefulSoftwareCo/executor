import { JSON_SCHEMA, dump as dumpYamlDocument, load as parseYamlDocument } from "js-yaml";

import { microsoftGraphKeepPathItem } from "./graph";
import {
  microsoftGraphExactPathsForPresetIds,
  microsoftGraphPathPrefixesForPresetIds,
  microsoftGraphTagPrefixesForPresetIds,
} from "./presets";

/**
 * Offline Microsoft Graph slice construction. NOT part of the runtime import
 * graph: the 43MB Graph source cannot be held in a 128MB Workers isolate (its
 * fetch alone has completed once in the last 30 days of production traces), so
 * slices are built where memory is free — the graph-slices workflow / a dev
 * machine — published as release assets, and fetched per selection at runtime
 * by `slices.ts`. Import this module only from scripts and tests.
 */

/** `components` subkeys retained whole in a slice — mirrors the runtime
 *  splitter's `SMALL_COMPONENT_SECTIONS` (`sdk/split.ts`), which keeps these
 *  resident for `$ref` resolution. `schemas` is pruned to the transitive
 *  closure instead; `examples` is dropped. */
const SMALL_COMPONENT_SECTIONS = [
  "parameters",
  "requestBodies",
  "responses",
  "headers",
  "links",
  "securitySchemes",
] as const;

const COMPONENT_REF_PREFIX = "#/components/";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const decodeRefSegment = (segment: string): string =>
  segment.replace(/~1/g, "/").replace(/~0/g, "~");

interface ComponentRef {
  readonly section: string;
  readonly name: string;
}

const collectComponentRefs = (value: unknown, into: (ref: ComponentRef) => void): void => {
  if (typeof value === "string") {
    if (value.startsWith(COMPONENT_REF_PREFIX)) {
      const rest = value.slice(COMPONENT_REF_PREFIX.length);
      const slash = rest.indexOf("/");
      if (slash > 0) {
        const section = rest.slice(0, slash);
        const name = decodeRefSegment(rest.slice(slash + 1));
        if (name.length > 0) into({ section, name });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectComponentRefs(item, into);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectComponentRefs(item, into);
  }
};

/**
 * Transitive `#/components/<section>/<name>` closure over every component
 * section, seeded from `roots` (the kept path-items). Only components actually
 * reachable from a kept operation survive — Graph's ~8k schemas and its
 * catch-all responses/parameters sections otherwise drag nearly the whole
 * component graph into every slice.
 */
const componentClosure = (
  components: Record<string, unknown>,
  roots: readonly unknown[],
): Record<string, Record<string, unknown>> => {
  const kept: Record<string, Record<string, unknown>> = {};
  const queue: ComponentRef[] = [];
  const seen = new Set<string>();
  const enqueue = (ref: ComponentRef): void => {
    const key = `${ref.section}/${ref.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(ref);
  };

  for (const root of roots) collectComponentRefs(root, enqueue);
  for (let i = 0; i < queue.length; i += 1) {
    const { section, name } = queue[i]!;
    const sectionValues = components[section];
    if (!isRecord(sectionValues)) continue;
    const component = sectionValues[name];
    if (component === undefined) continue;
    (kept[section] ??= {})[name] = component;
    collectComponentRefs(component, enqueue);
  }
  return kept;
};

export interface GraphSliceBuild {
  /** The slice as streamable block YAML (the same profile `structuralSplit`
   *  accepts, so the runtime pipeline treats a slice exactly like a source). */
  readonly specText: string;
  readonly pathCount: number;
  readonly operationCount: number;
  readonly schemaCount: number;
}

const HTTP_METHODS = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);

const countOperations = (paths: Record<string, unknown>): number => {
  let count = 0;
  for (const pathItem of Object.values(paths)) {
    if (!isRecord(pathItem)) continue;
    for (const key of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(key.toLowerCase())) count += 1;
    }
  }
  return count;
};

/**
 * Build one preset selection's slice from the parsed Graph document: keep the
 * selection's path-items (via the same `microsoftGraphKeepPathItem` filter the
 * runtime applies), retain the small component sections whole, and prune
 * `components.schemas` to the transitive `$ref` closure of everything kept.
 */
export const buildGraphSliceDocument = (
  doc: Record<string, unknown>,
  presetIds: readonly string[],
): GraphSliceBuild => {
  const keepPathItem = microsoftGraphKeepPathItem({
    coversFullGraph: false,
    presetIds,
    customScopes: [],
    exactPaths: microsoftGraphExactPathsForPresetIds(presetIds),
    pathPrefixes: microsoftGraphPathPrefixesForPresetIds(presetIds),
    tagPrefixes: microsoftGraphTagPrefixesForPresetIds(presetIds),
  });

  const sourcePaths = isRecord(doc.paths) ? doc.paths : {};
  const paths: Record<string, unknown> = {};
  for (const [path, pathItem] of Object.entries(sourcePaths)) {
    if (!isRecord(pathItem)) continue;
    const kept = keepPathItem(path, pathItem);
    if (kept) paths[path] = kept;
  }

  const sourceComponents = isRecord(doc.components) ? doc.components : {};
  const closure = componentClosure(sourceComponents, [paths]);
  const components: Record<string, unknown> = {};
  for (const section of SMALL_COMPONENT_SECTIONS) {
    if (closure[section]) components[section] = closure[section];
  }
  // securitySchemes are never `$ref`'d from operations by name in Graph
  // (operations reference them via `security` entries), so retain the section
  // whole — it is tiny and the runtime reads OAuth endpoints from it.
  if (isRecord(sourceComponents.securitySchemes)) {
    components.securitySchemes = sourceComponents.securitySchemes;
  }
  const schemas = closure.schemas ?? {};
  components.schemas = schemas;

  const slice: Record<string, unknown> = {
    ...(doc.openapi !== undefined ? { openapi: doc.openapi } : {}),
    ...(doc.info !== undefined ? { info: doc.info } : {}),
    ...(doc.servers !== undefined ? { servers: doc.servers } : {}),
    ...(doc.security !== undefined ? { security: doc.security } : {}),
    paths,
    components,
  };

  // noRefs duplicates shared subtrees instead of emitting YAML anchors, which
  // the streamable block profile forbids; lineWidth -1 keeps scalars on one
  // line so no wrapped line can be mistaken for structure.
  const specText = dumpYamlDocument(slice, { noRefs: true, lineWidth: -1, schema: JSON_SCHEMA });

  return {
    specText,
    pathCount: Object.keys(paths).length,
    operationCount: countOperations(paths),
    schemaCount: Object.keys(schemas).length,
  };
};

/** Parse Graph source YAML for slice building, or null when the source does
 *  not parse to an object. Offline-only: this is the whole-document parse the
 *  runtime can never do. */
export const parseGraphSourceDocument = (sourceText: string): Record<string, unknown> | null => {
  const parsed = parseYamlDocument(sourceText, { json: true, schema: JSON_SCHEMA });
  return isRecord(parsed) ? parsed : null;
};
