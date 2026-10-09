/** Deterministic provider identity and validation of serialized field declarations. */
import { type Crypto, Effect, JsonSchema, Redacted, Schema, SchemaRepresentation } from "effect";
import { Hex } from "effect/encoding";
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

/**
 * Equal JSON definitions, regardless of object key order, share a content-derived ID. Declared
 * hosts are not part of it: each account records the hosts it was connected for, so an app that
 * declares other hosts still fills the slot, but sends credentials only where both allow.
 * `shared` is the definition every app with this ID agrees on, without hosts.
 */
export const identifyProvider = (definition: ProviderDefinition, crypto: Crypto.Crypto) =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(ProviderDefinition)(definition).pipe(
      Effect.mapError(() => new StorageError()),
    );
    const { hosts: _hosts, ...shared } = parsed;
    const content = yield* Schema.decodeUnknownEffect(JsonObject)(shared).pipe(
      Effect.mapError(() => new StorageError()),
    );
    const hash = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(canonical(content)))
      .pipe(Effect.mapError(() => new StorageError()));
    return { id: ProviderId.make(`prv_${Hex.encode(hash)}`), definition: parsed, shared };
  });

/**
 * Where an account's secret values may go in one app: the hosts the account was connected for,
 * narrowed to the hosts the app declares. An account connected without hosts allows whatever the
 * app declares; an app that declares none still sends only to the account's hosts. Undefined only
 * when neither restricts, and app code then reads real values.
 */
export const grantedHosts = (
  account: readonly string[] | null,
  declared: readonly string[] | undefined,
): readonly string[] | undefined => {
  if (account === null) return declared;
  if (declared === undefined) return account;
  const allowed = new Set(declared);
  return account.filter((host) => allowed.has(host));
};

/** The definition an invocation sends for one account, carrying that account's granted hosts. */
export const grantedDefinition = (
  definition: ProviderDefinition,
  account: readonly string[] | null,
): ProviderDefinition => {
  const { hosts: declared, ...shared } = definition;
  const hosts = grantedHosts(account, declared);
  return hosts === undefined ? shared : { ...shared, hosts };
};

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
