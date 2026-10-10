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
