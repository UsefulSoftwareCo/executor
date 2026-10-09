/**
 * The JSON text a tool listing is kept as beyond its isolate. Routers such as the OpenAPI and
 * GraphQL importers give every tool a copy of each definition its schemas reach, so most of a
 * large listing is the same `$defs` entries again and again. The text keeps each distinct entry
 * once, and the listing in memory shares one object per distinct entry among its tools.
 */
import { Effect, Schema } from "effect";
import { ProfileRevision } from "../contracts/profiles.ts";
import { DeploymentId, Json, type JsonObject, ProfileId } from "../contracts/shared.ts";
import { Tool, ToolRouter } from "../contracts/tools.ts";
import type { ToolListing } from "./listings.ts";

const Catalog = Schema.Struct({
  deployment: DeploymentId,
  profile: Schema.optionalKey(ProfileId),
  profileRevision: Schema.optionalKey(ProfileRevision),
});
/** The schemas of a tool whose `$defs` entries can be shared. */
const SchemaKey = Schema.Literals(["inputSchema", "outputSchema"]);
type SchemaKey = typeof SchemaKey.Type;
/**
 * Format 2. Each `$defs` entry of a schema a tool names in `shared` is the index of its definition
 * in `definitions`. Format 1 texts have no `format` and fail to decode as it, and readers of
 * format 1 find no `items` here, so neither is ever mistaken for the other.
 */
const SharedListing = Schema.Struct({
  format: Schema.Literal(2),
  catalog: Catalog,
  definitions: Schema.Array(Json),
  tools: Schema.Array(
    Schema.Struct({ ...Tool.fields, shared: Schema.optionalKey(Schema.Array(SchemaKey)) }),
  ),
  routers: Schema.Array(ToolRouter),
});
/**
 * Format 1: every tool carries each definition it reaches. Texts kept before format 2 expire
 * within `maxStaleMillis` of their evaluation, a day; read them until then.
 */
const UnsharedListing = Schema.Struct({
  catalog: Catalog,
  items: Schema.Array(Tool),
  routers: Schema.Array(ToolRouter),
});
type StoredTool = (typeof SharedListing.Type)["tools"][number];
const SharedListingJson = Schema.fromJsonString(SharedListing);
const ListingJson = Schema.fromJsonString(Schema.Union([SharedListing, UnsharedListing]));

/** A format 2 text that names a definition it does not hold. */
class ListingJsonInvalid extends Schema.TaggedError<ListingJsonInvalid>()(
  "ListingJsonInvalid",
  {},
) {}

/** Add an own entry. Assignment would set the prototype for a definition named `__proto__`. */
const put = (target: Record<string, Json>, name: string, value: Json) => {
  if (name === "__proto__")
    Object.defineProperty(target, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  else target[name] = value;
};
const definitionsOf = (schema: JsonObject | undefined) => {
  const definitions = schema?.$defs;
  return typeof definitions === "object" && definitions !== null && !Array.isArray(definitions)
    ? definitions
    : undefined;
};
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
 * The listing with one object per distinct `$defs` entry, what it counts in memory, and its text,
 * encoded when it is written. Entries with the same name and JSON are the same entry, so sharing
 * one object changes no schema a reader sees: listings are never mutated.
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
  const definitions: Array<Json> = [];
  let definitionChars = 0;
  let copies = 0;
  // Drawn in the call: Workers refuse random values at global scope.
  const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
  const add = (text: string, definition: Json): Interned => {
    definitionChars += text.length;
    return { text, at: definitions.push(definition) - 1, definition };
  };
  /** The first definition with this name and JSON, and its index. */
  const intern = (name: string, definition: Json) => {
    const text = JSON.stringify(definition);
    // Each length seeds its own hash of the name.
    const key = hashText(name, seed ^ text.length);
    const buckets = known.get(key);
    const bucket = buckets?.find((candidate) => candidate.name === name);
    if (bucket === undefined) {
      const added = add(text, definition);
      const created = { name, first: added };
      if (buckets === undefined) known.set(key, [created]);
      else buckets.push(created);
      return added;
    }
    if (bucket.byHash === undefined && bucket.first.text === text) {
      copies += 1;
      return bucket.first;
    }
    bucket.byHash ??= new Map([[hashText(bucket.first.text, seed), [bucket.first]]]);
    const hash = hashText(text, seed);
    const candidates = bucket.byHash.get(hash);
    const found = candidates?.find((candidate) => candidate.text === text);
    if (found !== undefined) {
      copies += 1;
      return found;
    }
    const added = add(text, definition);
    if (candidates === undefined) bucket.byHash.set(hash, [added]);
    else candidates.push(added);
    return added;
  };
  const share = (schema: JsonObject | undefined) => {
    const own = definitionsOf(schema);
    if (schema === undefined || own === undefined) return undefined;
    const kept: Record<string, Json> = {};
    const stored: Record<string, Json> = {};
    for (const [name, definition] of Object.entries(own)) {
      const interned = intern(name, definition);
      put(kept, name, interned.definition);
      put(stored, name, interned.at);
    }
    // Spreading keeps `$defs` where the schema had it.
    return { kept: { ...schema, $defs: kept }, stored: { ...schema, $defs: stored } };
  };
  const items: Array<Tool> = [];
  const tools: Array<StoredTool> = [];
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
  }
  const chars = JSON.stringify(tools).length + definitionChars;
  return {
    listing: { ...listing, items },
    /** UTF-16 bytes of its tools' text, with each definition once, as `DeclarationLimits` counts. */
    bytes: chars * 2,
    /** What sharing found, for the evaluation's span. */
    sizes: {
      "executor.listing.json_chars": chars,
      "executor.listing.definitions": definitions.length,
      "executor.listing.definition_copies": copies,
    },
    // Suspended: building a schema's encoding effect already encodes.
    json: Effect.suspend(() =>
      Schema.encodeEffect(SharedListingJson)({
        format: 2,
        catalog: listing.catalog,
        definitions,
        tools,
        routers: listing.routers,
      }),
    ),
  };
};

/**
 * A kept listing's text, in either format, recording its size and format on the current span.
 * Tools of a format 2 text share their definitions.
 */
export const decodeListing = (json: string) =>
  Schema.decodeEffect(ListingJson)(json).pipe(
    Effect.tap((kept) =>
      Effect.annotateCurrentSpan({
        "executor.listing.json_chars": json.length,
        "executor.listing.format": "format" in kept ? kept.format : 1,
      }),
    ),
    Effect.flatMap((kept): Effect.Effect<ToolListing, ListingJsonInvalid> => {
      if (!("format" in kept)) return Effect.succeed(kept);
      const restore = (schema: JsonObject | undefined) => {
        const own = definitionsOf(schema);
        if (schema === undefined || own === undefined) return undefined;
        const restored: Record<string, Json> = {};
        for (const [name, at] of Object.entries(own)) {
          const definition = typeof at === "number" ? kept.definitions[at] : undefined;
          if (definition === undefined) return undefined;
          put(restored, name, definition);
        }
        return { ...schema, $defs: restored };
      };
      const items: Array<Tool> = [];
      for (const { shared, ...tool } of kept.tools) {
        let item: Tool = tool;
        for (const key of shared ?? []) {
          const schema = restore(item[key]);
          if (schema === undefined) return Effect.fail(new ListingJsonInvalid());
          item =
            key === "inputSchema"
              ? { ...item, inputSchema: schema }
              : { ...item, outputSchema: schema };
        }
        items.push(item);
      }
      return Effect.succeed({ catalog: kept.catalog, items, routers: kept.routers });
    }),
  );
