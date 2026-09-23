/** Apply catalog-specific overrides before handing the document to the shared source generator. */
import { Effect, Schema } from "effect";
import { JsonObject } from "@executor-js/sdk";
import { generateOpenApiApp } from "@executor-js/app-templates";
import { CatalogImportFailed, type CatalogEntry } from "../contracts/catalog.ts";

function fail(reason: string): never {
  throw new CatalogImportFailed({ reason });
}
const record = (value: unknown): JsonObject => Schema.decodeUnknownSync(JsonObject)(value);
const own = (value: JsonObject, key: string) =>
  Object.hasOwn(value, key) ? value[key] : undefined;
function applyPatches(root: JsonObject, patches: CatalogEntry["specOverrides"]): JsonObject {
  const cloned = record(JSON.parse(JSON.stringify(root)));
  for (const patch of patches ?? []) {
    if (
      (patch.op !== "replace" && patch.op !== "add" && patch.op !== "remove") ||
      typeof patch.path !== "string" ||
      !patch.path.startsWith("/")
    )
      fail("This catalog entry uses an unsupported spec patch.");
    const path = patch.path
      .slice(1)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    const key = path.pop();
    if (key === undefined || path.some((p) => p === "__proto__") || key === "__proto__")
      fail("Invalid spec patch.");
    // record() parses into a fresh projection, so walk the original JSON with a recursive patch instead.
    const update = (node: JsonObject, parts: readonly string[]): JsonObject => {
      const [head, ...rest] = parts;
      if (head === undefined) return node;
      if (rest.length) return { ...node, [head]: update(record(own(node, head)), rest) };
      if (patch.op === "replace" && !Object.hasOwn(node, head))
        fail("The catalog patch no longer matches the API spec.");
      if (patch.op === "remove")
        return Object.fromEntries(Object.entries(node).filter(([name]) => name !== head));
      if (patch.value === undefined) fail("Invalid spec patch value.");
      return { ...node, [head]: patch.value };
    };
    Object.assign(cloned, update(cloned, [...path, key]));
  }
  return cloned;
}

/** Catalog overrides do not enter the reusable template package. */
export const generateApp = (
  entry: CatalogEntry,
  document: unknown,
  options: { readonly baseUrl?: string } = {},
) =>
  Effect.try({
    try: () => applyPatches(record(document), entry.specOverrides),
    catch: (error) =>
      error instanceof CatalogImportFailed
        ? error
        : new CatalogImportFailed({ reason: "This API definition could not be read." }),
  }).pipe(
    Effect.flatMap((document) => generateOpenApiApp(entry, document, options)),
    Effect.mapError((error) => new CatalogImportFailed({ reason: error.reason })),
  );
