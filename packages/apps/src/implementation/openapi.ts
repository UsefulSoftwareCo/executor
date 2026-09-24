/** Evaluate normalized metadata into ordinary tools, with account-specific security filtering. */
import { Effect, JsonPointer, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import {
  OpenapiError,
  OpenapiToolsOptions,
  type OpenapiTools,
  type OpenapiOperation,
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

/** Account-free validators can be reused inside a Worker for one immutable revision. */
export const prepareOpenapiOperation = (
  op: OpenapiOperation,
  definitions: Readonly<Record<string, JsonObject>>,
) =>
  Effect.gen(function* () {
    const bundle = bundler(definitions);
    const input = yield* lazyJsonSchemaDecoder(() => bundle(op.input));
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
            (yield* prepareOpenapiOperation(op, config.definitions ?? {}));
          const { input, errors } = schemas;
          const tool: OpenapiTools[string] = {
            description: op.description,
            readOnly: ["GET", "HEAD", "OPTIONS"].includes(op.method),
            input,
            run: (_context, value) =>
              Schema.decodeUnknownEffect(input)(value).pipe(
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
