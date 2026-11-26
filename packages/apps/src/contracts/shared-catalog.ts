/**
 * A `HostedSharedCatalog` both ways: the bundle shares a catalog, the host restores it.
 *
 * Routers such as the OpenAPI importer give every tool's schema a `$defs` of its own, holding the
 * definitions it reaches: the same object for each tool that reaches one. A densely connected
 * document, one whose resources expand into each other, reaches most of its definitions from
 * every tool, so writing each tool's copy multiplies the document by its tool count. Stripe's
 * 8 MB description became 384 million characters, and its schemas' `$defs` name about 330,000
 * entries, though only a few hundred `$defs` differ.
 *
 * `shareCatalog` writes each definition once and each distinct `$defs` once. `restoreSharedCatalog`
 * puts them back: each tool's schemas are again, as JSON, those the bundle evaluated, and tools
 * whose `$defs` were equal share one object for it, so the host holds each `$defs` once.
 *
 * Definitions are matched by object, not by text: matching by text would first write every copy,
 * which is the cost sharing avoids. Copies that are distinct objects stay distinct. Two `$defs` are
 * equal when they name the same definitions under the same names, in the same order.
 */
import { putEntry, schemaDefinitions } from "@executor-js/utils/schema-definitions";
import type {
  HostedCatalog,
  HostedRouter,
  HostedSharedCatalog,
  HostedSharedTool,
  HostedTool,
} from "./protocols/current.ts";
import type { JsonObject, JsonValue } from "./schema.ts";

/** A catalog with each definition and each distinct `$defs` its tools' schemas hold sent once. */
export const shareCatalog = (catalog: {
  readonly tools: ReadonlyArray<HostedTool>;
  readonly routers: ReadonlyArray<HostedRouter>;
}): HostedSharedCatalog => {
  const definitions: Array<JsonValue> = [];
  /** Positions by object, or by value for a definition that is not an object. */
  const positions = new Map<JsonValue, number>();
  const position = (definition: JsonValue) => {
    let at = positions.get(definition);
    if (at === undefined) positions.set(definition, (at = definitions.push(definition) - 1));
    return at;
  };
  const defs: Array<Record<string, number>> = [];
  /** A number for each name and position, so a `$defs` is keyed by its entries' numbers. */
  const entries = new Map<string, Map<number, number>>();
  let entryCount = 0;
  const entry = (name: string, at: number) => {
    let named = entries.get(name);
    if (named === undefined) entries.set(name, (named = new Map()));
    let number = named.get(at);
    if (number === undefined) named.set(at, (number = entryCount++));
    return number;
  };
  /** Each `$defs` by object, and by its entries' numbers in order. */
  const byObject = new Map<JsonObject, number>();
  const byEntries = new Map<string, number>();
  const defsOf = (own: JsonObject) => {
    const known = byObject.get(own);
    if (known !== undefined) return known;
    const named: Record<string, number> = {};
    const key: Array<number> = [];
    for (const [name, definition] of Object.entries(own)) {
      const at = position(definition);
      putEntry(named, name, at);
      key.push(entry(name, at));
    }
    const text = key.join(",");
    let at = byEntries.get(text);
    if (at === undefined) byEntries.set(text, (at = defs.push(named) - 1));
    byObject.set(own, at);
    return at;
  };
  const share = (schema: JsonObject | undefined) => {
    const own = schemaDefinitions(schema);
    return schema === undefined || own === undefined
      ? undefined
      : { ...schema, $defs: defsOf(own) };
  };
  const tools = catalog.tools.map((tool): HostedSharedTool => {
    const input = share(tool.inputSchema);
    const output = share(tool.outputSchema);
    if (input === undefined && output === undefined) return tool;
    return {
      ...tool,
      ...(input === undefined ? {} : { inputSchema: input }),
      ...(output === undefined ? {} : { outputSchema: output }),
      shared: [
        ...(input === undefined ? [] : ["inputSchema" as const]),
        ...(output === undefined ? [] : ["outputSchema" as const]),
      ],
    };
  });
  return { tools, routers: catalog.routers, definitions, defs };
};

/**
 * The catalog a shared catalog was made from; undefined when it names a definition or `$defs`
 * it does not send.
 */
export const restoreSharedCatalog = (catalog: HostedSharedCatalog): HostedCatalog | undefined => {
  const { definitions } = catalog;
  const defs: Array<JsonObject> = [];
  for (const named of catalog.defs) {
    const restored: Record<string, JsonValue> = {};
    for (const [name, at] of Object.entries(named)) {
      const definition = definitions[at];
      if (definition === undefined) return undefined;
      putEntry(restored, name, definition);
    }
    defs.push(restored);
  }
  const restore = (schema: JsonObject | undefined) => {
    const at = schema?.$defs;
    const found = typeof at === "number" ? defs[at] : undefined;
    return schema === undefined || found === undefined ? undefined : { ...schema, $defs: found };
  };
  const tools: Array<HostedTool> = [];
  for (const { shared, ...tool } of catalog.tools) {
    let restored: HostedTool = tool;
    for (const key of shared ?? []) {
      const schema = restore(restored[key]);
      if (schema === undefined) return undefined;
      restored =
        key === "inputSchema"
          ? { ...restored, inputSchema: schema }
          : { ...restored, outputSchema: schema };
    }
    tools.push(restored);
  }
  return { tools, routers: catalog.routers };
};
