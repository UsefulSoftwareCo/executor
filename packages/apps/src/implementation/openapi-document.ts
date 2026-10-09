/** OpenAPI reference and dialect rules, shared by every part of the app importer. */
import { upgradeFromTwoToThree } from "@scalar/openapi-upgrader/2.0-to-3.0";
import { upgradeOpenApi30InPlace } from "./openapi-upgrade.ts";
import { yieldToRuntime } from "./runtime-yield.ts";
import { JsonPointer, JsonSchema, Schema, SchemaIssue } from "effect";
import { JsonObject } from "../contracts/schema.ts";
import { Specification } from "../contracts/openapi-document.ts";
import { OpenapiCompileError as TemplateError } from "../contracts/openapi-compile.ts";

/**
 * An object in a document that was validated as JSON when it was read. Compilation only turns JSON
 * into JSON, so inside it an object's shape is checked, not its every leaf again: re-validating
 * whole documents was most of a large API's compile time.
 */
export const DocumentObject = Schema.declare(
  (value: unknown): value is JsonObject =>
    typeof value === "object" && value !== null && !Array.isArray(value),
  { expected: "object" },
);
export const documentObject = Schema.decodeUnknownSync(DocumentObject);
const record = documentObject;
function fail(code: TemplateError["code"], reason: string): never {
  throw new TemplateError({ code, reason });
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One JSON Pointer reference token. */
export const pointerToken = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

// Never echo values from the definition: a failing path and the expected shape locate the problem.
const issueFormat = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    SchemaIssue.hasInput(issue) ? "Invalid value" : SchemaIssue.defaultLeafHook(issue),
  checkHook: (issue) =>
    SchemaIssue.hasInput(issue) || SchemaIssue.hasInput(issue.issue)
      ? (SchemaIssue.defaultCheckHook(issue) ?? "Invalid value")
      : SchemaIssue.defaultCheckHook(issue),
});

/**
 * Decode one part of the definition, located by the JSON Pointer `at`. A mismatch names the
 * pointer of the first failing value and what was expected there.
 */
export const decodeDefinition = <S extends Schema.Decoder<unknown>>(
  schema: S,
  value: unknown,
  at: string,
  what: string,
): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch (error) {
    if (!Schema.isSchemaError(error)) throw error;
    const [issue] = issueFormat(error.issue).issues;
    const path = (issue?.path ?? []).map((key) =>
      pointerToken(String(typeof key === "object" ? key.key : key)),
    );
    return fail(
      "invalid_document",
      `The ${what} at ${[at, ...path].join("/")} is invalid: ${issue?.message ?? "it does not match OpenAPI"}.`,
    );
  }
};

/** Keywords whose value is one schema, an array of schemas, or a map of named schemas. */
const schemaKeywords = new Set([
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
]);
const schemaArrayKeywords = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaMapKeywords = new Set(["properties", "patternProperties", "$defs", "dependentSchemas"]);
const isSchemaValue = (value: unknown) => typeof value === "boolean" || isObject(value);
const jsonKind = (value: unknown) =>
  Array.isArray(value)
    ? "an array"
    : value === null
      ? "null"
      : typeof value === "object"
        ? "an object"
        : `a ${typeof value}`;

/** Whether a value holds a Reference Object anywhere inside it. */
const holdsReference = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some(holdsReference)
    : isObject(value) &&
      (typeof value.$ref === "string" || Object.values(value).some(holdsReference));

/**
 * Reject a schema keyword whose value is not a schema but holds a reference, such as an array
 * `items` of `$ref`s, which JSON Schema 2020-12 and OpenAPI 3.0 both forbid. Converters pass such a
 * value through without reading it, so its reference would stay unresolved and fail validation.
 * Such a value without a reference passes through unchanged, as validators accept it. The failure
 * names the keyword's JSON Pointer, starting from `at`.
 */
const checkSchemaKeywords = (schema: JsonObject, at: string) => {
  const path: string[] = [];
  /** Visit a schema, or reject a value that is not one when it holds a reference. */
  const child = (value: Schema.Json, problem: () => string) => {
    if (isSchemaValue(value)) return visit(value);
    if (holdsReference(value))
      fail(
        "schema_keyword",
        `The schema at ${[at, ...path].join("/")} is invalid: ${problem()}, so the reference inside it cannot be resolved.`,
      );
  };
  const visit = (node: Schema.Json) => {
    if (!isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      path.push(pointerToken(key));
      if (schemaKeywords.has(key))
        child(value, () => `"${key}" must be a schema, not ${jsonKind(value)}`);
      else if (schemaArrayKeywords.has(key) || schemaMapKeywords.has(key)) {
        const entries = schemaArrayKeywords.has(key)
          ? Array.isArray(value)
            ? [...value.entries()]
            : undefined
          : isObject(value)
            ? Object.entries(value)
            : undefined;
        if (entries === undefined)
          child(value, () =>
            schemaArrayKeywords.has(key)
              ? `"${key}" must be an array of schemas, not ${jsonKind(value)}`
              : `"${key}" must map names to schemas, not ${jsonKind(value)}`,
          );
        else
          for (const [name, item] of entries) {
            path.push(pointerToken(String(name)));
            child(item, () => `each "${key}" entry must be a schema, not ${jsonKind(item)}`);
            path.pop();
          }
      }
      path.pop();
    }
  };
  visit(schema);
};
/** Fields that map names to Path Item Objects, whose `$ref` siblings extend the referenced item. */
const pathItemMaps = new Set(["paths", "webhooks", "pathItems"]);

/** The path of a local reference. Documents often leave characters such as `[` unencoded in the
 * fragment, so a fragment that is not a valid URI fragment is read as a plain JSON Pointer.
 */
const localPath = (ref: string): readonly string[] | undefined => {
  if (!ref.startsWith("#")) return undefined;
  const strict = JsonPointer.parseUriFragment(ref);
  if (strict !== undefined) return strict;
  let pointer = ref.slice(1);
  try {
    pointer = decodeURIComponent(pointer);
  } catch {
    // An invalid percent-encoding is read literally.
  }
  if (pointer === "") return [];
  return pointer.startsWith("/")
    ? pointer.slice(1).split("/").map(JsonPointer.unescapeToken)
    : undefined;
};

/** Replace the document's local Reference Objects with their targets in one walk.
 * Only the document itself is a reference scope: external, missing and circular references
 * stay in place, and operations that reach them are skipped when their objects are resolved.
 * A Reference Object's `summary` and `description` override its target's. A Path Item keeps
 * every sibling of its `$ref`. Schema Objects, examples and extensions are values, not objects
 * to resolve. `origins` holds the reference each resolved object came from, so diagnostics can
 * point into the definition where it is declared.
 */
function dereference(scope: JsonObject) {
  const active = new Set<string>();
  const origins = new WeakMap<JsonObject, string>();
  const target = (ref: string): JsonObject | undefined => {
    const path = localPath(ref);
    let node: Schema.Json | undefined = scope;
    for (const part of path ?? []) {
      node = isObject(node)
        ? Object.hasOwn(node, part)
          ? node[part]
          : undefined
        : Array.isArray(node)
          ? node[Number(part)]
          : undefined;
      if (node === undefined) return;
    }
    return path !== undefined && isObject(node) ? node : undefined;
  };
  const fields = (object: JsonObject): JsonObject => {
    const result: Record<string, Schema.Json> = {};
    for (const [key, value] of Object.entries(object))
      result[key] =
        key === "schema"
          ? value
          : key === "example" || key.startsWith("x-")
            ? value
            : pathItemMaps.has(key) && isObject(value)
              ? Object.fromEntries(
                  Object.entries(value).map(([name, item]) => [name, visit(item, true)]),
                )
              : key === "responses"
                ? defaultFirst(visit(value, false))
                : visit(value, false);
    return result;
  };
  // A Responses Object lists its fixed `default` field before status codes, as the importer
  // always stored it.
  const defaultFirst = (responses: Schema.Json): Schema.Json => {
    if (!isObject(responses) || !Object.hasOwn(responses, "default")) return responses;
    const { default: fallback, ...statuses } = responses;
    return { default: fallback ?? null, ...statuses };
  };
  const visit = (value: Schema.Json, pathItem: boolean): Schema.Json => {
    if (Array.isArray(value)) return value.map((item) => visit(item, false));
    if (!isObject(value)) return value;
    const ref = value.$ref;
    const found = typeof ref === "string" && !active.has(ref) ? target(ref) : undefined;
    if (typeof ref !== "string" || found === undefined) return fields(value);
    active.add(ref);
    const resolved = visit(found, pathItem);
    active.delete(ref);
    if (!isObject(resolved)) return resolved;
    const { $ref: _, ...siblings } = value;
    const result = pathItem
      ? { ...resolved, ...fields(siblings) }
      : {
          ...resolved,
          ...(typeof siblings.summary === "string" ? { summary: siblings.summary } : {}),
          ...(typeof siblings.description === "string"
            ? { description: siblings.description }
            : {}),
        };
    origins.set(result, ref);
    return result;
  };
  return { document: record(visit(scope, false)), origins };
}

/** The document's specification, with its paths and components checked for shape. */
const DocumentSpecification = Schema.Struct({
  ...Specification.fields,
  paths: Schema.Record(Schema.String, DocumentObject),
  components: Schema.optionalKey(
    Schema.Struct({
      schemas: Schema.optionalKey(Schema.Record(Schema.String, DocumentObject)),
      securitySchemes: Schema.optionalKey(Schema.Record(Schema.String, DocumentObject)),
    }),
  ),
});

/** The parts of a Swagger 2.0 definition that Scalar's upgrader reads without checking them. */
const MediaTypes = Schema.Array(Schema.String);
const Swagger2Parameters = Schema.Array(DocumentObject);
const Swagger2Operation = Schema.Struct({
  parameters: Schema.optionalKey(Swagger2Parameters),
  consumes: Schema.optionalKey(MediaTypes),
  produces: Schema.optionalKey(MediaTypes),
  responses: Schema.optionalKey(DocumentObject),
});
const Swagger2PathItem = Schema.Struct({
  parameters: Schema.optionalKey(Swagger2Parameters),
  get: Schema.optionalKey(Swagger2Operation),
  put: Schema.optionalKey(Swagger2Operation),
  post: Schema.optionalKey(Swagger2Operation),
  delete: Schema.optionalKey(Swagger2Operation),
  options: Schema.optionalKey(Swagger2Operation),
  head: Schema.optionalKey(Swagger2Operation),
  patch: Schema.optionalKey(Swagger2Operation),
});
const Swagger2Definition = Schema.Struct({
  paths: Schema.optionalKey(DocumentObject),
  consumes: Schema.optionalKey(MediaTypes),
  produces: Schema.optionalKey(MediaTypes),
  securityDefinitions: Schema.optionalKey(Schema.Record(Schema.String, DocumentObject)),
});
const swagger2Methods = ["get", "put", "post", "delete", "options", "head", "patch"] as const;

/** Name a malformed part of a Swagger 2.0 definition by its JSON Pointer before upgrading it. */
function checkSwagger2(document: JsonObject) {
  const definition = decodeDefinition(Swagger2Definition, document, "#", "definition");
  for (const [path, value] of Object.entries(definition.paths ?? {})) {
    if (!path.startsWith("/")) continue;
    const itemAt = `#/paths/${pointerToken(path)}`;
    const item = decodeDefinition(Swagger2PathItem, value, itemAt, "path item");
    for (const method of swagger2Methods)
      for (const [status, response] of Object.entries(item[method]?.responses ?? {}))
        if (!status.startsWith("x-"))
          decodeDefinition(
            DocumentObject,
            response,
            `${itemAt}/${method}/responses/${pointerToken(status)}`,
            "response",
          );
  }
}

/** Upgrade a document the caller owns to OpenAPI 3.1, as Scalar's upgrader does: Swagger 2.0 is
 * first converted to 3.0, a 3.0 document is upgraded in place, and 3.1 and 3.2 documents are
 * unchanged.
 */
function upgradeOwned(document: JsonObject): JsonObject {
  if (typeof document.swagger === "string" && document.swagger.startsWith("2.0"))
    checkSwagger2(document);
  let upgraded: unknown;
  try {
    upgraded = upgradeFromTwoToThree(document);
  } catch (error) {
    // Scalar reads the definition without checking it, so a malformed part the check above does
    // not cover fails inside the upgrader, which does not say where.
    if (!(error instanceof TypeError)) throw error;
    return fail(
      "invalid_document",
      "The Swagger 2.0 definition could not be converted to OpenAPI 3.0: part of it does not have the structure Swagger 2.0 requires, such as a null entry in a path item or response map.",
    );
  }
  return record(upgradeOpenApi30InPlace(record(upgraded)));
}

/** OpenAPI 3.1 and 3.2 share the JSON Schema 2020-12 dialect for Schema Objects. */
const supportedVersion = /^3\.[12]\.\d+$/;

/** Resolve OpenAPI objects once; schemas retain their original recursive references.
 * Scalar first upgrades Swagger 2.0 and OpenAPI 3.0 to 3.1, so the importer reads 3.1 and 3.2,
 * whose Schema Objects share one dialect, and 3.1 keywords that appear in 3.0 documents keep
 * their meaning. Unsupported versions, references and conversions throw TemplateError at the
 * import boundary.
 */
export async function openApiDocument(input: JsonObject) {
  // The caller hands over the document; each original entry is released as it is upgraded.
  const root = upgradeOwned(record(input));
  // oxlint-disable-next-line executor/authored-code-through-adapter -- scheduler yield
  await yieldToRuntime();
  const spec = decodeDefinition(DocumentSpecification, root, "#", "definition");
  if (!supportedVersion.test(spec.openapi))
    fail(
      "openapi_version",
      `This importer supports Swagger 2.0 and OpenAPI 3.0, 3.1 and 3.2, not openapi ${JSON.stringify(spec.openapi.slice(0, 32))}.`,
    );
  const components = spec.components?.schemas ?? {};
  const convert = JsonSchema.fromSchemaOpenApi3_1;

  // Schema Objects are opaque to the object resolver. Effect owns their dialect,
  // reference siblings and recursion, so component schemas are not reference targets here.
  const componentsObject = root.components === undefined ? {} : record(root.components);
  const { document: restored, origins } = dereference({
    ...root,
    components: { ...componentsObject, schemas: {} },
  });
  // oxlint-disable-next-line executor/authored-code-through-adapter -- scheduler yield
  await yieldToRuntime();
  const parsed = decodeDefinition(
    DocumentSpecification,
    { ...restored, components: { ...record(restored.components), schemas: components } },
    "#",
    "definition",
  );

  // Component schemas converted once for the whole app. Operation schemas keep
  // `#/$defs/<name>` references; the runtime attaches the definitions a schema reaches.
  const definitions = new Map<string, JsonObject>();
  // Component names each definition references directly, for transitive reach checks.
  const references = new Map<string, ReadonlySet<string>>();

  return {
    spec: parsed,
    definitions,
    /**
     * The JSON Pointer of the object a local reference resolved to, so a diagnostic can locate
     * a resolved Response, Parameter, Request Body or Path Item where the definition declares it.
     */
    origin(value: unknown): string | undefined {
      return isObject(value) ? origins.get(value) : undefined;
    },
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
          fail(
            "external_reference",
            `The reference ${JSON.stringify(ref)} does not resolve within the definition. Only local references to objects the definition declares are supported.`,
          );
        if (visited.has(ref))
          fail("circular_reference", `The schema ${ref} is a circular alias of itself.`);
        visited.add(ref);
        if (!Object.hasOwn(components, path[2]))
          fail(
            "missing_component",
            `The reference ${ref} names a schema the definition does not declare.`,
          );
        value = record(components[path[2]]);
      }
      return value;
    },
    /** Compose a Draft 2020-12 schema around API Schema Objects. Only values passed to
     * `api` use the document's OpenAPI dialect; Executor-authored wrappers are already
     * Draft 2020-12 and must not be reinterpreted. `api` takes the schema's JSON Pointer in the
     * definition, which failures name. Reached components are converted once into the shared
     * `definitions` and stay references here; nothing is inlined or copied per operation.
     */
    schema(build: (api: (input: Schema.Json, at: string) => JsonObject) => JsonObject): JsonObject {
      const added: string[] = [];
      const direct = new Set<string>();
      const local: Record<string, Schema.Json> = {};
      const visit = (input: JsonObject, direct: Set<string>, at: string): JsonObject => {
        checkSchemaKeywords(input, at);
        let document: ReturnType<typeof convert>;
        try {
          document = convert(input, {
            onReference(ref) {
              const path = JsonPointer.parseUriFragment(ref);
              const name = path?.[2];
              if (
                path?.length !== 3 ||
                path[0] !== "components" ||
                path[1] !== "schemas" ||
                name === undefined
              )
                fail(
                  "schema_reference",
                  `The schema at ${at} references ${JSON.stringify(ref)}. Only references to #/components/schemas/<name> are supported.`,
                );
              const component = Object.hasOwn(components, name) ? components[name] : undefined;
              if (component === undefined)
                fail(
                  "missing_component",
                  `The schema at ${at} references ${ref}, which the definition does not declare.`,
                );
              direct.add(name);
              if (!definitions.has(name)) {
                // The placeholder ends recursion; a cycle stays a reference to the same definition.
                added.push(name);
                definitions.set(name, {});
                const names = new Set<string>();
                definitions.set(
                  name,
                  visit(component, names, `#/components/schemas/${pointerToken(name)}`),
                );
                references.set(name, names);
              }
            },
          });
        } catch (error) {
          if (error instanceof TemplateError) throw error;
          // Effect's converter refuses keywords whose meaning the target dialect would change.
          return fail(
            "schema_keyword",
            `The schema at ${at} cannot be converted to JSON Schema 2020-12 without changing its constraints${error instanceof Error ? `: ${error.message}` : ""}.`,
          );
        }
        return record({
          ...document.schema,
          ...(Object.keys(document.definitions).length ? { $defs: document.definitions } : {}),
        });
      };
      const api = (input: Schema.Json, at: string): JsonObject => {
        // OpenAPI 3.1 allows boolean schemas; these objects mean the same.
        const schema =
          input === true
            ? {}
            : input === false
              ? { not: {} }
              : isObject(input)
                ? input
                : fail(
                    "schema_keyword",
                    `The schema at ${at} must be a schema, not ${jsonKind(input)}.`,
                  );
        const { $defs, ...converted } = visit(schema, direct, at);
        for (const [name, definition] of Object.entries($defs === undefined ? {} : record($defs))) {
          if (
            Object.hasOwn(local, name) &&
            JSON.stringify(local[name]) !== JSON.stringify(definition)
          )
            fail(
              "schema_reference",
              `The schema at ${at} declares the local definition ${JSON.stringify(name)} differently from another schema of the same operation.`,
            );
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
          const shared = [...reached].find((name) => Object.hasOwn(local, name));
          if (shared !== undefined)
            fail(
              "schema_reference",
              `A local definition named ${JSON.stringify(shared)} conflicts with the component schema of the same name.`,
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
        throw error;
      }
    },
  };
}

/** A parsed document with one reference scope and one schema dialect. */
export type OpenApiDocument = Awaited<ReturnType<typeof openApiDocument>>;
