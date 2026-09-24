import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Synthetic issuer through the production HTTP seam, with real SQLite and credential encryption. */
import { defaultUrlPolicy, HttpOrigin, type UrlPolicy } from "@executor-js/utils/url-policy";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { pgliteLayer } from "fumadb-effect/pglite";
import { SqlClient } from "effect/unstable/sql";
import { Context, Deferred, Effect, Exit, Layer, Redacted, Schema, Scope } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  BuildId,
  OwnerId,
  ToolName,
  createExecutor,
  makeExecutorStorage,
  runtimeAdapter,
  RuntimeProtocolFailed,
  type BuiltApp,
  type ProviderDefinition,
  type AccountConnectionId,
  type AccountId,
  type Executor,
} from "../src/index.ts";
import {
  aesGcmCredentials as credentials,
  OAuthSetupFailed,
  OAuthCompletionFailed,
  type HostOAuthClient,
} from "@executor-js/sdk/core";
import { accountSignIn } from "../../../apps/local/server/src/implementation/account-status.ts";

const issuerUrl = "https://issuer.example";
const resourceUrl = "https://service.example/mcp";
const redirectUri = "http://127.0.0.1:4312/oauth/callback";
const definition: ProviderDefinition = {
  name: "Synthetic service",
  auth: {
    oauth: {
      type: "oauth2",
      discover: resourceUrl,
      response: {
        type: "object",
        properties: { access_token: { type: "string" } },
        required: ["access_token"],
        additionalProperties: false,
      },
    },
    apiKey: {
      type: "secrets",
      label: "API key",
      fields: {
        type: "object",
        properties: { token: { type: "string", minLength: 1 } },
        required: ["token"],
        additionalProperties: false,
      },
    },
  },
};

/**
 * How the synthetic service publishes metadata. "none" has no protected-resource metadata and
 * serves authorization-server metadata only at the origin root, like Atlassian's MCP server.
 */
type Discovery = "path" | "challenge" | "origin" | "none";

function issuer(
  mode: "dcr" | "cimd" | "manual",
  discovery: Discovery = "path",
  offlineAccess = false,
  urls = { issuer: issuerUrl, resource: resourceUrl, redirect: redirectUri },
) {
  let registrations = 0;
  let exchanges = 0;
  let refreshes = 0;
  let rejected = false;
  const pauses = new Map<
    string,
    { reached: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
  >();
  const pause = (operation: string) =>
    Effect.gen(function* () {
      const held = pauses.get(operation);
      if (held === undefined) return;
      pauses.delete(operation);
      yield* Deferred.succeed(held.reached, undefined);
      yield* Deferred.await(held.release);
    });
  const codes = new Map<string, URL>();
  const usedRefreshTokens = new Set<string>();
  const requestClients: string[] = [];
  const registrationScopes: string[] = [];
  const discoveryRequests: string[] = [];
  const clientSecrets: string[] = [];
  // Fixed replies by URL, for services that answer differently from this issuer.
  const replies = new Map<string, { body: unknown; status: number }>();
  const canonicalResource =
    discovery === "none"
      ? null
      : discovery === "path"
        ? urls.resource
        : new URL(urls.resource).origin;
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
      const url = new URL(web.url);
      const text = yield* Effect.promise(() => web.text());
      let response: Response;
      if (web.method === "GET") discoveryRequests.push(url.href);
      const reply = replies.get(url.href);
      if (reply !== undefined) response = json(reply.body, reply.status);
      else if (url.href === urls.resource)
        response =
          discovery === "challenge"
            ? new Response(null, {
                status: 401,
                headers: {
                  "www-authenticate":
                    'Basic realm="other", Bearer resource_metadata="https://metadata.example/resource"',
                },
              })
            : json({}, 404);
      else if (
        discovery !== "none" &&
        (url.href === "https://metadata.example/resource" ||
          url.href === new URL("/.well-known/oauth-protected-resource", urls.resource).href)
      )
        response = json({
          resource: canonicalResource,
          authorization_servers: [urls.issuer],
          scopes_supported: ["read"],
        });
      else if (
        discovery !== "none" &&
        url.href === new URL("/.well-known/oauth-protected-resource/mcp", urls.resource).href
      )
        response =
          discovery === "origin"
            ? json({}, 404)
            : json({
                resource: urls.resource,
                authorization_servers: [urls.issuer],
                scopes_supported: ["read"],
              });
      else if (url.href === `${urls.issuer}/.well-known/oauth-authorization-server`)
        response = json({
          issuer: urls.issuer,
          authorization_endpoint: `${urls.issuer}/authorize`,
          token_endpoint: `${urls.issuer}/token`,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
          scopes_supported: ["read", "profile", ...(offlineAccess ? ["offline_access"] : [])],
          ...(mode === "dcr" ? { registration_endpoint: `${urls.issuer}/register` } : {}),
          ...(mode === "cimd" ? { client_id_metadata_document_supported: true } : {}),
        });
      else if (url.pathname === "/register") {
        registrations++;
        const metadata = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
        )(text);
        assert.deepEqual(metadata.redirect_uris, [urls.redirect]);
        // Without resource metadata, only the issuer's offline access adds a scope.
        const scopes = [
          ...(discovery === "none" ? [] : ["read"]),
          ...(offlineAccess ? ["offline_access"] : []),
        ];
        assert.equal(metadata.scope, scopes.length === 0 ? undefined : scopes.join(" "));
        registrationScopes.push(String(metadata.scope));
        response = json({ ...metadata, client_id: `registered-${registrations}` }, 201);
      } else if (url.pathname === "/token") {
        const body = new URLSearchParams(text);
        assert.equal(body.get("resource"), canonicalResource);
        if (body.get("grant_type") === "authorization_code") {
          const code = body.get("code");
          const authorization = code === null ? undefined : codes.get(code);
          assert.ok(authorization);
          assert.ok(code);
          codes.delete(code);
          const verifier = body.get("code_verifier");
          assert.ok(verifier);
          const digest = yield* Effect.promise(() =>
            crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
          );
          assert.equal(
            Buffer.from(digest).toString("base64url"),
            authorization.searchParams.get("code_challenge"),
          );
          assert.equal(body.get("redirect_uri"), urls.redirect);
          const clientId = authorization.searchParams.get("client_id");
          assert.ok(clientId);
          const basic = web.headers.get("authorization");
          const basicCredentials =
            basic !== null && basic.startsWith("Basic ")
              ? atob(basic.slice(6)).split(":").map(decodeURIComponent)
              : undefined;
          if (mode === "manual")
            assert.deepEqual(basicCredentials, ["manual-client", "synthetic-client-secret"]);
          else if (basicCredentials === undefined) assert.equal(body.get("client_id"), clientId);
          else {
            assert.equal(basicCredentials[0], clientId);
            clientSecrets.push(String(basicCredentials[1]));
          }
          requestClients.push(clientId);
          exchanges++;
          yield* pause("exchange");
          const refreshAllowed =
            !offlineAccess ||
            (authorization.searchParams.get("scope")?.split(" ").includes("offline_access") &&
              registrationScopes.includes("read offline_access"));
          response = json({
            access_token: `access-${exchanges}`,
            ...(refreshAllowed ? { refresh_token: `refresh-${exchanges}` } : {}),
            token_type: "Bearer",
            expires_in: 1,
            client_secret: "never-expose-this",
            ignored: "never-project-this",
          });
        } else {
          refreshes++;
          const refreshToken = body.get("refresh_token");
          assert.ok(refreshToken);
          assert.ok(!usedRefreshTokens.has(refreshToken), "rotating refresh token was replayed");
          usedRefreshTokens.add(refreshToken);
          const shouldReject = rejected;
          yield* pause("refresh");
          response = shouldReject
            ? json({ error: "invalid_grant" }, 400)
            : json({
                access_token: `fresh-${refreshToken}`,
                refresh_token: `rotated-${refreshToken}`,
                token_type: "Bearer",
                expires_in: 3600,
              });
        }
      } else response = json({ error: "not_found" }, 404);
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  return {
    httpClient,
    requestClients,
    discoveryRequests,
    registrationScopes,
    /** Secrets that registered clients sent with HTTP Basic authentication at the token endpoint. */
    clientSecrets,
    /** Answer every later request to `url` with this JSON body instead of the issuer's behavior. */
    reply(url: string, body: unknown, status = 200) {
      replies.set(url, { body, status });
    },
    get registrations() {
      return registrations;
    },
    get exchanges() {
      return exchanges;
    },
    get refreshes() {
      return refreshes;
    },
    rejectRefresh() {
      rejected = true;
    },
    allowRefresh() {
      rejected = false;
    },
    pauseNext(operation: "exchange" | "refresh") {
      const held = {
        reached: Effect.runSync(Deferred.make<void>()),
        release: Effect.runSync(Deferred.make<void>()),
      };
      pauses.set(operation, held);
      return {
        started: Effect.runPromise(Deferred.await(held.reached)),
        release: () => Effect.runPromise(Deferred.succeed(held.release, undefined)),
      };
    },
    callback(authorizationUrl: string) {
      const authorization = new URL(authorizationUrl);
      const code = crypto.randomUUID();
      codes.set(code, authorization);
      const callback = new URL(urls.redirect);
      const state = authorization.searchParams.get("state");
      assert.ok(state);
      callback.searchParams.set("state", state);
      callback.searchParams.set("code", code);
      return callback.href;
    },
  };
}

async function setup(
  mode: "dcr" | "cimd" | "manual",
  discovery: Discovery = "path",
  offlineAccess = false,
  settings: {
    redirect?: string;
    issuer?: string;
    resource?: string;
    urlPolicy?: UrlPolicy;
    /** Provider method options declared by the app. */
    method?: { tokenEndpointAuthMethod?: "client_secret_basic"; scopes?: string[] };
    hostClients?: ReadonlyArray<HostOAuthClient>;
  } = {},
) {
  const scope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(pgliteLayer(), scope));
  const sql = Context.get(context, SqlClient.SqlClient);
  const storage = await Effect.runPromise(
    makeExecutorStorage({ provider: "postgresql" }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(Scope.Scope, scope),
    ),
  );
  await Effect.runPromise(storage.migrate);
  const credentialStore = await Effect.runPromise(
    credentials(Redacted.make("ab".repeat(32)), crypto),
  );
  const urls = {
    issuer: settings.issuer ?? issuerUrl,
    resource: settings.resource ?? resourceUrl,
    redirect: settings.redirect ?? redirectUri,
  };
  const service = issuer(mode, discovery, offlineAccess, urls);
  const seen: unknown[] = [];
  let requirements: BuiltApp["requirements"] = {
    accounts: {
      service: {
        definition: {
          ...definition,
          auth: {
            ...definition.auth,
            oauth: {
              type: "oauth2",
              discover: urls.resource,
              ...(mode === "manual"
                ? { tokenEndpointAuthMethod: "client_secret_basic" as const }
                : {}),
              ...settings.method,
              response: {
                type: "object",
                properties: { access_token: { type: "string" } },
                required: ["access_token"],
                additionalProperties: false,
              },
            },
          },
        },
        cardinality: "one",
      },
    },
  };
  const runtime = runtimeAdapter({
    build: () => Effect.succeed({ build: BuildId.make("bld_oauth_test"), requirements }),
    query: () => Effect.fail(new RuntimeProtocolFailed()),
    mutate: () => Effect.fail(new RuntimeProtocolFailed()),
    workflow: () => Effect.die("Unexpected workflow invocation"),
    webhook: () => Effect.die("Unexpected webhook invocation"),
    skills: () => Effect.die("This fixture does not load skills"),
    inspect: ({ accounts }) =>
      Effect.sync(() => {
        seen.push(Redacted.value(accounts));
        return [];
      }),
    call: ({ accounts }) =>
      Effect.sync(() => {
        seen.push(Redacted.value(accounts));
        return { ok: true };
      }),
  });
  const options = {
    blobs: memoryBlobStore(),
    sources: memorySourceStorage(),
    storage,
    credentials: credentialStore,
    runtime,
    oauth: {
      httpClient: service.httpClient,
      clientName: "Executor test",
      urlPolicy: settings.urlPolicy ?? defaultUrlPolicy,
      ...(mode === "cimd" ? { clientMetadataUrl: "https://client.example/oauth.json" } : {}),
      ...(settings.hostClients === undefined ? {} : { hostClients: settings.hostClients }),
    },
  };
  const executor = await createExecutor(options);
  const secondExecutor = await createExecutor(options);
  const { app } = await executor.apps.deploy({
    owner: OwnerId.make("project"),
    name: "OAuth test",
    files: [{ path: "index.ts", content: "// Test runtime seam" }],
  });
  const profile = await executor.apps.profiles.create({
    app: app.id,
    owner: app.owner,
    subject: "alice",
    idempotencyKey: "test",
    accounts: {},
  });
  const provider = app.requirements.accounts.service?.provider;
  assert.ok(provider);
  // The product retains the connection ID across the provider redirect.
  const requests = new Map<string, AccountConnectionId>();
  const startOAuth = async (
    input: {
      owner: OwnerId;
      provider: typeof provider;
      method: string;
      label: string;
      redirectUri: string;
      account?: AccountId;
      client?: {
        clientId: string;
        clientSecret: string;
      };
    },
    host: Executor = executor,
  ) => {
    const connection = await host.accountConnections.create(input);
    const signIn = await host.accountConnections.startOAuth({
      ...input,
      connection: connection.id,
    });
    assert.ok(signIn.status === "redirect");
    const state = new URL(signIn.authorizationUrl).searchParams.get("state");
    assert.ok(state);
    requests.set(state, connection.id);
    return { ...signIn, connection: connection.id };
  };
  const start = (owner = "alice") =>
    startOAuth({
      owner: OwnerId.make(owner),
      provider,
      method: "oauth",
      label: owner,
      redirectUri: urls.redirect,
      ...(mode === "manual"
        ? {
            client: {
              clientId: "manual-client",
              clientSecret: "synthetic-client-secret",
            },
          }
        : {}),
    });
  const complete = ({ callbackUrl }: { callbackUrl: string }, host: Executor = executor) => {
    const state = new URL(callbackUrl).searchParams.get("state");
    const connection = state === null ? undefined : requests.get(state);
    assert.ok(connection);
    return host.accountConnections.completeOAuth({ connection, callbackUrl });
  };
  const reconnect = async (
    input: { account: AccountId; owner?: OwnerId; redirectUri: string },
    host: Executor = executor,
  ) => {
    const account = await host.accounts.get(input);
    return startOAuth(
      {
        owner: account.owner,
        provider: account.provider,
        method: account.method,
        label: account.label,
        account: account.id,
        redirectUri: input.redirectUri,
      },
      host,
    );
  };
  return {
    executor,
    secondExecutor,
    profile,
    storage,
    service,
    app,
    provider,
    seen,
    start,
    startOAuth,
    complete,
    reconnect,
    credentialStore,
    setRequirements: (next: BuiltApp["requirements"]) => {
      requirements = next;
    },
    signIn: accountSignIn(storage, credentialStore),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

const completionFailed = (reason: OAuthCompletionFailed["reason"]) => (error: unknown) =>
  Schema.is(OAuthCompletionFailed)(error) && error.reason === reason;

/** The failure of an operation that must fail, for assertions on its fields. */
const rejection = (operation: Promise<unknown>) =>
  operation.then(
    () => assert.fail("expected the operation to fail"),
    (error: unknown) => error,
  );

test("host OAuth clients serve only their exact endpoints and are never saved for an owner", async () => {
  const client = {
    client_id: "manual-client",
    client_secret: "synthetic-client-secret",
    token_endpoint_auth_method: "client_secret_basic" as const,
  };
  const f = await setup("manual", "path", false, {
    hostClients: [
      {
        authorizationEndpoint: `${issuerUrl}/authorize`,
        tokenEndpoint: `${issuerUrl}/token`,
        client,
      },
    ],
  });
  try {
    const owner = OwnerId.make("alice");
    const check = { owner, provider: f.provider, method: "oauth", redirectUri };
    assert.equal((await f.executor.accountConnections.oauthSetup(check)).mode, "automatic");
    const signIn = await f.startOAuth({ ...check, label: "Work" });
    assert.equal(new URL(signIn.authorizationUrl).searchParams.get("client_id"), "manual-client");
    await f.complete({ callbackUrl: f.service.callback(signIn.authorizationUrl) });
    assert.equal(f.service.exchanges, 1);
    assert.equal(f.service.registrations, 0);
    assert.equal((await f.executor.accountConnections.oauthSetup(check)).mode, "automatic");
  } finally {
    await f.close();
  }
  const elsewhere = await setup("manual", "path", false, {
    hostClients: [
      {
        authorizationEndpoint: "https://github.com/login/oauth/authorize",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        client,
      },
    ],
  });
  try {
    const check = {
      owner: OwnerId.make("alice"),
      provider: elsewhere.provider,
      method: "oauth",
      redirectUri,
    };
    assert.equal(
      (await elsewhere.executor.accountConnections.oauthSetup(check)).mode,
      "client-required",
    );
  } finally {
    await elsewhere.close();
  }
});

test("remote HTTP discovery and token endpoints are rejected before OAuth network requests", async () => {
  const f = await setup("dcr");
  try {
    const definitions: readonly ProviderDefinition[] = [
      {
        name: "Insecure discovery",
        auth: {
          oauth: {
            type: "oauth2",
            discover: "http://service.example/mcp",
            response: { type: "object" },
          },
        },
      },
      {
        name: "Insecure token",
        auth: {
          oauth: {
            type: "oauth2",
            authorizationUrl: "https://issuer.example/authorize",
            tokenUrl: "http://issuer.example/token",
            scopes: [],
            response: { type: "object" },
          },
        },
      },
    ];
    for (const definition of definitions) {
      f.setRequirements({ accounts: { service: { definition, cardinality: "one" } } });
      const { app } = await f.executor.apps.deploy({
        owner: f.app.owner,
        app: f.app.id,
        files: [{ path: "index.ts", content: "// Invalid OAuth endpoint fixture" }],
      });
      const provider = app.requirements.accounts.service?.provider;
      assert.ok(provider);
      await assert.rejects(
        f.startOAuth({
          owner: app.owner,
          provider,
          method: "oauth",
          label: "Default",
          redirectUri,
        }),
        (error) => Schema.is(OAuthSetupFailed)(error) && error.reason === "discovery_blocked",
      );
    }
    assert.equal(f.service.discoveryRequests.length, 0);
    assert.equal(f.service.registrations, 0);
    assert.equal(f.service.exchanges, 0);
  } finally {
    await f.close();
  }
});

test("dashboard reports expired sign-ins before tool discovery without refreshing or exposing credentials", async () => {
  const f = await setup("dcr");
  try {
    const account = await f.complete({
      callbackUrl: f.service.callback((await f.start()).authorizationUrl),
    });
    assert.deepEqual(await Effect.runPromise(f.signIn(account, definition)), {
      state: "saved",
      reconnectAt: null,
    });
    const db = f.storage.orm("4.0.0");
    const row = await Effect.runPromise(
      db.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
    );
    assert.ok(row);
    const decrypted = await Effect.runPromise(
      f.credentialStore.decrypt(account.id, Redacted.make(row.encrypted)),
    );
    const { refreshToken: _refreshToken, ...grant } = Redacted.value(decrypted);
    const future = Date.now() + 60_000;
    for (const expiresAt of [future, 0]) {
      const encrypted = await Effect.runPromise(
        f.credentialStore.encrypt(account.id, Redacted.make({ ...grant, expiresAt })),
      );
      await Effect.runPromise(
        db.updateMany("oauthGrants", {
          where: (b) => b("id", "=", account.id),
          set: { encrypted },
        }),
      );
      assert.deepEqual(
        await Effect.runPromise(f.signIn(account, definition)),
        expiresAt === 0
          ? { state: "reconnect" }
          : { state: "saved", reconnectAt: new Date(future) },
      );
    }
    assert.equal(f.service.refreshes, 0);
    assert.equal(f.seen.length, 0);
    await f.executor.apps.profiles.update({
      profile: f.profile.id,
      expectedRevision: (
        await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
      ).revision,
      app: f.app.id,
      accounts: { service: account.id },
    });
    await assert.rejects(f.executor.tools.list({ profile: f.profile.id, app: f.app.id }), {
      _tag: "OAuthReconnectRequired",
    });
    const callbackUrl = f.service.callback(
      (await f.reconnect({ account: account.id, redirectUri })).authorizationUrl,
    );
    await f.complete({ callbackUrl });
    assert.deepEqual(await Effect.runPromise(f.signIn(account, definition)), {
      state: "saved",
      reconnectAt: null,
    });
  } finally {
    await f.close();
  }
});

for (const offlineAccess of [false, true])
  test(`issuer ${offlineAccess ? "advertising" : "without"} offline access preserves resource scopes and refreshes accounts`, async () => {
    const f = await setup("dcr", "path", offlineAccess);
    try {
      const signIn = await f.start();
      const scope = offlineAccess ? "read offline_access" : "read";
      assert.equal(new URL(signIn.authorizationUrl).searchParams.get("scope"), scope);
      assert.deepEqual(f.service.registrationScopes, [scope]);
      const account = await f.complete({
        callbackUrl: f.service.callback(signIn.authorizationUrl),
      });
      await f.executor.apps.profiles.update({
        profile: f.profile.id,
        expectedRevision: (
          await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
        ).revision,
        app: f.app.id,
        accounts: { service: account.id },
      });
      await f.executor.tools.list({ profile: f.profile.id, app: f.app.id });
      assert.equal(f.service.refreshes, 1);
      assert.equal(f.seen.length, 1);
      const reconnected = await f.reconnect({ account: account.id, redirectUri });
      assert.equal(new URL(reconnected.authorizationUrl).searchParams.get("scope"), scope);
      assert.equal(f.service.registrations, 1, "unchanged registration scopes reuse the client");
    } finally {
      await f.close();
    }
  });

test("DCR, one-time callback, two owners, and coordinated refresh preserve reusable accounts", async () => {
  const f = await setup("dcr");
  try {
    const first = await f.start();
    assert.deepEqual(await f.executor.accounts.list(), []);
    const callbackUrl = f.service.callback(first.authorizationUrl);
    const completions = await Promise.allSettled([
      f.complete({ callbackUrl }),
      f.complete({ callbackUrl }, f.secondExecutor),
    ]);
    const completed = completions.find((result) => result.status === "fulfilled");
    assert.ok(completed?.status === "fulfilled");
    assert.equal(completions.filter((result) => result.status === "rejected").length, 1);
    const alice = completed.value;
    assert.equal(alice.owner, "alice");
    assert.equal(f.service.exchanges, 1);
    const next = await f.start();
    assert.equal(f.service.registrations, 1, "same owner reuses its registered client");
    const bobStart = await f.start("bob");
    assert.equal(f.service.registrations, 2);
    const bob = await f.complete({ callbackUrl: f.service.callback(bobStart.authorizationUrl) });
    assert.notEqual(alice.id, bob.id);
    assert.deepEqual(
      (await f.executor.accounts.list({ owner: OwnerId.make("alice") })).map(
        (account) => account.id,
      ),
      [alice.id],
    );
    await f.executor.apps.profiles.update({
      profile: f.profile.id,
      expectedRevision: (
        await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
      ).revision,
      app: f.app.id,
      accounts: { service: alice.id },
    });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 ? f.executor : f.secondExecutor).tools.call({
          profile: f.profile.id,
          app: f.app.id,
          tool: ToolName.make("inspect"),
        }),
      ),
    );
    assert.equal(f.service.refreshes, 1);
    assert.equal((await f.executor.accounts.get({ account: alice.id })).id, alice.id);
    for (const seen of f.seen) {
      assert.deepEqual(
        Schema.decodeUnknownSync(
          Schema.Struct({
            service: Schema.Struct({ fields: Schema.Record(Schema.String, Schema.String) }),
          }),
        )(seen).service.fields,
        { access_token: "fresh-refresh-1" },
      );
    }
    const wrong = new URL(f.service.callback(next.authorizationUrl));
    wrong.pathname = "/wrong";
    await assert.rejects(
      f.complete({ callbackUrl: wrong.href }),
      completionFailed("invalid_callback"),
    );
    const accounts = await f.executor.accounts.list();
    assert.ok(!JSON.stringify(accounts).includes("refresh-"));
    for (const row of await Effect.runPromise(f.storage.orm("4.0.0").findMany("oauthGrants", {})))
      assert.ok(!new TextDecoder().decode(row.encrypted).includes("refresh-"));
  } finally {
    await f.close();
  }
});

for (const mode of ["cimd", "manual"] as const)
  test(`${mode} clients complete OAuth and keep host-only secrets private`, async () => {
    const f = await setup(mode);
    try {
      if (mode === "manual")
        await assert.rejects(
          f.startOAuth({
            owner: OwnerId.make("alice"),
            provider: f.provider,
            method: "oauth",
            label: "Alice",
            redirectUri,
          }),
          { _tag: "OAuthClientUnavailable" },
        );
      const signIn = await f.start();
      const account = await f.complete({
        callbackUrl: f.service.callback(signIn.authorizationUrl),
      });
      assert.equal(
        f.service.requestClients[0],
        mode === "cimd" ? "https://client.example/oauth.json" : "manual-client",
      );
      assert.equal(f.service.registrations, 0);
      const reused = await f.startOAuth({
        owner: OwnerId.make("alice"),
        provider: f.provider,
        method: "oauth",
        label: "Alice again",
        redirectUri,
      });
      assert.equal(
        new URL(reused.authorizationUrl).searchParams.get("client_id"),
        f.service.requestClients[0],
      );
      await f.executor.apps.profiles.update({
        profile: f.profile.id,
        expectedRevision: (
          await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
        ).revision,
        app: f.app.id,
        accounts: { service: account.id },
      });
      f.service.rejectRefresh();
      await assert.rejects(f.executor.tools.list({ profile: f.profile.id, app: f.app.id }), {
        _tag: "OAuthReconnectRequired",
        account: account.id,
      });
      assert.equal((await f.executor.accounts.get({ account: account.id })).id, account.id);
      await assert.rejects(f.executor.tools.list({ profile: f.profile.id, app: f.app.id }), {
        _tag: "OAuthReconnectRequired",
      });
      assert.equal(f.service.refreshes, 1);
    } finally {
      await f.close();
    }
  });

test("denied, expired and modified callbacks never create an account", async () => {
  const f = await setup("dcr");
  try {
    const denied = new URL(f.service.callback((await f.start()).authorizationUrl));
    denied.searchParams.delete("code");
    denied.searchParams.set("error", "access_denied");
    await assert.rejects(f.complete({ callbackUrl: denied.href }), completionFailed("denied"));
    await assert.rejects(
      f.complete({ callbackUrl: denied.href }),
      completionFailed("sign_in_expired"),
    );
    const expiring = f.service.callback((await f.start()).authorizationUrl);
    await Effect.runPromise(
      f.storage.orm("4.0.0").updateMany("oauthAttempts", { set: { expiresAt: new Date(0) } }),
    );
    await assert.rejects(
      f.complete({ callbackUrl: expiring }),
      completionFailed("sign_in_expired"),
    );
    const modified = new URL(expiring);
    modified.searchParams.set("state", "changed");
    await assert.rejects(
      f.executor.accountConnections.completeOAuth({
        connection: (await f.start()).connection,
        callbackUrl: modified.href,
      }),
      completionFailed("invalid_callback"),
    );
    assert.equal(f.service.exchanges, 0);
    assert.deepEqual(await f.executor.accounts.list(), []);
  } finally {
    await f.close();
  }
});

for (const discovery of ["challenge", "origin"] as const)
  test(`${discovery} metadata keeps the canonical resource through authorization, exchange and refresh`, async () => {
    const f = await setup("dcr", discovery);
    try {
      const signIn = await f.start();
      assert.equal(
        new URL(signIn.authorizationUrl).searchParams.get("resource"),
        "https://service.example",
      );
      if (discovery === "challenge") {
        assert.ok(f.service.discoveryRequests.includes("https://metadata.example/resource"));
        assert.ok(
          !f.service.discoveryRequests.includes(
            "https://service.example/.well-known/oauth-protected-resource/mcp",
          ),
        );
      }
      const account = await f.complete({
        callbackUrl: f.service.callback(signIn.authorizationUrl),
      });
      await f.executor.apps.profiles.update({
        profile: f.profile.id,
        expectedRevision: (
          await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
        ).revision,
        app: f.app.id,
        accounts: { service: account.id },
      });
      await f.executor.tools.list({ profile: f.profile.id, app: f.app.id });
      assert.equal(f.service.exchanges, 1);
      assert.equal(f.service.refreshes, 1);
    } finally {
      await f.close();
    }
  });

test("OAuth reconnect keeps identity, current name and all app selections; denial preserves credentials", async () => {
  const f = await setup("dcr");
  try {
    const account = await f.complete({
      callbackUrl: f.service.callback((await f.start()).authorizationUrl),
    });
    const second = await f.executor.apps.copy({
      from: f.app.id,
      owner: OwnerId.make("project"),
      name: "Second",
    });
    const secondProfile = await f.executor.apps.profiles.create({
      app: second.id,
      owner: second.owner,
      subject: "alice",
      idempotencyKey: "test",
      accounts: {},
    });
    const configured = [
      { app: f.app, profile: f.profile },
      { app: second, profile: secondProfile },
    ];
    for (const { app, profile } of configured)
      await f.executor.apps.profiles.update({
        profile: profile.id,
        expectedRevision: (await f.executor.apps.profiles.get({ app: app.id, profile: profile.id }))
          .revision,
        app: app.id,
        accounts: { service: account.id },
      });
    await assert.rejects(
      f.reconnect({ account: account.id, owner: OwnerId.make("bob"), redirectUri }),
      { _tag: "AccountNotFound" },
    );
    await assert.rejects(
      f.executor.accounts.replaceCredentials({
        account: account.id,
        fields: { access_token: "injected" },
      }),
      { _tag: "AuthMethodInvalid" },
    );
    const before = await Effect.runPromise(
      f.storage.orm("4.0.0").findFirst("accounts", { where: (b) => b("id", "=", account.id) }),
    );
    const denied = new URL(
      f.service.callback(
        (await f.reconnect({ account: account.id, redirectUri })).authorizationUrl,
      ),
    );
    denied.searchParams.delete("code");
    denied.searchParams.set("error", "access_denied");
    await assert.rejects(f.complete({ callbackUrl: denied.href }), completionFailed("denied"));
    assert.deepEqual(
      await Effect.runPromise(
        f.storage.orm("4.0.0").findFirst("accounts", { where: (b) => b("id", "=", account.id) }),
      ),
      before,
    );

    const reconnect = await f.reconnect({ account: account.id, redirectUri });
    await f.executor.accounts.update({ account: account.id, label: "Renamed during consent" });
    const callbackUrl = f.service.callback(reconnect.authorizationUrl);
    const connected = await f.complete({ callbackUrl });
    assert.deepEqual(connected, { ...account, label: "Renamed during consent" });
    assert.equal((await f.executor.accounts.list()).length, 1);
    assert.equal(f.service.registrations, 1);
    for (const { app, profile } of configured) {
      assert.equal(
        (await f.executor.apps.profiles.get({ app: app.id, profile: profile.id })).accounts.service,
        account.id,
      );
      await f.executor.tools.list({ profile: profile.id, app: app.id });
    }
    assert.ok(f.seen.every((seen) => JSON.stringify(seen).includes("fresh-refresh-2")));
    assert.deepEqual(await f.complete({ callbackUrl }), connected);
  } finally {
    await f.close();
  }
});

for (const phase of ["consent", "exchange"] as const)
  test(
    `disconnect during OAuth ${phase} cannot recreate an account`,
    { timeout: 10_000 },
    async () => {
      const f = await setup("dcr");
      try {
        const account = await f.complete({
          callbackUrl: f.service.callback((await f.start()).authorizationUrl),
        });
        await f.executor.apps.profiles.update({
          profile: f.profile.id,
          expectedRevision: (
            await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
          ).revision,
          app: f.app.id,
          accounts: { service: account.id },
        });
        const callbackUrl = f.service.callback(
          (await f.reconnect({ account: account.id, redirectUri })).authorizationUrl,
        );
        if (phase === "exchange") {
          const paused = f.service.pauseNext("exchange");
          const result = assert.rejects(
            f.complete({ callbackUrl }),
            completionFailed("account_unavailable"),
          );
          await paused.started;
          await f.executor.accounts.remove({ account: account.id });
          await paused.release();
          await result;
        } else {
          await f.executor.accounts.remove({ account: account.id });
          await assert.rejects(
            f.complete({ callbackUrl }),
            completionFailed("account_unavailable"),
          );
        }
        await f.executor.accounts.remove({ account: account.id });
        assert.deepEqual(await f.executor.accounts.list(), []);
        assert.deepEqual(
          await Effect.runPromise(f.storage.orm("4.0.0").findMany("oauthGrants", {})),
          [],
        );
        assert.equal(
          (await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })).accounts
            .service,
          account.id,
        );
        await assert.rejects(f.executor.tools.list({ profile: f.profile.id, app: f.app.id }), {
          _tag: "AccountNotFound",
        });
      } finally {
        await f.close();
      }
    },
  );

for (const failed of [false, true])
  test(
    `a ${failed ? "failed" : "successful"} stale refresh cannot replace a reconnected grant`,
    { timeout: 10_000 },
    async () => {
      const f = await setup("dcr");
      try {
        const account = await f.complete({
          callbackUrl: f.service.callback((await f.start()).authorizationUrl),
        });
        await f.executor.apps.profiles.update({
          profile: f.profile.id,
          expectedRevision: (
            await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
          ).revision,
          app: f.app.id,
          accounts: { service: account.id },
        });
        if (failed) f.service.rejectRefresh();
        const paused = f.service.pauseNext("refresh");
        const listing = f.executor.tools.list({ profile: f.profile.id, app: f.app.id });
        await paused.started;
        const callbackUrl = f.service.callback(
          (await f.reconnect({ account: account.id, redirectUri }, f.secondExecutor))
            .authorizationUrl,
        );
        await f.complete({ callbackUrl }, f.secondExecutor);
        f.service.allowRefresh();
        await paused.release();
        await listing;
        assert.equal(f.seen.length, 1);
        assert.ok(JSON.stringify(f.seen[0]).includes("fresh-refresh-2"));
        assert.equal(f.service.refreshes, 2);
        await f.secondExecutor.tools.list({ profile: f.profile.id, app: f.app.id });
        assert.equal(f.service.refreshes, 2, "the newly refreshed grant remains saved");
      } finally {
        await f.close();
      }
    },
  );

test(
  "disconnect during refresh deletes credentials and does not invoke app code",
  { timeout: 10_000 },
  async () => {
    const f = await setup("dcr");
    try {
      const account = await f.complete({
        callbackUrl: f.service.callback((await f.start()).authorizationUrl),
      });
      await f.executor.apps.profiles.update({
        profile: f.profile.id,
        expectedRevision: (
          await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
        ).revision,
        app: f.app.id,
        accounts: { service: account.id },
      });
      const paused = f.service.pauseNext("refresh");
      const listing = assert.rejects(
        f.executor.tools.list({ profile: f.profile.id, app: f.app.id }),
        {
          _tag: "OAuthReconnectRequired",
        },
      );
      await paused.started;
      await f.secondExecutor.accounts.remove({ account: account.id });
      await paused.release();
      await listing;
      assert.deepEqual(await f.executor.accounts.list(), []);
      assert.deepEqual(
        await Effect.runPromise(f.storage.orm("4.0.0").findMany("oauthGrants", {})),
        [],
      );
      assert.deepEqual(f.seen, []);
    } finally {
      await f.close();
    }
  },
);

test("connection requests save secrets once, survive a new SDK instance, and expose metadata only", async () => {
  const f = await setup("dcr");
  try {
    const request = await f.executor.accountConnections.create({
      owner: OwnerId.make("alice"),
      provider: f.provider,
    });
    assert.equal(request.target, null);
    assert.equal(
      (await f.secondExecutor.accountConnections.get({ connection: request.id })).state.status,
      "pending",
    );
    await assert.rejects(
      f.secondExecutor.accountConnections.get({
        connection: request.id,
        owner: OwnerId.make("bob"),
      }),
      { _tag: "AccountConnectionNotFound" },
    );
    await assert.rejects(
      f.executor.accountConnections.submit({
        connection: request.id,
        method: "apiKey",
        label: "Default",
        fields: { wrong: "synthetic-secret" },
      }),
      { _tag: "AccountFieldsInvalid" },
    );
    assert.equal(
      (await f.executor.accountConnections.get({ connection: request.id })).state.status,
      "pending",
    );
    const input = {
      connection: request.id,
      method: "apiKey",
      label: "Default",
      fields: { token: "synthetic-connection-secret" },
    };
    const saved = await Promise.all([
      f.executor.accountConnections.submit(input),
      f.secondExecutor.accountConnections.submit(input),
    ]);
    assert.deepEqual(saved[0], saved[1]);
    assert.equal((await f.executor.accounts.list()).length, 1);
    const result = await f.secondExecutor.accountConnections.get({ connection: request.id });
    assert.deepEqual(result.state, { status: "completed", account: saved[0] });
    assert.deepEqual(
      (await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })).accounts,
      {},
    );
    assert.equal(JSON.stringify(result).includes("synthetic-connection-secret"), false);
    assert.deepEqual(
      (await f.executor.accountConnections.cancel({ connection: request.id })).state,
      result.state,
    );
    const cancelled = await f.executor.accountConnections.create({
      owner: OwnerId.make("alice"),
      provider: f.provider,
    });
    assert.equal(
      (await f.executor.accountConnections.cancel({ connection: cancelled.id })).state.status,
      "cancelled",
    );
    await assert.rejects(
      f.executor.accountConnections.submit({ ...input, connection: cancelled.id }),
      { _tag: "AccountConnectionClosed" },
    );
    const expired = await f.executor.accountConnections.create({
      owner: OwnerId.make("alice"),
      provider: f.provider,
    });
    await Effect.runPromise(
      f.storage.orm("4.0.0").updateMany("accountConnections", {
        where: (b) => b("id", "=", expired.id),
        set: { expiresAt: new Date(0) },
      }),
    );
    assert.equal(
      (await f.executor.accountConnections.get({ connection: expired.id })).state.status,
      "expired",
    );
    await assert.rejects(
      f.executor.accountConnections.submit({ ...input, connection: expired.id }),
      { _tag: "AccountConnectionClosed" },
    );
    assert.equal((await f.executor.accounts.list()).length, 1);
  } finally {
    await f.close();
  }
});

test("OAuth callbacks are bound to their connection and cancellation wins during exchange", async () => {
  const f = await setup("dcr");
  try {
    const first = await f.start();
    const second = await f.start("bob");
    const callbackUrl = f.service.callback(first.authorizationUrl);
    await assert.rejects(
      f.executor.accountConnections.completeOAuth({ connection: second.connection, callbackUrl }),
      completionFailed("invalid_callback"),
    );
    assert.equal(f.service.exchanges, 0);
    const paused = f.service.pauseNext("exchange");
    const completion = assert.rejects(
      f.executor.accountConnections.completeOAuth({ connection: first.connection, callbackUrl }),
      { _tag: "AccountConnectionClosed" },
    );
    await paused.started;
    await f.secondExecutor.accountConnections.cancel({ connection: first.connection });
    await paused.release();
    await completion;
    assert.equal((await f.executor.accounts.list()).length, 0);
  } finally {
    await f.close();
  }
});

test("targeted secrets replace an unchanged deleted selection, preserve other slots, and retry once", async () => {
  const f = await setup("dcr");
  try {
    f.setRequirements({
      accounts: {
        service: { definition, cardinality: "one" },
        other: { definition, cardinality: "one" },
      },
    });
    await f.executor.apps.deploy({
      owner: f.app.owner,
      app: f.app.id,
      files: [{ path: "index.ts", content: "// Two slots" }],
    });
    const previous = await f.executor.accounts.add({
      owner: OwnerId.make("alice"),
      provider: f.provider,
      method: "apiKey",
      label: "Previous",
      fields: { token: "synthetic-old" },
    });
    await f.executor.apps.profiles.update({
      profile: f.profile.id,
      expectedRevision: (
        await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
      ).revision,
      app: f.app.id,
      accounts: { service: previous.id, other: previous.id },
    });
    const target = { profile: f.profile.id, app: f.app.id, requirement: "service" };
    const request = await f.executor.accountConnections.create({
      owner: OwnerId.make("alice"),
      target,
    });
    assert.deepEqual(request.target, { ...target, name: f.app.name });
    assert.equal(request.provider.id, f.provider);
    const other = await f.executor.accounts.add({
      owner: OwnerId.make("bob"),
      provider: f.provider,
      method: "apiKey",
      label: "Other",
      fields: { token: "synthetic-other" },
    });
    await f.executor.apps.profiles.update({
      profile: f.profile.id,
      expectedRevision: (
        await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
      ).revision,
      app: f.app.id,
      accounts: { service: previous.id, other: other.id },
    });
    await f.executor.accounts.remove({ account: previous.id });
    const input = {
      connection: request.id,
      method: "apiKey",
      label: "Default",
      fields: { token: "synthetic-new" },
    };
    const account = await f.executor.accountConnections.submit(input);
    assert.equal(account.owner, "alice");
    assert.equal(f.app.owner, "project");
    assert.deepEqual(
      (await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })).accounts,
      {
        service: account.id,
        other: other.id,
      },
    );
    await f.executor.apps.profiles.update({
      profile: f.profile.id,
      expectedRevision: (
        await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
      ).revision,
      app: f.app.id,
      accounts: { service: other.id, other: other.id },
    });
    assert.deepEqual(await f.secondExecutor.accountConnections.submit(input), account);
    assert.equal(
      (await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })).accounts
        .service,
      other.id,
      "retry must not reapply selection",
    );
    assert.equal((await f.executor.accounts.list()).length, 2);
  } finally {
    await f.close();
  }
});

test("a changed single selection rolls back a targeted reconnect's credential write", async () => {
  const f = await setup("dcr");
  try {
    const original = await f.executor.accounts.add({
      owner: OwnerId.make("alice"),
      provider: f.provider,
      method: "apiKey",
      label: "Original",
      fields: { token: "synthetic-original" },
    });
    const request = await f.executor.accountConnections.create({
      owner: original.owner,
      account: original.id,
      target: { profile: f.profile.id, app: f.app.id, requirement: "service" },
    });
    const db = f.storage.orm("4.0.0");
    const before = await Effect.runPromise(db.findMany("accounts", {}));
    await f.executor.apps.profiles.update({
      profile: f.profile.id,
      expectedRevision: (
        await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
      ).revision,
      app: f.app.id,
      accounts: { service: original.id },
    });
    await assert.rejects(
      f.executor.accountConnections.submit({
        connection: request.id,
        method: "apiKey",
        label: "Default",
        fields: { token: "synthetic-replacement" },
      }),
      { _tag: "AccountConnectionTargetChanged" },
    );
    assert.deepEqual(await Effect.runPromise(db.findMany("accounts", {})), before);
    assert.equal(
      (await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })).accounts
        .service,
      original.id,
    );
    assert.equal(
      (await f.executor.accountConnections.get({ connection: request.id })).state.status,
      "pending",
    );
  } finally {
    await f.close();
  }
});

test("many targets append to current selections across concurrent requests without duplicates", async () => {
  const f = await setup("dcr");
  try {
    f.setRequirements({
      accounts: {
        service: { definition, cardinality: "many" },
        other: { definition, cardinality: "one" },
      },
    });
    await f.executor.apps.deploy({
      owner: f.app.owner,
      app: f.app.id,
      files: [{ path: "index.ts", content: "// Many accounts" }],
    });
    const existing = await f.executor.accounts.add({
      owner: OwnerId.make("alice"),
      provider: f.provider,
      method: "apiKey",
      label: "Existing",
      fields: { token: "synthetic-existing" },
    });
    await f.executor.apps.profiles.update({
      profile: f.profile.id,
      expectedRevision: (
        await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
      ).revision,
      app: f.app.id,
      accounts: { service: [], other: existing.id },
    });
    const input = {
      owner: existing.owner,
      target: { profile: f.profile.id, app: f.app.id, requirement: "service" },
    };
    const first = await f.executor.accountConnections.create(input);
    const second = await f.secondExecutor.accountConnections.create(input);
    await f.executor.apps.profiles.update({
      profile: f.profile.id,
      expectedRevision: (
        await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
      ).revision,
      app: f.app.id,
      accounts: { service: [existing.id], other: existing.id },
    });
    const accounts = await Promise.all([
      f.executor.accountConnections.submit({
        connection: first.id,
        method: "apiKey",
        label: "First",
        fields: { token: "synthetic-first" },
      }),
      f.secondExecutor.accountConnections.submit({
        connection: second.id,
        method: "apiKey",
        label: "Second",
        fields: { token: "synthetic-second" },
      }),
    ]);
    const expected = [existing.id, ...accounts.map((account) => account.id)];
    const selected = (await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id }))
      .accounts;
    assert.ok(Array.isArray(selected.service));
    assert.deepEqual([...selected.service].sort(), expected.sort());
    assert.equal(selected.other, existing.id);
    const reconnect = await f.executor.accountConnections.create({
      ...input,
      account: existing.id,
    });
    await f.executor.accountConnections.submit({
      connection: reconnect.id,
      method: "apiKey",
      label: "Existing",
      fields: { token: "synthetic-reconnect" },
    });
    assert.deepEqual(
      (await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })).accounts,
      selected,
    );
  } finally {
    await f.close();
  }
});

for (const change of ["removed", "slot", "provider", "cardinality"] as const)
  test(`target ${change} changes roll back completion`, async () => {
    const f = await setup("dcr");
    try {
      await assert.rejects(
        f.executor.accountConnections.create({
          owner: OwnerId.make("alice"),
          target: { profile: f.profile.id, app: f.app.id, requirement: "absent" },
        }),
        { _tag: "AccountSelectionInvalid" },
      );
      const request = await f.executor.accountConnections.create({
        owner: OwnerId.make("alice"),
        target: { profile: f.profile.id, app: f.app.id, requirement: "service" },
      });
      if (change === "removed") await f.executor.apps.remove({ app: f.app.id });
      else {
        f.setRequirements({
          accounts:
            change === "slot"
              ? {}
              : {
                  service: {
                    definition:
                      change === "provider"
                        ? { ...definition, name: "Other provider" }
                        : definition,
                    cardinality: change === "cardinality" ? "many" : "one",
                  },
                },
        });
        await f.executor.apps.deploy({
          owner: f.app.owner,
          app: f.app.id,
          files: [{ path: "index.ts", content: "// Changed requirement" }],
        });
      }
      await assert.rejects(
        f.executor.accountConnections.submit({
          connection: request.id,
          method: "apiKey",
          label: "Default",
          fields: { token: "synthetic-key" },
        }),
        { _tag: "AccountConnectionTargetChanged" },
      );
      assert.deepEqual(await f.executor.accounts.list(), []);
      assert.equal(
        (await f.executor.accountConnections.get({ connection: request.id })).state.status,
        "pending",
      );
    } finally {
      await f.close();
    }
  });

for (const changed of [false, true])
  test(`targeted OAuth ${changed ? "preserves a selection changed during exchange" : "saves and selects atomically"}`, async () => {
    const f = await setup("dcr");
    try {
      const request = await f.executor.accountConnections.create({
        owner: OwnerId.make("alice"),
        target: { profile: f.profile.id, app: f.app.id, requirement: "service" },
      });
      const signIn = await f.executor.accountConnections.startOAuth({
        connection: request.id,
        method: "oauth",
        label: "Default",
        redirectUri,
      });
      assert.ok(signIn.status === "redirect");
      const callbackUrl = f.service.callback(signIn.authorizationUrl);
      if (changed) {
        const paused = f.service.pauseNext("exchange");
        const completion = assert.rejects(
          f.executor.accountConnections.completeOAuth({ connection: request.id, callbackUrl }),
          { _tag: "AccountConnectionTargetChanged" },
        );
        await paused.started;
        const other = await f.secondExecutor.accounts.add({
          owner: OwnerId.make("alice"),
          provider: f.provider,
          method: "apiKey",
          label: "Other",
          fields: { token: "synthetic-other" },
        });
        await f.secondExecutor.apps.profiles.update({
          profile: f.profile.id,
          expectedRevision: (
            await f.secondExecutor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
          ).revision,
          app: f.app.id,
          accounts: { service: other.id },
        });
        await paused.release();
        await completion;
        assert.deepEqual(await f.executor.accounts.list(), [other]);
        assert.deepEqual(
          await Effect.runPromise(f.storage.orm("4.0.0").findMany("oauthGrants", {})),
          [],
        );
        assert.equal(
          (await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })).accounts
            .service,
          other.id,
        );
        assert.equal(
          (await f.executor.accountConnections.get({ connection: request.id })).state.status,
          "pending",
        );
      } else {
        const account = await f.executor.accountConnections.completeOAuth({
          connection: request.id,
          callbackUrl,
        });
        assert.deepEqual(
          (await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })).accounts,
          {
            service: account.id,
          },
        );
        assert.deepEqual(
          (await f.executor.accountConnections.get({ connection: request.id })).state,
          { status: "completed", account },
        );
        assert.deepEqual(
          await f.executor.accountConnections.completeOAuth({
            connection: request.id,
            callbackUrl,
          }),
          account,
        );
      }
    } finally {
      await f.close();
    }
  });

for (const callback of [
  "http://account-picker.localhost:55251/api/oauth/callback",
  "https://host.example/callback?tenant=one&tenant=two",
]) {
  test(`OAuth completes with callback ${callback}`, async () => {
    const f = await setup("dcr", "path", false, { redirect: callback });
    try {
      const started = await f.start();
      const returned = f.service.callback(started.authorizationUrl);
      const tampered = new URL(returned);
      tampered.searchParams.set("tenant", "changed");
      if (new URL(callback).search !== "") {
        await assert.rejects(
          f.complete({ callbackUrl: tampered.href }),
          completionFailed("invalid_callback"),
        );
        assert.equal(f.service.exchanges, 0);
      }
      const account = await f.complete({ callbackUrl: returned });
      assert.equal(account.label, "alice");
      assert.equal(f.service.exchanges, 1);
    } finally {
      await f.close();
    }
  });
}

test("configured HTTP origins cover discovery, registration, callbacks, exchange and refresh", async () => {
  const f = await setup("dcr", "path", false, {
    redirect: "http://executor.internal:8080/callback?tenant=one",
    issuer: "http://auth.internal:9000",
    resource: "http://service.internal:8081/mcp",
    urlPolicy: {
      allowLoopbackHttp: false,
      allowedHttpOrigins: [
        "http://executor.internal:8080",
        "http://auth.internal:9000",
        "http://service.internal:8081",
      ].map((value) => HttpOrigin.make(value)),
    },
  });
  try {
    const started = await f.start();
    const account = await f.complete({ callbackUrl: f.service.callback(started.authorizationUrl) });
    assert.equal(f.service.exchanges, 1);
    await f.executor.apps.profiles.update({
      profile: f.profile.id,
      expectedRevision: (
        await f.executor.apps.profiles.get({ app: f.app.id, profile: f.profile.id })
      ).revision,
      app: f.app.id,
      accounts: { service: account.id },
    });
    await f.executor.tools.list({ profile: f.profile.id, app: f.app.id });
    assert.equal(f.service.refreshes, 1);
  } finally {
    await f.close();
  }
});

test("callback policy rejects unapproved HTTP, fragments, credentials and reserved response parameters before discovery", async () => {
  const f = await setup("dcr", "path", false, {
    urlPolicy: { allowLoopbackHttp: false, allowedHttpOrigins: [] },
  });
  try {
    for (const callback of [
      "http://localhost/callback",
      "http://account-picker.localhost/callback",
      "http://host.internal/callback",
      "https://host.example/callback#",
      "https://user:pass@host.example/callback",
      "https://host.example/callback?state=chosen",
    ]) {
      await assert.rejects(
        f.startOAuth({
          owner: f.app.owner,
          provider: f.provider,
          method: "oauth",
          label: "Default",
          redirectUri: callback,
        }),
        (error) => Schema.is(OAuthSetupFailed)(error) && error.reason === "invalid_redirect",
      );
    }
    assert.equal(f.service.discoveryRequests.length, 0);
  } finally {
    await f.close();
  }
});

test("an MCP server without resource metadata falls back to authorization metadata at its origin", async () => {
  const f = await setup("dcr", "none", false, {
    issuer: "https://service.example",
    resource: "https://service.example/v1/mcp",
  });
  try {
    const signIn = await f.start();
    assert.equal(new URL(signIn.authorizationUrl).searchParams.get("resource"), null);
    const pathMetadata = "https://service.example/.well-known/oauth-authorization-server/v1/mcp";
    const rootMetadata = "https://service.example/.well-known/oauth-authorization-server";
    assert.ok(f.service.discoveryRequests.includes(pathMetadata));
    assert.ok(
      f.service.discoveryRequests.indexOf(rootMetadata) >
        f.service.discoveryRequests.indexOf(pathMetadata),
    );
    const account = await f.complete({ callbackUrl: f.service.callback(signIn.authorizationUrl) });
    assert.equal(account.owner, "alice");
    assert.equal(f.service.exchanges, 1);
  } finally {
    await f.close();
  }
});

for (const expiry of ["missing", "null"] as const)
  test(`registration with a client secret and ${expiry} expiry uses the secret`, async () => {
    const f = await setup("dcr", "path", false, {
      method: { tokenEndpointAuthMethod: "client_secret_basic" },
    });
    try {
      f.service.reply(
        `${issuerUrl}/register`,
        {
          client_id: "registered-confidential",
          client_secret: "synthetic-registered-secret",
          token_endpoint_auth_method: "client_secret_basic",
          ...(expiry === "null" ? { client_secret_expires_at: null } : {}),
        },
        201,
      );
      const signIn = await f.start();
      assert.equal(
        new URL(signIn.authorizationUrl).searchParams.get("client_id"),
        "registered-confidential",
      );
      await f.complete({ callbackUrl: f.service.callback(signIn.authorizationUrl) });
      assert.deepEqual(f.service.clientSecrets, ["synthetic-registered-secret"]);
    } finally {
      await f.close();
    }
  });

test("an openid sign-in completes without an ID token but still validates a returned one", async () => {
  const f = await setup("manual", "path", false, { method: { scopes: ["openid", "read"] } });
  const idToken = (nonce: string | null) =>
    [
      { alg: "RS256", typ: "JWT" },
      {
        iss: issuerUrl,
        aud: "manual-client",
        sub: "synthetic-user",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce,
      },
    ]
      .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
      .concat("c3ludGhldGlj")
      .join(".");
  const tokens = (nonce: string | null) => ({
    access_token: "synthetic-access",
    token_type: "Bearer",
    id_token: idToken(nonce),
  });
  try {
    const first = await f.start();
    assert.ok(new URL(first.authorizationUrl).searchParams.get("nonce"));
    await f.complete({ callbackUrl: f.service.callback(first.authorizationUrl) });
    assert.equal(f.service.exchanges, 1, "the token response had no ID token");

    const wrong = await f.start();
    f.service.reply(`${issuerUrl}/token`, tokens("synthetic-other-nonce"));
    const error = await rejection(
      f.complete({ callbackUrl: f.service.callback(wrong.authorizationUrl) }),
    );
    assert.ok(Schema.is(OAuthCompletionFailed)(error));
    assert.equal(error.reason, "incompatible_response");
    assert.equal(error.cause?.status, 200);

    const matching = await f.start();
    f.service.reply(
      `${issuerUrl}/token`,
      tokens(new URL(matching.authorizationUrl).searchParams.get("nonce")),
    );
    await f.complete({ callbackUrl: f.service.callback(matching.authorizationUrl) });
    assert.equal((await f.executor.accounts.list()).length, 2);
  } finally {
    await f.close();
  }
});

for (const { name, status, body, reason, cause } of [
  {
    name: "an invalid redirect URI",
    status: 400,
    body: { error: "invalid_redirect_uri" },
    reason: "client_not_approved",
    cause: { stage: "register", status: 400, providerError: "invalid_redirect_uri" },
  },
  {
    name: "HTTP 403",
    status: 403,
    body: {},
    reason: "client_not_approved",
    cause: { stage: "register", status: 403 },
  },
  {
    name: "invalid client metadata",
    status: 400,
    body: { error: "invalid_client_metadata" },
    reason: "registration_rejected",
    cause: { stage: "register", status: 400, providerError: "invalid_client_metadata" },
  },
  {
    name: "a successful response without a client ID",
    status: 200,
    body: { client_name: "Executor test" },
    reason: "incompatible_response",
    cause: { stage: "register", status: 200, field: "client_id" },
  },
] satisfies ReadonlyArray<{
  name: string;
  status: number;
  body: unknown;
  reason: OAuthSetupFailed["reason"];
  cause: OAuthSetupFailed["cause"];
}>)
  test(`registration refused with ${name} reports ${reason}`, async () => {
    const f = await setup("dcr");
    try {
      f.service.reply(`${issuerUrl}/register`, body, status);
      const error = await rejection(f.start());
      assert.ok(Schema.is(OAuthSetupFailed)(error));
      assert.equal(error.reason, reason);
      assert.deepEqual(error.cause, cause);
      assert.equal(error.callbackUrl, redirectUri);
      assert.equal(f.service.exchanges, 0);
    } finally {
      await f.close();
    }
  });

test("resource metadata for a sibling path reports resource_mismatch", async () => {
  const f = await setup("dcr");
  try {
    f.service.reply("https://service.example/.well-known/oauth-protected-resource/mcp", {
      resource: "https://service.example/other",
      authorization_servers: [issuerUrl],
    });
    const error = await rejection(f.start());
    assert.ok(Schema.is(OAuthSetupFailed)(error));
    assert.equal(error.reason, "resource_mismatch");
    assert.equal(error.cause?.stage, "discover");
    assert.equal(f.service.registrations, 0);
  } finally {
    await f.close();
  }
});

for (const { name, status, body, reason, cause } of [
  {
    name: "invalid_grant",
    status: 400,
    body: { error: "invalid_grant" },
    reason: "sign_in_expired",
    cause: { stage: "exchange", status: 400, providerError: "invalid_grant" },
  },
  {
    name: "HTTP 503",
    status: 503,
    body: {},
    reason: "service_unavailable",
    cause: { stage: "exchange", status: 503 },
  },
] satisfies ReadonlyArray<{
  name: string;
  status: number;
  body: unknown;
  reason: OAuthCompletionFailed["reason"];
  cause: OAuthCompletionFailed["cause"];
}>)
  test(`token endpoint ${name} reports ${reason} without creating an account`, async () => {
    const f = await setup("dcr");
    try {
      const signIn = await f.start();
      f.service.reply(`${issuerUrl}/token`, body, status);
      const error = await rejection(
        f.complete({ callbackUrl: f.service.callback(signIn.authorizationUrl) }),
      );
      assert.ok(Schema.is(OAuthCompletionFailed)(error));
      assert.equal(error.reason, reason);
      assert.deepEqual(error.cause, cause);
      assert.deepEqual(await f.executor.accounts.list(), []);
    } finally {
      await f.close();
    }
  });
