/**
 * A stored client's credentials are its owner, authorization server (issuer), client ID and secret
 * (none for a public client). They have one identity per owner and issuer, a keyed digest,
 * recorded in `executor_stored_oauth_client_credentials` for every set of credentials a client
 * holds or held. So credentials read from anywhere, a grant's copy, a connect form or an attempt,
 * resolve to exactly one stored client, or to none, by an indexed lookup that compares no secret.
 *
 * Rows written before 4.0.12 digest owner, provider, client ID and secret instead. Data step
 * `8_oauth_clients_by_issuer` records each existing client's current credentials under the new
 * identity, but a row for credentials a client held before an edit, or held before it was removed,
 * holds only its digest, so it cannot be recomputed. A sign-in therefore also looks its
 * credentials up under that earlier identity for its own provider (`legacyCredentialsDigest`), so
 * those credentials keep resolving to their client, or stay withdrawn.
 */
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

/** The credentials' identity under this host's key. */
export const credentialsDigest = (credentials: Credentials, input: ClientCredentials) =>
  credentials.fingerprint(
    "oauth client credentials by issuer",
    Redacted.make(
      JSON.stringify([input.owner, input.issuer, input.clientId, input.secret ?? null]),
    ),
  );

/** The identity rows written before 4.0.12 have: owner, provider, client ID and secret. */
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

/**
 * Who the credentials belong to: the stored client holding them now or before an edit, a client
 * since gone (`withdrawn`, with why), or nobody.
 */
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

/**
 * Record that a client holds the credentials, in the caller's transaction. Credentials another
 * existing client holds, now or before an edit, are refused with that client's ID. Those of a
 * removed client pass to this one when `reclaim` allows it, since it is registered with them
 * again; otherwise they are refused with the removed client's ID.
 *
 * Concurrent claims of the same credentials have one winner. A first claim inserts the row in a
 * savepoint, so a racing insert's primary-key conflict leaves the caller's transaction usable,
 * and a reclaim moves the row only from the removed client it read. Either way the loser reads
 * the row again once the winner has committed, and is refused with the winner's ID.
 */
export const claimCredentials = (
  store: Query,
  input: {
    readonly digest: string;
    readonly owner: OwnerId;
    /** Only data step `6_stored_oauth_clients` writes rows under the pre-4.0.12 identity. */
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

/**
 * Record why a client no longer holds its credentials, after its row was deleted in the caller's
 * transaction. A removal by a person always wins: it is recorded over any earlier reason, so a
 * pending sign-in with the client fails closed. Executor's own discards record theirs only when
 * no reason is recorded yet, so a discard racing a removal never records over it.
 */
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

/**
 * The authorization server a client belongs to: the issuer discovery found or the provider
 * declared, or, when the provider declares endpoints without an issuer, its token endpoint URL.
 * Executor records a derived issuer (the token URL's origin) for such a server, but one origin can
 * host several servers, such as one per realm or tenant, whose clients are not interchangeable.
 */
export const oauthClientIssuer = (server: {
  readonly issuer: string;
  readonly issuer_derived?: true | undefined;
  readonly token_endpoint: string;
}) => (server.issuer_derived === true ? server.token_endpoint : server.issuer);

/**
 * The key a registered client is found again by: what its registration request asked for. See
 * `automaticKey` in the sign-in for why these settings and no others.
 */
export const registeredClientKey = <E>(
  hash: (value: string) => Effect.Effect<string, E>,
  input: {
    readonly owner: OwnerId;
    readonly issuer: string;
    readonly callback: string | undefined;
    readonly scopes: ReadonlyArray<string>;
    /** The client authentication the registration requested (`token_endpoint_auth_method`). */
    readonly tokenEndpointAuthMethod: string;
    /** The grants it requested (`grant_types`). */
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
