import { schemaDefinitions } from "@executor-js/utils/schema-definitions";
import { Effect, Schema } from "effect";
import type { Json, JsonObject } from "../contracts/shared.ts";
import { type Tool, ToolPage } from "../contracts/tools.ts";
import type { ToolListing } from "./listings.ts";

export const pageStart = (listing: ToolListing, cursor: string | undefined) => {
  if (cursor === undefined) return 0;
  let low = 0;
  let high = listing.items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (listing.items[middle]!.name > cursor) high = middle;
    else low = middle + 1;
  }
  return low;
};

const counter = () => {
  const definitionLengths = new Map<object, number>();
  const definitionLength = (definition: Json) => {
    if (typeof definition !== "object" || definition === null)
      return JSON.stringify(definition).length;
    let length = definitionLengths.get(definition);
    if (length === undefined)
      definitionLengths.set(definition, (length = JSON.stringify(definition).length));
    return length;
  };
  const definitionsApart = (schema: JsonObject) => {
    const own = schemaDefinitions(schema);
    if (own === undefined) return { schema, length: 0 };
    let length = 0;
    let entries = 0;
    for (const [name, definition] of Object.entries(own)) {
      length += JSON.stringify(name).length + 1 + definitionLength(definition);
      entries += 1;
    }
    return { schema: { ...schema, $defs: {} }, length: length + Math.max(0, entries - 1) };
  };
  return (tool: Tool) => {
    const input = definitionsApart(tool.inputSchema);
    const output =
      tool.outputSchema === undefined ? undefined : definitionsApart(tool.outputSchema);
    return (
      JSON.stringify({
        ...tool,
        inputSchema: input.schema,
        ...(output === undefined ? {} : { outputSchema: output.schema }),
      }).length +
      input.length +
      (output?.length ?? 0)
    );
  };
};

const encodePage = Schema.encodeEffect(ToolPage);

export const pageTools = (
  listing: ToolListing,
  start: number,
  limit: number,
  chars: number | undefined,
) =>
  Effect.gen(function* () {
    const candidates = listing.items.slice(start, start + limit);
    const first = candidates[0];
    if (chars === undefined || first === undefined) return candidates;
    const kept = listing.itemChars;
    const count = counter();
    const pageLength = (items: ReadonlyArray<Tool>) =>
      encodePage({ ...listing.catalog, routers: listing.routers, items }).pipe(
        Effect.map((page) => JSON.stringify(page).length),
        Effect.orDie,
      );
    const { outputSchema: _output, _meta: _toolMeta, ...fields } = first;
    const sample = { ...fields, inputSchema: {} };
    let length = yield* pageLength([]);
    const added = (yield* pageLength([sample])) - length - JSON.stringify(sample).length;
    const page: Array<Tool> = [];
    for (const [index, tool] of candidates.entries()) {
      length +=
        (index === 0 ? 0 : 1) + (kept === undefined ? count(tool) : kept[start + index]!) + added;
      if (
        index > 0 &&
        length + 10 + tool.name.length * 6 > chars &&
        length +
          (start + index + 1 < listing.items.length ? 8 + JSON.stringify(tool.name).length : 0) >
          chars
      )
        break;
      page.push(tool);
    }
    return page;
  });
