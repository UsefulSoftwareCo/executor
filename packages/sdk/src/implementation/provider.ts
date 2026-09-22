/** Deterministic provider identity and validation of serialized field declarations. */
import {
  type Crypto,
  Effect,
  Encoding,
  JsonSchema,
  Redacted,
  Schema,
  SchemaRepresentation,
} from "effect";
import { AccountFieldsInvalid } from "../contracts/account.ts";
import { AuthMethodInvalid, ProviderDefinition } from "../contracts/provider.ts";
import { ProviderId, StorageError, type Json } from "../contracts/shared.ts";
import { JsonObject } from "../contracts/shared.ts";

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Equal JSON definitions, regardless of object key order, share a content-derived ID. */
export const identifyProvider = (definition: ProviderDefinition, crypto: Crypto.Crypto) =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(ProviderDefinition)(definition).pipe(
      Effect.mapError(() => new StorageError()),
    );
    const content = yield* Schema.decodeUnknownEffect(JsonObject)(parsed).pipe(
      Effect.mapError(() => new StorageError()),
    );
    const hash = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(canonical(content)))
      .pipe(Effect.mapError(() => new StorageError()));
    return { id: ProviderId.make(`prv_${Encoding.encodeHex(hash)}`), definition: parsed };
  });

/** Validate submitted secrets against the saved provider declaration; native app decoding still runs at invocation. */
export const validateFields = (
  provider: ProviderId,
  definition: ProviderDefinition,
  method: string,
  fields: Redacted.Redacted<JsonObject>,
) =>
  Effect.gen(function* () {
    const auth = Object.hasOwn(definition.auth, method) ? definition.auth[method] : undefined;
    if (auth === undefined || auth.type !== "secrets")
      return yield* Effect.fail(new AuthMethodInvalid({ provider, method }));
    const invalid = new AccountFieldsInvalid({ provider, method });
    const decoder = yield* Effect.try({
      try: () =>
        Schema.toType(
          SchemaRepresentation.fromJsonSchemaDocument(
            JsonSchema.fromSchemaDraft2020_12(auth.fields),
          ),
        ),
      catch: () => invalid,
    });
    yield* Schema.decodeUnknownEffect(decoder)(Redacted.value(fields)).pipe(
      Effect.mapError(() => invalid),
    );
    return fields;
  });
