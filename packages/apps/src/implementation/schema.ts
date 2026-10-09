/** Author schema facade. Internals use the native decoder retained by each value. */
import {
  Cause,
  Effect,
  Exit,
  Schema as EffectSchema,
  SchemaGetter,
  SchemaIssue,
  SchemaParser,
} from "effect";
import { deepCompareStrict, dereference, validate } from "@cfworker/json-schema";
import { JsonObject, ValidationError, type JsonValue } from "../contracts/schema.ts";

import type { FieldExposure } from "../contracts/provider.ts";

const Decoder = Symbol("apps.Schema");

/** An author-facing value schema. Effect is never required in author code. */
export interface Schema<T, Optional extends boolean = false> {
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

/**
 * Source that skipped type checking can pass any value where a schema belongs, such as `string`
 * for `string()`. Name the argument and the mistake before a native constructor reads it.
 */
export const schemaArgument = <S extends Schema<unknown, boolean>>(value: S, role: string): S => {
  if (isSchema(value)) return value;
  const received: unknown = value;
  throw new TypeError(
    `${role} must be a schema, such as string() or object({ ... }), but ${
      typeof received === "function"
        ? "it is a function. Call it, as in string()."
        : received === undefined
          ? "it is undefined. Check that it is defined and imported before this declaration."
          : typeof received === "object" &&
              received !== null &&
              Object.getPrototypeOf(received) === Object.prototype
            ? "it is a plain object. Wrap its fields in object({ ... })."
            : "no apps schema constructor created it."
    }`,
  );
};

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
): Schema<T, Optional> {
  return {
    [Decoder]: decoder,
    optionalValue,
    parse: (input) => Effect.runSync(parse(decoder, input)),
    optional: () => wrap(EffectSchema.optional(decoder), true),
    default: (value) => {
      const parsed = Effect.runSync(parse(decoder, value));
      return {
        ...wrap(
          decoder
            .annotate({ default: parsed })
            .pipe(EffectSchema.withDecodingDefault(Effect.succeed(parsed))),
          false,
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
  );
}
/** A finite JSON number. No coercion. */
export const number = (): Schema<number> => wrap(EffectSchema.Finite, false);
/** A boolean. No coercion. */
export const boolean = (): Schema<boolean> => wrap(EffectSchema.Boolean, false);
/** Any JSON value. Values still cross the native JSON decoder. */
export const json = (): Schema<EffectSchema.Json> => wrap(EffectSchema.Json, false);
/** Named values with a common schema. */
export const record = <T>(value: Schema<T, boolean>): Schema<Readonly<Record<string, T>>> =>
  wrap(
    EffectSchema.Record(
      EffectSchema.String,
      decoderOf(schemaArgument(value, "The record() value")),
    ),
    false,
  );
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
  wrap(EffectSchema.Array(decoderOf(schemaArgument(item, "The array() item"))), false);

/** Parse declared fields and omit undeclared fields. */
export function object<const F extends Fields>(fields: F): ObjectSchema<F> {
  const entries = Object.entries(fields).map(
    ([key, field]): readonly [string, EffectSchema.Decoder<unknown>] => [
      key,
      decoderOf(schemaArgument(field, `The object() field ${JSON.stringify(key)}`)),
    ],
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

const Exposure: unique symbol = Symbol("apps.FieldExposure");

/** A schema marked with how app code sees the field in a provider that declares hosts. */
export type Exposed<S, E extends FieldExposure = FieldExposure> = S & { readonly [Exposure]: E };

/** The marking of one account field, if any. */
export const exposureOf = (schema: Schema<unknown, boolean>): FieldExposure | undefined =>
  Exposure in schema && (schema[Exposure] === "plain" || schema[Exposure] === "raw")
    ? schema[Exposure]
    : undefined;

const expose = <S extends Schema<unknown, boolean>, E extends FieldExposure>(
  schema: S,
  exposure: E,
): Exposed<S, E> =>
  // SAFETY: the copy keeps every member of S, and `optional` and `default` keep the marking.
  ({
    ...schema,
    [Exposure]: exposure,
    optional: () => expose(schema.optional(), exposure),
    default: (value: never) => expose(schema.default(value), exposure),
  }) as unknown as Exposed<S, E>;

/**
 * A field that is not secret, such as a subdomain or region. App code reads its real value and
 * the connect form shows it.
 */
export const plain = <S extends Schema<unknown, boolean>>(schema: S): Exposed<S, "plain"> =>
  expose(schema, "plain");

/**
 * A secret field that app code reads as its real value, for request signing and similar uses.
 * The connect form warns that the app can read it. Prefer an unmarked field, which app code
 * receives as a handle that only reaches the provider's declared hosts.
 */
export const raw = <S extends Schema<unknown, boolean>>(schema: S): Exposed<S, "raw"> =>
  expose(schema, "raw");

/** Marked fields of an account object, by name. */
export const fieldExposure = (fields: Fields): Readonly<Record<string, FieldExposure>> =>
  Object.fromEntries(
    Object.entries(fields).flatMap(([name, field]) => {
      const exposure = exposureOf(field);
      return exposure === undefined ? [] : [[name, exposure]];
    }),
  );

declare const Secret: unique symbol;
/**
 * A secret account value. In a provider that declares hosts it is a handle, which the host's
 * outbound network replaces with the real value only on requests to those hosts. Pass it to
 * clients and headers as an ordinary string; do not decode or transform it.
 */
export type SecretString = string & { readonly [Secret]: true };

type Sealed<T> = T extends string ? SecretString : T;
/** Account fields as app code receives them: unmarked string fields are secret. */
export type SecretFields<F extends Fields> = {
  readonly [Key in keyof ObjectValue<F>]: Key extends keyof F
    ? F[Key] extends Exposed<unknown>
      ? ObjectValue<F>[Key]
      : Sealed<ObjectValue<F>[Key]>
    : ObjectValue<F>[Key];
};
/** An account object without declared fields, such as a default OAuth projection. */
export type SecretObject<T> = { readonly [Key in keyof T]: Sealed<T[Key]> };

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
 * A `$recursiveRef` becomes the pointer to its static target, such as the relocated root. The
 * patched validator applies it like `"#"` was: the recursive anchor in scope, else that target.
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
 * Whether an input key may be named in a validation problem. Other keys can carry supplied data,
 * so problems locate them without echoing them.
 */
export const echoableKey = (key: string): boolean => /^[A-Za-z_$][\w$-]{0,63}$/.test(key);

/** A key the schema declares, quoted when it is not a plain identifier. */
const schemaKey = (name: string) => (echoableKey(name) ? name : JSON.stringify(name.slice(0, 64)));

const maxShapeKeys = 24;
/**
 * The keys an object accepts, as `object {name, optional?}`. `...` marks an object that also
 * accepts other keys. Names come from the schema, never from supplied input.
 */
export const objectShape = (
  keys: readonly { readonly name: string; readonly optional: boolean }[],
  open: boolean,
  limit = maxShapeKeys,
): string => {
  const listed = keys
    .slice(0, limit)
    .map(({ name, optional }) => `${schemaKey(name)}${optional ? "?" : ""}`);
  const parts = [
    ...listed,
    ...(keys.length > limit ? [`${keys.length - limit} more`] : []),
    ...(open ? ["..."] : []),
  ];
  return parts.length === 0 ? "object {} with no keys" : `object {${parts.join(", ")}}`;
};

/** Values a problem lists, and the length of their text, before it counts the rest. */
const maxListedValues = 10;
const maxValuesText = 200;
/** A schema value as an agent writes it in input: JSON, or `1n` for a native bigint. */
const valueText = (value: unknown) =>
  typeof value === "bigint" ? `${value}n` : JSON.stringify(value);
/**
 * The values a schema fixes, as `"v1"` or `one of "a", "b" and 3 more`. Agents already read
 * these values in the tool's signature, so problems list them, up to {@link maxListedValues}
 * values and {@link maxValuesText} characters. They come from the schema, never from input.
 */
export const allowedValues = (values: readonly unknown[]): string => {
  const texts = [...new Set(values.map(valueText))];
  const listed: string[] = [];
  for (const text of texts) {
    if (listed.length === maxListedValues || [...listed, text].join(", ").length > maxValuesText)
      break;
    listed.push(text);
  }
  const [only] = listed;
  if (texts.length === 0) return "no value, since the schema allows none";
  if (only === undefined)
    return texts.length === 1
      ? "a fixed value too long to list"
      : `one of ${texts.length} values too long to list`;
  if (texts.length === 1) return only;
  const rest = texts.length - listed.length;
  return `one of ${listed.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
};

/** Keys listed for each union alternative, so several alternatives fit in one problem. */
export const maxAlternativeKeys = 8;
const maxAlternativesText = 360;
/**
 * The alternatives a union accepts, as `string or object {id}`, and the key whose value tells
 * them apart. Shapes, values and the key come from the schema, never from supplied input.
 */
export const unionShape = (alternatives: readonly string[], selector: string | undefined) => {
  const listed: string[] = [];
  for (const alternative of alternatives) {
    if (listed.length > 0 && [...listed, alternative].join(" or ").length > maxAlternativesText)
      break;
    listed.push(alternative);
  }
  const rest = alternatives.length - listed.length;
  return `${[...listed, ...(rest > 0 ? [`${rest} more`] : [])].join(" or ")}${
    selector === undefined ? "" : `, told apart by ${schemaKey(selector)}`
  }`;
};

/** The problem for a required key the input omits, with what its schema expects when stated. */
export const missingKey = (expected: string | undefined) =>
  expected === undefined ? missingKeyText : `${missingKeyText}. Expected ${expected}`;
/** The text every missing-key problem starts with, so the caller can add where the input has it. */
export const missingKeyText = "Missing key";

const isJsonRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Decode a JSON Pointer fragment such as `#/properties/a~1b` into its segments. */
const pointerSegments = (pointer: string): string[] =>
  pointer === "#" || pointer === ""
    ? []
    : pointer
        .replace(/^#?\//, "")
        .split("/")
        .map((segment) => decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~"));

/** The schema a reference keyword's resolved URI names, as the validator resolved it. */
const resolved = (lookup: Readonly<Record<string, unknown>>, uri: unknown): unknown =>
  typeof uri === "string" && Object.hasOwn(lookup, uri) ? lookup[uri] : undefined;

/** The schema a `$ref` node refers to, as the validator resolved it. */
const referenced = (lookup: Readonly<Record<string, unknown>>, node: unknown): unknown =>
  isJsonRecord(node)
    ? resolved(lookup, Reflect.get(node, "__absolute_ref__") ?? node.$ref)
    : undefined;

/** Keywords whose value holds several schemas; a keyword location names the member next. */
const memberKeywords = new Set([...schemaMaps, ...schemaArrays, "dependencies"]);
/** Members of these keep the validator's recursive anchor only when their holder declares it. */
const combinators = new Set(["allOf", "anyOf", "oneOf"]);

/**
 * The schema node at a validator keyword location. A location records each reference the
 * validator followed, so this follows them the same way. A `$ref` segment continues at the
 * referenced schema. A `$recursiveRef` segment, whether `"#"` or a relocated schema's pointer,
 * continues at the recursive anchor in scope:
 * the outermost schema with `$recursiveAnchor: true` on the validator's path, which the members of
 * an `allOf`, `anyOf` or `oneOf` keep only when their holder declares it. With no anchor in scope,
 * the validator applies the same schema again with the reference's static target as the anchor.
 */
const schemaAt = (
  document: EffectSchema.Json,
  lookup: Readonly<Record<string, unknown>>,
  segments: readonly string[],
): unknown => {
  // The validator's recursive anchor; null while none is in scope.
  const anchoredAt = (node: unknown, anchor: unknown) =>
    anchor === null && isJsonRecord(node) && node.$recursiveAnchor === true ? node : anchor;
  const pending = [...segments];
  let node: unknown = document;
  let anchor = anchoredAt(document, null);
  for (let keyword = pending.shift(); keyword !== undefined; keyword = pending.shift()) {
    if (!isJsonRecord(node)) return undefined;
    if (keyword === "$recursiveRef") {
      const target =
        anchor === null
          ? resolved(lookup, Reflect.get(node, "__absolute_recursive_ref__"))
          : anchor;
      if (anchor !== null) node = anchor;
      anchor = target;
      continue;
    }
    if (keyword === "$ref") node = referenced(lookup, node);
    else {
      const value = Object.hasOwn(node, keyword) ? node[keyword] : undefined;
      if (memberKeywords.has(keyword) || (keyword === "items" && Array.isArray(value))) {
        const member = pending.shift();
        // The location names the keyword itself, such as a union's list of alternatives.
        if (member === undefined) return value;
        if (combinators.has(keyword) && node.$recursiveAnchor !== true) anchor = null;
        node = Array.isArray(value)
          ? /^\d+$/.test(member)
            ? value[Number(member)]
            : undefined
          : isJsonRecord(value) && Object.hasOwn(value, member)
            ? value[member]
            : undefined;
      } else node = value;
    }
    anchor = anchoredAt(node, anchor);
  }
  return node;
};

/** A JSON Schema object node by its keys, or plain `object` when it neither names nor limits them. */
const jsonObjectShape = (node: unknown): string => {
  if (!isJsonRecord(node)) return "object";
  const properties = isJsonRecord(node.properties) ? Object.keys(node.properties) : [];
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const open =
    node.additionalProperties !== false ||
    (isJsonRecord(node.patternProperties) && Object.keys(node.patternProperties).length > 0);
  return properties.length === 0 && open
    ? "object"
    : objectShape(
        properties.map((name) => ({ name, optional: !required.has(name) })),
        open,
      );
};

/** A JSON Pointer's segments as a map key; segments may themselves contain `/`. */
const locationKey = (segments: readonly string[]) => JSON.stringify(segments);

/** What the problem formatter can read from a compiled schema and the rejected input. */
interface Inspection {
  /** The schema node at a keyword location's segments. */
  readonly schemaAt: (segments: readonly string[]) => unknown;
  /** The schema a `$ref` node refers to. */
  readonly referenced: (node: unknown) => unknown;
  /** Whether the validator accepts a value for a schema node. */
  readonly accepts: (node: unknown, value: unknown) => boolean;
  /** The rejected input. It ranks union alternatives and is never rendered. */
  readonly input: EffectSchema.Json;
}

interface ValidatorError {
  readonly keyword: string;
  readonly instanceLocation: string;
  readonly keywordLocation: string;
  readonly error: string;
}

interface Problem {
  readonly path: readonly (string | number)[];
  readonly issue: string;
}

/**
 * The constraints one schema node places on a value, including its `$ref` target and `allOf`
 * members. Union alternatives are described and compared by outline.
 */
interface Outline {
  /** Accepted JSON types; undefined accepts every type. */
  readonly types: ReadonlySet<string> | undefined;
  readonly properties: ReadonlyMap<string, unknown>;
  readonly required: ReadonlySet<string>;
  readonly closed: boolean;
  /** The values every `const` and `enum` allows; undefined when none limits the value. */
  readonly values: readonly unknown[] | undefined;
}

const emptyOutline: Outline = {
  types: undefined,
  properties: new Map(),
  required: new Set(),
  closed: false,
  values: undefined,
};

/** Values both sets allow; undefined allows every value. */
const commonValues = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
  a === undefined
    ? b
    : b === undefined
      ? a
      : a.filter((value) => b.some((other) => deepCompareStrict(value, other)));

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Types both outlines accept; an integer is also a number. */
const commonTypes = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  new Set(
    [...a].flatMap((type) =>
      b.has(type)
        ? [type]
        : (type === "number" && b.has("integer")) || (type === "integer" && b.has("number"))
          ? ["integer"]
          : [],
    ),
  );

const mergeOutlines = (a: Outline, b: Outline): Outline => ({
  types:
    a.types === undefined
      ? b.types
      : b.types === undefined
        ? a.types
        : commonTypes(a.types, b.types),
  properties: new Map([...a.properties, ...b.properties]),
  required: new Set([...a.required, ...b.required]),
  closed: a.closed || b.closed,
  values: commonValues(a.values, b.values),
});

const outlineOf = (
  node: unknown,
  inspection: Inspection,
  seen: ReadonlySet<unknown> = new Set(),
): Outline => {
  if (!isJsonRecord(node) || seen.has(node)) return emptyOutline;
  const within = new Set([...seen, node]);
  const own: Outline = {
    types:
      typeof node.type === "string"
        ? new Set([node.type])
        : Array.isArray(node.type)
          ? new Set(strings(node.type))
          : undefined,
    properties: new Map(isJsonRecord(node.properties) ? Object.entries(node.properties) : []),
    required: new Set(strings(node.required)),
    closed:
      (node.additionalProperties === false || node.unevaluatedProperties === false) &&
      !(isJsonRecord(node.patternProperties) && Object.keys(node.patternProperties).length > 0),
    values: commonValues(
      Object.hasOwn(node, "const") ? [node.const] : undefined,
      Array.isArray(node.enum) ? node.enum : undefined,
    ),
  };
  return [inspection.referenced(node), ...(Array.isArray(node.allOf) ? node.allOf : [])].reduce(
    (outline: Outline, member) => mergeOutlines(outline, outlineOf(member, inspection, within)),
    own,
  );
};

const otherConstraints = "a value with other constraints";

/** An outline by the values it allows, else by its types and up to `limit` object keys. */
const outlineText = (outline: Outline, limit: number): string => {
  if (outline.values !== undefined) return allowedValues(outline.values);
  const names = [
    ...outline.properties.keys(),
    ...[...outline.required].filter((name) => !outline.properties.has(name)),
  ];
  const shape =
    names.length === 0 && !outline.closed
      ? "object"
      : objectShape(
          names.map((name) => ({ name, optional: !outline.required.has(name) })),
          !outline.closed,
          limit,
        );
  if (outline.types === undefined)
    return names.length > 0 || outline.closed ? shape : otherConstraints;
  return [...outline.types].map((type) => (type === "object" ? shape : type)).join(" or ");
};

/** An alternative by the values it allows, else by its types and object keys. */
const describeOutline = (outline: Outline) => outlineText(outline, maxAlternativeKeys);

/**
 * Whether an outline fixes the type of every value it accepts, by its values or its types. Object
 * keywords alone constrain only objects, and other keywords still apply to every value, so an
 * outline without either promises no type.
 */
const typed = (outline: Outline) => outline.values !== undefined || outline.types !== undefined;

/**
 * What a declared key's schema expects, as a missing key's problem states it: its values, types
 * and object keys, or its `anyOf` alternatives when every alternative fixes a type. Undefined when
 * the schema fixes no type, since keywords other than these may still reject a value, and for any
 * schema with a `oneOf`, even beside its own values or types, since its alternatives' overlap
 * rejects values that each alternative alone allows.
 */
const describeProperty = (node: unknown, inspection: Inspection): string | undefined => {
  const target = inspection.referenced(node) ?? node;
  if (isJsonRecord(target) && Object.hasOwn(target, "oneOf")) return undefined;
  const outline = outlineOf(node, inspection);
  if (typed(outline)) return outlineText(outline, maxShapeKeys);
  const members = isJsonRecord(target) && Array.isArray(target.anyOf) ? target.anyOf : [];
  const outlines = members
    .filter((member) => member !== false)
    .map((member) => outlineOf(member, inspection));
  return outlines.length === 0 || !outlines.every(typed)
    ? undefined
    : unionShape([...new Set(outlines.map(describeOutline))], undefined);
};

const maxPatternText = 160;
const count = (amount: number, noun: string) => `${amount} ${noun}${amount === 1 ? "" : "s"}`;

/**
 * A failed validation keyword as the limit its schema node declares, such as `Expected a string
 * of at least 3 characters`. Limits and patterns come from the schema, never from input.
 * Undefined for a keyword without a stated limit here, or when the node's value is not one.
 */
const constraintProblem = (keyword: string, node: unknown): string | undefined => {
  if (!isJsonRecord(node)) return undefined;
  const value = node[keyword];
  if (keyword === "pattern")
    return typeof value !== "string"
      ? undefined
      : value.length <= maxPatternText
        ? `Expected a string matching the pattern ${JSON.stringify(value)}`
        : "Expected a string matching the schema's pattern, which is too long to show";
  if (keyword === "format")
    return typeof value === "string"
      ? `Expected a string in the ${JSON.stringify(value.slice(0, 64))} format`
      : undefined;
  if (keyword === "uniqueItems") return "Expected an array without repeated items";
  if (typeof value !== "number") return undefined;
  switch (keyword) {
    // Draft 4's boolean `exclusiveMinimum` is not applied: imported schemas validate as draft 7
    // or 2020-12, where `minimum` and `maximum` always include their bound.
    case "minimum":
      return `Expected a number of at least ${value}`;
    case "maximum":
      return `Expected a number of at most ${value}`;
    case "exclusiveMinimum":
      return `Expected a number greater than ${value}`;
    case "exclusiveMaximum":
      return `Expected a number less than ${value}`;
    case "multipleOf":
      return `Expected a multiple of ${value}`;
    case "minLength":
      return `Expected a string of at least ${count(value, "character")}`;
    case "maxLength":
      return `Expected a string of at most ${count(value, "character")}`;
    case "minItems":
      return `Expected an array of at least ${count(value, "item")}`;
    case "maxItems":
      return `Expected an array of at most ${count(value, "item")}`;
    case "minProperties":
      return `Expected an object with at least ${count(value, "key")}`;
    case "maxProperties":
      return `Expected an object with at most ${count(value, "key")}`;
    default:
      return undefined;
  }
};

/** How many keys of an input object, at any depth, an outline declares. */
const overlap = (outline: Outline, value: unknown, inspection: Inspection, depth = 0): number =>
  !isJsonRecord(value) || depth > 16
    ? 0
    : Object.entries(value).reduce((total, [key, item]) => {
        const property = outline.properties.get(key);
        return property === undefined
          ? total
          : total + 1 + overlap(outlineOf(property, inspection), item, inspection, depth + 1);
      }, 0);

const jsonType = (value: unknown) =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value === "object"
        ? "object"
        : typeof value;

/** Whether a value has a type the outline accepts: its allowed values' types, else its types. */
const accepted = (outline: Outline, value: unknown) => {
  const type = jsonType(value);
  if (outline.values !== undefined)
    return outline.values.some((allowed) => jsonType(allowed) === type);
  if (outline.types === undefined) return true;
  return (
    outline.types.has(type) ||
    (type === "number" && outline.types.has("integer") && Number.isInteger(value))
  );
};

/** The input value at an instance location. */
const valueAt = (input: unknown, location: readonly string[]): unknown =>
  location.reduce<unknown>(
    (value, segment) =>
      Array.isArray(value)
        ? value[Number(segment)]
        : isJsonRecord(value) && Object.hasOwn(value, segment)
          ? value[segment]
          : undefined,
    input,
  );

/** An OpenAPI `discriminator` declared beside a union. Validation ignores it; problems use it. */
const discriminatorOf = (holder: unknown) =>
  isJsonRecord(holder) && isJsonRecord(holder.discriminator) ? holder.discriminator : undefined;

/** The definition a local reference names, as `Dog` in `#/$defs/Dog` or `#/components/schemas/Dog`. */
const definitionName = (reference: unknown): string | undefined => {
  if (typeof reference !== "string" || !reference.startsWith("#/")) return undefined;
  const segments = pointerSegments(reference);
  const container = segments.at(-2);
  return container === "$defs" ||
    container === "definitions" ||
    (container === "schemas" && segments.at(-3) === "components")
    ? segments.at(-1)
    : undefined;
};

/**
 * The schema name a discriminator value selects. `mapping` names a schema per value, by schema
 * name or by reference; a value it does not list is itself a schema name. Imported OpenAPI
 * documents keep component names as definition names, so names compare across both forms.
 */
const discriminatedName = (holder: unknown, value: unknown): string | undefined => {
  const discriminator = discriminatorOf(holder);
  if (discriminator === undefined || typeof value !== "string") return undefined;
  const { mapping } = discriminator;
  const target = isJsonRecord(mapping) && Object.hasOwn(mapping, value) ? mapping[value] : value;
  if (typeof target !== "string") return undefined;
  return /^[\w.-]+$/.test(target) ? target : definitionName(target);
};

/**
 * The key whose value tells object alternatives apart, as OpenAPI's `discriminator` names it or as
 * every alternative fixes it with a `const` or `enum`.
 */
const selectorOf = (holder: unknown, alternatives: readonly Outline[], inspection: Inspection) => {
  const declared = discriminatorOf(holder)?.propertyName;
  if (typeof declared === "string") return declared;
  const [first] = alternatives;
  if (first === undefined || alternatives.length < 2) return undefined;
  return [...first.properties.keys()].find((key) =>
    alternatives.every(
      (alternative) =>
        alternative.properties.has(key) &&
        outlineOf(alternative.properties.get(key), inspection).values !== undefined,
    ),
  );
};

/**
 * The errors each alternative of the union at `head` reported, which follow it in validator
 * order, and the index after them. `schemas` are the union's alternatives, when located.
 */
const alternativeErrors = (errors: readonly ValidatorError[], head: number, schemas: unknown) => {
  const prefix = `${errors[head]?.keywordLocation}/`;
  const alternatives = new Map<number, ValidatorError[]>();
  // The validator reports a `false` schema at its instance location, not its keyword location.
  // A nested one follows the error of the keyword that applied it, so it stays in that
  // alternative. A `false` alternative reports exactly one, directly after the errors of the
  // alternatives before it; those are removed from the alternative they were collected into.
  const settle = (current: number, next: number) => {
    const collected = alternatives.get(current);
    const rejected = Array.isArray(schemas)
      ? schemas.slice(current + 1, next).filter((schema) => schema === false).length
      : 0;
    if (collected !== undefined) collected.splice(collected.length - rejected, rejected);
  };
  let index = head + 1;
  let current = -1;
  for (; index < errors.length; index++) {
    const error = errors[index];
    if (error === undefined) break;
    if (error.keywordLocation.startsWith(prefix)) {
      const alternative = Number(error.keywordLocation.slice(prefix.length).split("/")[0]);
      if (alternative !== current) settle(current, alternative);
      current = alternative;
    } else if (error.keyword !== "false") break;
    // Before any alternative reports, a `false` error can only be a `false` alternative's.
    if (current >= 0) alternatives.set(current, [...(alternatives.get(current) ?? []), error]);
  }
  settle(current, Array.isArray(schemas) ? schemas.length : current);
  return { alternatives, end: index };
};

const pathOf = (location: readonly string[]) =>
  location.map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));

/**
 * A failed `anyOf` or `oneOf`, as one problem naming the alternatives it accepts and the key that
 * tells them apart. When the input has an alternative's type, the closest alternative's own
 * problems follow, so the caller sees what to change for the shape it most likely meant. The
 * closest is the alternative the input's selector value picks, then one of the input's type,
 * then the one declaring most of the input's keys, then the one with fewest problems. A selector
 * value picks an alternative through the union's OpenAPI `discriminator`, or when the alternative
 * fixes the selector to values that include it. Declaring only the selector's type picks nothing.
 */
const unionProblems = (
  union: ValidatorError,
  schemas: unknown,
  errorsByAlternative: ReadonlyMap<number, readonly ValidatorError[]>,
  inspection: Inspection,
): Problem[] => {
  const location = pointerSegments(union.instanceLocation);
  const path = pathOf(location);
  if (!Array.isArray(schemas))
    // The union's alternatives could not be located, so they are neither described nor compared.
    // State the failed keyword, as the validator does, with every alternative's problems.
    return [
      { path, issue: `Failed the "${union.keyword}" constraint` },
      ...[...errorsByAlternative.values()].flatMap((errors) => problemsOf(errors, inspection)),
    ];
  // A `false` alternative accepts nothing, so it is neither described nor closest.
  const alternatives = schemas.flatMap((schema, index) =>
    schema === false
      ? []
      : [
          {
            schema,
            matched: !errorsByAlternative.has(index),
            problems: () => problemsOf(errorsByAlternative.get(index) ?? [], inspection),
          },
        ],
  );
  const [only] = alternatives;
  if (only === undefined) return [{ path, issue: "No value is allowed here" }];
  if (alternatives.length === 1) return only.problems();
  const holder = inspection.schemaAt(pointerSegments(union.keywordLocation).slice(0, -1));
  // Alternatives refine the object that holds the union, such as OpenAPI request body variants.
  const shared = outlineOf(holder, inspection);
  const own = alternatives.map(({ schema }) => outlineOf(schema, inspection));
  const outlines = own.map((outline) => mergeOutlines(shared, outline));
  const selector = selectorOf(holder, own, inspection);
  const expected = `Expected ${unionShape(outlines.map(describeOutline), selector)}`;
  const matched = alternatives.filter((alternative) => alternative.matched).length;
  if (union.keyword === "oneOf" && matched > 1)
    return [{ path, issue: `${expected}. Exactly one may match, but ${matched} do` }];
  // With no alternative matching, every value any `anyOf` alternative fixes is one the input could
  // use. A `oneOf` rejects a value its alternatives share, so its alternatives stay apart.
  const fixed = outlines.flatMap(({ values }) => (values === undefined ? [] : [values]));
  if (fixed.length === outlines.length)
    return [
      {
        path,
        issue:
          union.keyword === "oneOf"
            ? `${expected}. Exactly one alternative must match`
            : `Expected ${allowedValues(fixed.flat())}`,
      },
    ];
  const value = valueAt(inspection.input, location);
  const selectorValue =
    selector !== undefined && isJsonRecord(value) && Object.hasOwn(value, selector)
      ? { value: value[selector] }
      : undefined;
  const named = discriminatedName(holder, selectorValue?.value);
  const ranked = alternatives.map(({ schema, problems }, index) => {
    const outline = outlines[index] ?? emptyOutline;
    const property = own[index]?.properties.get(selector ?? "");
    return {
      index,
      problems: problems(),
      selected:
        selectorValue !== undefined &&
        ((named !== undefined && isJsonRecord(schema) && definitionName(schema.$ref) === named) ||
          (property !== undefined &&
            outlineOf(property, inspection).values !== undefined &&
            inspection.accepts(property, selectorValue.value))),
      typed: accepted(outline, value),
      overlap: overlap(outline, value, inspection),
    };
  });
  const closest = ranked.reduce((best, candidate) =>
    ([
      Number(candidate.selected) - Number(best.selected),
      Number(candidate.typed) - Number(best.typed),
      candidate.overlap - best.overlap,
      best.problems.length - candidate.problems.length,
    ].find((difference) => difference !== 0) ?? 0) > 0
      ? candidate
      : best,
  );
  return closest.selected || closest.typed
    ? [
        {
          path,
          issue: `${expected}. Closest is alternative ${closest.index + 1}, whose problems follow`,
        },
        ...closest.problems,
      ]
    : [{ path, issue: expected }];
};

/**
 * Locate imported JSON Schema failures without the validator's text, which can quote input
 * values. Each problem states what the schema expects at its path: the types, an expected
 * object's keys, an unexpected key with the keys its object accepts, the values a `const` or
 * `enum` allows, or a union's alternatives.
 */
const problemsOf = (errors: readonly ValidatorError[], inspection: Inspection): Problem[] => {
  // The validator reports a key that `additionalProperties: false` rejects as this keyword at
  // the object, followed by a `false` schema at the key. Keep each object's schema for the key.
  const closed = new Map<string, unknown>();
  const problems: Problem[] = [];
  for (let index = 0; index < errors.length; index++) {
    const error = errors[index];
    if (error === undefined) break;
    const { keyword, instanceLocation, keywordLocation } = error;
    if (keyword === "anyOf" || keyword === "oneOf") {
      const schemas = inspection.schemaAt(pointerSegments(keywordLocation));
      const { alternatives, end } = alternativeErrors(errors, index, schemas);
      problems.push(...unionProblems(error, schemas, alternatives, inspection));
      index = end - 1;
      continue;
    }
    const location = pointerSegments(instanceLocation);
    const path = pathOf(location);
    const problem = (issue: string, at = path) => problems.push({ path: at, issue });
    // The keyword's own schema node: its location without the keyword segment.
    const node = () => inspection.schemaAt(pointerSegments(keywordLocation).slice(0, -1));
    if (keyword === "additionalProperties" || keyword === "unevaluatedProperties") {
      closed.set(locationKey(location), node());
      continue;
    }
    if (containerKeywords.has(keyword)) continue;
    if (keyword === "false") {
      const key = location.at(-1);
      const parent = locationKey(location.slice(0, -1));
      if (key === undefined || !closed.has(parent)) problem("No value is allowed here");
      else
        problem(
          `Unexpected key${echoableKey(key) ? ` "${key}"` : ""}. Expected ${jsonObjectShape(closed.get(parent))}`,
          path.slice(0, -1),
        );
      continue;
    }
    const required =
      keyword === "required" ? /required property "([^"]*)"/.exec(error.error) : null;
    if (required !== null) {
      const name = required[1] ?? "";
      const property = outlineOf(node(), inspection).properties.get(name);
      problem(
        missingKey(property === undefined ? undefined : describeProperty(property, inspection)),
        [...path, name],
      );
      continue;
    }
    const expected = keyword === "type" ? /Expected "([^.]*)"\.?$/.exec(error.error) : null;
    if (expected !== null) {
      const types = (expected[1] ?? "")
        .split('", "')
        .map((type) => (type === "object" ? jsonObjectShape(node()) : type));
      problem(`Expected ${types.join(" or ")}`);
      continue;
    }
    if (keyword === "const" || keyword === "enum") {
      const schema = node();
      const values = !isJsonRecord(schema)
        ? undefined
        : keyword === "const"
          ? Object.hasOwn(schema, "const")
            ? [schema.const]
            : undefined
          : Array.isArray(schema.enum)
            ? schema.enum
            : undefined;
      // A keyword whose schema node cannot be located states the constraint without its values.
      problem(
        values === undefined
          ? "Expected one of the allowed values"
          : `Expected ${allowedValues(values)}`,
      );
      continue;
    }
    problem(constraintProblem(keyword, node()) ?? `Failed the "${keyword}" constraint`);
  }
  return problems;
};

/**
 * Whether an imported schema may accept a key as an object's own key anywhere in its document:
 * one some object names in `properties`, `required` or `dependentRequired`, or any key once some
 * object accepts keys by pattern or by an `additionalProperties` or `unevaluatedProperties`
 * schema. It errs toward accepting, since it is used to avoid suggesting a key moved when the
 * schema has a place for it where it is.
 */
const documentKeys = (document: unknown): ((key: string) => boolean) => {
  const named = new Set<string>();
  let any = false;
  const visit = (node: unknown, depth: number): void => {
    if (depth > 64 || typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Readonly<Record<string, unknown>>;
    if (isJsonRecord(record.properties))
      for (const name of Object.keys(record.properties)) named.add(name);
    for (const name of strings(record.required)) named.add(name);
    if (isJsonRecord(record.dependentRequired))
      for (const [name, names] of Object.entries(record.dependentRequired)) {
        named.add(name);
        for (const other of strings(names)) named.add(other);
      }
    if (
      (isJsonRecord(record.patternProperties) &&
        Object.keys(record.patternProperties).length > 0) ||
      isJsonRecord(record.additionalProperties) ||
      isJsonRecord(record.unevaluatedProperties)
    )
      any = true;
    for (const value of Object.values(record)) visit(value, depth + 1);
  };
  visit(document, 0);
  return (key) => any || named.has(key);
};

/** Each imported schema decoder's check, by the keys its document may accept. */
const importedKeys = new WeakMap<object, (key: string) => boolean>();

/**
 * Whether the imported schema whose check failed may accept a key as an object's own key, for a
 * failure's check; undefined when the check is not an imported schema's.
 */
export const importedSchemaKeys = (check: object): ((key: string) => boolean) | undefined =>
  importedKeys.get(check);

/** Problems for the decoder's filter, or `false` when none locate the failure. */
const jsonSchemaProblems = (errors: readonly ValidatorError[], inspection: Inspection) => {
  const problems = problemsOf(errors, inspection);
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
        const inspection = (input: EffectSchema.Json): Inspection => ({
          schemaAt: (segments) => schemaAt(normalized, lookup, segments),
          referenced: (node) => referenced(lookup, node),
          accepts: (node, value) => {
            if (typeof node !== "boolean" && !isJsonRecord(node)) return false;
            try {
              return validate(value, node, draft, lookup).valid;
            } catch {
              return false;
            }
          },
          input,
        });
        return {
          validate: (input: EffectSchema.Json) => validate(input, normalized, draft, lookup),
          inspection,
        };
      },
      catch: () => new ValidationError(),
    });
    const check = EffectSchema.makeFilter(
      (value: EffectSchema.Json) => {
        try {
          const result = validator.validate(value);
          return result.valid || jsonSchemaProblems(result.errors, validator.inspection(value));
        } catch {
          return false;
        }
      },
      { expected: "a value matching a supported imported JSON Schema" },
    );
    importedKeys.set(check, documentKeys(document));
    const decoder = EffectSchema.Json.check(check);
    return Object.assign(decoder, { [ImportedJsonSchema]: document });
  });

/**
 * Build the document only when a value is first decoded or the schema is described, then
 * compile its validator once. Imported apps can share definitions between many schemas
 * without making each one self-contained up front. Construction runs no Effect: an app
 * evaluation constructs one of these for every imported schema.
 */
const lazyCompiledDecoder = (document: () => JsonObject) => {
  const read = once(document);
  // Reuse only this tool's compiled decoder. Every app evaluation still obtains
  // fresh account-specific metadata; no catalog or credentials are cached here.
  let compiled: Exit.Exit<EffectSchema.Decoder<EffectSchema.Json>, ValidationError> | undefined;
  const compile = Effect.suspend(
    () =>
      compiled ??
      compileJsonSchemaDecoder(read()).pipe(
        // An interrupted compilation is not a result; the next decode compiles again.
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit) || !Cause.hasInterrupts(exit.cause)) compiled = exit;
          }),
        ),
      ),
  );
  const decoder = EffectSchema.declareConstructor<EffectSchema.Json>()(
    [],
    () => (input, _ast, options) =>
      compile.pipe(
        Effect.mapError(() => new SchemaIssue.InvalidValue({ message: "Unsupported JSON Schema" })),
        Effect.flatMap((schema) => SchemaParser.decodeUnknownEffect(schema)(input, options)),
      ),
  );
  return { decoder: withLazyJsonSchemaDocument(decoder, read), compile };
};
const lazyDecoder = (document: () => JsonObject) => lazyCompiledDecoder(document).decoder;
export const lazyJsonSchemaDecoder = (document: () => JsonObject) =>
  Effect.sync(() => lazyDecoder(document));
/**
 * A lazy decoder and the compilation it decodes with. Running `compile` first lets a caller
 * reject an unsupported schema before a side effect whose result the decoder will check.
 */
export const preparedJsonSchemaDecoder = (document: JsonObject) =>
  lazyCompiledDecoder(() => document);

const isJsonValue = EffectSchema.is(EffectSchema.Json);

/**
 * A JSON Schema document: an object whose own string-keyed fields are JSON, as
 * `Schema.Record(Schema.String, Schema.Json)` accepts. Its values are checked by one
 * `Schema.Json` walk, which is iterative and visits a shared subtree once, instead of a
 * decode that builds a result per field. Only the top level is copied, as that decode did.
 */
const jsonDocument = (input: unknown): JsonObject | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  const values = keys.map((key) => Reflect.get(input, key));
  if (!isJsonValue(values)) return undefined;
  const document: Record<string, EffectSchema.Json> = {};
  keys.forEach((key, index) =>
    Object.defineProperty(document, key, {
      value: values[index],
      enumerable: true,
      writable: true,
      configurable: true,
    }),
  );
  return document;
};

/** Preserve the JSON document; compile its validator only when a value is first decoded. */
export const jsonSchemaDecoder = (input: unknown) =>
  Effect.suspend(() => {
    const document = jsonDocument(input);
    return document === undefined
      ? Effect.fail(new ValidationError())
      : lazyJsonSchemaDecoder(() => document);
  });

/** Import JSON metadata now; unsupported schemas and invalid values fail when parsed. */
export const jsonSchema = (input: unknown): Schema<EffectSchema.Json> => {
  const document = jsonDocument(input);
  if (document === undefined) throw new ValidationError();
  return wrap(
    lazyDecoder(() => document),
    false,
  );
};

/** Render a decoder as a JSON Schema document, keeping an imported upstream document as-is. */
export const jsonSchemaDocument = (decoder: EffectSchema.Decoder<unknown>) => {
  const imported = importedJsonSchema(decoder);
  if (imported !== undefined) return EffectSchema.decodeUnknownEffect(JsonObject)(imported);
  const document = EffectSchema.toJsonSchemaDocument(decoder);
  return EffectSchema.decodeUnknownEffect(JsonObject)({
    ...document.schema,
    $defs: document.definitions,
    $schema: "https://json-schema.org/draft/2020-12/schema",
  });
};
