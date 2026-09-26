/** OpenAPI reference and dialect rules, shared by every part of the app importer. */
import "../contracts/swagger-client.ts";
import SwaggerClient from "swagger-client";
import { upgrade } from "@scalar/openapi-upgrader";
import { JsonPointer, JsonSchema, Schema } from "effect";
import { JsonObject } from "../contracts/schema.ts";
import { Specification } from "../contracts/openapi-document.ts";
import { OpenapiCompileError as TemplateError } from "../contracts/openapi-compile.ts";

const record = Schema.decodeUnknownSync(JsonObject);
function fail(code: TemplateError["code"], reason: string): never {
  throw new TemplateError({ code, reason });
}

/** Resolve OpenAPI objects once with Swagger; schemas retain their original recursive references.
 * Scalar first upgrades Swagger 2.0 and OpenAPI 3.0 to 3.1, so the importer has one dialect and
 * 3.1 keywords that appear in 3.0 documents keep their meaning.
 * Unsupported versions, references and conversions throw TemplateError at the import boundary.
 */
export async function openApiDocument(input: unknown) {
  // The upgrader rewrites its argument in place.
  const root = record(upgrade(structuredClone(record(input)), "3.1"));
  const spec = Schema.decodeUnknownSync(Specification)(root);
  if (!spec.openapi.startsWith("3.1."))
    fail("openapi_version", "This importer supports Swagger 2.0 and OpenAPI 3.0 and 3.1.");
  const components = spec.components?.schemas ?? {};
  const convert = JsonSchema.fromSchemaOpenApi3_1;

  // Schema Objects are opaque to the object resolver. Effect owns their dialect,
  // reference siblings and recursion. Masking also avoids dereferencing a large
  // component graph only to reconstruct it for the validator.
  const schemas: Schema.Json[] = [];
  const componentsObject = root.components === undefined ? {} : record(root.components);
  const masked: unknown = JSON.parse(
    JSON.stringify(
      { ...root, components: { ...componentsObject, schemas: {} } },
      (key, value: unknown) => {
        if (key !== "schema") return value;
        const index = schemas.push(Schema.decodeUnknownSync(Schema.Json)(value)) - 1;
        return { "x-executor-schema": index };
      },
    ),
  );
  const resolved = await SwaggerClient.resolve({
    spec: masked,
    skipNormalization: true,
    useCircularStructures: false,
    // Spec import uses the host's guarded download. References must not acquire
    // a second, unguarded network capability inside the resolver.
    requestInterceptor: () =>
      fail("external_reference", "External OpenAPI references are not supported yet."),
  });
  const restored = record(
    JSON.parse(JSON.stringify(resolved.spec), (key, value: unknown) => {
      if (key !== "schema") return value;
      const marker = record(value)["x-executor-schema"];
      if (typeof marker !== "number" || schemas[marker] === undefined)
        return fail("invalid_document", "The API resolver did not preserve a schema.");
      return schemas[marker];
    }),
  );
  const parsed = Schema.decodeUnknownSync(Specification)({
    ...restored,
    components: { ...record(restored.components), schemas: components },
  });

  // Component schemas converted once for the whole app. Operation schemas keep
  // `#/$defs/<name>` references; the runtime attaches the definitions a schema reaches.
  const definitions = new Map<string, JsonObject>();
  // Component names each definition references directly, for transitive reach checks.
  const references = new Map<string, ReadonlySet<string>>();

  return {
    spec: parsed,
    definitions,
    /** Inspect a component schema without expanding its children. OpenAPI object refs must already be resolved by Swagger. */
    resolve(value: JsonObject): JsonObject {
      const visited = new Set<string>();
      while (value.$ref !== undefined) {
        const ref = value.$ref;
        const path = typeof ref === "string" ? JsonPointer.parseUriFragment(ref) : undefined;
        if (
          typeof ref !== "string" ||
          path?.length !== 3 ||
          path[0] !== "components" ||
          path[1] !== "schemas" ||
          path[2] === undefined
        )
          fail("external_reference", "An OpenAPI object reference could not be resolved locally.");
        if (visited.has(ref))
          fail("circular_reference", "A circular schema alias cannot be imported.");
        visited.add(ref);
        value = record(Object.hasOwn(components, path[2]) ? components[path[2]] : undefined);
      }
      return value;
    },
    /** Compose a Draft 2020-12 schema around API Schema Objects. Only values passed to
     * `api` use the document's OpenAPI dialect; Executor-authored wrappers are already
     * Draft 2020-12 and must not be reinterpreted. Reached components are converted once into
     * the shared `definitions` and stay references here; nothing is inlined or copied per operation.
     */
    schema(build: (api: (input: Schema.Json) => JsonObject) => JsonObject): JsonObject {
      const added: string[] = [];
      const direct = new Set<string>();
      const local: Record<string, Schema.Json> = {};
      const visit = (input: JsonObject, direct: Set<string>): JsonObject => {
        const document = convert(input, {
          onReference(ref) {
            const path = JsonPointer.parseUriFragment(ref);
            const name = path?.[2];
            if (
              path?.length !== 3 ||
              path[0] !== "components" ||
              path[1] !== "schemas" ||
              name === undefined
            )
              fail("schema_reference", "Only local component schema references are supported.");
            const component = Object.hasOwn(components, name) ? components[name] : undefined;
            if (component === undefined)
              fail("missing_component", "An API schema references a missing component.");
            direct.add(name);
            if (!definitions.has(name)) {
              // The placeholder ends recursion; a cycle stays a reference to the same definition.
              added.push(name);
              definitions.set(name, {});
              const names = new Set<string>();
              definitions.set(name, visit(component, names));
              references.set(name, names);
            }
          },
        });
        return record({
          ...document.schema,
          ...(Object.keys(document.definitions).length ? { $defs: document.definitions } : {}),
        });
      };
      const api = (input: Schema.Json): JsonObject => {
        const { $defs, ...converted } = visit(record(input), direct);
        for (const [name, definition] of Object.entries($defs === undefined ? {} : record($defs))) {
          if (
            Object.hasOwn(local, name) &&
            JSON.stringify(local[name]) !== JSON.stringify(definition)
          )
            fail("schema_reference", "An API schema has conflicting local definitions.");
          local[name] = definition;
        }
        return converted;
      };
      try {
        const converted = build(api);
        if (Object.keys(local).length) {
          // Local definitions share the `$defs` scope with every component this schema reaches.
          const reached = new Set<string>();
          const pending = [...direct];
          for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
            if (reached.has(name)) continue;
            reached.add(name);
            pending.push(...(references.get(name) ?? []));
          }
          if ([...reached].some((name) => Object.hasOwn(local, name)))
            fail(
              "schema_reference",
              "An API schema has conflicting local and component definitions.",
            );
        }
        return {
          ...converted,
          ...(Object.keys(local).length ? { $defs: local } : {}),
          $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
        };
      } catch (error) {
        // A failed conversion leaves no placeholder or partial definition for later schemas.
        for (const name of added) {
          definitions.delete(name);
          references.delete(name);
        }
        if (error instanceof TemplateError) throw error;
        return fail(
          "schema_keyword",
          "An API schema cannot be converted without changing its constraints.",
        );
      }
    },
  };
}

/** A parsed document with one reference scope and one schema dialect. */
export type OpenApiDocument = Awaited<ReturnType<typeof openApiDocument>>;
