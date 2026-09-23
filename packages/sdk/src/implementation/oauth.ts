import type { ResourceLifecycle } from "../contracts/executor.ts";
/** Trusted OAuth lifecycle. Provider definitions never contain client secrets or saved grants. */
import { parseDestination, parseEndpoint, httpsOnlyUrlPolicy } from "@executor-js/utils/url-policy";
import {
  Clock,
  type Crypto,
  Effect,
  Encoding,
  JsonSchema,
  Match,
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
  type CheckOAuthSetup,
  type OAuthClientSetup,
  OAuthCompletionFailed,
  OAuthAttempt,
  OAuthAttemptId,
  OAuthClientId,
  OAuthGrant,
  OAuthReconnectRequired,
  OAuthRegistration,
  OAuthConfidentialRegistration,
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
  lifecycle?: ResourceLifecycle,
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

  const resolveSetup = (input: typeof CheckOAuthSetup.Type, automatic: boolean) =>
    Effect.gen(function* () {
      if (protocol === undefined || options === undefined)
        return yield* new OAuthSetupFailed({ reason: "unsupported" });
      const row = yield* query(() =>
        db.findFirst("providers", { where: (b) => b("id", "=", input.provider) }),
      );
      if (row === null) return yield* new ProviderNotFound({ provider: input.provider });
      const provider = yield* decode(Provider, row);
      yield* Effect.annotateCurrentSpan("oauth.provider.id", provider.id);
      const method = Object.hasOwn(provider.definition.auth, input.method)
        ? provider.definition.auth[input.method]
        : undefined;
      if (method === undefined || method.type !== "oauth2")
        return yield* new AuthMethodInvalid(input);
      const redirect =
        method.grant === "client_credentials" || input.redirectUri === undefined
          ? undefined
          : parseEndpoint(input.redirectUri, options.urlPolicy);
      if (
        method.grant !== "client_credentials" &&
        (redirect === undefined ||
          ["code", "state", "error", "error_description", "error_uri", "iss"].some((key) =>
            redirect.searchParams.has(key),
          ))
      )
        return yield* new OAuthSetupFailed({ reason: "invalid_redirect" });
      const discovered = yield* protocol.discover(method).pipe(
        Effect.mapError(
          (error) =>
            new OAuthSetupFailed({
              reason: Match.value(error.reason).pipe(
                Match.when("request", () => "discovery_unavailable" as const),
                Match.when("metadata_missing", () => "discovery_missing" as const),
                Match.when("destination_blocked", () => "discovery_blocked" as const),
                Match.whenOr(
                  "invalid_response",
                  "invalid_client",
                  "invalid_grant",
                  () => "discovery_invalid" as const,
                ),
                Match.exhaustive,
              ),
            }),
        ),
      );
      for (const address of [
        discovered.server.issuer,
        discovered.server.authorization_endpoint,
        discovered.server.token_endpoint,
        discovered.server.registration_endpoint,
      ].filter((address) => address !== undefined)) {
        const url = parseDestination(address, options.urlPolicy);
        if (url === undefined) return yield* new OAuthSetupFailed({ reason: "discovery_blocked" });
      }
      if (
        discovered.grant === "authorization_code" &&
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
            redirect?.href,
            discovered.server.issuer,
            options.clientMetadataUrl,
            [...discovered.scopes].sort(),
          ]),
        )}`,
      );
      const now = yield* Clock.currentTimeMillis;
      const saved = automatic
        ? yield* query(() => db.findFirst("oauthClients", { where: (b) => b("id", "=", clientId) }))
        : null;
      let client: OAuthRegistration | undefined;
      if (saved !== null) {
        const registered = yield* decrypt(clientId, saved.encrypted, OAuthRegistration);
        if (
          registered.client_secret_expires_at === undefined ||
          registered.client_secret_expires_at === 0 ||
          registered.client_secret_expires_at * 1000 > now
        )
          client = registered;
      }
      const savedClient = client !== undefined;
      if (
        automatic &&
        discovered.grant === "authorization_code" &&
        client === undefined &&
        (method.tokenEndpointAuthMethod === undefined ||
          method.tokenEndpointAuthMethod === "none") &&
        discovered.server.client_id_metadata_document_supported === true &&
        options.clientMetadataUrl !== undefined
      ) {
        const metadataUrl = options.clientMetadataUrl;
        const url = parseDestination(metadataUrl, httpsOnlyUrlPolicy);
        if (url === undefined) return yield* new OAuthSetupFailed({ reason: "invalid_client" });
        client = { client_id: url.href, token_endpoint_auth_method: "none" };
      }
      return { method, redirect, discovered, clientId, client, savedClient };
    });
  const oauthSetup = (input: typeof CheckOAuthSetup.Type) =>
    resolveSetup(input, true).pipe(
      Effect.map(({ client, discovered, method, savedClient }): OAuthClientSetup => {
        const mode = savedClient
          ? "saved"
          : client !== undefined ||
              (discovered.grant === "authorization_code" &&
                discovered.server.registration_endpoint !== undefined)
            ? "automatic"
            : "client-required";
        return method.grant === "client_credentials"
          ? {
              mode,
              scopes: discovered.scopes,
              grant: method.grant,
              tokenEndpointAuthMethod: method.tokenEndpointAuthMethod,
            }
          : {
              mode,
              scopes: discovered.scopes,
              grant: "authorization_code",
              tokenEndpointAuthMethod: discovered.tokenEndpointAuthMethod,
            };
      }),
      Effect.withSpan("oauth.setup"),
    );

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
      const {
        method,
        redirect,
        discovered,
        clientId,
        client: availableClient,
      } = yield* resolveSetup(input, input.client === undefined);
      const now = yield* Clock.currentTimeMillis;
      let client: OAuthRegistration | undefined;
      if (input.client !== undefined) {
        if (
          discovered.tokenEndpointAuthMethod === "none" &&
          input.client.clientSecret !== undefined
        )
          return yield* new OAuthSetupFailed({ reason: "invalid_client" });
        client = yield* Schema.decodeUnknownEffect(OAuthRegistration)({
          client_id: input.client.clientId,
          token_endpoint_auth_method: discovered.tokenEndpointAuthMethod,
          ...(input.client.clientSecret === undefined
            ? {}
            : { client_secret: Redacted.value(input.client.clientSecret) }),
        }).pipe(Effect.mapError(() => new OAuthSetupFailed({ reason: "invalid_client" })));
      } else client = availableClient;
      if (
        client === undefined &&
        discovered.grant === "authorization_code" &&
        discovered.server.registration_endpoint !== undefined
      ) {
        if (redirect === undefined)
          return yield* new OAuthSetupFailed({ reason: "invalid_redirect" });
        client = yield* protocol
          .register(
            discovered.server,
            redirect.href,
            discovered.scopes,
            method.tokenEndpointAuthMethod,
          )
          .pipe(Effect.mapError(() => new OAuthSetupFailed({ reason: "registration" })));
      }
      if (client === undefined) return yield* new OAuthClientUnavailable(input);
      if (
        client.token_endpoint_auth_method === "client_secret_basic_raw" &&
        client.client_id.includes(":")
      )
        return yield* new OAuthSetupFailed({ reason: "invalid_client" });
      const registered = client;
      const encryptedClient = yield* encrypt(clientId, registered);
      const saveClient = (store: Query) =>
        query(() =>
          store.upsert("oauthClients", {
            where: (b) => b("id", "=", clientId),
            create: { id: clientId, encrypted: encryptedClient },
            update: { encrypted: encryptedClient },
          }),
        );
      if (discovered.grant === "client_credentials") {
        const confidential = yield* Schema.decodeUnknownEffect(OAuthConfidentialRegistration)(
          registered,
        ).pipe(Effect.mapError(() => new OAuthSetupFailed({ reason: "invalid_client" })));
        const tokens = yield* protocol
          .clientCredentials({ ...discovered, client: confidential })
          .pipe(
            Effect.mapError(
              (error) =>
                new OAuthSetupFailed({
                  reason: error.reason === "invalid_client" ? "invalid_client" : "token_exchange",
                }),
            ),
          );
        const fields = yield* project(method.response, tokens).pipe(
          Effect.mapError(() => new OAuthSetupFailed({ reason: "invalid_client" })),
        );
        const completedAt = yield* Clock.currentTimeMillis;
        const account = existing ?? {
          id: AccountId.make(`acc_${yield* nextId}`),
          owner: input.owner,
          provider: input.provider,
          method: input.method,
          label: input.label,
          createdAt: new Date(completedAt),
        };
        const grant = yield* decode(OAuthGrant, {
          ...discovered,
          client: confidential,
          fields,
          response: method.response,
          ...(tokens.expires_in === undefined
            ? {}
            : { expiresAt: completedAt + tokens.expires_in * 1000 }),
        });
        const encryptedCredentials = yield* encrypt(account.id, fields);
        const encryptedGrant = yield* encrypt(account.id, grant);
        const ready = `ready_${yield* nextId}`;
        const saved = yield* transaction(db, (tx) =>
          Effect.gen(function* () {
            const current = yield* lockConnection(tx, input, crypto);
            if (current.state.status === "completed") return current.state.account;
            yield* openConnection(tx, input);
            const saved =
              existing === undefined
                ? account
                : yield* ownedAccount(tx, { account: account.id, owner: input.owner });
            if (existing === undefined) {
              yield* query(() => tx.create("accounts", { ...saved, encryptedCredentials }));
              if (lifecycle) yield* lifecycle.accountCreated(saved);
            } else
              yield* query(() =>
                tx.updateMany("accounts", {
                  where: (b) => b("id", "=", saved.id),
                  set: { encryptedCredentials },
                }),
              );
            const state = {
              encrypted: encryptedGrant,
              status: ready,
              updatedAt: new Date(completedAt),
            };
            yield* query(() =>
              tx.upsert("oauthGrants", {
                where: (b) => b("id", "=", saved.id),
                create: { id: saved.id, ...state },
                update: state,
              }),
            );
            if (lifecycle) yield* lifecycle.connectionCompleting(input.connection);
            yield* finishConnection(tx, input, saved);
            yield* saveClient(tx);
            return saved;
          }),
        );
        return { status: "completed" as const, account: saved };
      }
      if (redirect === undefined)
        return yield* new OAuthSetupFailed({ reason: "invalid_redirect" });
      if (input.client === undefined) yield* saveClient(db);
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
        ...(input.client === undefined ? {} : { clientKey: clientId }),
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
      return {
        status: "redirect" as const,
        authorizationUrl: HttpUrl.make(authorization.authorizationUrl),
        expiresAt,
      };
    }).pipe(Effect.withSpan("oauth.beginOAuth"));

  const startOAuth = (input: typeof StartConnectionOAuth.Type) =>
    Effect.gen(function* () {
      const saved = yield* readConnection(db, input);
      if (saved.state.status === "completed")
        return { status: "completed" as const, account: saved.state.account };
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
      yield* Effect.annotateCurrentSpan("oauth.provider.id", attempt.provider);
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
        return yield* new OAuthCompletionFailed({
          reason: ["invalid_client", "unauthorized_client"].includes(
            callback.searchParams.get("error") ?? "",
          )
            ? "invalid_client"
            : "denied",
        });
      if (attempt.reconnect) yield* reconnectTarget(db, attempt);
      const tokens = yield* protocol.exchange(attempt, callback).pipe(
        Effect.mapError(
          (error) =>
            new OAuthCompletionFailed({
              reason: error.reason === "invalid_client" ? "invalid_client" : "exchange_failed",
            }),
        ),
      );
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
      const savedClient =
        attempt.clientKey === undefined
          ? undefined
          : {
              id: attempt.clientKey,
              encrypted: yield* encrypt(attempt.clientKey, attempt.client),
            };
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
          } else {
            yield* query(() => tx.create("accounts", { ...saved, encryptedCredentials }));
            if (lifecycle) yield* lifecycle.accountCreated(saved);
          }
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
          if (lifecycle) yield* lifecycle.connectionCompleting(input.connection);
          yield* finishConnection(tx, input, saved);
          if (savedClient !== undefined)
            yield* query(() =>
              tx.upsert("oauthClients", {
                where: (b) => b("id", "=", savedClient.id),
                create: savedClient,
                update: { encrypted: savedClient.encrypted },
              }),
            );
          return saved;
        }),
      );
    }).pipe(Effect.withSpan("oauth.completeOAuth"));

  const resolveCredentials = (account: StoredAccount, provider: ProviderDefinition) =>
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
        const renewable = grant.grant === "client_credentials" || grant.refreshToken !== undefined;
        if (
          grant.expiresAt === undefined ||
          grant.expiresAt > now + 30_000 ||
          (!renewable && grant.expiresAt > now)
        )
          return Redacted.make(grant.fields);
        if (protocol === undefined) return yield* reconnect();
        const renewal =
          grant.grant === "client_credentials"
            ? protocol.clientCredentials(grant)
            : grant.refreshToken === undefined
              ? undefined
              : protocol.refresh({ ...grant, refreshToken: grant.refreshToken });
        if (renewal === undefined) return yield* reconnect();
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
        const result = yield* renewal.pipe(
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
          ...(grant.grant === "client_credentials"
            ? {}
            : { refreshToken: tokens.refresh_token ?? grant.refreshToken }),
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

  const resolve = (account: StoredAccount, provider: ProviderDefinition) =>
    Effect.gen(function* () {
      if (lifecycle) yield* lifecycle.accountResolving(account);
      const fields = yield* resolveCredentials(account, provider);
      // A remote token refresh can outlive a permission change or account deletion.
      if (lifecycle) yield* lifecycle.accountResolving(account);
      return fields;
    });
  return { connections: { oauthSetup, startOAuth, completeOAuth }, resolve };
};
