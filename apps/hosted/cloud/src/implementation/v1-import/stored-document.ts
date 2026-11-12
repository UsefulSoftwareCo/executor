/**
 * A stored OpenAPI document read one entry at a time: its top-level entries, its path items and its
 * components, so the cut parses only what it reads. v1's Microsoft Graph presets store Microsoft's
 * whole Graph document, over 40 MB of YAML, whose whole parse needs several times a Worker's memory.
 * v1 never parsed it whole either: it compiled it entry by entry from its text (`structuralSplit` in
 * v1's OpenAPI plugin). Every other document v1 parsed whole, and so does the import.
 */
import { JSON_SCHEMA, YAMLException, load as loadYaml } from "js-yaml";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A map read one entry at a time: a document, its `paths`, its `components` and each of their
 * sections. Its keys are in the order a parsed object holds them; every other value is read whole.
 */
export class Entries {
  readonly keys: readonly string[];
  readonly #has: (key: string) => boolean;
  readonly #read: (key: string) => unknown;
  constructor(
    keys: readonly string[],
    has: (key: string) => boolean,
    read: (key: string) => unknown,
  ) {
    this.keys = keys;
    this.#has = has;
    this.#read = read;
  }
  /** The value at a key, or undefined when the map has none. */
  get(key: string): unknown {
    return this.#has(key) ? this.#read(key) : undefined;
  }
}

/** A map with no entries. */
export const noEntries = new Entries(
  [],
  () => false,
  () => undefined,
);

/** A map's entries: read entry by entry, or a parsed object's. Undefined for any other value. */
export const mapEntries = (value: unknown) =>
  value instanceof Entries
    ? value
    : isObject(value)
      ? new Entries(
          Object.keys(value),
          (key) => Object.hasOwn(value, key),
          (key) => value[key],
        )
      : undefined;

/** A document parsed whole, read through the same entries. */
export const parsedDocument = (document: Json) => mapEntries(document) ?? noEntries;

/** The format of v1's Microsoft Graph presets, whose documents v1 compiled entry by entry. */
export const microsoftGraphFormat = "microsoft-graph";

/**
 * The parser's reason up to the first quoted name, tag or value it carries, so a failure names the
 * kind of error and never the specification's text.
 */
export const parserReason = (reason: string) => reason.split(/[:"'`!<]/)[0]?.trim() ?? "";

// ---------------------------------------------------------------------------------------------
// Block YAML, read entry by entry.

const newline = 0x0a;
const space = 0x20;
const tab = 0x09;
const carriageReturn = 0x0d;
const hash = 0x23;
const dash = 0x2d;

const lossyUtf8 = new TextDecoder("utf-8");
const yamlOptions = { schema: JSON_SCHEMA, json: true } as const;

/** A line that carries structure: where it starts and ends (before its newline), and its indent. */
interface Line {
  readonly start: number;
  readonly end: number;
  readonly indent: number;
  /** Counted from zero. */
  readonly number: number;
}

/** Each line of a range but blank and comment lines. */
function* significantLines(bytes: Uint8Array, from: number, to: number, number: number) {
  let line = number;
  for (let start = from; start < to; line++) {
    const found = bytes.indexOf(newline, start);
    const end = found === -1 || found >= to ? to : found;
    let content = start;
    while (content < end && bytes[content] === space) content++;
    let rest = content;
    while (
      rest < end &&
      (bytes[rest] === space || bytes[rest] === tab || bytes[rest] === carriageReturn)
    )
      rest++;
    if (rest < end && bytes[content] !== hash)
      yield { start, end, indent: content - start, number: line } satisfies Line;
    start = end + 1;
  }
}

/** Whether a line is a block list's entry (`- `), which can sit at its parent key's indent. */
const listEntry = (bytes: Uint8Array, line: Line) => {
  const at = line.start + line.indent;
  const after = bytes[at + 1];
  return (
    bytes[at] === dash &&
    (at + 1 >= line.end || after === space || after === carriageReturn || after === tab)
  );
};

/**
 * Where a simple key ends on a line: just after its `:`, for a plain, single- or double-quoted key
 * followed by a space or the line's end. Undefined for any other line, such as an explicit (`?`),
 * anchored or tagged key, or a line that holds no key.
 */
const keyEnd = (text: string, from: number) => {
  let at = from;
  const quote = text[at];
  if (quote === "'" || quote === '"') {
    // To the closing quote: a backslash escapes the next character in double quotes, and a
    // doubled quote is one quote in single quotes.
    for (at++; ; at++) {
      if (at >= text.length) return undefined;
      if (quote === '"' && text[at] === "\\") at++;
      else if (text[at] === quote && quote === "'" && text[at + 1] === "'") at++;
      else if (text[at] === quote) break;
    }
    for (at++; text[at] === " "; at++);
    if (text[at] !== ":") return undefined;
  } else {
    if (quote === undefined || "?:,[]{}#&*!|>%@`\t".includes(quote)) return undefined;
    for (at = text.indexOf(":", at); at !== -1; at = text.indexOf(":", at + 1)) {
      const after = text[at + 1];
      if (after === undefined || after === " " || after === "\r") break;
    }
    if (at === -1 || /\s#/u.test(text.slice(from, at))) return undefined;
  }
  const after = text[at + 1];
  return after === undefined || after === " " || after === "\r" ? at + 1 : undefined;
};

/** The key a `key:` line names, as the parser reads it, or undefined when it names none. */
const keyOf = (line: string) => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the YAML parser throws on input it cannot read
  try {
    const parsed: unknown = loadYaml(line, yamlOptions);
    const keys = isObject(parsed) ? Object.keys(parsed) : [];
    return keys.length === 1 ? keys[0] : undefined;
  } catch {
    return undefined;
  }
};

/** An entry's place in the text: from its key line to the next entry's. */
interface Place {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly indent: number;
  /** Whether its key line holds no value, so that a deeper block map can. */
  readonly bare: boolean;
}

/**
 * The block map of a range under a key at `parent` columns: each key line at the indent of the
 * range's first line, which is deeper, and the lines under it up to the next. `none` when the range
 * holds no block map, such as a list; `unreadable` with the line of a key this reader cannot read,
 * or of a line between the two indents. A key that repeats keeps its last entry where it first
 * appeared, as the parser does.
 */
const blockMap = (
  bytes: Uint8Array,
  from: number,
  to: number,
  number: number,
  parent: number,
):
  | { readonly kind: "map"; readonly places: Record<string, Place> }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable"; readonly line: number } => {
  const places: Record<string, Place> = Object.create(null);
  let indent = -1;
  let open: (Omit<Place, "end"> & { readonly key: string }) | undefined;
  for (const line of significantLines(bytes, from, to, number)) {
    if (indent === -1) {
      if (line.indent <= parent || listEntry(bytes, line)) return { kind: "none" };
      indent = line.indent;
    }
    if (line.indent > indent || (line.indent === indent && listEntry(bytes, line))) continue;
    if (line.indent < indent) return { kind: "unreadable", line: line.number };
    const text = lossyUtf8.decode(bytes.subarray(line.start, line.end));
    const end = keyEnd(text, indent);
    const key = end === undefined ? undefined : keyOf(text.slice(0, end));
    if (end === undefined || key === undefined) return { kind: "unreadable", line: line.number };
    if (open !== undefined) places[open.key] = { ...open, end: line.start };
    const rest = text.slice(end).trim();
    open = {
      key,
      start: line.start,
      line: line.number,
      indent,
      bare: rest === "" || rest.startsWith("#"),
    };
  }
  if (open === undefined) return { kind: "none" };
  places[open.key] = { ...open, end: to };
  return { kind: "map", places };
};

/**
 * Read a stored document of block YAML one entry at a time, as v1 read its Microsoft Graph
 * documents: an index of where each top-level entry, path item and component starts, built from
 * the bytes without decoding them whole, and each entry parsed when it is read. `unread` names the
 * first entry that could not be parsed, which reads as missing, so a cut that read it is not used.
 * Refused when the text is not block YAML this reader can index.
 */
export const blockYamlDocument = (
  bytes: Uint8Array,
):
  | { readonly ok: true; readonly document: Entries; readonly unread: () => string | undefined }
  | { readonly ok: false; readonly reason: string } => {
  let unread: string | undefined;
  const parse = (place: Place, key: string): unknown => {
    if (unread !== undefined) return undefined;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the YAML parser throws on input it cannot read
    try {
      const parsed: unknown = loadYaml(
        lossyUtf8.decode(bytes.subarray(place.start, place.end)),
        yamlOptions,
      );
      if (isObject(parsed) && Object.keys(parsed).length === 1 && Object.hasOwn(parsed, key))
        return parsed[key];
      unread = `v1's stored specification could not be read: its entry at line ${place.line + 1} does not read as that entry alone (${bytes.length} bytes).`;
    } catch (error) {
      const at =
        error instanceof YAMLException && error.mark !== undefined
          ? ` at line ${place.line + error.mark.line + 1}, column ${error.mark.column + 1}`
          : "";
      unread =
        error instanceof YAMLException
          ? `v1's stored specification could not be read: as YAML, ${parserReason(error.reason)}${at} (${bytes.length} bytes).`
          : `v1's stored specification could not be read: reading it as YAML failed with ${error instanceof Error ? error.name : "an unknown error"} (${bytes.length} bytes).`;
    }
    return undefined;
  };
  const refused = (line: number) => ({
    ok: false as const,
    reason: `v1's stored Microsoft Graph specification is not block YAML the import can read one entry at a time, as v1 read it: line ${line + 1} holds no key it can read.`,
  });
  const entries = (places: Record<string, Place>, read: (place: Place, key: string) => unknown) =>
    new Entries(
      Object.keys(places),
      (key) => Object.hasOwn(places, key),
      (key) => {
        const place = places[key];
        return place === undefined ? undefined : read(place, key);
      },
    );
  /** The block map under an entry's bare key line. */
  const under = (place: Place) => {
    const keyLine = bytes.indexOf(newline, place.start);
    return !place.bare || keyLine === -1 || keyLine >= place.end
      ? ({ kind: "none" } as const)
      : blockMap(bytes, keyLine + 1, place.end, place.line + 1, place.indent);
  };
  const top = blockMap(bytes, 0, bytes.length, 0, -1);
  if (top.kind === "none") return refused(0);
  if (top.kind === "unreadable") return refused(top.line);
  const maps: Record<string, Entries> = Object.create(null);
  const paths = top.places.paths === undefined ? undefined : under(top.places.paths);
  if (paths?.kind === "unreadable") return refused(paths.line);
  if (paths?.kind === "map") maps.paths = entries(paths.places, parse);
  const components = top.places.components === undefined ? undefined : under(top.places.components);
  if (components?.kind === "unreadable") return refused(components.line);
  if (components?.kind === "map") {
    const sections: Record<string, Entries> = Object.create(null);
    for (const [name, place] of Object.entries(components.places)) {
      const section = under(place);
      if (section.kind === "unreadable") return refused(section.line);
      if (section.kind === "map") sections[name] = entries(section.places, parse);
    }
    maps.components = entries(
      components.places,
      (place, key) => sections[key] ?? parse(place, key),
    );
  }
  return {
    ok: true,
    document: entries(top.places, (place, key) => maps[key] ?? parse(place, key)),
    unread: () => unread,
  };
};
