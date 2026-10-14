/**
 * Moves the saved clients of versions before 4.0.10 into stored OAuth clients, once, through a data
 * step. A saved client was keyed by a digest of its owner, provider, method, callback, issuer and
 * scopes, and its record held only the registration, so neither its owner nor its provider can be
 * read from it. Both come from the accounts whose grants hold the same client: a saved client no
 * account signed in with is not moved, and one that accounts of several owners hold is reported
 * rather than guessed, with why: how many owners and providers hold it, whether it has a secret,
 * how it was saved, and whether exactly one holder's settings reproduce its key. Saved records and
 * grants are never changed: a grant keeps its own copy of
 * the client, and a sign-in using credentials a stored client holds uses that client, so a
 * reconnect keeps the client and the callback it was registered at, under the host's policy for
 * it, without the grant naming it.
 */
import { Clock, type Crypto, Data, Effect, Option, Redacted, Schema } from "effect";
import { Hex } from "effect/encoding";
import {
  OAuthClientAuth,
  OAuthClientId,
  OAuthClientSource,
  OAuthGrant,
  OAuthRegistration,
  isFirstPartyGrant,
  type OAuthServer,
} from "../contracts/oauth.ts";
import {
  OAuthClient,
  type ClientIssuerOutcome,
  type SavedClientByIssuerOutcome,
  type SavedClientOutcome,
  type SavedOAuthClients,
} from "../contracts/oauth-clients.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import { Provider } from "../contracts/provider.ts";
import {
  AccountId,
  CredentialsError,
  JsonObject,
  OwnerId,
  ProviderId,
  StorageError,
} from "../contracts/shared.ts";
import type { Credentials } from "../contracts/storage.ts";
import { query, transaction, type Query } from "./database.ts";
import { preferredClientMethod, registrationGrantTypes } from "./oauth-protocol.ts";
import {
  claimCredentials,
  credentialsDigest,
  credentialsOwner,
  legacyCredentialsDigest,
  oauthClientIssuer,
  registeredClientKey,
} from "./stored-oauth-client-credentials.ts";

/** A stored client's encrypted part, as the client store writes it. */
const StoredClientSecret = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.optional(Schema.NonEmptyString),
  token_endpoint_auth_method: Schema.optional(OAuthClientAuth),
});

/** Read beside the registration from a saved record, once sources were recorded. */
const SavedClientSource = Schema.Struct({ executor_source: Schema.optionalKey(OAuthClientSource) });

interface Holder {
  readonly account: AccountId;
  readonly owner: OwnerId;
  readonly provider: ProviderId;
  readonly secret: string | undefined;
  readonly machine: boolean;
  /** What a saved key was made from, as far as the account and its grant still say. */
  readonly method: string;
  /** The issuer the grant recorded, derived from the token URL for declared endpoints. */
  readonly issuer: string;
  /** The authorization server it signed in at, as stored clients name it (`oauthClientIssuer`). */
  readonly identity: string;
  /** The stored client the grant names, when a 4.0.10 or later sign-in recorded it. */
  readonly oauthClient: OAuthClientId | undefined;
  /** What the server's metadata said, which chose what a registration requested. */
  readonly metadata: Pick<
    OAuthServer,
    "token_endpoint_auth_methods_supported" | "grant_types_supported"
  >;
  /** The scopes granted, when the account's fields keep the token response's `scope`. */
  readonly granted: ReadonlyArray<string> | undefined;
}

/** A saved client whose holders span several owners or providers. */
interface Ambiguous {
  readonly ambiguous: {
    readonly browser: ReadonlyArray<Holder>;
    readonly secret: boolean;
    readonly source: "registered" | "manual" | "metadata" | "unrecorded";
  };
}

/** Settings a key from before 4.0.12 may have been made from. */
interface KeyCandidate {
  readonly owner: OwnerId;
  readonly provider: ProviderId;
  readonly method: string;
  /** The issuer as the sign-in recorded it, derived from the token URL for declared endpoints. */
  readonly issuer: string;
  /** The same server as stored clients name it. */
  readonly identity: string;
  /** What a registration from these settings requested besides callback and scopes. */
  readonly registration: {
    readonly tokenEndpointAuthMethod: string;
    readonly grantTypes: ReadonlyArray<string>;
  };
  /** Scope lists the sign-in may have requested, besides none. */
  readonly scopes: ReadonlyArray<ReadonlyArray<string>>;
}

const decodeStored = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => new StorageError()));

export const makeSavedOAuthClients = (
  db: Query,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  lifecycle: ResourceLifecycle | undefined,
  /** Callbacks the host sent when saving clients, tried when reading which owner a key names. */
  callbacks: ReadonlyArray<string>,
): SavedOAuthClients => {
  const decrypt = <A>(
    identity: AccountId | OAuthClientId,
    bytes: Uint8Array,
    schema: Schema.Decoder<A>,
  ) =>
    credentials
      .decrypt(identity, Redacted.make(bytes))
      .pipe(Effect.flatMap((value) => decodeStored(schema, Redacted.value(value))));
  const encrypt = (identity: AccountId | OAuthClientId, value: unknown) =>
    decodeStored(JsonObject, value).pipe(
      Effect.flatMap((json) => credentials.encrypt(identity, Redacted.make(json))),
    );

  /** Who holds each client ID: every account whose grant signed in with it. */
  const holders = Effect.gen(function* () {
    const accounts = new Map(
      (yield* query(() =>
        db.findMany("accounts", { select: ["id", "owner", "provider", "method"] }),
      )).map((account) => [account.id, account] as const),
    );
    const byClient = new Map<string, Holder[]>();
    for (const row of yield* query(() => db.findMany("oauthGrants", {}))) {
      const account = accounts.get(AccountId.make(row.id));
      if (account === undefined) continue;
      const grant = yield* decrypt(account.id, row.encrypted, OAuthGrant).pipe(Effect.option);
      if (Option.isNone(grant) || isFirstPartyGrant(grant.value)) continue;
      const { client, server, fields } = grant.value;
      const list = byClient.get(client.client_id) ?? [];
      list.push({
        account: account.id,
        owner: account.owner,
        provider: account.provider,
        secret: client.token_endpoint_auth_method === "none" ? undefined : client.client_secret,
        machine: grant.value.grant === "client_credentials",
        method: account.method,
        issuer: server.issuer,
        identity: oauthClientIssuer(server),
        oauthClient: "oauthClient" in grant.value ? grant.value.oauthClient : undefined,
        metadata: {
          ...(server.token_endpoint_auth_methods_supported === undefined
            ? {}
            : {
                token_endpoint_auth_methods_supported: server.token_endpoint_auth_methods_supported,
              }),
          ...(server.grant_types_supported === undefined
            ? {}
            : { grant_types_supported: server.grant_types_supported }),
        },
        granted:
          typeof fields.scope === "string"
            ? fields.scope.split(/[\s,]+/).filter((scope) => scope !== "")
            : undefined,
      });
      byClient.set(client.client_id, list);
    }
    return byClient;
  });

  /** Where a saved client moves, read again for every report and move. */
  const analyse = (id: string, byClient: ReadonlyMap<string, ReadonlyArray<Holder>>) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        db.findFirst("oauthClients", { where: (b) => b("id", "=", id) }),
      );
      if (row === null) return "absent" as const;
      if (!id.startsWith("client_")) return "unreadable" as const;
      const identity = OAuthClientId.make(id);
      const read = yield* Effect.all([
        decrypt(identity, row.encrypted, OAuthRegistration),
        decrypt(identity, row.encrypted, SavedClientSource),
      ]).pipe(Effect.option);
      if (Option.isNone(read)) return "unreadable" as const;
      const [client, { executor_source }] = read.value;
      const secret =
        client.token_endpoint_auth_method === "none" ? undefined : client.client_secret;
      const held = (byClient.get(client.client_id) ?? []).filter(
        (holder) => holder.secret === secret,
      );
      if (held.length === 0) return "no_account" as const;
      // A machine client is the account itself; its grant keeps it.
      const browser = held.filter((holder) => !holder.machine);
      const holder = browser[0];
      if (holder === undefined) return "machine_client" as const;
      if (new Set(browser.map((found) => `${found.owner}\n${found.provider}`)).size !== 1)
        return {
          ambiguous: {
            browser,
            secret: secret !== undefined,
            source: executor_source ?? "unrecorded",
          },
        } satisfies Ambiguous;
      const key = id.slice("client_".length);
      // Before sources were recorded a record has none; it is kept as entered, never discarded.
      const source = executor_source === "registered" ? "registered" : "manual";
      // Every record moves to a client of its own key. Records saved under several settings with
      // the same credentials are one client: the first moved holds them and the rest are
      // duplicates. Records with different secrets for one client ID are different credentials,
      // so each is its own client, and a grant holding either resolves to the client holding it.
      const target = OAuthClientId.make(`oac_${key}`);
      // The identity credentials had before 4.0.12: this step's outcomes never change, so it
      // still moves records as 4.0.10 did, and `8_oauth_clients_by_issuer` records their server.
      const digest = yield* legacyCredentialsDigest(credentials, {
        owner: holder.owner,
        provider: holder.provider,
        clientId: client.client_id,
        secret,
      });
      return { key, client, secret, source, holder, target, digest } as const;
    });

  const sha256 = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(() => new StorageError()),
    );

  /** Callbacks the host sent, as sign-ins wrote them into keys. */
  const hrefs = [
    ...new Set(
      callbacks.flatMap((callback) => (URL.canParse(callback) ? [new URL(callback).href] : [])),
    ),
  ];

  /**
   * The settings among `candidates` that reproduce a key from before 4.0.12: the SHA-256 of
   * [owner, provider, method, callback, issuer, null, sorted scopes], which keyed saved clients
   * and, in 4.0.10, registered stored clients. The account records the method and the grant the
   * issuer. The callback is one the host sent, and the scopes are the provider's declared ones (a
   * provider ID names one definition), or the ones the account's fields say were granted, each
   * also with `offline_access`, which was added when a provider declared none. A key whose scopes
   * came from a challenge may match none.
   */
  const keyMatches = (key: string, candidates: ReadonlyArray<KeyCandidate>) =>
    Effect.gen(function* () {
      const tried = new Set<string>();
      const matches: Array<
        KeyCandidate & { readonly callback: string; readonly requested: ReadonlyArray<string> }
      > = [];
      for (const candidate of candidates) {
        const scopeSets = [...candidate.scopes, []].flatMap((scopes) => [
          [...new Set(scopes)].sort(),
          [...new Set([...scopes, "offline_access"])].sort(),
        ]);
        for (const callback of hrefs)
          for (const scopes of scopeSets) {
            const input = JSON.stringify([
              candidate.owner,
              candidate.provider,
              candidate.method,
              callback,
              candidate.issuer,
              null,
              scopes,
            ]);
            if (tried.has(input)) continue;
            tried.add(input);
            if ((yield* sha256(input)) === key)
              matches.push({ ...candidate, callback, requested: scopes });
          }
      }
      return matches;
    });

  /** What a holder's grant says its sign-in was keyed with. */
  const holderCandidate = (
    holder: Holder,
    declared: ReadonlyMap<ProviderId, Provider>,
  ): KeyCandidate => {
    const method = declared.get(holder.provider)?.definition.auth[holder.method];
    return {
      owner: holder.owner,
      provider: holder.provider,
      method: holder.method,
      issuer: holder.issuer,
      identity: holder.identity,
      registration: {
        tokenEndpointAuthMethod: preferredClientMethod(
          holder.metadata,
          "registered",
          method?.type === "oauth2" ? method.tokenEndpointAuthMethod : undefined,
        ),
        grantTypes: registrationGrantTypes(holder.metadata),
      },
      scopes: [
        ...(method?.type === "oauth2" && method.scopes !== undefined ? [method.scopes] : []),
        ...(holder.granted === undefined ? [] : [holder.granted]),
      ],
    };
  };

  /** The (owner, provider) pairs among the holders whose settings reproduce a saved key. */
  const keyOwners = (
    id: string,
    browser: ReadonlyArray<Holder>,
    declared: ReadonlyMap<ProviderId, Provider>,
  ) =>
    keyMatches(
      id.slice("client_".length),
      browser.map((holder) => holderCandidate(holder, declared)),
    ).pipe(
      Effect.map(
        (matches) => new Set(matches.map((match) => `${match.owner}\n${match.provider}`)).size,
      ),
    );

  /**
   * Why a saved client's owner is ambiguous, as a report files it: how many owners and providers
   * hold it, whether it has a secret, how it was saved, whether exactly one holder's settings
   * reproduce its key, and the providers, whose IDs derive from their definitions.
   */
  const ambiguity = (
    id: string,
    found: Ambiguous["ambiguous"],
    declared: ReadonlyMap<ProviderId, Provider>,
  ) =>
    Effect.gen(function* () {
      const owners = new Set(found.browser.map((holder) => holder.owner));
      const providers = [...new Set(found.browser.map((holder) => holder.provider))].sort();
      const matches = yield* keyOwners(id, found.browser, declared);
      return [
        `ambiguous:owners=${owners.size}`,
        `providers=${providers.length}`,
        `secret=${found.secret ? "yes" : "no"}`,
        `source=${found.source}`,
        `resolvable_by_key=${matches === 1 ? "yes" : matches === 0 ? "no" : "several"}`,
        `provider_ids=${providers.join("|")}`,
      ].join(",");
    });

  /** The definitions of the providers ambiguous clients' holders signed in to. */
  const declarations = (providers: ReadonlySet<ProviderId>) =>
    Effect.gen(function* () {
      const declared = new Map<ProviderId, Provider>();
      if (providers.size === 0) return declared;
      for (const row of yield* query(() =>
        db.findMany("providers", { where: (b) => b("id", "in", [...providers]) }),
      )) {
        const provider = yield* Schema.decodeUnknownEffect(Provider)(row).pipe(Effect.option);
        if (Option.isSome(provider)) declared.set(provider.value.id, provider.value);
      }
      return declared;
    });

  /** The order a data step walks records in, which decides which of a duplicate set moves. */
  const byId = (left: { readonly id: string }, right: { readonly id: string }) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

  const move = (
    id: string,
    byClient: ReadonlyMap<string, ReadonlyArray<Holder>>,
    firstWith: ReadonlyMap<string, string>,
    apply: boolean,
  ): Effect.Effect<SavedClientOutcome, StorageError | CredentialsError> =>
    Effect.gen(function* () {
      const found = yield* analyse(id, byClient);
      if (typeof found === "string") return found;
      if ("ambiguous" in found) return "ambiguous_owner";
      const { key, client, secret, source, holder, target, digest } = found;
      const existing = yield* query(() =>
        db.findFirst("storedOAuthClients", { where: (b) => b("id", "=", target) }),
      );
      // A pass that moved it may have been interrupted before its outcome was recorded.
      if (existing !== null) return "already_moved";
      // Credentials are one client per owner and provider: a client holding these, such as one
      // registered since or another record's, keeps them, and this record is not moved. A
      // removed client's stay withdrawn. A report reads the same answer an apply would.
      if ((yield* credentialsOwner(db, digest)) !== undefined) return "duplicate";
      // A pass walks records in ID order, so of records with the same unheld credentials the
      // first moves and the rest are duplicates. The report decides that from every record, not
      // from the ones this process walked, so a report resumed after its cursor agrees too.
      if (!apply) return (firstWith.get(digest) ?? id) === id ? "would_move" : "duplicate";
      const stored = {
        id: target,
        owner: holder.owner,
        provider: holder.provider,
        issuer: null,
        clientId: client.client_id,
        source,
        hasSecret: secret !== undefined,
        // The saved key, so a sign-in finds the callback the client was registered at.
        automaticKey: key,
        // An account signed in with it.
        confirmed: true,
        encrypted: yield* encrypt(
          target,
          source === "registered"
            ? client
            : {
                client_id: client.client_id,
                ...(secret === undefined ? {} : { client_secret: secret }),
              },
        ),
        createdAt: new Date(yield* Clock.currentTimeMillis),
      };
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const holding = yield* claimCredentials(tx, {
            digest,
            owner: holder.owner,
            provider: holder.provider,
            client: target,
            createdAt: stored.createdAt,
            reclaim: false,
          });
          if (holding !== undefined) return "duplicate" as const;
          yield* query(() => tx.create("storedOAuthClients", stored));
          if (lifecycle?.oauthClientCreated)
            yield* lifecycle.oauthClientCreated(yield* decodeStored(OAuthClient, stored));
          return "moved" as const;
        }),
      );
    });

  // ---------------------------------------------------------------------------------------------
  // 8_oauth_clients_by_issuer: record the authorization server of clients stored before 4.0.12.
  // ---------------------------------------------------------------------------------------------

  /** A provider's browser sign-in methods. */
  const browserMethods = (provider: Provider | undefined) =>
    provider === undefined
      ? []
      : Object.entries(provider.definition.auth).flatMap(([name, method]) =>
          method.type === "oauth2" && method.grant !== "client_credentials"
            ? [{ name, method }]
            : [],
        );

  /**
   * The servers a provider's declared endpoints name, without contacting anyone: the declared
   * issuer, or the token URL, as a sign-in records them (`oauthClientIssuer`). Undefined when a
   * method discovers its server, which only a sign-in that did so recorded.
   */
  const declaredServers = (owner: OwnerId, provider: Provider | undefined) => {
    const methods = browserMethods(provider);
    if (methods.length === 0) return undefined;
    const servers: Array<KeyCandidate> = [];
    for (const { name, method } of methods) {
      if (method.discover !== undefined || method.tokenUrl === undefined || provider === undefined)
        return undefined;
      servers.push({
        owner,
        provider: provider.id,
        method: name,
        issuer: method.issuer ?? new URL(method.tokenUrl).origin,
        identity: method.issuer ?? method.tokenUrl,
        registration: {
          tokenEndpointAuthMethod: preferredClientMethod(
            {},
            "registered",
            method.tokenEndpointAuthMethod,
          ),
          grantTypes: registrationGrantTypes({}),
        },
        scopes: method.scopes === undefined ? [] : [method.scopes],
      });
    }
    return servers;
  };

  /** One identity when every value names the same one. */
  const only = (values: Iterable<string>) => {
    const distinct = new Set(values);
    return distinct.size === 1 ? [...distinct][0] : undefined;
  };

  /** A stored client's current credentials, as its credentials identity digests them. */
  const storedCredentials = (row: { readonly id: OAuthClientId; readonly encrypted: Uint8Array }) =>
    decrypt(row.id, row.encrypted, StoredClientSecret).pipe(
      Effect.map((secret) => ({
        clientId: secret.client_id,
        secret: secret.token_endpoint_auth_method === "none" ? undefined : secret.client_secret,
      })),
    );

  type StoredRow = Effect.Success<typeof storedRows>[number];
  const storedRows = query(() =>
    db.findMany("storedOAuthClients", { orderBy: ["createdAt", "asc"] }),
  );

  /**
   * Which client of a set holding the same credentials for one server survives: a client already
   * recorded under the server, which sign-ins already use as it; otherwise one a person registered,
   * whose audience an administrator chose, before an automatic one; then the oldest, then the
   * lowest ID. Deterministic, so every pass and every report picks the same one.
   */
  const survivorOf = (members: ReadonlyArray<StoredRow>) =>
    members.toSorted((left, right) => {
      const rank = (row: StoredRow) => (row.issuer !== null ? 0 : row.source === "manual" ? 1 : 2);
      return (
        rank(left) - rank(right) ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      );
    })[0];

  /** What recording one client's server needs, read again on every load of the step's items. */
  const analyseStored = (
    row: StoredRow,
    byClient: ReadonlyMap<string, ReadonlyArray<Holder>>,
    byProvider: ReadonlyMap<ProviderId, ReadonlyArray<Holder>>,
    declared: ReadonlyMap<ProviderId, Provider>,
  ) =>
    Effect.gen(function* () {
      const read = yield* storedCredentials(row).pipe(Effect.option);
      if (Option.isNone(read)) return "unreadable" as const;
      const { clientId, secret } = read.value;
      const provider = row.provider === null ? undefined : declared.get(row.provider);
      const servers = declaredServers(row.owner, provider);
      // The owner's accounts that signed in with this client, by its credentials or its ID.
      const held = (byClient.get(clientId) ?? []).filter(
        (holder) =>
          !holder.machine &&
          holder.owner === row.owner &&
          (holder.secret === secret || holder.oauthClient === row.id),
      );
      // Declared endpoints name the server exactly. Otherwise the server the owner's sign-ins with
      // it discovered, or else every sign-in for its provider, whose definition its ID names.
      const issuer =
        (servers === undefined ? undefined : only(servers.map((server) => server.identity))) ??
        only(held.map((holder) => holder.identity)) ??
        (row.provider === null
          ? undefined
          : only((byProvider.get(row.provider) ?? []).map((holder) => holder.identity)));
      if (issuer === undefined) return "issuer_unknown" as const;
      // A registered client is found again by what it was registered for. Its earlier key names
      // the callback and scopes; it is rebuilt from the settings that reproduce it, or the client
      // is no longer found automatically, and the next automatic sign-in registers another.
      const automaticKey =
        row.automaticKey === null || row.provider === null
          ? null
          : yield* rebuiltKey(row.automaticKey, row.owner, issuer, [
              ...(servers ?? []),
              ...[...held, ...(byProvider.get(row.provider) ?? [])]
                .filter((holder) => holder.provider === row.provider)
                .map((holder) => ({
                  ...holderCandidate(holder, declared),
                  owner: row.owner,
                })),
            ]);
      const digest = yield* credentialsDigest(credentials, {
        owner: row.owner,
        issuer,
        clientId,
        secret,
      });
      return { row, issuer, automaticKey, digest } as const;
    });

  /** The key a registered client is found by from 4.0.12, from the settings of its earlier key. */
  const rebuiltKey = (
    key: string,
    owner: OwnerId,
    issuer: string,
    candidates: ReadonlyArray<KeyCandidate>,
  ) =>
    Effect.gen(function* () {
      const match = (yield* keyMatches(key, candidates)).find((found) => found.identity === issuer);
      return match === undefined
        ? null
        : yield* registeredClientKey(sha256, {
            owner,
            issuer,
            callback: match.callback,
            scopes: match.requested,
            tokenEndpointAuthMethod: match.registration.tokenEndpointAuthMethod,
            grantTypes: match.registration.grantTypes,
          });
    });

  /** The step's items and the set each belongs to, from one read of every client and grant. */
  const loadIssuerGroups = Effect.gen(function* () {
    const byClient = yield* holders;
    const byProvider = new Map<ProviderId, Holder[]>();
    for (const list of byClient.values())
      for (const holder of list)
        if (!holder.machine)
          byProvider.set(holder.provider, [...(byProvider.get(holder.provider) ?? []), holder]);
    const rows = yield* storedRows;
    const pending = rows.filter((row) => row.issuer === null);
    const declared = yield* declarations(
      new Set(pending.flatMap((row) => (row.provider === null ? [] : [row.provider]))),
    );
    const analysed = new Map<OAuthClientId, Effect.Success<ReturnType<typeof analyseStored>>>();
    const owners = new Map(pending.map((row) => [row.id, row.owner] as const));
    for (const row of pending)
      analysed.set(
        row.id,
        yield* analyseStored(row, byClient, byProvider, declared).pipe(
          Effect.catch(() => Effect.succeed("unreadable" as const)),
        ),
      );
    // Clients of one owner with the same credentials for the same server are one client.
    const groups = new Map<string, OAuthClientId[]>();
    for (const [id, found] of analysed)
      if (typeof found !== "string")
        groups.set(found.digest, [...(groups.get(found.digest) ?? []), id]);
    return { analysed, groups, owners };
  });

  /** Signals that a set's audiences cannot be combined, so its transaction rolls back. */
  class AccessConflict extends Data.TaggedError("AccessConflict")<{}> {}

  const migrateStored = (
    id: OAuthClientId,
    loaded: Effect.Success<typeof loadIssuerGroups>,
    apply: boolean,
  ): Effect.Effect<ClientIssuerOutcome, StorageError | CredentialsError> =>
    Effect.gen(function* () {
      const found = loaded.analysed.get(id);
      if (found === undefined) return "absent";
      if (typeof found === "string") return found;
      const current = yield* query(() =>
        db.findFirst("storedOAuthClients", { where: (b) => b("id", "=", id) }),
      );
      if (current === null) {
        // Merged by an earlier item of its set in this pass, whose survivor now holds the
        // credentials this client held: a sign-in using them is that client's.
        const holder = yield* credentialsOwner(db, found.digest);
        return holder?.kind === "held" && holder.row.id !== id ? "merged" : "absent";
      }
      if (current.issuer !== null) return "already_migrated";
      // The set as it is now: its members still waiting, and a client recorded under the server
      // since, such as one registered from 4.0.12 with the same credentials.
      const members: StoredRow[] = [];
      for (const member of loaded.groups.get(found.digest) ?? []) {
        const row = yield* query(() =>
          db.findFirst("storedOAuthClients", { where: (b) => b("id", "=", member) }),
        );
        if (row !== null && row.issuer === null) members.push(row);
      }
      const holding = yield* credentialsOwner(db, found.digest);
      const recorded =
        holding?.kind === "held" && holding.row.issuer === found.issuer ? holding.row : undefined;
      const survivor = survivorOf(recorded === undefined ? members : [recorded, ...members]);
      if (survivor === undefined) return "absent";
      const merged = members.filter((member) => member.id !== survivor.id);
      const outcome = survivor.id === id ? ("migrated" as const) : ("merged" as const);
      const metadata = (row: StoredRow) => decodeStored(OAuthClient, row);
      if (!apply) {
        if (
          merged.length > 0 &&
          lifecycle?.oauthClientsMerging !== undefined &&
          !(yield* lifecycle.oauthClientsMerging({
            survivor: yield* metadata(survivor),
            merged: yield* Effect.forEach(merged, metadata),
            apply: false,
          }))
        )
          return "access_conflict";
        return outcome === "migrated" ? "would_migrate" : "would_merge";
      }
      const survivorFound = loaded.analysed.get(survivor.id);
      const automaticKey =
        survivor.issuer !== null
          ? survivor.automaticKey
          : typeof survivorFound === "object"
            ? survivorFound.automaticKey
            : null;
      const result = yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const now = new Date(yield* Clock.currentTimeMillis);
          if (survivor.issuer === null) {
            const other = yield* claimCredentials(tx, {
              digest: found.digest,
              owner: survivor.owner,
              client: survivor.id,
              createdAt: now,
              // These credentials were the survivor's before a client stored from 4.0.12 that
              // held them for this server was removed; it was never removed itself.
              reclaim: true,
            });
            // Another client claimed them meanwhile; the next pass reads the set again.
            if (other !== undefined) return yield* new StorageError();
            yield* query(() =>
              tx.updateMany("storedOAuthClients", {
                where: (b) => b.and(b("id", "=", survivor.id), b("issuer", "is", null)),
                set: {
                  issuer: found.issuer,
                  automaticKey,
                  confirmed: survivor.confirmed || merged.some((member) => member.confirmed),
                },
              }),
            );
          } else if (merged.some((member) => member.confirmed) && !survivor.confirmed)
            yield* query(() =>
              tx.updateMany("storedOAuthClients", {
                where: (b) => b("id", "=", survivor.id),
                set: { confirmed: true },
              }),
            );
          if (merged.length === 0) return outcome;
          // Who may use the merged clients may use the survivor; a set whose audiences cannot be
          // combined is left as it is.
          if (
            lifecycle?.oauthClientsMerging !== undefined &&
            !(yield* lifecycle.oauthClientsMerging({
              survivor: yield* metadata({ ...survivor, issuer: found.issuer }),
              merged: yield* Effect.forEach(merged, metadata),
              apply: true,
            }))
          )
            return yield* new AccessConflict();
          for (const member of merged) {
            yield* query(() =>
              tx.deleteMany("storedOAuthClients", { where: (b) => b("id", "=", member.id) }),
            );
            // Every set of credentials a merged client holds or held, under its provider, is the
            // survivor's: a grant's copy of them, or someone entering them, is the survivor.
            yield* query(() =>
              tx.updateMany("storedOAuthClientCredentials", {
                where: (b) => b("client", "=", member.id),
                set: { client: survivor.id },
              }),
            );
          }
          return outcome;
        }),
      ).pipe(Effect.catchTag("AccessConflict", () => Effect.succeed("access_conflict" as const)));
      return result;
    });

  // ---------------------------------------------------------------------------------------------
  // 9_saved_oauth_clients_by_issuer: move saved records to their owner's client for their server.
  // ---------------------------------------------------------------------------------------------

  /** Where a saved record moves by owner and server, read again for every report and move. */
  const analyseByIssuer = (
    id: string,
    byClient: ReadonlyMap<string, ReadonlyArray<Holder>>,
    declared: ReadonlyMap<ProviderId, Provider>,
  ) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        db.findFirst("oauthClients", { where: (b) => b("id", "=", id) }),
      );
      if (row === null) return "absent" as const;
      if (!id.startsWith("client_")) return "unreadable" as const;
      const identity = OAuthClientId.make(id);
      const read = yield* Effect.all([
        decrypt(identity, row.encrypted, OAuthRegistration),
        decrypt(identity, row.encrypted, SavedClientSource),
      ]).pipe(Effect.option);
      if (Option.isNone(read)) return "unreadable" as const;
      const [client, { executor_source }] = read.value;
      const secret =
        client.token_endpoint_auth_method === "none" ? undefined : client.client_secret;
      const held = (byClient.get(client.client_id) ?? []).filter(
        (holder) => holder.secret === secret,
      );
      if (held.length === 0) return "no_account" as const;
      const browser = held.filter((holder) => !holder.machine);
      if (browser.length === 0) return "machine_client" as const;
      const key = id.slice("client_".length);
      const matches = yield* keyMatches(
        key,
        browser.map((holder) => holderCandidate(holder, declared)),
      );
      // One owner's accounts hold it, whatever providers they are for. Otherwise the one owner
      // whose settings reproduce the record's key saved it.
      const owner =
        only(browser.map((holder) => holder.owner)) ?? only(matches.map((match) => match.owner));
      if (owner === undefined) return "ambiguous_owner" as const;
      const owned = matches.filter((match) => match.owner === owner);
      const issuer =
        only(browser.filter((holder) => holder.owner === owner).map((holder) => holder.identity)) ??
        only(owned.map((match) => match.identity));
      if (issuer === undefined) return "ambiguous_issuer" as const;
      const match = owned.find((found) => found.identity === issuer);
      const source = executor_source === "registered" ? "registered" : "manual";
      const ownerId = OwnerId.make(owner);
      return {
        key,
        client,
        secret,
        source,
        owner: ownerId,
        issuer,
        // Providers whose clients stored before 4.0.12 may hold the credentials.
        providers: [
          ...new Set(
            browser.filter((holder) => holder.owner === owner).map((holder) => holder.provider),
          ),
        ],
        target: OAuthClientId.make(`oac_${key}`),
        digest: yield* credentialsDigest(credentials, {
          owner: ownerId,
          issuer,
          clientId: client.client_id,
          secret,
        }),
        automaticKey:
          match === undefined
            ? null
            : yield* registeredClientKey(sha256, {
                owner: ownerId,
                issuer,
                callback: match.callback,
                scopes: match.requested,
                tokenEndpointAuthMethod: match.registration.tokenEndpointAuthMethod,
                grantTypes: match.registration.grantTypes,
              }),
      } as const;
    });

  const moveByIssuer = (
    id: string,
    byClient: ReadonlyMap<string, ReadonlyArray<Holder>>,
    declared: ReadonlyMap<ProviderId, Provider>,
    firstWith: ReadonlyMap<string, string>,
    apply: boolean,
  ): Effect.Effect<SavedClientByIssuerOutcome, StorageError | CredentialsError> =>
    Effect.gen(function* () {
      const found = yield* analyseByIssuer(id, byClient, declared);
      if (typeof found === "string") return found;
      const existing = yield* query(() =>
        db.findFirst("storedOAuthClients", { where: (b) => b("id", "=", found.target) }),
      );
      // Moved by `6_stored_oauth_clients` or an earlier pass of this step.
      if (existing !== null) return "already_moved";
      // Credentials are one client per owner and server: records with the same ones collapse into
      // the client holding them, and a removed client's stay withdrawn.
      if ((yield* credentialsOwner(db, found.digest)) !== undefined) return "duplicate";
      // So do records whose credentials a client stored before 4.0.12 holds under a provider; data
      // step `8_oauth_clients_by_issuer` records that client under its server.
      for (const provider of found.providers)
        if (
          (yield* credentialsOwner(
            db,
            yield* legacyCredentialsDigest(credentials, {
              owner: found.owner,
              provider,
              clientId: found.client.client_id,
              secret: found.secret,
            }),
          )) !== undefined
        )
          return "duplicate";
      if (!apply) return (firstWith.get(found.digest) ?? id) === id ? "would_move" : "duplicate";
      const stored = {
        id: found.target,
        owner: found.owner,
        provider: null,
        issuer: found.issuer,
        clientId: found.client.client_id,
        source: found.source,
        hasSecret: found.secret !== undefined,
        automaticKey: found.automaticKey,
        // An account signed in with it.
        confirmed: true,
        encrypted: yield* encrypt(
          found.target,
          found.source === "registered"
            ? found.client
            : {
                client_id: found.client.client_id,
                ...(found.secret === undefined ? {} : { client_secret: found.secret }),
              },
        ),
        createdAt: new Date(yield* Clock.currentTimeMillis),
      };
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const holding = yield* claimCredentials(tx, {
            digest: found.digest,
            owner: found.owner,
            client: found.target,
            createdAt: stored.createdAt,
            reclaim: false,
          });
          if (holding !== undefined) return "duplicate" as const;
          yield* query(() => tx.create("storedOAuthClients", stored));
          if (lifecycle?.oauthClientCreated)
            yield* lifecycle.oauthClientCreated(yield* decodeStored(OAuthClient, stored));
          return "moved" as const;
        }),
      );
    });

  return {
    items: Effect.gen(function* () {
      const byClient = yield* holders;
      const rows = (yield* query(() => db.findMany("oauthClients", { select: ["id"] }))).toSorted(
        byId,
      );
      const analysed = yield* Effect.forEach(rows, (row) =>
        analyse(row.id, byClient).pipe(
          Effect.option,
          Effect.map((found) => {
            const value =
              Option.isSome(found) && typeof found.value !== "string" ? found.value : undefined;
            return value === undefined || "ambiguous" in value
              ? { id: row.id, found: undefined, ambiguous: value?.ambiguous }
              : { id: row.id, found: value, ambiguous: undefined };
          }),
        ),
      );
      // The first record, in walking order, of each set of credentials.
      const firstWith = new Map<string, string>();
      for (const { id, found } of analysed)
        if (found !== undefined && !firstWith.has(found.digest)) firstWith.set(found.digest, id);
      const declared = yield* declarations(
        new Set(
          analysed.flatMap(({ ambiguous }) =>
            (ambiguous?.browser ?? []).map((holder) => holder.provider),
          ),
        ),
      );
      const buckets = new Map<string, string>();
      for (const { id, ambiguous } of analysed)
        if (ambiguous !== undefined) buckets.set(id, yield* ambiguity(id, ambiguous, declared));
      return analysed.map(({ id, found }) => ({
        id,
        owner: found?.holder.owner,
        bucket: buckets.get(id),
        move: (apply: boolean) =>
          move(id, byClient, firstWith, apply).pipe(
            Effect.catch(() => Effect.succeed("unavailable" as const)),
            Effect.withSpan("oauth.clients.moveSaved", { attributes: { apply } }),
          ),
      }));
    }).pipe(Effect.withSpan("oauth.clients.savedItems")),
    issuerItems: Effect.gen(function* () {
      const loaded = yield* loadIssuerGroups;
      return [...loaded.analysed.keys()].toSorted().map((id) => ({
        id,
        owner: loaded.owners.get(id) ?? "",
        migrate: (apply: boolean) =>
          migrateStored(id, loaded, apply).pipe(
            Effect.catch(() => Effect.succeed("unavailable" as const)),
            Effect.withSpan("oauth.clients.recordIssuer", { attributes: { apply } }),
          ),
      }));
    }).pipe(Effect.withSpan("oauth.clients.issuerItems")),
    itemsByIssuer: Effect.gen(function* () {
      const byClient = yield* holders;
      const declared = yield* declarations(
        new Set([...byClient.values()].flatMap((list) => list.map((holder) => holder.provider))),
      );
      const rows = (yield* query(() => db.findMany("oauthClients", { select: ["id"] }))).toSorted(
        byId,
      );
      const analysed = yield* Effect.forEach(rows, (row) =>
        analyseByIssuer(row.id, byClient, declared).pipe(
          Effect.option,
          Effect.map((found) => ({
            id: row.id,
            found:
              Option.isSome(found) && typeof found.value !== "string" ? found.value : undefined,
          })),
        ),
      );
      // The first record, in walking order, of each owner's credentials for each server.
      const firstWith = new Map<string, string>();
      for (const { id, found } of analysed)
        if (found !== undefined && !firstWith.has(found.digest)) firstWith.set(found.digest, id);
      return analysed.map(({ id, found }) => ({
        id,
        owner: found?.owner,
        move: (apply: boolean) =>
          moveByIssuer(id, byClient, declared, firstWith, apply).pipe(
            Effect.catch(() => Effect.succeed("unavailable" as const)),
            Effect.withSpan("oauth.clients.moveSavedByIssuer", { attributes: { apply } }),
          ),
      }));
    }).pipe(Effect.withSpan("oauth.clients.savedItemsByIssuer")),
  };
};
