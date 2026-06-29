/**
 * Structural splitter for large OpenAPI documents written in clean block YAML.
 *
 * The whole-document parse of a 37MB spec (Microsoft Graph: 16.5k operations,
 * 8.2k schemas) builds a ~300MB JS tree that OOMs the 128MB Cloudflare Workers
 * isolate. This splitter avoids ever holding that tree: it scans the text once,
 * recording the byte range of each top-level key, each path-item (the indent-2
 * entries under `paths:`), and each schema (the indent-4 entries under
 * `components.schemas:`). The streaming compile then slices one item at a time,
 * de-indents it back to column 0, hands the isolated fragment to a real YAML
 * parser, and discards the result before moving on. Peak memory stays near the
 * size of the largest single item plus the raw text, not the parsed whole.
 *
 * This is not a YAML reimplementation: it extracts safe byte ranges from a
 * constrained document shape, then defers every actual parse to `js-yaml`. It
 * is only valid for the block-YAML profile `isStreamableSpec` accepts (2-space
 * block maps, top-level keys at column 0, no anchors/aliases/merge keys). Block
 * scalars (`|` / `>`) in descriptions are tracked so their indented content is
 * never mistaken for structure.
 */

import { JSON_SCHEMA, load as parseYamlDocument } from "js-yaml";

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export interface SpecStructure {
  /** Raw spec text. Every range below indexes into this string. */
  readonly text: string;
  /** Byte ranges of the top-level keys that are not `paths` / `components`
   *  (openapi, info, servers, tags, security, ...). Concatenated and parsed as
   *  one small document for the head (servers, info). */
  readonly headRanges: readonly ByteRange[];
  /** One range per path-item: the indent-2 entries under `paths:`. */
  readonly pathItems: readonly ByteRange[];
  /** One range per schema entry: the indent-4 entries under
   *  `components.schemas:`. */
  readonly schemas: readonly ByteRange[];
  /** Ranges of the indent-2 `components` subkeys we keep whole because they are
   *  small and may be `$ref`'d by a kept operation (parameters / requestBodies /
   *  responses / headers / links / securitySchemes). Excludes the huge `schemas`
   *  (streamed and pruned separately) and `examples` (never referenced by a
   *  binding). */
  readonly smallComponentRanges: readonly ByteRange[];
}

const SPACE = 32;
const HASH = 35;
const DASH = 45;

/** `components` subkeys kept whole during a reduce: small, and a kept operation
 *  may `$ref` into any of them. `schemas` is streamed/pruned separately and
 *  `examples` is dropped (large, never referenced by a binding). */
const SMALL_COMPONENT_SECTIONS = new Set([
  "parameters",
  "requestBodies",
  "responses",
  "headers",
  "links",
  "securitySchemes",
]);

/** Count of leading spaces on the line starting at `lineStart`. */
const indentOf = (text: string, lineStart: number, lineEnd: number): number => {
  let i = lineStart;
  while (i < lineEnd && text.charCodeAt(i) === SPACE) i++;
  return i - lineStart;
};

/** True for a blank (whitespace-only) or comment line. */
const isBlankOrComment = (text: string, contentStart: number, lineEnd: number): boolean =>
  contentStart >= lineEnd || text.charCodeAt(contentStart) === HASH;

/**
 * True when the line opens a block scalar (`key: |`, `key: >-`, etc.), meaning
 * every following more-indented line is literal content, not structure.
 */
const opensBlockScalar = (line: string): boolean =>
  /:\s*[|>][+-]?\d*\s*(#.*)?$/.test(line) || /^\s*[|>][+-]?\d*\s*(#.*)?$/.test(line);

interface LineCursor {
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly nextStart: number;
  readonly indent: number;
  readonly contentStart: number;
}

/** Advance to the next significant line at offset `from`, returning null at EOF.
 *  Blank lines, comments, and block-scalar content (lines indented deeper than
 *  the scalar key, tracked by the caller) are still returned; the caller skips
 *  them. */
const lineAt = (text: string, from: number, limit: number): LineCursor | null => {
  if (from >= limit) return null;
  let lineEnd = text.indexOf("\n", from);
  if (lineEnd === -1 || lineEnd > limit) lineEnd = limit;
  const indent = indentOf(text, from, lineEnd);
  const contentStart = from + indent;
  return {
    lineStart: from,
    lineEnd,
    nextStart: lineEnd + 1,
    indent,
    contentStart,
  };
};

/**
 * Find the start offset of every key line at exactly `indent` within
 * `[start, end)`, skipping blank/comment lines, deeper child lines, and
 * block-scalar content. Sequence items (`- `) at the target indent are not
 * treated as keys. Returns offsets in document order.
 */
const keyLineStartsAtIndent = (
  text: string,
  start: number,
  end: number,
  indent: number,
): number[] => {
  const starts: number[] = [];
  let blockScalarIndent = -1;
  let pos = start;
  while (pos < end) {
    const line = lineAt(text, pos, end);
    if (!line) break;
    pos = line.nextStart;
    if (isBlankOrComment(text, line.contentStart, line.lineEnd)) continue;
    if (blockScalarIndent >= 0) {
      if (line.indent > blockScalarIndent) continue;
      blockScalarIndent = -1;
    }
    if (line.indent === indent && text.charCodeAt(line.contentStart) !== DASH) {
      starts.push(line.lineStart);
    }
    if (line.indent <= indent && opensBlockScalar(text.slice(line.contentStart, line.lineEnd))) {
      blockScalarIndent = line.indent;
    }
  }
  return starts;
};

/** Contiguous ranges from a sorted list of block-start offsets within
 *  `[blockStart, blockEnd)`: each range runs to the next start (or blockEnd). */
const rangesFromStarts = (starts: readonly number[], blockEnd: number): ByteRange[] =>
  starts.map((s, i) => ({ start: s, end: i + 1 < starts.length ? starts[i + 1]! : blockEnd }));

/** The simple (unquoted) key name on a key line, e.g. `paths`, `schemas`. */
const keyNameAt = (text: string, lineStart: number, lineEnd: number): string => {
  const indent = indentOf(text, lineStart, lineEnd);
  const colon = text.indexOf(":", lineStart + indent);
  const keyEnd = colon === -1 || colon > lineEnd ? lineEnd : colon;
  return text.slice(lineStart + indent, keyEnd).trim();
};

/**
 * Scan a document into its structural ranges. Pure and synchronous; never
 * parses. Returns null when the document does not present the expected shape
 * (no `paths:` block), so the caller can fall back to a whole-document parse.
 */
export const structuralSplit = (text: string): SpecStructure | null => {
  const len = text.length;

  // Top-level keys (column 0). Record each key's start + name, respecting
  // block scalars whose content could sit at column >= 1.
  const topStarts: number[] = [];
  const topNames: string[] = [];
  {
    let blockScalarIndent = -1;
    let pos = 0;
    while (pos < len) {
      const line = lineAt(text, pos, len);
      if (!line) break;
      pos = line.nextStart;
      if (isBlankOrComment(text, line.contentStart, line.lineEnd)) continue;
      if (blockScalarIndent >= 0) {
        if (line.indent > blockScalarIndent) continue;
        blockScalarIndent = -1;
      }
      if (line.indent === 0) {
        topStarts.push(line.lineStart);
        topNames.push(keyNameAt(text, line.lineStart, line.lineEnd));
      }
      if (opensBlockScalar(text.slice(line.contentStart, line.lineEnd))) {
        blockScalarIndent = line.indent;
      }
    }
  }

  const topRanges = rangesFromStarts(topStarts, len);
  const pathsIdx = topNames.indexOf("paths");
  if (pathsIdx === -1) return null;
  const componentsIdx = topNames.indexOf("components");

  const headRanges: ByteRange[] = [];
  for (let i = 0; i < topRanges.length; i++) {
    if (i === pathsIdx || i === componentsIdx) continue;
    headRanges.push(topRanges[i]!);
  }

  // Path-items: indent-2 keys inside the `paths:` block (after its key line).
  const pathsRange = topRanges[pathsIdx]!;
  const pathsBodyStart =
    lineAt(text, pathsRange.start, pathsRange.end)?.nextStart ?? pathsRange.end;
  const pathItems = rangesFromStarts(
    keyLineStartsAtIndent(text, pathsBodyStart, pathsRange.end, 2),
    pathsRange.end,
  );

  const schemas: ByteRange[] = [];
  const smallComponentRanges: ByteRange[] = [];
  if (componentsIdx !== -1) {
    const componentsRange = topRanges[componentsIdx]!;
    const componentsBodyStart =
      lineAt(text, componentsRange.start, componentsRange.end)?.nextStart ?? componentsRange.end;
    const subStarts = keyLineStartsAtIndent(text, componentsBodyStart, componentsRange.end, 2);
    const subRanges = rangesFromStarts(subStarts, componentsRange.end);
    for (const range of subRanges) {
      const name = keyNameAt(text, range.start, lineAt(text, range.start, range.end)!.lineEnd);
      if (name === "schemas") {
        const bodyStart = lineAt(text, range.start, range.end)?.nextStart ?? range.end;
        for (const s of rangesFromStarts(
          keyLineStartsAtIndent(text, bodyStart, range.end, 4),
          range.end,
        )) {
          schemas.push(s);
        }
      } else if (SMALL_COMPONENT_SECTIONS.has(name)) {
        smallComponentRanges.push(range);
      }
      // `examples` and any other subkey are intentionally dropped: no binding
      // field references them, and they can be large.
    }
  }

  return { text, headRanges, pathItems, schemas, smallComponentRanges };
};

/** Strip exactly `indent` leading spaces from every line of `fragment`, lifting
 *  an indent-N block back to column 0 so it parses as a standalone document. */
const dedent = (fragment: string, indent: number): string =>
  indent === 0 ? fragment : fragment.replace(new RegExp(`^ {1,${indent}}`, "gm"), "");

const parseYaml = (text: string): unknown =>
  parseYamlDocument(text, { json: true, schema: JSON_SCHEMA });

/**
 * Parse a single indent-N entry range (a path-item or a schema) in isolation.
 * Returns `[name, value]` where `name` is the entry's key and `value` its
 * parsed body, or null when the fragment does not parse to a single-key map.
 */
export const parseEntry = (
  text: string,
  range: ByteRange,
  indent: number,
): readonly [string, unknown] | null => {
  const parsed = parseYaml(dedent(text.slice(range.start, range.end), indent));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length !== 1) return null;
  return entries[0]!;
};

/** Parse the concatenation of the head ranges into the document head (openapi,
 *  info, servers, tags). Small; safe to materialize whole. */
export const parseHead = (structure: SpecStructure): Record<string, unknown> => {
  const text = structure.headRanges.map((r) => structure.text.slice(r.start, r.end)).join("");
  const parsed = parseYaml(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

/** Parse the small component subkeys (parameters / requestBodies / responses)
 *  into a `components`-shaped object for `$ref` resolution. */
export const parseSmallComponents = (structure: SpecStructure): Record<string, unknown> => {
  if (structure.smallComponentRanges.length === 0) return {};
  const body = structure.smallComponentRanges
    .map((r) => structure.text.slice(r.start, r.end))
    .join("");
  const parsed = parseYaml(`components:\n${body}`);
  const components =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).components : null;
  return components && typeof components === "object"
    ? (components as Record<string, unknown>)
    : {};
};

/**
 * Accept only the block-YAML profile the splitter can safely slice: no tabs, no
 * anchors/aliases, no merge keys, and a `paths:` block present. Block scalars
 * are allowed (tracked during the scan). Conservative by design: a false
 * negative just routes a spec through the whole-document parse.
 */
export const isStreamableSpec = (text: string): boolean => {
  if (text.indexOf("\t") !== -1) return false;
  // Anchors/aliases/merge keys: cheap substring rejects before structural work.
  if (/(^|\s)[&*][A-Za-z0-9_]/m.test(text)) return false;
  if (/<<\s*:/.test(text)) return false;
  return /^paths:/m.test(text);
};

const SCHEMA_REF_PREFIX = "#/components/schemas/";

/** Map each `components.schemas` entry name to its byte range, reading only the
 *  key line (never parsing the schema body). The schema name is the raw YAML
 *  key, which matches the trailing segment of a `#/components/schemas/<name>`
 *  reference. */
export const indexSchemas = (structure: SpecStructure): ReadonlyMap<string, ByteRange> => {
  const index = new Map<string, ByteRange>();
  for (const range of structure.schemas) {
    const line = lineAt(structure.text, range.start, range.end);
    if (!line) continue;
    const name = keyNameAt(structure.text, range.start, line.lineEnd);
    if (name) index.set(name, range);
  }
  return index;
};

/** Decode a `#/components/schemas/<segment>` name segment. Schema names are raw
 *  YAML keys, so only JSON-pointer tilde escaping can appear (no `%`-encoding
 *  in the wild specs we target); decode `~1`/`~0` and leave the rest verbatim. */
const decodeSchemaRefName = (segment: string): string =>
  segment.replace(/~1/g, "/").replace(/~0/g, "~");

/** Collect the names of every `#/components/schemas/X` reference reachable in
 *  `value`, without resolving them. */
const collectSchemaRefNames = (value: unknown, into: Set<string>): void => {
  if (typeof value === "string") {
    if (value.startsWith(SCHEMA_REF_PREFIX)) {
      const name = decodeSchemaRefName(value.slice(SCHEMA_REF_PREFIX.length));
      if (name.length > 0) into.add(name);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaRefNames(item, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectSchemaRefNames(item, into);
    }
  }
};

/**
 * Resolve the transitive closure of schemas referenced by `roots`, parsing each
 * referenced schema once from its byte range (BFS over `$ref`s). Schemas not
 * reachable from `roots` are never parsed, so peak memory tracks the kept
 * subset rather than the full `components.schemas` map.
 */
export const collectReferencedSchemas = (
  structure: SpecStructure,
  index: ReadonlyMap<string, ByteRange>,
  roots: readonly unknown[],
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  const wanted = new Set<string>();
  for (const root of roots) collectSchemaRefNames(root, wanted);

  const queue = [...wanted];
  for (let i = 0; i < queue.length; i += 1) {
    const name = queue[i]!;
    if (Object.prototype.hasOwnProperty.call(result, name)) continue;
    const range = index.get(name);
    if (!range) continue;
    const entry = parseEntry(structure.text, range, 4);
    if (!entry) continue;
    result[name] = entry[1];
    const next = new Set<string>();
    collectSchemaRefNames(entry[1], next);
    for (const ref of next) {
      if (!Object.prototype.hasOwnProperty.call(result, ref)) queue.push(ref);
    }
  }
  return result;
};

/** A path-item filter for the streaming compile: given a parsed path-item,
 *  return the (possibly trimmed) value to keep, or null to drop the path
 *  entirely. Applied per path-item by `streamOperationBindingsFromStructure`. */
export type KeepPathItem = (
  path: string,
  pathItem: Record<string, unknown>,
) => Record<string, unknown> | null;
