/** Evaluate normalized metadata into ordinary tools, with account-specific security filtering. */
import { Effect, JsonPointer, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import {
  OpenapiError,
  OpenapiToolsOptions,
  type OpenapiTools,
  type OpenapiOperation,
  type OpenapiParameterDefaults,
} from "../contracts/openapi.ts";
import type { JsonObject, JsonValue } from "../contracts/schema.ts";
import { lazyJsonSchemaDecoder, once } from "./schema.ts";
import { createRequest } from "./openapi-request.ts";

/** Names of shared definitions a JSON value references directly as `#/$defs/<name>`. */
export function references(value: JsonValue, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) references(item, found);
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (key !== "$ref" || typeof item !== "string") references(item, found);
      else {
        const path = item.startsWith("#/$defs/") ? JsonPointer.parseUriFragment(item) : undefined;
        if (path?.[1] !== undefined) found.add(path[1]);
      }
    }
  return found;
}

/**
 * Make a schema self-contained with only the shared definitions it reaches. Cycles stay
 * references to the same definition. A missing definition stays unresolved and fails when
 * the schema compiles. The schema's own `$defs` keep precedence.
 */
export const bundler = (definitions: Readonly<Record<string, JsonObject>>) => {
  const direct = new Map<string, ReadonlySet<string>>();
  return (schema: JsonObject): JsonObject => {
    const reached = new Map<string, JsonObject>();
    const pending = [...references(schema)];
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
      if (definition === undefined || reached.has(name)) continue;
      reached.set(name, definition);
      let names = direct.get(name);
      if (names === undefined) direct.set(name, (names = references(definition)));
      pending.push(...names);
    }
    if (reached.size === 0) return schema;
    const own = schema.$defs;
    return {
      ...schema,
      $defs: {
        ...Object.fromEntries(reached),
        ...(own !== null && typeof own === "object" && !Array.isArray(own) ? own : {}),
      },
    };
  };
};

const parameterGroups = { path: "path", query: "query", headers: "header" } as const;
const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Defaults for parameters this operation declares; other names never enter its input. */
const boundParameters = (op: OpenapiOperation, defaults: OpenapiParameterDefaults | undefined) =>
  (Object.keys(parameterGroups) as (keyof typeof parameterGroups)[]).flatMap((group) =>
    Object.entries(defaults?.[group] ?? {})
      .filter(([name]) =>
        op.request.parameters.some((p) => p.name === name && p.in === parameterGroups[group]),
      )
      .map(([name, value]) => ({ group, name, value })),
  );

/**
 * Make account-bound parameters optional. Validators omit the values so they stay account-free;
 * the published schema includes them as `default` so callers can see what an omission sends.
 */
export const parameterDefaultsInput = (
  op: OpenapiOperation,
  defaults: OpenapiParameterDefaults | undefined,
  publish: boolean,
): JsonObject => {
  const bound = boundParameters(op, defaults);
  if (!bound.length || !isObject(op.input.properties)) return op.input;
  const properties: Record<string, JsonValue> = { ...op.input.properties };
  let required = Array.isArray(op.input.required) ? op.input.required : [];
  for (const group of new Set(bound.map((entry) => entry.group))) {
    const shape = properties[group];
    if (!isObject(shape)) continue;
    const names = bound.filter((entry) => entry.group === group);
    const remaining = (Array.isArray(shape.required) ? shape.required : []).filter(
      (name) => !names.some((entry) => entry.name === name),
    );
    const fields = isObject(shape.properties) ? shape.properties : {};
    properties[group] = {
      ...shape,
      required: remaining,
      ...(publish
        ? {
            properties: {
              ...fields,
              ...Object.fromEntries(
                names.map(({ name, value }) => {
                  const field = isObject(fields[name]) ? fields[name] : {};
                  const note = "Optional; defaults to the value bound to the selected account.";
                  const description =
                    typeof field.description === "string" ? `${field.description} ${note}` : note;
                  return [name, { ...field, description, default: value }];
                }),
              ),
            },
          }
        : {}),
    };
    if (!remaining.length) required = required.filter((key) => key !== group);
  }
  return { ...op.input, properties, required };
};

/** Fill omitted account-bound parameters before validation. Explicit values are kept. */
const fillParameterDefaults = (
  op: OpenapiOperation,
  defaults: OpenapiParameterDefaults | undefined,
  value: unknown,
) => {
  const bound = boundParameters(op, defaults);
  if (!bound.length || !isObject(value)) return value;
  const result: Record<string, JsonValue> = { ...value };
  for (const { group, name, value: fallback } of bound) {
    const current = result[group] ?? {};
    if (!isObject(current)) return value;
    if (!Object.hasOwn(current, name)) result[group] = { ...current, [name]: fallback };
  }
  return result;
};

/** Account-free validators can be reused inside a Worker for one immutable revision. */
export const prepareOpenapiOperation = (
  op: OpenapiOperation,
  definitions: Readonly<Record<string, JsonObject>>,
  defaults?: OpenapiParameterDefaults,
) =>
  Effect.gen(function* () {
    const bundle = bundler(definitions);
    const input = yield* lazyJsonSchemaDecoder(() =>
      bundle(parameterDefaultsInput(op, defaults, false)),
    );
    const errors = yield* Effect.forEach(op.errorResponses ?? [], (response) =>
      lazyJsonSchemaDecoder(() => bundle(response.schema)).pipe(
        Effect.map((decoder) => ({ ...response, decoder })),
      ),
    );
    return {
      input,
      errors,
      output: once(() => (op.outputSchema === undefined ? undefined : bundle(op.outputSchema))),
    };
  });
export type PreparedOpenapiOperation = Effect.Success<ReturnType<typeof prepareOpenapiOperation>>;

/** Decode retained metadata and expose only operations supported by the selected account. */
export const openapiToolsEffect = (
  options: OpenapiToolsOptions,
  prepared?: ReadonlyMap<string, PreparedOpenapiOperation>,
): Effect.Effect<OpenapiTools, OpenapiError> =>
  Effect.gen(function* () {
    const config = yield* Schema.decodeUnknownEffect(OpenapiToolsOptions)(options).pipe(
      Effect.mapError(() => new OpenapiError({ reason: "invalid_definition" })),
    );
    const request = createRequest(config);
    const entries = yield* Effect.forEach(
      config.operations.filter((op) => request.available(op, config.account)),
      (op) =>
        Effect.gen(function* () {
          const schemas =
            prepared?.get(op.name) ??
            (yield* prepareOpenapiOperation(
              op,
              config.definitions ?? {},
              config.parameterDefaults,
            ));
          const { input, errors } = schemas;
          const tool: OpenapiTools[string] = {
            description: op.description,
            readOnly: ["GET", "HEAD", "OPTIONS"].includes(op.method),
            input,
            run: (_context, value) =>
              Schema.decodeUnknownEffect(input)(
                fillParameterDefaults(op, config.parameterDefaults, value),
              ).pipe(
                Effect.mapError(() => new OpenapiError({ reason: "invalid_input" })),
                Effect.flatMap((parsed) =>
                  request
                    .call(op, parsed, config.account, errors)
                    .pipe(
                      Effect.provideService(
                        FetchHttpClient.Fetch,
                        config.fetch ?? globalThis.fetch,
                      ),
                    ),
                ),
              ),
          };
          const output = op.outputSchema;
          if (output !== undefined)
            Object.defineProperty(tool, "outputSchema", {
              enumerable: true,
              get: schemas.output,
            });
          return [op.name, tool] as const;
        }),
    );
    return Object.fromEntries(entries);
  });
