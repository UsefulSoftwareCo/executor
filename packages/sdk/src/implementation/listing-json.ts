import { withLegacyKeys } from "@executor-js/utils/legacy-keys";
import { putEntry, schemaDefinitions } from "@executor-js/utils/schema-definitions";
import { Effect, Schema } from "effect";
import { AppAccounts } from "../contracts/apps.ts";
import { VersionId, Json, type JsonObject } from "../contracts/shared.ts";
import { type Tool, ToolFields, ToolRouter } from "../contracts/tools.ts";
import type { ToolListing } from "./listings.ts";

const CatalogFields = Schema.Struct({ version: VersionId, accounts: AppAccounts });
const Catalog = CatalogFields.pipe(withLegacyKeys({ version: "deployment" }));
const SchemaKey = Schema.Literals(["inputSchema", "outputSchema"]);
type SchemaKey = typeof SchemaKey.Type;
export const StoredTool = Schema.Struct({
  ...ToolFields.fields,
  shared: Schema.optionalKey(Schema.Array(SchemaKey)),
}).pipe(withLegacyKeys({ version: "deployment" }));
export type StoredTool = typeof StoredTool.Type;
const DefsListing = Schema.Struct({
  format: Schema.Literal(3),
  catalog: Catalog,
  definitions: Schema.Array(Json),
  defs: Schema.Array(Schema.Record(Schema.String, Schema.Int)),
  tools: Schema.Array(StoredTool),
  chars: Schema.Array(Schema.Int),
  routers: Schema.Array(ToolRouter),
});
const SharedListing = Schema.Struct({
  format: Schema.Literal(2),
  catalog: Catalog,
  definitions: Schema.Array(Json),
  tools: Schema.Array(StoredTool),
  routers: Schema.Array(ToolRouter),
});
const DefsListingJson = Schema.fromJsonString(DefsListing);
const ListingJson = Schema.fromJsonString(Schema.Union([DefsListing, SharedListing]));

class ListingJsonInvalid extends Schema.TaggedError<ListingJsonInvalid>()(
  "ListingJsonInvalid",
  {},
) {}

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

export const shareListing = (listing: ToolListing) => {
  type Interned = { readonly text: string; readonly at: number; readonly definition: Json };
  type Bucket = {
    readonly name: string;
    readonly first: Interned;
    byHash?: Map<number, Array<Interned>>;
  };
  const known = new Map<number, Array<Bucket>>();
  const objects = new Map<Json, Interned>();
  const definitions: Array<Json> = [];
  const definitionLengths: Array<number> = [];
  let definitionChars = 0;
  let copies = 0;
  let comparisons = 0;
  const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
  const add = (text: string, definition: Json): Interned => {
    definitionChars += text.length;
    definitionLengths.push(text.length);
    return { text, at: definitions.push(definition) - 1, definition };
  };
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
    readonly at: number;
  };
  const defs: Array<{ readonly [name: string]: number }> = [];
  const defsPositions: Array<ReadonlyArray<number>> = [];
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
  let counts: { readonly chars: number; readonly items: ReadonlyArray<number> } | undefined;
  const counted = () => {
    if (counts !== undefined) return counts;
    const grown = definitionLengths.map((length, at) => length - String(at).length);
    let chars = definitionChars + 2 * 2 + Math.max(0, defs.length - 1);
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
    get bytes() {
      return counted().chars * 2;
    },
    get itemChars() {
      return counted().items;
    },
    stored,
    get sizes() {
      return {
        "executor.listing.json_chars": counted().chars,
        "executor.listing.definitions": definitions.length,
        "executor.listing.definition_copies": copies,
        "executor.listing.definition_comparisons": comparisons,
        "executor.listing.defs": defs.length,
      };
    },
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
    const put = { ...schema, $defs: restored };
    item = key === "inputSchema" ? { ...item, inputSchema: put } : { ...item, outputSchema: put };
  }
  return item;
};

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

const restoreDefs = (kept: typeof DefsListing.Type) => {
  const defs: Array<JsonObject> = [];
  for (const named of kept.defs) {
    const restored: Record<string, Json> = {};
    for (const [name, at] of Object.entries(named)) {
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

const restorePositions = (kept: typeof SharedListing.Type) => {
  const items: Array<Tool> = [];
  for (const tool of kept.tools) {
    const item = restoreTool(tool, (at) => kept.definitions[at]);
    if (item === undefined) return undefined;
    items.push(item);
  }
  return items;
};

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
