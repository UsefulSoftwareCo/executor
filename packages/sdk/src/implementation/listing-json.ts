/**
 * The JSON text a tool listing is kept as beyond its isolate. Routers such as the OpenAPI and
 * GraphQL importers give every tool's schema a `$defs` of its own, with a copy of each definition
 * it reaches, so most of a large listing is the same `$defs` again and again. The text keeps each
 * distinct definition and each distinct `$defs` once, and the listing in memory shares one object
 * for each among its tools.
 */
import { withLegacyKeys } from "@executor-js/utils/legacy-keys";
import { putEntry, schemaDefinitions } from "@executor-js/utils/schema-definitions";
import { Effect, Schema } from "effect";
import { AppAccounts } from "../contracts/apps.ts";
import { VersionId, Json, type JsonObject } from "../contracts/shared.ts";
import { type Tool, ToolFields, ToolRouter } from "../contracts/tools.ts";
import type { ToolListing } from "./listings.ts";

/**
 * What the listing was evaluated with. Texts kept before 4.0.13 named a profile instead of
 * accounts; they are kept under declaration keys of that time, which no current read computes.
 * Texts kept before account scopes named one flat record and fail to decode, so they are read
 * as missing and evaluated again.
 */
const CatalogFields = Schema.Struct({ version: VersionId, accounts: AppAccounts });
const Catalog = CatalogFields.pipe(withLegacyKeys({ version: "deployment" }));
/** The schemas of a tool whose `$defs` can be shared. */
const SchemaKey = Schema.Literals(["inputSchema", "outputSchema"]);
type SchemaKey = typeof SchemaKey.Type;
/**
 * A tool whose schemas `shared` names keep their `$defs` elsewhere. In search rows and format 2,
 * each `$defs` entry of such a schema is the position of its definition in `definitions`; in
 * format 3, its `$defs` is the position of its entries in `defs`.
 */
export const StoredTool = Schema.Struct({
  ...ToolFields.fields,
  shared: Schema.optionalKey(Schema.Array(SchemaKey)),
}).pipe(withLegacyKeys({ version: "deployment" }));
export type StoredTool = typeof StoredTool.Type;
/**
 * Format 3. Each distinct `$defs` is kept once in `defs`, its entries the positions of their
 * definitions in `definitions`. An OpenAPI listing's schemas may name 300,000 `$defs` entries,
 * of a few hundred distinct `$defs`. `chars` is each tool's `ToolListing.itemChars`, so a reader
 * bounds its pages without writing its tools.
 */
const DefsListing = Schema.Struct({
  format: Schema.Literal(3),
  catalog: Catalog,
  definitions: Schema.Array(Json),
  defs: Schema.Array(Schema.Record(Schema.String, Schema.Int)),
  tools: Schema.Array(StoredTool),
  chars: Schema.Array(Schema.Int),
  routers: Schema.Array(ToolRouter),
});
/**
 * Format 2: each tool keeps its `$defs` entries as positions. Texts kept before format 3 expire
 * within `maxStaleMillis` of their evaluation, a day; read them until then. Older servers read
 * a format 3 text as missing and evaluate the listing again.
 */
const SharedListing = Schema.Struct({
  format: Schema.Literal(2),
  catalog: Catalog,
  definitions: Schema.Array(Json),
  tools: Schema.Array(StoredTool),
  routers: Schema.Array(ToolRouter),
});
const DefsListingJson = Schema.fromJsonString(DefsListing);
const ListingJson = Schema.fromJsonString(Schema.Union([DefsListing, SharedListing]));

/** A text that names a definition or `$defs` it does not hold. */
class ListingJsonInvalid extends Schema.TaggedError<ListingJsonInvalid>()(
  "ListingJsonInvalid",
  {},
) {}

/**
 * A 53-bit hash of a text (cyrb53). Maps cannot index an app's strings themselves: V8 hashes a
 * string of more than 16,383 characters by its length alone, so distinct long strings of one
 * length share a hash and each lookup compares them all. The seed is random, so an app cannot
 * list texts made to collide. Its collisions are improbable, not impossible: indexes keyed by it
 * take expected linear time, and exact text still decides equality.
 */
const hashText = (text: string, seed: number) => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

/**
 * The listing with one object per distinct `$defs` and per distinct `$defs` entry, what it counts
 * in memory, the JSON length of each of its tools, and its text, encoded when it is written.
 * Entries with the same name and JSON are the same entry, and `$defs` with the same entries in the
 * same order are the same `$defs`, so sharing one object changes no schema a reader sees: listings
 * are never mutated.
 */
export const shareListing = (listing: ToolListing) => {
  type Interned = { readonly text: string; readonly at: number; readonly definition: Json };
  /**
   * Definitions of one name and text length. Hashing whole definitions costs as much again as
   * writing them, and most buckets hold one definition and its copies, which compare at memory
   * speed. A bucket that holds more indexes them by hash, so each text is hashed at most once and
   * compared only with those it may equal.
   */
  type Bucket = {
    readonly name: string;
    readonly first: Interned;
    byHash?: Map<number, Array<Interned>>;
  };
  /** Buckets by a hash of their name and text length: names are the app's, of any length. */
  const known = new Map<number, Array<Bucket>>();
  /**
   * Definitions by object. A listing whose tools already share their definitions, such as a kept
   * one, finds each copy here without encoding it again. An object is one JSON value, so its
   * position serves every name it appears under.
   */
  const objects = new Map<Json, Interned>();
  const definitions: Array<Json> = [];
  /** The JSON length of each definition, by position. */
  const definitionLengths: Array<number> = [];
  let definitionChars = 0;
  let copies = 0;
  /**
   * Names, texts and `$defs` compared with one already interned. A definition's name is compared
   * with the buckets under its hash, normally only its own name's, and its text with the earlier
   * definitions of its name and length that share its hash, normally none, so this stays near the
   * definition count however names and texts repeat. The evaluation's span records it.
   */
  let comparisons = 0;
  // Drawn in the call: Workers refuse random values at global scope.
  const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
  const add = (text: string, definition: Json): Interned => {
    definitionChars += text.length;
    definitionLengths.push(text.length);
    return { text, at: definitions.push(definition) - 1, definition };
  };
  /** The first definition with this name and JSON, and its index. */
  const intern = (name: string, definition: Json) => {
    const same = typeof definition === "object" ? objects.get(definition) : undefined;
    if (same !== undefined) {
      copies += 1;
      return same;
    }
    const found = internText(name, definition);
    if (typeof definition === "object") objects.set(definition, found);
    return found;
  };
  const internText = (name: string, definition: Json) => {
    const text = JSON.stringify(definition);
    // Each length seeds its own hash of the name.
    const key = hashText(name, seed ^ text.length);
    const buckets = known.get(key);
    const bucket = buckets?.find((candidate) => {
      comparisons += 1;
      return candidate.name === name;
    });
    if (bucket === undefined) {
      const added = add(text, definition);
      const created = { name, first: added };
      if (buckets === undefined) known.set(key, [created]);
      else buckets.push(created);
      return added;
    }
    if (bucket.byHash === undefined) {
      comparisons += 1;
      if (bucket.first.text === text) {
        copies += 1;
        return bucket.first;
      }
    }
    bucket.byHash ??= new Map([[hashText(bucket.first.text, seed), [bucket.first]]]);
    const hash = hashText(text, seed);
    const candidates = bucket.byHash.get(hash);
    const found = candidates?.find((candidate) => {
      comparisons += 1;
      return candidate.text === text;
    });
    if (found !== undefined) {
      copies += 1;
      return found;
    }
    const added = add(text, definition);
    if (candidates === undefined) bucket.byHash.set(hash, [added]);
    else candidates.push(added);
    return added;
  };
  type Defs = {
    readonly names: ReadonlyArray<string>;
    readonly positions: ReadonlyArray<number>;
    readonly kept: JsonObject;
    readonly stored: { readonly [name: string]: number };
    /** Its position in `defs`. */
    readonly at: number;
  };
  /** Each distinct `$defs` once, its entries as positions in `definitions`. */
  const defs: Array<{ readonly [name: string]: number }> = [];
  /** The positions each of `defs` names, in its entries' order. */
  const defsPositions: Array<ReadonlyArray<number>> = [];
  /**
   * `$defs` by object, and by a hash of their entries' positions. Tools of a catalog restored from
   * an app's shared catalog, or of a kept listing, share one object for each distinct `$defs`,
   * found here without interning its entries again.
   */
  const defsByObject = new Map<JsonObject, Defs>();
  const defsByPositions = new Map<number, Array<Defs>>();
  const same = <A>(left: ReadonlyArray<A>, right: ReadonlyArray<A>) =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  const internDefs = (own: JsonObject) => {
    const known = defsByObject.get(own);
    if (known !== undefined) {
      copies += known.names.length;
      return known;
    }
    const names: Array<string> = [];
    const found: Array<Interned> = [];
    for (const [name, definition] of Object.entries(own)) {
      names.push(name);
      found.push(intern(name, definition));
    }
    const positions = found.map((entry) => entry.at);
    // Positions alone do not name the entries: one definition object is one position under every
    // name it appears under, so a match also compares the names.
    const key = hashText(positions.join(","), seed);
    const candidates = defsByPositions.get(key);
    let interned = candidates?.find((candidate) => {
      comparisons += 1;
      return same(candidate.positions, positions) && same(candidate.names, names);
    });
    if (interned === undefined) {
      const kept: Record<string, Json> = {};
      const stored: Record<string, number> = {};
      for (const [index, name] of names.entries()) {
        putEntry(kept, name, found[index]!.definition);
        putEntry(stored, name, positions[index]!);
      }
      interned = { names, positions, kept, stored, at: defs.push(stored) - 1 };
      defsPositions.push(positions);
      if (candidates === undefined) defsByPositions.set(key, [interned]);
      else candidates.push(interned);
    }
    defsByObject.set(own, interned);
    return interned;
  };
  const share = (schema: JsonObject | undefined) => {
    const own = schemaDefinitions(schema);
    if (schema === undefined || own === undefined) return undefined;
    const { kept, stored, at } = internDefs(own);
    // Spreading keeps `$defs` where the schema had it.
    return {
      kept: { ...schema, $defs: kept },
      stored: { ...schema, $defs: stored },
      text: { ...schema, $defs: at },
    };
  };
  const items: Array<Tool> = [];
  const tools: Array<StoredTool> = [];
  const texts: Array<StoredTool> = [];
  for (const tool of listing.items) {
    const input = share(tool.inputSchema);
    const output = share(tool.outputSchema);
    const shared: Array<SchemaKey> = [
      ...(input === undefined ? [] : ["inputSchema" as const]),
      ...(output === undefined ? [] : ["outputSchema" as const]),
    ];
    items.push(
      shared.length === 0
        ? tool
        : {
            ...tool,
            ...(input === undefined ? {} : { inputSchema: input.kept }),
            ...(output === undefined ? {} : { outputSchema: output.kept }),
          },
    );
    tools.push(
      shared.length === 0
        ? tool
        : {
            ...tool,
            ...(input === undefined ? {} : { inputSchema: input.stored }),
            ...(output === undefined ? {} : { outputSchema: output.stored }),
            shared,
          },
    );
    texts.push(
      shared.length === 0
        ? tool
        : {
            ...tool,
            ...(input === undefined ? {} : { inputSchema: input.text }),
            ...(output === undefined ? {} : { outputSchema: output.text }),
            shared,
          },
    );
  }
  const stored: {
    readonly definitions: ReadonlyArray<Json>;
    readonly tools: ReadonlyArray<StoredTool>;
  } = { definitions, tools };
  /**
   * The length of its text, and of each tool's JSON with its `$defs` in place, written once:
   * a tool's text names each of its `$defs` by position, and each `$defs` its definitions. Counted
   * when read: search rows share a listing without keeping its text or its pages.
   */
  let counts: { readonly chars: number; readonly items: ReadonlyArray<number> } | undefined;
  const counted = () => {
    if (counts !== undefined) return counts;
    /** What a definition's JSON adds in place of its position. */
    const grown = definitionLengths.map((length, at) => length - String(at).length);
    let chars = definitionChars + 2 * 2 + Math.max(0, defs.length - 1);
    /** The JSON length of each `$defs` with its definitions in place. */
    const defsLengths = defs.map((named, at) => {
      const length = JSON.stringify(named).length;
      chars += length;
      let restored = length;
      for (const position of defsPositions[at]!) restored += grown[position]!;
      return restored;
    });
    chars += Math.max(0, texts.length - 1);
    const lengths = texts.map((text) => {
      const length = JSON.stringify(text).length;
      chars += length;
      if (text.shared === undefined) return length;
      // Without its trailing `,"shared":[…]`, and each `$defs` position written as its `$defs`.
      let restored = length - ',"shared":'.length - JSON.stringify(text.shared).length;
      for (const key of text.shared) {
        const at = text[key]?.$defs;
        if (typeof at === "number") restored += defsLengths[at]! - String(at).length;
      }
      return restored;
    });
    return (counts = { chars, items: lengths });
  };
  return {
    listing: { catalog: listing.catalog, routers: listing.routers, items },
    /**
     * UTF-16 bytes of its tools, `$defs` and definitions as its text writes them, as
     * `DeclarationLimits` counts.
     */
    get bytes() {
      return counted().chars * 2;
    },
    /** `ToolListing.itemChars` of the listing. */
    get itemChars() {
      return counted().items;
    },
    /**
     * The listing as search rows keep it: each distinct definition once, and the tools naming
     * them by position, in the order of the listing's items.
     */
    stored,
    /** What sharing found, for the evaluation's span. */
    get sizes() {
      return {
        "executor.listing.json_chars": counted().chars,
        "executor.listing.definitions": definitions.length,
        "executor.listing.definition_copies": copies,
        "executor.listing.definition_comparisons": comparisons,
        "executor.listing.defs": defs.length,
      };
    },
    // Suspended: building a schema's encoding effect already encodes.
    json: Effect.suspend(() =>
      Schema.encodeEffect(DefsListingJson)({
        format: 3,
        catalog: listing.catalog,
        definitions,
        defs,
        tools: texts,
        chars: counted().items,
        routers: listing.routers,
      }),
    ),
  };
};

/** A tool with the `$defs` of each schema `shared` names put back; undefined when one is not. */
const restoreSchemas = (
  tool: Tool,
  shared: ReadonlyArray<SchemaKey> | undefined,
  restore: (schema: JsonObject) => JsonObject | undefined,
): Tool | undefined => {
  let item = tool;
  for (const key of shared ?? []) {
    const schema = item[key];
    const restored = schema === undefined ? undefined : restore(schema);
    if (schema === undefined || restored === undefined) return undefined;
    // Spreading keeps `$defs` where the schema had it.
    const put = { ...schema, $defs: restored };
    item = key === "inputSchema" ? { ...item, inputSchema: put } : { ...item, outputSchema: put };
  }
  return item;
};

/**
 * A tool of search rows or a format 2 text with the definitions it names put back, or undefined
 * when it names one `definition` does not have.
 */
export const restoreTool = (
  { shared, ...tool }: StoredTool,
  definition: (position: number) => Json | undefined,
): Tool | undefined =>
  restoreSchemas(tool, shared, (schema) => {
    const own = schemaDefinitions(schema);
    if (own === undefined) return undefined;
    const restored: Record<string, Json> = {};
    for (const [name, at] of Object.entries(own)) {
      const found = typeof at === "number" ? definition(at) : undefined;
      if (found === undefined) return undefined;
      putEntry(restored, name, found);
    }
    return restored;
  });

/**
 * A format 3 listing's tools, each distinct `$defs` put back once and shared by the tools that
 * name it; undefined when one names a definition or `$defs` the text does not hold.
 */
const restoreDefs = (kept: typeof DefsListing.Type) => {
  const defs: Array<JsonObject> = [];
  for (const named of kept.defs) {
    const restored: Record<string, Json> = {};
    for (const [name, at] of Object.entries(named)) {
      // A JSON value is never undefined, so a position out of range is the only way to get it.
      const definition = kept.definitions[at];
      if (definition === undefined) return undefined;
      putEntry(restored, name, definition);
    }
    defs.push(restored);
  }
  const items: Array<Tool> = [];
  for (const { shared, ...tool } of kept.tools) {
    const item = restoreSchemas(tool, shared, (schema) =>
      typeof schema.$defs === "number" ? defs[schema.$defs] : undefined,
    );
    if (item === undefined) return undefined;
    items.push(item);
  }
  return items;
};

/** A format 2 listing's tools; undefined when one names a definition the text does not hold. */
const restorePositions = (kept: typeof SharedListing.Type) => {
  const items: Array<Tool> = [];
  for (const tool of kept.tools) {
    const item = restoreTool(tool, (at) => kept.definitions[at]);
    if (item === undefined) return undefined;
    items.push(item);
  }
  return items;
};

/**
 * A kept listing's text, in either format, recording its size and format on the current span.
 * Its tools share their definitions, and those of a format 3 text their `$defs`.
 */
export const decodeListing = (json: string) =>
  Schema.decodeEffect(ListingJson)(json).pipe(
    Effect.tap((kept) =>
      Effect.annotateCurrentSpan({
        "executor.listing.json_chars": json.length,
        "executor.listing.format": kept.format,
      }),
    ),
    Effect.flatMap((kept): Effect.Effect<ToolListing, ListingJsonInvalid> => {
      if (kept.format === 2) {
        const items = restorePositions(kept);
        return items === undefined
          ? Effect.fail(new ListingJsonInvalid())
          : Effect.succeed({ catalog: kept.catalog, items, routers: kept.routers });
      }
      const items = kept.chars.length === kept.tools.length ? restoreDefs(kept) : undefined;
      return items === undefined
        ? Effect.fail(new ListingJsonInvalid())
        : Effect.succeed({
            catalog: kept.catalog,
            items,
            routers: kept.routers,
            itemChars: kept.chars,
          });
    }),
  );
