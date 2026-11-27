import { Effect, JsonSchema, Redacted, Schema, SchemaRepresentation } from "effect";
import type { HostCrypto } from "./host-crypto.ts";
import { Digest } from "effect/crypto";
import { Hex } from "effect/encoding";
import { type HostAccount, withoutHelp } from "apps/contracts";
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

export const identifyProvider = (definition: ProviderDefinition, crypto: HostCrypto) =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(ProviderDefinition)(definition).pipe(
      Effect.mapError(() => new StorageError()),
    );
    const { hosts: _hosts, ...shared } = withoutHelp(parsed);
    const auth = Object.fromEntries(
      Object.entries(shared.auth).map(([name, method]) => {
        if (method.type !== "oauth2" || method.grant === "client_credentials")
          return [name, method];
        const { identity: _identity, ...compatible } = method;
        return [name, compatible];
      }),
    );
    const content = yield* Schema.decodeUnknownEffect(JsonObject)({ ...shared, auth }).pipe(
      Effect.mapError(() => new StorageError()),
    );
    const hash = yield* crypto.digest.digest(
      Digest.sha256,
      new TextEncoder().encode(canonical(content)),
    );
    return { id: ProviderId.make(`prv_${Hex.encode(hash)}`), definition: parsed, shared };
  });

export const grantedHosts = (
  account: readonly string[] | null,
  declared: readonly string[] | undefined,
): readonly string[] | undefined => {
  if (account === null) return declared;
  if (declared === undefined) return account;
  const allowed = new Set(declared);
  return account.filter((host) => allowed.has(host));
};

export const grantedDefinition = (
  definition: ProviderDefinition,
  account: readonly string[] | null,
): ProviderDefinition => {
  const { hosts: declared, ...shared } = definition;
  const hosts = grantedHosts(account, declared);
  return hosts === undefined ? shared : { ...shared, hosts };
};

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

export interface AccountCredential {
  readonly fields: Redacted.Redacted<JsonObject>;
  readonly firstParty: FirstPartyOAuthClientId | undefined;
  readonly generation: number;
}

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
