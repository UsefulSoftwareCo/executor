/** Deterministic provider identity and validation of serialized field declarations. */
import { type Crypto, Effect, JsonSchema, Redacted, Schema, SchemaRepresentation } from "effect";
import { Hex } from "effect/encoding";
import type { HostAccount } from "apps/contracts";
import { AccountFieldsInvalid } from "../contracts/account.ts";
import type {
  FirstPartyOAuthClient,
  FirstPartyOAuthClientId,
  ManagedPlacement,
} from "../contracts/oauth.ts";
import type { StoredAccount } from "../contracts/storage.ts";
import { intersectCredentialHosts } from "./credential-handles.ts";
import { AuthMethodInvalid, ProviderDefinition } from "../contracts/provider.ts";
import { ProviderId, StorageError, type Json } from "../contracts/shared.ts";
import { JsonObject } from "../contracts/shared.ts";

/** JSON with object keys sorted, so equal definitions compare equal regardless of key order. */
export function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** JSON Schema keywords whose value is one schema, or a list of them for `items` before 2020-12. */
const subschema = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contains",
  "propertyNames",
  "contentSchema",
  "not",
  "if",
  "then",
  "else",
]);
/** Keywords whose value lists schemas. */
const subschemaLists = new Set(["prefixItems", "allOf", "anyOf", "oneOf"]);
/** Keywords whose value maps names, such as field names, to schemas, or to lists of names. */
const subschemaMaps = new Set([
  "properties",
  "dependencies",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
]);

/**
 * A field schema without the `title` and `description` forms show. Only annotations at schema
 * positions go, so a field named `title` or `description` stays, as do types, formats, `required`
 * and every other keyword that decides what a value is.
 */
const withoutDisplayText = (schema: Json): Json => {
  if (schema === null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(withoutDisplayText);
  return Object.fromEntries(
    Object.entries(schema).flatMap(([keyword, value]): Array<[string, Json]> => {
      if (keyword === "title" || keyword === "description") return [];
      if (subschema.has(keyword) || subschemaLists.has(keyword))
        return [[keyword, withoutDisplayText(value)]];
      if (subschemaMaps.has(keyword) && value !== null && typeof value === "object")
        return [
          [
            keyword,
            Array.isArray(value)
              ? value
              : Object.fromEntries(
                  Object.entries(value).map(([name, item]) => [name, withoutDisplayText(item)]),
                ),
          ],
        ];
      return [[keyword, value]];
    }),
  );
};

/**
 * A method without the text forms show: a secrets method's `label`, and the `title` and
 * `description` of its fields. What remains decides how the credential is obtained and used.
 */
export const methodCredential = (method: ProviderDefinition["auth"][string]) => {
  if (method.type !== "secrets") return method;
  const { label: _label, fields, ...credential } = method;
  return { ...credential, fields: withoutDisplayText(fields) };
};

const withoutDisplay = (shared: Omit<ProviderDefinition, "hosts">) => ({
  ...shared,
  auth: Object.fromEntries(
    Object.entries(shared.auth).map(([name, method]) => [name, methodCredential(method)]),
  ),
});

const contentId = (value: unknown, crypto: Crypto.Crypto) =>
  Effect.gen(function* () {
    const content = yield* Schema.decodeUnknownEffect(JsonObject)(value).pipe(
      Effect.mapError(() => new StorageError()),
    );
    const hash = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(canonical(content)))
      .pipe(Effect.mapError(() => new StorageError()));
    return ProviderId.make(`prv_${Hex.encode(hash)}`);
  });

/**
 * Equal JSON definitions, regardless of object key order, share a content-derived identity.
 * Declared hosts are not part of it: each account records the hosts it was connected for, so an
 * app that declares other hosts still fills the slot, but sends credentials only where both allow.
 * Display text is not part of it either (see `methodCredential`), so rewording a form keeps the
 * provider and its accounts. `shared` is the definition every app with this identity agrees on,
 * without hosts; its display text is the last deploy's, so forms read it from the app version's
 * own definition.
 *
 * `identity` is the ID a provider first stored now gets. `legacy` is the ID earlier versions
 * derived, display text included; a provider stored then keeps that ID. A deploy chooses the ID by
 * identity: see `chooseProviderIds` in apps.ts.
 */
export const identifyProvider = (definition: ProviderDefinition, crypto: Crypto.Crypto) =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(ProviderDefinition)(definition).pipe(
      Effect.mapError(() => new StorageError()),
    );
    const { hosts: _hosts, ...shared } = parsed;
    const identity = yield* contentId(withoutDisplay(shared), crypto);
    const legacy = yield* contentId(shared, crypto);
    return { identity, legacy, definition: parsed, shared };
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

/** The operator's placement of a managed access token, as the outbound fills it. */
export const managedPlacement = (placement: ManagedPlacement) => {
  const name = placement.header ?? "authorization";
  const scheme =
    placement.scheme === undefined
      ? name === "authorization"
        ? "Bearer"
        : null
      : placement.scheme;
  return [
    {
      in: "header" as const,
      name,
      value:
        scheme === null ? [{ field: "access_token" }] : [`${scheme} `, { field: "access_token" }],
    },
  ];
};

/**
 * Where a managed account's token may go in one app: the operator's placement, and only to the
 * operator's pinned hosts that are also among the hosts the app declares and the account was
 * connected for. An app that declares no hosts reaches none. The method's own placements are
 * replaced; `plain()` and `raw()` stay, as the provider's identity, and the runner ignores them.
 * Without the operator's client, because the operator removed it, there are no hosts and no
 * placements, so nothing is sent.
 */
export const managedDefinition = (
  definition: ProviderDefinition,
  account: Pick<StoredAccount, "method" | "allowedHosts">,
  client: FirstPartyOAuthClient | undefined,
): ProviderDefinition => {
  const { hosts: declared, ...shared } = definition;
  const app = declared ?? [];
  const connected =
    account.allowedHosts === null ? app : intersectCredentialHosts(account.allowedHosts, app);
  const hosts = intersectCredentialHosts(connected, client?.placement.hosts ?? []);
  const method = Object.hasOwn(shared.auth, account.method)
    ? shared.auth[account.method]
    : undefined;
  if (method === undefined) return { ...shared, hosts };
  const request = client === undefined ? [] : managedPlacement(client.placement);
  return { ...shared, hosts, auth: { ...shared.auth, [account.method]: { ...method, request } } };
};

/**
 * One account's credential as it was resolved. Its values, the operator client that issued it,
 * and its generation are read together from the stored credential, so they always describe the
 * same credential, even when a reconnect replaced the account's credential after the invocation
 * selected the account.
 */
export interface AccountCredential {
  readonly fields: Redacted.Redacted<JsonObject>;
  /** The operator's OAuth client that issued it, when it is managed. */
  readonly firstParty: FirstPartyOAuthClientId | undefined;
  readonly generation: number;
}

/**
 * The account as an invocation sends it to the runner. A credential the user brought carries the
 * hosts granted to it. A managed credential carries the operator's placement and hosts, and the
 * mark that has the runner seal all of it.
 */
export const invocationAccount = (
  account: Pick<StoredAccount, "id" | "method" | "allowedHosts">,
  definition: ProviderDefinition,
  credential: AccountCredential,
  clients: ReadonlyMap<string, FirstPartyOAuthClient>,
): HostAccount => {
  const bound = {
    id: account.id,
    method: account.method,
    generation: credential.generation,
    fields: Redacted.value(credential.fields),
  };
  if (credential.firstParty === undefined)
    return { ...bound, provider: grantedDefinition(definition, account.allowedHosts) };
  return {
    ...bound,
    provider: managedDefinition(definition, account, clients.get(credential.firstParty)),
    managed: true,
  };
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
