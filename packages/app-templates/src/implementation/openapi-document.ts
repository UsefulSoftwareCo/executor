/** OpenAPI reference and dialect rules, shared by every part of the app importer. */
import "../../../apps/src/contracts/swagger-client.ts";
import SwaggerClient from "swagger-client";
import { JsonPointer, JsonSchema, Schema } from "effect";
import { JsonObject } from "@executor-js/sdk";
import { Specification } from "../contracts/openapi.ts";
import { TemplateError } from "../contracts/templates.ts";

const record = Schema.decodeUnknownSync(JsonObject);
function fail(code: TemplateError["code"], reason: string): never {
  throw new TemplateError({ code, reason });
}

/** Resolve OpenAPI objects once with Swagger; schemas retain their original recursive references.
 * Unsupported versions, references and conversions throw TemplateError at the import boundary.
 */
export async function openApiDocument(input: unknown) {
  const root = record(input);
  const spec = Schema.decodeUnknownSync(Specification)(root);
  if (!/^3\.[01]\./.test(spec.openapi))
    fail(
      "openapi_version",
      "This importer supports OpenAPI 3.0 and 3.1. Swagger 2 needs conversion first.",
    );
  const components = spec.components?.schemas ?? {};
  const convert = spec.openapi.startsWith("3.0.")
    ? JsonSchema.fromSchemaOpenApi3_0
    : JsonSchema.fromSchemaOpenApi3_1;

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

  return {
    spec: parsed,
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
    /** Convert with Effect and retain only reachable component definitions. No references are inlined. */
    schema(input: JsonObject): JsonObject {
      const definitions = new Map<string, JsonObject>();
      const visit = (input: JsonObject): JsonObject => {
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
            if (!definitions.has(name)) {
              definitions.set(name, {});
              definitions.set(name, visit(component));
            }
          },
        });
        return record({
          ...document.schema,
          ...(Object.keys(document.definitions).length ? { $defs: document.definitions } : {}),
        });
      };
      try {
        const converted = visit(input);
        const local = converted.$defs === undefined ? {} : record(converted.$defs);
        if ([...definitions.keys()].some((name) => Object.hasOwn(local, name)))
          fail(
            "schema_reference",
            "An API schema has conflicting local and component definitions.",
          );
        return {
          ...converted,
          $defs: { ...local, ...Object.fromEntries(definitions) },
          $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
        };
      } catch (error) {
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
