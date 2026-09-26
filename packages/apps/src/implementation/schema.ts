/** Author schema facade. Internals use the native decoder retained by each value. */
import { Effect, Schema as EffectSchema, SchemaGetter, SchemaIssue, SchemaParser } from "effect";
import { dereference, validate } from "@cfworker/json-schema";
import { ValidationError, type JsonObject, type JsonValue } from "../contracts/schema.ts";

import type { Field } from "@executor-js/app-data/contracts";
const StorageField = Symbol("apps.StorageField");

const Decoder = Symbol("apps.Schema");

/** An author-facing value schema. Effect is never required in author code. */
export interface Schema<T, Optional extends boolean = false> {
  readonly [StorageField]?: Field;
  readonly [Decoder]: EffectSchema.Decoder<T>;
  readonly optionalValue: Optional;
  /** Parse an unknown value; invalid input throws a safe ValidationError. */
  parse(input: unknown): T;
  /** Accept an absent field without changing the original schema. */
  optional(): Schema<T | undefined, true>;
  /** Validate the default now and use it for undefined input. */
  default(value: T): Schema<T> & { readonly hasDefault: true; readonly inputOptional: Optional };
}

/** Infer the parsed author value. */
export type Infer<S> = S extends Schema<infer T, boolean> ? T : never;
/** Named author fields. */
export type Fields = Readonly<Record<string, Schema<unknown, boolean>>>;
/** Optional fields may be absent; defaulted fields are present after decoding. */
export type ObjectValue<F extends Fields> = {
  readonly [Key in keyof F as F[Key]["optionalValue"] extends true ? never : Key]: Infer<F[Key]>;
} & {
  readonly [Key in keyof F as F[Key]["optionalValue"] extends true ? Key : never]?: Infer<F[Key]>;
};
/** An author object schema with retained field declarations. */
export interface ObjectSchema<F extends Fields> extends Schema<ObjectValue<F>> {
  readonly fields: F;
}

/** Retrieve a native decoder at the author boundary without erasing its type. */
export const decoderOf = <T>(schema: Schema<T, boolean>): EffectSchema.Decoder<T> =>
  schema[Decoder];

/** Recognize schemas made by this author facade when adapting a definition. */
export const isSchema = (value: unknown): value is Schema<unknown, boolean> =>
  typeof value === "object" && value !== null && Decoder in value;

/** Decode within an Effect program. Invalid input is omitted from the failure. */
export const parse = <T>(
  decoder: EffectSchema.Decoder<T>,
  input: unknown,
): Effect.Effect<T, ValidationError> =>
  Effect.suspend(() => EffectSchema.decodeUnknownEffect(decoder)(input)).pipe(
    Effect.mapError(() => new ValidationError()),
  );

/** Present a native decoder through the synchronous author API. */
export function wrap<T, Optional extends boolean>(
  decoder: EffectSchema.Decoder<T>,
  optionalValue: Optional,
  field?: Field,
): Schema<T, Optional> {
  return {
    [Decoder]: decoder,
    ...(field === undefined ? {} : { [StorageField]: field }),
    optionalValue,
    parse: (input) => Effect.runSync(parse(decoder, input)),
    optional: () =>
      wrap(
        EffectSchema.optional(decoder),
        true,
        field === undefined ? undefined : { ...field, optional: true },
      ),
    default: (value) => {
      const parsed = Effect.runSync(parse(decoder, value));
      return {
        ...wrap(
          decoder
            .annotate({ default: parsed })
            .pipe(EffectSchema.withDecodingDefault(Effect.succeed(parsed))),
          false,
          field === undefined || parsed === undefined
            ? undefined
            : {
                ...field,
                default: EffectSchema.decodeUnknownSync(
                  EffectSchema.Union([
                    EffectSchema.String,
                    EffectSchema.Finite,
                    EffectSchema.Boolean,
                  ]),
                )(parsed),
              },
        ),
        hasDefault: true,
        inputOptional: optionalValue,
      };
    },
  };
}

/** A string, optionally with a minimum length. No coercion. */
export function string(options: { readonly minLength?: number } = {}): Schema<string> {
  return wrap(
    options.minLength === undefined
      ? EffectSchema.String
      : EffectSchema.String.check(EffectSchema.isMinLength(options.minLength)),
    false,
    { kind: "string" },
  );
}
/** A finite JSON number. No coercion. */
export const number = (): Schema<number> => wrap(EffectSchema.Finite, false, { kind: "number" });
/** A boolean. No coercion. */
export const boolean = (): Schema<boolean> =>
  wrap(EffectSchema.Boolean, false, { kind: "boolean" });
/** Any JSON value. Values still cross the native JSON decoder. */
export const json = (): Schema<EffectSchema.Json> => wrap(EffectSchema.Json, false);
/** Named values with a common schema. */
export const record = <T>(value: Schema<T, boolean>): Schema<Readonly<Record<string, T>>> =>
  wrap(EffectSchema.Record(EffectSchema.String, decoderOf(value)), false);
/** One exact JSON scalar value. */
export function literal<const T extends string | number | boolean | null>(value: T): Schema<T>;
export function literal(
  value: string | number | boolean | null,
): Schema<string | number | boolean | null> {
  if (typeof value === "number") Effect.runSync(parse(EffectSchema.Finite, value));
  return wrap<string | number | boolean | null, false>(
    value === null ? EffectSchema.Null : EffectSchema.Literal(value),
    false,
  );
}
/** An array whose elements use the given schema. */
export const array = <T>(item: Schema<T, boolean>): Schema<readonly T[]> =>
  wrap(EffectSchema.Array(decoderOf(item)), false);

/** Parse declared fields and omit undeclared fields. */
export function object<const F extends Fields>(fields: F): ObjectSchema<F> {
  const entries = Object.entries(fields).map(
    ([key, field]): readonly [string, EffectSchema.Decoder<unknown>] => [key, decoderOf(field)],
  );
  // SAFETY: each key retains its own decoder and optional/default metadata.
  // Object.fromEntries erases the mapped key association represented by ObjectValue.
  const decoder = (
    entries.length === 0
      ? withJsonSchemaDocument(
          // Native Struct({}) accepts every non-null value and retains undeclared fields.
          EffectSchema.Record(EffectSchema.String, EffectSchema.Unknown).pipe(
            EffectSchema.decodeTo(EffectSchema.Record(EffectSchema.String, EffectSchema.Never), {
              decode: SchemaGetter.transform(() => ({})),
              encode: SchemaGetter.transform((value) => value),
            }),
          ),
          { type: "object", properties: {}, additionalProperties: false },
        )
      : EffectSchema.Struct(Object.fromEntries(entries))
  ) as EffectSchema.Decoder<ObjectValue<F>>;
  return { ...wrap(decoder, false), fields: Object.freeze({ ...fields }) };
}

const ImportedJsonSchema = Symbol("apps.JsonSchemaDocument");

/** Read the original document for an imported decoder without a lossy schema round trip. */
export const importedJsonSchema = (decoder: EffectSchema.Decoder<unknown>): unknown | undefined =>
  ImportedJsonSchema in decoder ? decoder[ImportedJsonSchema] : undefined;

/** Attach a composed discovery document without replacing its authoritative native decoder. */
export const withJsonSchemaDocument = <S extends EffectSchema.Decoder<unknown>>(
  decoder: S,
  document: JsonObject,
): S => Object.assign(decoder, { [ImportedJsonSchema]: document });

/** Compute a value on first use and reuse it. */
export const once = <A>(compute: () => A): (() => A) => {
  let state: { readonly value: A } | undefined;
  return () => (state ??= { value: compute() }).value;
};

/** Attach a discovery document that is built only when it is first read. */
export const withLazyJsonSchemaDocument = <S extends EffectSchema.Decoder<unknown>>(
  decoder: S,
  document: () => JsonObject,
): S =>
  Object.defineProperty(decoder, ImportedJsonSchema, {
    configurable: true,
    enumerable: true,
    get: once(document),
  });

/**
 * Relocate a self-contained JSON Schema under a document pointer. Resolve references
 * before nesting so account schemas can reuse definition names, IDs and anchors.
 * Only schema nodes are rewritten; examples and ordinary property values stay intact.
 */
export const nestJsonSchema = (input: JsonObject, pointer: string): JsonObject => {
  const document = structuredClone(input);
  const lookup = dereference(document);
  const schemas = new Set(Object.values(lookup));
  const pointers = new Map<unknown, string>();
  const locate = (value: JsonValue, path: string): void => {
    if (!pointers.has(value)) pointers.set(value, path);
    if (Array.isArray(value)) value.forEach((item, index) => locate(item, `${path}/${index}`));
    else if (value !== null && typeof value === "object")
      for (const [key, item] of Object.entries(value))
        locate(
          item,
          `${path}/${encodeURI(key.replaceAll("~", "~0").replaceAll("/", "~1")).replaceAll("#", "%23")}`,
        );
  };
  locate(document, pointer);
  const references = new Map<unknown, Readonly<Record<string, string>>>();
  for (const schema of schemas) {
    if (typeof schema === "boolean") continue;
    const refs: Record<string, string> = {};
    for (const [key, absolute] of [
      ["$ref", schema.__absolute_ref__],
      ["$recursiveRef", schema.__absolute_recursive_ref__],
    ] as const) {
      if (absolute === undefined) continue;
      const target = lookup[absolute];
      const path = pointers.get(target);
      if (path === undefined) throw new ValidationError();
      refs[key] = path;
    }
    references.set(schema, refs);
  }
  const rewrite = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value === null || typeof value !== "object") return value;
    const refs = references.get(value);
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => refs === undefined || !["$id", "id", "$anchor"].includes(key))
        .map(([key, item]) => [key, refs?.[key] ?? rewrite(item)]),
    );
  };
  return EffectSchema.decodeUnknownSync(
    EffectSchema.Record(EffectSchema.String, EffectSchema.Json),
  )(rewrite(document));
};

// Walk schema positions only. A property named "format" or "default" is still ordinary user data.
const schemaMaps = new Set([
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaNodes = new Set([
  "not",
  "if",
  "then",
  "else",
  "items",
  "additionalItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
]);
function interpretedDocument(value: EffectSchema.Json): EffectSchema.Json {
  if (typeof value === "boolean") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError();
  const entries: Array<readonly [string, EffectSchema.Json]> = [];
  for (const [key, item] of Object.entries(value)) {
    // These keywords are not implemented by this interpreter. Reject, never silently ignore a constraint.
    if (key === "$dynamicRef" || key === "$dynamicAnchor") throw new ValidationError();
    // Existing imports treat formats as annotations, not assertions.
    if (key === "format") continue;
    if (schemaMaps.has(key) && item !== null && typeof item === "object" && !Array.isArray(item)) {
      entries.push([
        key,
        Object.fromEntries(
          Object.entries(item).map(([name, schema]) => [name, interpretedDocument(schema)]),
        ),
      ]);
    } else if ((schemaArrays.has(key) || key === "items") && Array.isArray(item)) {
      entries.push([key, item.map(interpretedDocument)]);
    } else if (schemaNodes.has(key)) entries.push([key, interpretedDocument(item)]);
    else if (
      key === "dependencies" &&
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      entries.push([
        key,
        Object.fromEntries(
          Object.entries(item).map(([name, schema]) => [
            name,
            Array.isArray(schema) ? schema : interpretedDocument(schema),
          ]),
        ),
      ]);
    } else entries.push([key, item]);
  }
  return Object.fromEntries(entries);
}

// Keywords that only wrap a nested failure; the nested error carries the useful location.
const containerKeywords = new Set([
  "$ref",
  "$recursiveRef",
  "$dynamicRef",
  "properties",
  "patternProperties",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "items",
  "prefixItems",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "allOf",
  "if",
  "then",
  "else",
  "dependentSchemas",
]);

/**
 * Locate imported JSON Schema failures without the validator's text, which can quote input
 * values. Type failures name only the schema's expected types.
 */
const jsonSchemaProblems = (
  errors: readonly { keyword: string; instanceLocation: string; error: string }[],
) => {
  const problems = errors.flatMap(({ keyword, instanceLocation, error }) => {
    if (containerKeywords.has(keyword)) return [];
    const path = instanceLocation
      .replace(/^#\/?/, "")
      .split("/")
      .filter((segment) => segment !== "")
      .map((segment) => decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~"))
      .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
    const required = keyword === "required" ? /required property "([^"]*)"/.exec(error) : null;
    const expected = keyword === "type" ? /Expected "([^.]*)"\.?$/.exec(error) : null;
    const issue =
      required !== null
        ? { path: [...path, required[1] ?? ""], issue: "Missing key" }
        : {
            path,
            issue:
              expected !== null
                ? `Expected ${(expected[1] ?? "").replace(/"/g, "")}`
                : keyword === "const" || keyword === "enum"
                  ? "Expected one of the allowed values"
                  : `Failed the "${keyword}" constraint`,
          };
    return [issue];
  });
  return problems.length === 0 ? false : problems;
};

/** Prepare an interpreted validator. No eval or generated JavaScript runs in any host. */
export const compileJsonSchemaDecoder = (document: JsonObject) =>
  Effect.gen(function* () {
    const validator = yield* Effect.try({
      try: () => {
        const draft =
          document.$schema === "http://json-schema.org/draft-07/schema#" ||
          document.$schema === "https://json-schema.org/draft-07/schema"
            ? "7"
            : "2020-12";
        const normalized = interpretedDocument(document);
        if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized))
          throw new ValidationError();
        const lookup = dereference(normalized);
        // Resolve the whole selected schema before any tool side effect, including
        // references in output schemas and branches not reached by a sample input.
        for (const schema of new Set(Object.values(lookup))) {
          if (typeof schema === "boolean") continue;
          for (const pattern of [schema.pattern, ...Object.keys(schema.patternProperties ?? {})]) {
            if (pattern === undefined) continue;
            // Match the interpreter's Unicode-first compatibility patch, but do
            // this before an upstream call rather than waiting for output data.
            try {
              new RegExp(pattern, "u");
            } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
              new RegExp(pattern);
            }
          }
          for (const reference of [schema.__absolute_ref__, schema.__absolute_recursive_ref__]) {
            if (reference !== undefined && lookup[reference] === undefined)
              throw new ValidationError();
          }
        }
        return {
          validate: (input: EffectSchema.Json) => validate(input, normalized, draft, lookup),
        };
      },
      catch: () => new ValidationError(),
    });
    const decoder = EffectSchema.Json.check(
      EffectSchema.makeFilter(
        (value) => {
          try {
            const result = validator.validate(value);
            return result.valid || jsonSchemaProblems(result.errors);
          } catch {
            return false;
          }
        },
        { expected: "a value matching a supported imported JSON Schema" },
      ),
    );
    return Object.assign(decoder, { [ImportedJsonSchema]: document });
  });

/**
 * Build the document only when a value is first decoded or the schema is described, then
 * compile its validator once. Imported apps can share definitions between many schemas
 * without making each one self-contained up front.
 */
export const lazyJsonSchemaDecoder = (document: () => JsonObject) =>
  Effect.gen(function* () {
    const read = once(document);
    // Reuse only this tool's compiled decoder. Every app evaluation still obtains
    // fresh account-specific metadata; no catalog or credentials are cached here.
    const compiled = yield* Effect.cached(Effect.suspend(() => compileJsonSchemaDecoder(read())));
    const decoder = EffectSchema.declareConstructor<EffectSchema.Json>()(
      [],
      () => (input, _ast, options) =>
        compiled.pipe(
          Effect.mapError(
            () => new SchemaIssue.InvalidValue({ message: "Unsupported JSON Schema" }),
          ),
          Effect.flatMap((schema) => SchemaParser.decodeUnknownEffect(schema)(input, options)),
        ),
    );
    return withLazyJsonSchemaDocument(decoder, read);
  });

/** Preserve the JSON document; compile its validator only when a value is first decoded. */
export const jsonSchemaDecoder = (input: unknown) =>
  parse(EffectSchema.Record(EffectSchema.String, EffectSchema.Json), input).pipe(
    Effect.flatMap((document) => lazyJsonSchemaDecoder(() => document)),
  );

/** Import JSON metadata now; unsupported schemas and invalid values fail when parsed. */
export const jsonSchema = (input: unknown): Schema<EffectSchema.Json> =>
  wrap(Effect.runSync(jsonSchemaDecoder(input)), false);

/** Database declaration retained by primitive constructors; nested payload schemas are not database fields. */
export const storageFieldOf = (schema: Schema<unknown, boolean>): Field | undefined =>
  schema[StorageField];
/** A row reference records the target table; existence is not a foreign-key constraint. */
export const id = (table: string): Schema<string> =>
  wrap(EffectSchema.NonEmptyString, false, { kind: "id", references: table });
/** A host user identifier, stored as a string without imposing a product auth model. */
export const userId = (): Schema<string> =>
  wrap(EffectSchema.NonEmptyString, false, { kind: "userId" });
