/** Trusted OAuth lifecycle. Provider definitions never contain client secrets or saved grants. */
import { parseDestination, parseEndpoint, httpsOnlyUrlPolicy } from "@executor-js/utils/url-policy";
import {
  Clock,
  type Crypto,
  Effect,
  Encoding,
  JsonSchema,
  Redacted,
  Schema,
  SchemaRepresentation,
} from "effect";
import { StartConnectionOAuth, CompleteConnectionOAuth } from "../contracts/account-connection.ts";
import {
  openConnection,
  readConnection,
  finishConnection,
  lockConnection,
} from "./connection-state.ts";
import { Account } from "../contracts/account.ts";
import {
  OAuthClientUnavailable,
  OAuthCompletionFailed,
  OAuthAttempt,
  OAuthAttemptId,
  OAuthClientId,
  OAuthGrant,
  OAuthReconnectRequired,
  OAuthRegistration,
  OAuthSetupFailed,
  type OAuthOptions,
} from "../contracts/oauth.ts";
import {
  AuthMethodInvalid,
  Provider,
  ProviderNotFound,
  type ProviderDefinition,
} from "../contracts/provider.ts";
import {
  AccountId,
  HttpUrl,
  JsonObject,
  StorageError,
  type OwnerId,
  type ProviderId,
} from "../contracts/shared.ts";
import type { Credentials, StoredAccount } from "../contracts/storage.ts";
import { query, transaction, type Query } from "./database.ts";
import { makeOAuthProtocol } from "./oauth-protocol.ts";
import { ownedAccount } from "./accounts.ts";

const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => new StorageError()));

/** Apply the authored output schema after removing host-only token material. */
const project = (response: JsonObject, fields: unknown) =>
  Effect.gen(function* () {
    const input = yield* decode(JsonObject, fields);
    const publicFields = Object.fromEntries(
      Object.entries(input).filter(
        ([key]) =>
          !["refresh_token", "id_token", "client_secret", "client_assertion"].includes(key),
      ),
    );
    const decoder = yield* Effect.try({
      try: () =>
        Schema.toType(
          SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(response)),
        ),
      catch: () => new StorageError(),
    });
    return yield* Schema.decodeUnknownEffect(decoder)(publicFields).pipe(
      Effect.flatMap((fields) => decode(JsonObject, fields)),
      Effect.mapError(() => new StorageError()),
    );
  });

/** Compose persisted sign-in and refresh operations with the host's encryption and transport. */
export const makeOAuth = (
  db: Query,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  options?: OAuthOptions,
) => {
  const hash = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map(Encoding.encodeHex),
      Effect.mapError(() => new StorageError()),
    );
  const nextId = crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()));
  const protocol = options === undefined ? undefined : makeOAuthProtocol(options);
  const encrypt = (identity: AccountId | OAuthAttemptId | OAuthClientId, value: unknown) =>
    decode(JsonObject, value).pipe(
      Effect.flatMap((value) => credentials.encrypt(identity, Redacted.make(value))),
    );
  const decrypt = <A>(
    identity: AccountId | OAuthAttemptId | OAuthClientId,
    bytes: Uint8Array,
    schema: Schema.Decoder<A>,
  ) =>
    credentials
      .decrypt(identity, Redacted.make(bytes))
      .pipe(Effect.flatMap((value) => decode(schema, Redacted.value(value))));

  const beginOAuth = (
    input: typeof StartConnectionOAuth.Type & {
      readonly owner: OwnerId;
      readonly provider: ProviderId;
    },
    existing?: Account,
  ) =>
    Effect.gen(function* () {
      if (protocol === undefined || options === undefined)
        return yield* new OAuthClientUnavailable(input);
      const redirect = parseEndpoint(input.redirectUri, options.urlPolicy);
      // Static callback parameters are legal; response fields must remain provider-owned.
      if (
        redirect === undefined ||
        ["code", "state", "error", "error_description", "error_uri", "iss"].some((key) =>
          redirect.searchParams.has(key),
        )
      ) {
        return yield* new OAuthSetupFailed({ reason: "invalid_redirect" });
      }
      const row = yield* query(() =>
        db.findFirst("providers", { where: (b) => b("id", "=", input.provider) }),
      );
      if (row === null) return yield* new ProviderNotFound({ provider: input.provider });
      const provider = yield* decode(Provider, row);
      const method = Object.hasOwn(provider.definition.auth, input.method)
        ? provider.definition.auth[input.method]
        : undefined;
      if (method === undefined || method.type !== "oauth2")
        return yield* new AuthMethodInvalid(input);
      const discovered = yield* protocol
        .discover(method)
        .pipe(Effect.mapError(() => new OAuthSetupFailed({ reason: "discovery" })));
      for (const address of [
        discovered.server.issuer,
        discovered.server.authorization_endpoint,
        discovered.server.token_endpoint,
        discovered.server.registration_endpoint,
      ].filter((address) => address !== undefined)) {
        const url = parseDestination(address, options.urlPolicy);
        if (url === undefined) return yield* new OAuthSetupFailed({ reason: "discovery" });
      }
      if (
        discovered.server.code_challenge_methods_supported !== undefined &&
        !discovered.server.code_challenge_methods_supported.includes("S256")
      ) {
        return yield* new OAuthSetupFailed({ reason: "unsupported" });
      }
      // A client registered for fewer scopes cannot be assumed to allow new ones.
      const clientId = OAuthClientId.make(
        `client_${yield* hash(
          JSON.stringify([
            input.owner,
            input.provider,
            input.method,
            redirect.href,
            discovered.server.issuer,
            options.clientMetadataUrl,
            [...discovered.scopes].sort(),
          ]),
        )}`,
      );
      const now = yield* Clock.currentTimeMillis;
      const saved = yield* query(() =>
        db.findFirst("oauthClients", { where: (b) => b("id", "=", clientId) }),
      );
      let client: OAuthRegistration | undefined;
      if (input.client !== undefined) {
        client = yield* Schema.decodeUnknownEffect(OAuthRegistration)({
          client_id: input.client.clientId,
          token_endpoint_auth_method: input.client.tokenEndpointAuthMethod,
          ...(input.client.clientSecret === undefined
            ? {}
            : { client_secret: Redacted.value(input.client.clientSecret) }),
        }).pipe(Effect.mapError(() => new OAuthSetupFailed({ reason: "invalid_client" })));
      } else if (saved !== null) {
        const registered = yield* decrypt(clientId, saved.encrypted, OAuthRegistration);
        if (
          registered.client_secret_expires_at === undefined ||
          registered.client_secret_expires_at === 0 ||
          registered.client_secret_expires_at * 1000 > now
        )
          client = registered;
      }
      if (
        client === undefined &&
        discovered.server.client_id_metadata_document_supported === true &&
        options.clientMetadataUrl !== undefined
      ) {
        const metadataUrl = options.clientMetadataUrl;
        const url = parseDestination(metadataUrl, httpsOnlyUrlPolicy);
        if (url === undefined) return yield* new OAuthSetupFailed({ reason: "invalid_client" });
        client = { client_id: url.href, token_endpoint_auth_method: "none" };
      }
      if (client === undefined && discovered.server.registration_endpoint !== undefined) {
        client = yield* protocol
          .register(discovered.server, redirect.href, discovered.scopes)
          .pipe(Effect.mapError(() => new OAuthSetupFailed({ reason: "registration" })));
      }
      if (client === undefined) return yield* new OAuthClientUnavailable(input);
      const registered = client;
      const encryptedClient = yield* encrypt(clientId, registered);
      yield* query(() =>
        db.upsert("oauthClients", {
          where: (b) => b("id", "=", clientId),
          create: { id: clientId, encrypted: encryptedClient },
          update: { encrypted: encryptedClient },
        }),
      );
      const authorization = yield* protocol
        .authorize({ ...discovered, client: registered, redirectUri: redirect.href })
        .pipe(Effect.mapError(() => new OAuthSetupFailed({ reason: "unsupported" })));
      const id = OAuthAttemptId.make(`oauth_${yield* hash(authorization.state)}`);
      const account = existing?.id ?? AccountId.make(`acc_${yield* nextId}`);
      const attempt = yield* decode(OAuthAttempt, {
        ...input,
        ...authorization,
        ...discovered,
        redirectUri: redirect.href,
        account,
        ...(existing === undefined ? {} : { reconnect: true }),
        client: registered,
        response: method.response,
      });
      const encrypted = yield* encrypt(id, attempt);
      const pending = yield* openConnection(db, input);
      const expiresAt = new Date(Math.min(now + 10 * 60_000, pending.expiresAt.getTime()));
      yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          yield* lockConnection(tx, input, crypto);
          yield* openConnection(tx, input);
          yield* query(() =>
            tx.create("oauthAttempts", { id, encrypted, expiresAt, status: "pending" }),
          );
          yield* query(() =>
            tx.updateMany("accountConnections", {
              where: (b) => b("id", "=", input.connection),
              set: { oauthAttempt: id },
            }),
          );
        }),
      );
      return { authorizationUrl: HttpUrl.make(authorization.authorizationUrl), expiresAt };
    }).pipe(Effect.withSpan("oauth.beginOAuth"));

  const startOAuth = (input: typeof StartConnectionOAuth.Type) =>
    Effect.gen(function* () {
      const connection = yield* openConnection(db, input);
      const existing =
        connection.reconnectAccount === null
          ? undefined
          : yield* ownedAccount(db, {
              account: connection.reconnectAccount,
              owner: connection.owner,
            });
      if (existing !== undefined && existing.method !== input.method)
        return yield* new AuthMethodInvalid({
          provider: connection.provider,
          method: input.method,
        });
      return yield* beginOAuth(
        {
          ...input,
          owner: connection.owner,
          provider: connection.provider,
          label: existing?.label ?? input.label,
        },
        existing,
      );
    }).pipe(Effect.withSpan("oauth.startOAuth"));

  const reconnectTarget = (tx: Query, attempt: OAuthAttempt) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        tx.findFirst("accounts", { where: (b) => b("id", "=", attempt.account) }),
      );
      if (
        row === null ||
        row.owner !== attempt.owner ||
        row.provider !== attempt.provider ||
        row.method !== attempt.method
      ) {
        return yield* new OAuthCompletionFailed({ reason: "account_unavailable" });
      }
      return yield* decode(Account, row);
    });

  const completeOAuth = (input: typeof CompleteConnectionOAuth.Type) =>
    Effect.gen(function* () {
      const connectionState = yield* readConnection(db, input);
      if (connectionState.state.status === "completed") return connectionState.state.account;
      const invalid = () => new OAuthCompletionFailed({ reason: "invalid_callback" });
      if (protocol === undefined) return yield* invalid();
      const callback = yield* Effect.try({
        try: () => new URL(Redacted.value(input.callbackUrl)),
        catch: invalid,
      });
      const states = callback.searchParams.getAll("state");
      const state = states[0];
      if (state === undefined || state.length < 32 || states.length !== 1 || callback.hash !== "")
        return yield* invalid();
      const id = OAuthAttemptId.make(`oauth_${yield* hash(state)}`);
      const row = yield* query(() =>
        db.findFirst("oauthAttempts", { where: (b) => b("id", "=", id) }),
      );
      if (row === null) return yield* invalid();
      if (row.status !== "pending")
        return yield* new OAuthCompletionFailed({ reason: "already_completed" });
      const now = yield* Clock.currentTimeMillis;
      if (row.expiresAt.getTime() <= now)
        return yield* new OAuthCompletionFailed({ reason: "expired" });
      const attempt = yield* decrypt(id, row.encrypted, OAuthAttempt);
      if (attempt.connection !== input.connection) return yield* invalid();
      const connection = yield* openConnection(db, input);
      if (connection.oauthAttempt !== id) return yield* invalid();
      const redirect = new URL(attempt.redirectUri);
      if (
        callback.origin !== redirect.origin ||
        callback.pathname !== redirect.pathname ||
        callback.username !== "" ||
        callback.password !== "" ||
        callback.href.includes("#") ||
        [...redirect.searchParams.keys()].some((key) => {
          const expected = redirect.searchParams.getAll(key);
          const actual = callback.searchParams.getAll(key);
          return (
            expected.length !== actual.length ||
            expected.some((value, index) => actual[index] !== value)
          );
        })
      )
        return yield* invalid();
      const claim = `claim_${yield* nextId}`;
      // Conditional UPDATE is atomic even on adapters without row locks or update counts.
      yield* query(() =>
        db.updateMany("oauthAttempts", {
          where: (b) => b.and(b("id", "=", id), b("status", "=", "pending")),
          set: { status: claim },
        }),
      );
      const claimed = yield* query(() =>
        db.findFirst("oauthAttempts", { where: (b) => b("id", "=", id) }),
      );
      if (claimed?.status !== claim)
        return yield* new OAuthCompletionFailed({ reason: "already_completed" });
      if (callback.searchParams.has("error"))
        return yield* new OAuthCompletionFailed({ reason: "denied" });
      if (attempt.reconnect) yield* reconnectTarget(db, attempt);
      const tokens = yield* protocol
        .exchange(attempt, callback)
        .pipe(Effect.mapError(() => new OAuthCompletionFailed({ reason: "exchange_failed" })));
      const fields = yield* project(attempt.response, tokens).pipe(
        Effect.mapError(() => new OAuthCompletionFailed({ reason: "exchange_failed" })),
      );
      const completedAt = yield* Clock.currentTimeMillis;
      const grant = yield* decode(OAuthGrant, {
        server: attempt.server,
        client: attempt.client,
        response: attempt.response,
        ...(attempt.resource === undefined ? {} : { resource: attempt.resource }),
        fields,
        ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
        ...(tokens.expires_in === undefined
          ? {}
          : { expiresAt: completedAt + tokens.expires_in * 1000 }),
      });
      const account = yield* decode(Account, {
        id: attempt.account,
        provider: attempt.provider,
        owner: attempt.owner,
        label: attempt.label,
        method: attempt.method,
        createdAt: new Date(completedAt),
      });
      const encryptedCredentials = yield* encrypt(account.id, fields);
      const encryptedGrant = yield* encrypt(account.id, grant);
      const ready = `ready_${yield* nextId}`;
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          yield* lockConnection(tx, input, crypto);
          const current = yield* openConnection(tx, input);
          if (current.oauthAttempt !== id) return yield* invalid();
          // Read again after the remote exchange: deletion must win, and a concurrent rename must survive.
          const saved = attempt.reconnect ? yield* reconnectTarget(tx, attempt) : account;
          if (attempt.reconnect) {
            yield* query(() =>
              tx.updateMany("accounts", {
                where: (b) => b("id", "=", saved.id),
                set: { encryptedCredentials },
              }),
            );
          } else yield* query(() => tx.create("accounts", { ...saved, encryptedCredentials }));
          const grant = {
            encrypted: encryptedGrant,
            status: ready,
            updatedAt: new Date(completedAt),
          };
          yield* query(() =>
            tx.upsert("oauthGrants", {
              where: (b) => b("id", "=", saved.id),
              create: { id: saved.id, ...grant },
              update: grant,
            }),
          );
          yield* query(() =>
            tx.updateMany("oauthAttempts", {
              where: (b) => b("id", "=", id),
              set: { status: "completed", encrypted: new Uint8Array() },
            }),
          );
          yield* finishConnection(tx, input, saved);
          return saved;
        }),
      );
    }).pipe(Effect.withSpan("oauth.completeOAuth"));

  const resolve = (account: StoredAccount, provider: ProviderDefinition) =>
    Effect.gen(function* () {
      if (provider.auth[account.method]?.type === "secrets")
        return yield* credentials.decrypt(account.id, account.encryptedCredentials);
      const reconnect = () => new OAuthReconnectRequired({ account: account.id });
      while (true) {
        const row = yield* query(() =>
          db.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
        );
        if (row === null || row.status === "reconnect") return yield* reconnect();
        const now = yield* Clock.currentTimeMillis;
        if (!row.status.startsWith("ready_")) {
          // A crashed process may have consumed a rotating token. Do not replay an uncertain refresh.
          if (now - row.updatedAt.getTime() > 60_000) return yield* reconnect();
          yield* Effect.sleep("100 millis");
          continue;
        }
        const grant = yield* decrypt(account.id, row.encrypted, OAuthGrant);
        if (
          grant.expiresAt === undefined ||
          grant.expiresAt > now + 30_000 ||
          (grant.refreshToken === undefined && grant.expiresAt > now)
        )
          return Redacted.make(grant.fields);
        if (grant.refreshToken === undefined || protocol === undefined) return yield* reconnect();
        const refreshToken = grant.refreshToken;
        const claim = `refresh_${yield* nextId}`;
        yield* query(() =>
          db.updateMany("oauthGrants", {
            where: (b) => b.and(b("id", "=", account.id), b("status", "=", row.status)),
            set: { status: claim, updatedAt: new Date(now) },
          }),
        );
        const claimed = yield* query(() =>
          db.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
        );
        if (claimed?.status !== claim) continue;
        const result = yield* protocol.refresh({ ...grant, refreshToken }).pipe(
          Effect.flatMap((tokens) =>
            project(grant.response, { ...grant.fields, ...tokens }).pipe(
              Effect.map((fields) => ({ tokens, fields })),
            ),
          ),
          Effect.result,
        );
        if (result._tag === "Failure") {
          const failed = yield* transaction(db, (tx) =>
            Effect.gen(function* () {
              const current = yield* query(() =>
                tx.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
              );
              if (current?.status !== claim) return false;
              yield* query(() =>
                tx.updateMany("oauthGrants", {
                  where: (b) => b.and(b("id", "=", account.id), b("status", "=", claim)),
                  set: { status: "reconnect" },
                }),
              );
              return true;
            }),
          );
          if (failed) return yield* reconnect();
          continue;
        }
        const { fields, tokens } = result.success;
        const updatedAt = new Date(yield* Clock.currentTimeMillis);
        const updated = yield* decode(OAuthGrant, {
          ...grant,
          fields,
          refreshToken: tokens.refresh_token ?? refreshToken,
          expiresAt:
            tokens.expires_in === undefined
              ? undefined
              : updatedAt.getTime() + tokens.expires_in * 1000,
        });
        const encrypted = yield* encrypt(account.id, updated);
        const encryptedCredentials = yield* encrypt(account.id, fields);
        const ready = `ready_${yield* nextId}`;
        const committed = yield* transaction(db, (tx) =>
          Effect.gen(function* () {
            const current = yield* query(() =>
              tx.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
            );
            const saved = yield* query(() =>
              tx.findFirst("accounts", { where: (b) => b("id", "=", account.id) }),
            );
            if (current?.status !== claim || saved === null) return false;
            yield* query(() =>
              tx.updateMany("oauthGrants", {
                where: (b) => b.and(b("id", "=", account.id), b("status", "=", claim)),
                set: { status: ready, encrypted, updatedAt },
              }),
            );
            yield* query(() =>
              tx.updateMany("accounts", {
                where: (b) => b("id", "=", account.id),
                set: { encryptedCredentials },
              }),
            );
            return true;
          }),
        );
        if (!committed) continue;
        return Redacted.make(fields);
      }
    }).pipe(Effect.withSpan("oauth.resolve"));
  return { connections: { startOAuth, completeOAuth }, resolve };
};
