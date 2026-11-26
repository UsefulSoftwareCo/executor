import { Effect, Redacted, Result, Schema } from "effect";
import { SqlError } from "effect/sql";
import type { OAuthClientId } from "../contracts/oauth.ts";
import { type OwnerId, type ProviderId, StorageError } from "../contracts/shared.ts";
import type { Credentials } from "../contracts/storage.ts";
import { query, type Query } from "./database.ts";
import type { CredentialsWithdrawal } from "./storage-schema.ts";

export interface ClientCredentials {
  readonly owner: OwnerId;
  readonly issuer: string;
  readonly clientId: string;
  readonly secret: string | undefined;
}

export const credentialsDigest = (credentials: Credentials, input: ClientCredentials) =>
  credentials.fingerprint(
    "oauth client credentials by issuer",
    Redacted.make(
      JSON.stringify([input.owner, input.issuer, input.clientId, input.secret ?? null]),
    ),
  );

export const legacyCredentialsDigest = (
  credentials: Credentials,
  input: Omit<ClientCredentials, "issuer"> & { readonly provider: ProviderId },
) =>
  credentials.fingerprint(
    "oauth client credentials",
    Redacted.make(
      JSON.stringify([input.owner, input.provider, input.clientId, input.secret ?? null]),
    ),
  );

export const credentialsOwner = (store: Query, digest: string) =>
  Effect.gen(function* () {
    const entry = yield* query(() =>
      store.findFirst("storedOAuthClientCredentials", { where: (b) => b("id", "=", digest) }),
    );
    if (entry === null) return undefined;
    const row = yield* query(() =>
      store.findFirst("storedOAuthClients", { where: (b) => b("id", "=", entry.client) }),
    );
    return row === null
      ? ({ kind: "withdrawn", client: entry.client, withdrawal: entry.withdrawal } as const)
      : ({ kind: "held", row } as const);
  });

export const claimCredentials = (
  store: Query,
  input: {
    readonly digest: string;
    readonly owner: OwnerId;
    readonly provider?: ProviderId | null | undefined;
    readonly client: OAuthClientId;
    readonly createdAt: Date;
    readonly reclaim: boolean;
  },
): Effect.Effect<OAuthClientId | undefined, StorageError> =>
  Effect.gen(function* () {
    const found = yield* credentialsOwner(store, input.digest);
    if (found === undefined) {
      const inserted = yield* store
        .transaction(
          store.create("storedOAuthClientCredentials", {
            id: input.digest,
            owner: input.owner,
            provider: input.provider ?? null,
            client: input.client,
            createdAt: input.createdAt,
          }),
        )
        .pipe(Effect.result);
      if (Result.isSuccess(inserted)) return undefined;
      if (!isUniqueViolation(inserted.failure)) return yield* new StorageError();
      return yield* claimCredentials(store, input);
    }
    if (found.kind === "held") return found.row.id === input.client ? undefined : found.row.id;
    if (!input.reclaim) return found.client;
    yield* query(() =>
      store.updateMany("storedOAuthClientCredentials", {
        where: (b) => b.and(b("id", "=", input.digest), b("client", "=", found.client)),
        set: { client: input.client, withdrawal: null, createdAt: input.createdAt },
      }),
    );
    const claimed = yield* query(() =>
      store.findFirst("storedOAuthClientCredentials", { where: (b) => b("id", "=", input.digest) }),
    );
    if (claimed?.client === input.client) return undefined;
    return yield* claimCredentials(store, input);
  });

export const withdrawCredentials = (
  store: Query,
  client: OAuthClientId,
  withdrawal: typeof CredentialsWithdrawal.Type,
) =>
  query(() =>
    store.updateMany("storedOAuthClientCredentials", {
      where: (b) =>
        withdrawal === "removed"
          ? b("client", "=", client)
          : b.and(b("client", "=", client), b("withdrawal", "is", null)),
      set: { withdrawal },
    }),
  );

const isUniqueViolation = (error: unknown) =>
  SqlError.isSqlError(error) && Schema.is(SqlError.UniqueViolation)(error.reason);

export const oauthClientIssuer = (server: {
  readonly issuer: string;
  readonly issuer_derived?: true | undefined;
  readonly token_endpoint: string;
}) => (server.issuer_derived === true ? server.token_endpoint : server.issuer);

export const registeredClientKey = <E>(
  hash: (value: string) => Effect.Effect<string, E>,
  input: {
    readonly owner: OwnerId;
    readonly issuer: string;
    readonly callback: string | undefined;
    readonly scopes: ReadonlyArray<string>;
    readonly tokenEndpointAuthMethod: string;
    readonly grantTypes: ReadonlyArray<string>;
  },
) =>
  hash(
    JSON.stringify([
      "registered",
      input.owner,
      input.issuer,
      input.callback ?? null,
      [...new Set(input.scopes)].sort(),
      input.tokenEndpointAuthMethod,
      [...input.grantTypes].sort(),
    ]),
  );
