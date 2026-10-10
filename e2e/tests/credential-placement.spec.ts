/**
 * A method that declares placements (`request`) sends its secret fields only where a request
 * matches one of its templates exactly; a handle anywhere else is refused, so an allowed host
 * cannot be made to store the secret and hand it back. Tokens from the operator's own OAuth client
 * are managed: sealed, and sent only in the operator's header to the operator's hosts, whatever
 * the provider declares.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { publishedRelease } from "../support/app-package.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { credentialUpstream, type ReceivedRequest } from "../support/credential-upstream.ts";
import { OperatorOAuthFixture, operatorOAuthFile } from "../support/operator-oauth.ts";
import { oauthSetupIssuer, oauthSetupIssuerOn } from "../support/oauth-setup-issuer.ts";
import { Target } from "../support/platform.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Record(Schema.String, Schema.Struct({ provider: Schema.String })),
  }),
});
const Refusal = Schema.Struct({
  reason: Schema.String,
  location: Schema.optional(Schema.String),
  allowedHosts: Schema.optional(Schema.Array(Schema.String)),
});
/** One request an app sent, as the app saw its answer. */
const Sent = Schema.Struct({ status: Schema.Number, refusal: Schema.NullOr(Refusal) });
const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});
const Setup = Schema.Struct({
  mode: Schema.String,
  scopes: Schema.Array(Schema.String),
  firstParty: Schema.optional(Schema.Struct({ label: Schema.String })),
  userScopes: Schema.optional(Schema.Array(Schema.String)),
});
const Health = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({
      app: Schema.String,
      check: Schema.NullOr(Schema.Struct({ status: Schema.String })),
    }),
  ),
});
const Run = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  output: Schema.optionalKey(Schema.Json),
});
const Tools = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });
/** A placed or managed handle, which an outbound from before placements never opens. */
const handle = /^exsec2_[0-9a-f]+_$/;
/** A failure as the API answers it. */
const Failure = Schema.Struct({ _tag: Schema.String, message: Schema.String });
/**
 * Wording that presents revocation as done. Executor revokes refused tokens beside its answer, and
 * the service may refuse or not support it, so an error never states it as a fact.
 */
const claimsRevoked = /\b(was|were|been|is|are) revoked\b/u;
/** The message of a failure the API answered; any other answer, as JSON, fails checks on it. */
const messageOf = (response: { readonly body: unknown }) =>
  Schema.decodeUnknownEffect(Failure)(response.body).pipe(
    Effect.map((failure) => failure.message),
    Effect.orElseSucceed(() => JSON.stringify(response.body)),
  );

/** Send a request and report its status and, for a refusal, why. Shared by every fixture app. */
const sendSource = `const send = async (url, init) => {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, refusal: response.status === 421 ? JSON.parse(text).refusal : null };
};`;

/**
 * Four providers that place their secrets differently, all on `host`: a bearer token, Basic
 * credentials with a plain username, Basic credentials with two secrets (two accounts), and a key
 * sent as a header or a query parameter. `probe` sends each credential everywhere it may and may
 * not go.
 */
const placedApp = (name: string, host: string) => `import {
  base64, basic, bearer, defineApp, defineProvider, header, object, plain, query, router, secrets, string, t,
} from "apps";
const hosts = [${JSON.stringify(host)}];
const bearerService = defineProvider({ name: ${JSON.stringify(`${name} bearer`)}, hosts, auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }), request: ({ token }) => bearer(token) }),
} });
const basicService = defineProvider({ name: ${JSON.stringify(`${name} basic`)}, hosts, auth: {
  key: secrets({
    label: "Key",
    fields: object({ email: plain(string()), token: string() }),
    request: ({ email, token }) => header("authorization", t\`Basic \${base64(t\`\${email}:\${token}\`)}\`),
  }),
} });
const pairService = defineProvider({ name: ${JSON.stringify(`${name} pair`)}, hosts, auth: {
  key: secrets({
    label: "Key",
    fields: object({ user: string(), password: string() }),
    request: ({ user, password }) => basic(user, password),
  }),
} });
const keyService = defineProvider({ name: ${JSON.stringify(`${name} key`)}, hosts, auth: {
  key: secrets({
    label: "Key",
    fields: object({ key: string() }),
    request: ({ key }) => [header("x-goog-api-key", key), query("key", key)],
  }),
} });
// Base64 parts in a query parameter and after literal text in a header.
const encodedService = defineProvider({ name: ${JSON.stringify(`${name} encoded`)}, hosts, auth: {
  key: secrets({
    label: "Key",
    fields: object({ key: string() }),
    request: ({ key }) => [query("auth", base64(t\`k:\${key}\`)), header("x-auth", t\`Token\${base64(key)}\`)],
  }),
} });
// Placed credentials go only over HTTPS, so this host, named over plain HTTP, never receives one.
const insecureService = defineProvider({ name: ${JSON.stringify(`${name} insecure`)}, hosts: ["insecure.example.test"], auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }), request: ({ token }) => bearer(token) }),
} });
${sendSource}
const basicOf = (user, password) => "Basic " + btoa(user + ":" + password);
export default defineApp({ accounts: { bearerService, basicService, pairs: pairService.many(), keyService, encodedService, insecureService } }, {
  tools: router({
    fields: query({ input: object({}) }, async ({ accounts }) => ({
      encoded: accounts.encodedService.fields,
      bearer: accounts.bearerService.fields,
      basic: accounts.basicService.fields,
      pairs: accounts.pairs.map((account) => account.fields),
      key: accounts.keyService.fields,
    })),
    probe: query({ input: object({ origin: string() }) }, async ({ accounts }, { origin }) => {
      const token = accounts.bearerService.fields.token;
      const basicAccount = accounts.basicService;
      const [first, second] = accounts.pairs;
      const keyAccount = accounts.keyService;
      return {
        bearerHelper: await send(origin + "/bearer-helper", { headers: accounts.bearerService.headers() }),
        bearerWritten: await send(origin + "/bearer-written", { headers: { authorization: "Bearer " + token } }),
        bearerPrefixed: await send(origin + "/refused", { headers: { authorization: "Bearer x" + token } }),
        bearerTwice: await send(origin + "/refused", { headers: { authorization: "Bearer " + token + " " + token } }),
        bearerExtra: await send(origin + "/refused", { headers: { authorization: "Bearer " + token + " extra" } }),
        otherHeader: await send(origin + "/refused", { headers: { "x-note": "Bearer " + token } }),
        jsonBody: await send(origin + "/refused", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ properties: { title: token } }),
        }),
        formBody: await send(origin + "/refused", { method: "POST", body: new URLSearchParams({ token }) }),
        urlPath: await send(origin + "/refused/" + token, {}),
        queryParameter: await send(origin + "/refused?token=" + token, {}),
        basicHelper: await send(origin + "/basic-helper", { headers: basicAccount.headers() }),
        basicOtherUser: await send(origin + "/basic-other-user", {
          headers: { authorization: basicOf("someone@example.test", basicAccount.fields.token) },
        }),
        basicSecretAsUser: await send(origin + "/refused", {
          headers: { authorization: basicOf(basicAccount.fields.token, basicAccount.fields.token) },
        }),
        bearerAsBasic: await send(origin + "/refused", {
          headers: { authorization: basicOf(basicAccount.fields.email, token) },
        }),
        pairHelper: await send(origin + "/pair-helper", { headers: first.headers() }),
        pairSwapped: await send(origin + "/refused", {
          headers: { authorization: basicOf(first.fields.password, first.fields.user) },
        }),
        pairAcrossAccounts: await send(origin + "/refused", {
          headers: { authorization: basicOf(first.fields.user, second.fields.password) },
        }),
        keyHeader: await send(origin + "/key-header", { headers: keyAccount.headers() }),
        keyUrl: await send(keyAccount.url(origin + "/key-url?q=a+b"), {}),
        keyWrongName: await send(origin + "/refused?apikey=" + keyAccount.fields.key, {}),
        encodedQuery: await send(accounts.encodedService.url(origin + "/encoded-query"), {}),
        encodedHeader: await send(origin + "/encoded-header", { headers: accounts.encodedService.headers() }),
        insecure: await send("http://insecure.example.test/refused", { headers: accounts.insecureService.headers() }),
      };
    }),
  }),
});`;

/** An app whose provider has a method with `request`, for checking what its declaration allows. */
const declaredApp = (request: string, options: { readonly hosts?: boolean } = {}) =>
  `import { bearer, defineApp, defineProvider, header, object, plain, raw, router, secrets, string, t } from "apps";
const service = defineProvider({
  name: "Declared placements",
  ${options.hosts === false ? "" : 'hosts: ["api.example.com"],'}
  auth: {
    key: secrets({
      label: "Key",
      fields: object({ region: plain(string()), token: string(), signing: raw(string()) }),
      request: ${request},
    }),
  },
});
export default defineApp({ accounts: { service } }, { tools: router({}) });`;

/**
 * A token placed as a bearer and one substituted anywhere, both on `host`. `fail` sends each where
 * the network cannot take the real value, a header value with a line break, and reports how the
 * app's fetch ended; `trace` sends each with `TRACE`.
 */
const outboundApp = (
  name: string,
  host: string,
) => `import { bearer, defineApp, defineProvider, object, query, router, secrets, string } from "apps";
const placed = defineProvider({ name: ${JSON.stringify(`${name} placed`)}, hosts: [${JSON.stringify(host)}], auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }), request: ({ token }) => bearer(token) }),
} });
const anywhere = defineProvider({ name: ${JSON.stringify(`${name} anywhere`)}, hosts: [${JSON.stringify(host)}], auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) }),
} });
${sendSource}
const ended = async (url, init) => {
  try {
    const response = await fetch(url, init);
    return { status: response.status, message: await response.text() };
  } catch (error) {
    return { status: 0, message: String(error) + " " + String(error?.stack) };
  }
};
export default defineApp({ accounts: { placed, anywhere } }, {
  tools: router({
    fail: query({ input: object({ origin: string() }) }, async ({ accounts }, { origin }) => ({
      placed: await ended(origin + "/placed", { headers: accounts.placed.headers() }),
      anywhere: await ended(origin + "/anywhere", { headers: { "x-key": accounts.anywhere.fields.token } }),
    })),
    trace: query({ input: object({ origin: string() }) }, async ({ accounts }, { origin }) => ({
      placed: await send(origin + "/trace", { method: "TRACE", headers: accounts.placed.headers() })
        .catch((error) => ({ status: 0, refusal: { reason: "fetch rejected: " + error.message } })),
      anywhere: await send(origin + "/trace", { method: "TRACE", headers: { "x-key": accounts.anywhere.fields.token } })
        .catch((error) => ({ status: 0, refusal: { reason: "fetch rejected: " + error.message } })),
    })),
  }),
});`;

/** A provider that declares its OAuth endpoints itself, as an app could for any server. */
const endpointsApp = (
  name: string,
  hosts: readonly string[],
  endpoints: object,
) => `import { defineApp, defineProvider, oauth2, object, query, router } from "apps";
const mail = defineProvider({ name: ${JSON.stringify(name)}, hosts: ${JSON.stringify(hosts)}, auth: {
  oauth: oauth2({ ...${JSON.stringify(endpoints)}, scopes: ["mail.read"] }),
} });
export default defineApp({ accounts: { mail } }, {
  tools: router({ fields: query({ input: object({}) }, async ({ accounts }) => accounts.mail.fields) }),
});`;

/** The token the issuer gives every first sign-in. */
const token = "synthetic-access-token";
/** What a service received when the operator's placement carried the real token. */
const realBearer = `Bearer ${token}`;

/**
 * The operator's OAuth client: its authorization server, which every request carrying its secret
 * or a user's tokens goes to, its scope menu and its placement.
 */
const operatorClients = (
  issuerOrigin: string,
  hosts: readonly string[],
  options: {
    readonly revocation?: boolean;
    /** Requested for a method that asks for no scopes; `mail.read` by default. */
    readonly defaultScopes?: readonly string[];
    /** What a sign-in may ask for and a grant may hold; `mail.read` and `mail.compose` by default. */
    readonly allowedScopes?: readonly string[];
    /** How the server separates the scopes it reports granting, such as GitHub's `,`. */
    readonly grantedScopeSeparator?: string;
    /** Extra sign-in parameters the operator sends, such as Slack's `user_scope`. */
    readonly authorizationParams?: Readonly<Record<string, string>>;
    /** The header the token goes in, and its scheme; `Authorization: Bearer` by default. */
    readonly header?: string;
    readonly scheme?: string | null;
  } = {},
) =>
  JSON.stringify([
    {
      id: "synthetic-mail",
      label: "Executor for Synthetic Mail",
      server: {
        issuer: issuerOrigin,
        authorizationUrl: `${issuerOrigin}/authorize`,
        tokenUrl: `${issuerOrigin}/token`,
        ...(options.revocation === true ? { revocationUrl: `${issuerOrigin}/revoke` } : {}),
        ...(options.grantedScopeSeparator === undefined
          ? {}
          : { grantedScopeSeparator: options.grantedScopeSeparator }),
        ...(options.authorizationParams === undefined
          ? {}
          : { authorizationParams: options.authorizationParams }),
      },
      clientId: "first-party-client",
      clientSecret: "first-party-secret",
      tokenEndpointAuthMethod: "client_secret_basic",
      defaultScopes: options.defaultScopes ?? ["mail.read"],
      allowedScopes: options.allowedScopes ?? ["mail.read", "mail.compose"],
      placement: {
        hosts,
        ...(options.header === undefined ? {} : { header: options.header }),
        ...(options.scheme === undefined ? {} : { scheme: options.scheme }),
      },
    },
  ]);

/**
 * A mail service on the operator client's issuer. `discover` and `scopes` choose the authorization
 * server and what it asks for; `request` adds the provider's own placements, which the operator's
 * header replaces for a managed account.
 */
const mailApp = (options: {
  readonly name: string;
  readonly discover: string;
  /** Undefined declares no hosts. */
  readonly hosts: readonly string[] | undefined;
  readonly scopes?: readonly string[];
  readonly scopeSeparator?: string;
  /** Extra sign-in parameters the provider declares. */
  readonly authorizationParams?: Readonly<Record<string, string>>;
  readonly request?: string;
  readonly resource: string;
  readonly store: string;
  readonly undeclared: string;
  /** Where the account check reads with the token; the store's `/check` by default. */
  readonly check?: string;
  /** Built with a framework from before placements, which writes its header by hand. */
  readonly legacy?: boolean;
  /** Mark the access token `raw()`, which a managed account ignores. */
  readonly rawToken?: boolean;
}) => `import {
  ${options.legacy === true ? "" : "bearer, header,"} defineApp, defineProvider, oauth2, object, ProviderError, query, raw, router, string, workflow,
} from "apps";
const headersOf = (account) => ${
  options.legacy === true
    ? '({ authorization: "Bearer " + account.fields.access_token })'
    : "account.headers()"
};
const mail = defineProvider({
  name: ${JSON.stringify(options.name)},
  ${options.hosts === undefined ? "" : `hosts: ${JSON.stringify(options.hosts)},`}
  auth: {
    oauth: oauth2({
      discover: ${JSON.stringify(options.discover)},
      scopes: ${JSON.stringify(options.scopes ?? ["mail.read"])},
      ${options.scopeSeparator === undefined ? "" : `scopeSeparator: ${JSON.stringify(options.scopeSeparator)},`}
      ${options.authorizationParams === undefined ? "" : `authorizationParams: ${JSON.stringify(options.authorizationParams)},`}
      ${options.rawToken === true ? "response: object({ access_token: raw(string()) })," : ""}
      ${options.request === undefined ? "" : `request: ${options.request},`}
    }),
  },
  async health({ account, fetch }) {
    if (!/^exsec2_[0-9a-f]+_$/.test(account.fields.access_token)) throw new Error("The check read a real token.");
    const response = await fetch(${JSON.stringify(options.check ?? `${options.store}/check`)}, { headers: headersOf(account) });
    if (!response.ok) throw new Error("The service answered " + response.status + ".");
  },
});
${sendSource}
const tampered = (value) => value.slice(0, 10) + (value[10] === "0" ? "1" : "0") + value.slice(11);
export default defineApp({ accounts: { mail } }, async ({ accounts }) => ({
  workflows: { fields: workflow({ input: object({}) }, async (ctx) =>
    ctx.step.do("fields", async (step) => step.accounts.mail.fields)) },
  tools: router({
    // Discovery evaluates the app with the account too; the tool's name says what it read.
    [/^exsec2_[0-9a-f]+_$/.test(accounts.mail.fields.access_token) ? "sealedDiscovery" : "realDiscovery"]:
      query({ input: object({}) }, async () => null),
    fields: query({ input: object({}) }, async ({ accounts }) => accounts.mail.fields),
    // Send the account's headers, with the app's own authorization beside them.
    headers: query({ input: object({ url: string() }) }, async ({ accounts }, { url }) =>
      send(url, { headers: { ...accounts.mail.headers(), authorization: "Bearer app-chosen" } })),
    // Send a bearer value written by hand, such as a handle kept from an earlier invocation.
    send: query({ input: object({ url: string(), token: string() }) }, async (_, { url, token }) =>
      send(url, { headers: { authorization: "Bearer " + token } })),
    // Read a URL with no credential, as app code may once a service logged one; null if it failed.
    readPlain: query({ input: object({ url: string(), encoding: string() }) }, async (_, { url, encoding }) => {
      try {
        const response = await fetch(url, { headers: { "accept-encoding": encoding } });
        return { status: response.status, text: await response.text() };
      } catch {
        return null;
      }
    }),
    // Read the resource with this invocation's token; a refusal by the service is the account's.
    // The global fetch returns Executor's refusal as a 421 rather than throwing it.
    resource: query({ input: object({}) }, async ({ accounts }) => {
      const account = accounts.mail;
      const token = account.fields.access_token;
      const response = await fetch(${JSON.stringify(options.resource)}, { headers: { authorization: "Bearer " + token } });
      if (response.status === 401) throw new ProviderError({ reason: "unauthorized", status: 401, accountId: account.id });
      return { token, status: response.status };
    }),
    probe: query({ input: object({}) }, async ({ accounts }) => {
      const account = accounts.mail;
      const token = account.fields.access_token;
      const resource = await fetch(${JSON.stringify(options.resource)}, { headers: headersOf(account) });
      const draft = await send(${JSON.stringify(`${options.store}/store`)}, {
        method: "POST",
        headers: { "content-type": "message/rfc822" },
        body: "Subject: draft\\r\\n\\r\\n" + token,
      });
      const stored = await fetch(${JSON.stringify(`${options.store}/stored`)});
      return {
        resource: { status: resource.status, body: await resource.json() },
        leak: await send(${JSON.stringify(`${options.store}/leak`)}, { headers: { "x-leak": token } }),
        leakTemplate: await send(${JSON.stringify(`${options.store}/leak`)}, { headers: { "x-leak": "Bearer " + token } }),
        tampered: await send(${JSON.stringify(`${options.store}/tampered`)}, { headers: { authorization: "Bearer " + tampered(token) } }),
        pageTitle: await send(${JSON.stringify(`${options.store}/store`)}, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ properties: { title: token } }),
        }),
        draft,
        stored: new TextDecoder().decode(await stored.arrayBuffer()),
        undeclared: await send(${JSON.stringify(`${options.undeclared}/undeclared`)}, { headers: headersOf(account) }),
        query: await send(${JSON.stringify(`${options.store}/query?access_token=`)} + token, {}),
        trace: await send(${JSON.stringify(`${options.store}/trace`)}, { method: "TRACE", headers: headersOf(account) })
          .catch((error) => ({ status: 0, refusal: { reason: "fetch rejected: " + error.message } })),
        // Another scheme, and other credentials beside it: the operator's header replaces them all.
        rewritten: await send(${JSON.stringify(`${options.store}/rewritten`)}, {
          headers: { authorization: "token " + token, "proxy-authorization": "Basic c3ludGhldGlj" },
        }),
      };
    }),
  }),
}));`;

const Probe = Schema.Struct({
  resource: Schema.Struct({
    status: Schema.Number,
    body: Schema.Struct({ authorization: Schema.NullOr(Schema.String) }),
  }),
  leak: Sent,
  leakTemplate: Sent,
  tampered: Sent,
  pageTitle: Sent,
  draft: Sent,
  stored: Schema.String,
  undeclared: Sent,
  query: Sent,
  trace: Sent,
  rewritten: Sent,
});

const harness = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    http = yield* HttpClient.HttpClient;
  const prefix = `/api/organizations/${actors.organization.id}`;
  /** Deploy `files`; the app is deleted when the case ends. */
  const deploy = (name: string, content: string, manifest = appsManifest) =>
    Effect.gen(function* () {
      const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name,
        files: [{ path: "index.ts", content }, manifest],
      });
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
      const app = yield* body(App, deployed);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
      );
      return { path: `${prefix}/apps/${app.id}`, app };
    });
  /** Open a connection for `requirement` in `profile`. */
  const connection = (path: string, requirement: string, profile: string) =>
    api.request(actors.owner, "POST", `${path}/connections`, { requirement, profile }).pipe(
      Effect.tap((response) =>
        Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
      ),
      Effect.flatMap((response) => body(Resource, response)),
      Effect.map((resource) => resource.id),
    );
  /** Connect a secrets account for `requirement` in `profile`. */
  const submit = (path: string, requirement: string, profile: string, fields: object) =>
    Effect.gen(function* () {
      const id = yield* connection(path, requirement, profile);
      const saved = yield* api.request(actors.owner, "POST", `${prefix}/connections/${id}/submit`, {
        method: "key",
        label: requirement,
        fields,
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const account = (yield* body(Resource, saved)).id;
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
      );
      return account;
    });
  const call = <A>(path: string, output: Schema.Decoder<A>, tool: string, profile: string) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
        profile,
        tool,
        input: tool === "probe" ? { origin: "" } : {},
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return yield* body(output, response);
    });
  const callWith = <A>(
    path: string,
    output: Schema.Decoder<A>,
    tool: string,
    profile: string,
    input: object,
  ) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
        profile,
        tool,
        input,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return yield* body(output, response);
    });
  /** The first redirect of an authorization URL: the callback the issuer sends the browser to. */
  const consent = (authorizationUrl: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* HttpClient.withScope(http).get(authorizationUrl);
        expect(response.status).toBe(302);
        const location = response.headers.location;
        if (location === undefined)
          return yield* Effect.die("The issuer did not return a callback");
        return location;
      }),
    ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  return { api, actors, prefix, deploy, connection, submit, call, callWith, consent };
});

layer(HostedLive, { excludeTestServices: true })("Credential placement", (it) => {
  it.effect(scenarios.credentialPlacementMatched.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, submit, callWith } = yield* harness;
        const upstream = yield* credentialUpstream;
        const name = `Credential placement ${randomUUID().slice(0, 8)}`;
        const { path } = yield* deploy(name, placedApp(name, `127.0.0.1:${upstream.port}`));
        const values = {
          token: `synthetic-token-${randomUUID()}`,
          email: "owner@example.test",
          basic: `synthetic-basic-${randomUUID()}`,
          pairs: [0, 1].map(() => ({
            user: `synthetic-user-${randomUUID()}`,
            password: `synthetic-password-${randomUUID()}`,
          })),
          key: `synthetic-key-${randomUUID()}`,
          encoded: `synthetic-encoded-${randomUUID()}`,
          insecure: `synthetic-insecure-${randomUUID()}`,
        };
        const { id: profile } = yield* createProfile(
          yield* Actors.pipe(Effect.map((actors) => actors.owner)),
          path,
        );
        yield* submit(path, "bearerService", profile, { token: values.token });
        yield* submit(path, "basicService", profile, { email: values.email, token: values.basic });
        for (const pair of values.pairs) yield* submit(path, "pairs", profile, pair);
        yield* submit(path, "keyService", profile, { key: values.key });
        yield* submit(path, "encodedService", profile, { key: values.encoded });
        yield* submit(path, "insecureService", profile, { token: values.insecure });
        // The service serves only requests that carry what it issued, exactly where it expects it.
        const basicOf = (user: string, password: string) =>
          `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
        yield* upstream.issue([
          { in: "header", name: "authorization", value: `Bearer ${values.token}` },
          { in: "header", name: "authorization", value: basicOf(values.email, values.basic) },
          {
            in: "header",
            name: "authorization",
            value: basicOf("someone@example.test", values.basic),
          },
          ...values.pairs.map(
            (pair) =>
              ({
                in: "header",
                name: "authorization",
                value: basicOf(pair.user, pair.password),
              }) as const,
          ),
          { in: "header", name: "x-goog-api-key", value: values.key },
          { in: "query", name: "key", value: values.key },
          {
            in: "query",
            name: "auth",
            value: Buffer.from(`k:${values.encoded}`).toString("base64"),
          },
          {
            in: "header",
            name: "x-auth",
            value: `Token${Buffer.from(values.encoded).toString("base64")}`,
          },
        ]);

        const fields = yield* callWith(
          path,
          Schema.Struct({
            bearer: Schema.Struct({ token: Schema.String }),
            basic: Schema.Struct({ email: Schema.String, token: Schema.String }),
            pairs: Schema.Array(Schema.Struct({ user: Schema.String, password: Schema.String })),
            key: Schema.Struct({ key: Schema.String }),
            encoded: Schema.Struct({ key: Schema.String }),
          }),
          "fields",
          profile,
          {},
        );
        // Secret fields are handles; a plain field keeps its value.
        expect(fields.bearer.token).toMatch(handle);
        expect(fields.basic.email).toBe(values.email);
        expect(fields.basic.token).toMatch(handle);
        // Every secret field of every account is sealed.
        const pairFields = fields.pairs.flatMap((pair) => [pair.user, pair.password]);
        expect(pairFields).toHaveLength(4);
        for (const value of pairFields) expect(value).toMatch(handle);
        expect(fields.key.key).toMatch(handle);
        expect(fields.encoded.key).toMatch(handle);

        const probe = yield* callWith(path, Schema.Record(Schema.String, Sent), "probe", profile, {
          origin: upstream.origin,
        });
        const sent = (key: string) => probe[key]?.status;
        const refused = (key: string) => probe[key]?.refusal;
        // Exactly the declared templates are substituted, written by hand or by the helpers.
        for (const key of [
          "bearerHelper",
          "bearerWritten",
          "basicHelper",
          "basicOtherUser",
          "pairHelper",
          "keyHeader",
          "keyUrl",
          "encodedQuery",
          "encodedHeader",
        ])
          expect(sent(key), key).toBe(200);
        // Anything else carrying a placed handle is refused, naming where the handle was.
        const placement = (location: string) => ({ reason: "credential_placement", location });
        expect(refused("bearerPrefixed")).toEqual(placement("authorization header"));
        expect(refused("bearerTwice")).toEqual(placement("authorization header"));
        expect(refused("bearerExtra")).toEqual(placement("authorization header"));
        expect(refused("otherHeader")).toEqual(placement("x-note header"));
        expect(refused("jsonBody")).toEqual(placement("request body"));
        expect(refused("formBody")).toEqual(placement("request body"));
        expect(refused("urlPath")).toEqual(placement("URL"));
        expect(refused("queryParameter")).toEqual(placement("token query parameter"));
        // A secret cannot fill another field's slot, and Basic slots cannot be swapped or mixed.
        expect(refused("basicSecretAsUser")).toEqual(placement("authorization header"));
        expect(refused("bearerAsBasic")).toEqual(placement("authorization header"));
        expect(refused("pairSwapped")).toEqual(placement("authorization header"));
        expect(refused("pairAcrossAccounts")).toEqual(placement("authorization header"));
        expect(refused("keyWrongName")).toEqual(placement("apikey query parameter"));
        // Over plain HTTP to a host that is not loopback, a placed credential is never sent.
        expect(refused("insecure")).toEqual({ reason: "credential_transport" });

        const received = yield* upstream.received;
        const at = (pathname: string): ReceivedRequest => {
          const found = received.find(
            (entry) => new URL(entry.url, upstream.origin).pathname === pathname,
          );
          if (found === undefined) return expect.fail(`The service never received ${pathname}`);
          return found;
        };
        const basicDecoded = (entry: ReceivedRequest) =>
          Buffer.from(entry.authorization?.replace(/^Basic /, "") ?? "", "base64").toString();
        expect(at("/bearer-helper").authorization).toBe(`Bearer ${values.token}`);
        expect(at("/bearer-written").authorization).toBe(`Bearer ${values.token}`);
        expect(basicDecoded(at("/basic-helper"))).toBe(`${values.email}:${values.basic}`);
        // A plain field's slot carries what the app wrote; the secret still fills only its own.
        expect(basicDecoded(at("/basic-other-user"))).toBe(`someone@example.test:${values.basic}`);
        expect(values.pairs.map((pair) => `${pair.user}:${pair.password}`)).toContain(
          basicDecoded(at("/pair-helper")),
        );
        // Base64 placements are found and filled in a query parameter and after literal text.
        const encodedQuery = new URL(at("/encoded-query").url, upstream.origin);
        expect(encodedQuery.searchParams.get("auth")).toBe(
          Buffer.from(`k:${values.encoded}`).toString("base64"),
        );
        expect(at("/encoded-header").headers["x-auth"]).toBe(
          `Token${Buffer.from(values.encoded).toString("base64")}`,
        );
        const keyRequests = received.filter((entry) => entry.url.startsWith("/key-"));
        expect(keyRequests).toHaveLength(2);
        // The key header carries exactly the key, under the name the provider declares.
        expect(at("/key-header").headers["x-goog-api-key"]).toBe(values.key);
        const keyUrl = new URL(at("/key-url").url, upstream.origin);
        expect(keyUrl.searchParams.get("key")).toBe(values.key);
        expect(keyUrl.searchParams.get("q")).toBe("a b");
        // Refused requests were never sent, and every request sent carried a real credential.
        expect(received.filter((entry) => entry.url.startsWith("/refused"))).toEqual([]);
        for (const entry of received) expect(entry.authenticated, entry.url).toBe(true);
        const secrets = [
          values.token,
          values.basic,
          values.key,
          ...values.pairs.map((p) => p.password),
        ];
        const elsewhere = received.filter(
          (entry) =>
            ![
              "/bearer-helper",
              "/bearer-written",
              "/basic-helper",
              "/basic-other-user",
              "/pair-helper",
              "/key-header",
              "/key-url",
              "/encoded-query",
              "/encoded-header",
            ].includes(new URL(entry.url, upstream.origin).pathname),
        );
        for (const secret of secrets) expect(JSON.stringify(elsewhere)).not.toContain(secret);
      }),
    ),
  );

  it.effect(scenarios.credentialPlacementDeclared.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix } = yield* harness;
        /** Deploy a declaration that must fail, and return what the deployer reads. */
        const refusedDeploy = (request: string, options?: { readonly hosts?: boolean }) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `Declared placements ${randomUUID().slice(0, 8)}`,
              files: [{ path: "index.ts", content: declaredApp(request, options) }, appsManifest],
            });
            expect(response.status, JSON.stringify(response.body)).not.toBe(200);
            return JSON.stringify(response.body);
          });
        // An untagged template literal turns a field reference into a string, which throws.
        expect(
          yield* refusedDeploy('({ token }) => header("authorization", `Bearer ${token}`)'),
        ).toContain("Build placement values with t`...`");
        expect(yield* refusedDeploy("({ secret }) => bearer(secret)")).toContain(
          'references \\"secret\\", which is not one of its fields',
        );
        expect(yield* refusedDeploy("({ signing }) => bearer(signing)")).toContain(
          'references the raw() field \\"signing\\"',
        );
        expect(
          yield* refusedDeploy('({ region }) => header("x-region", t`fixed-${region}`)'),
        ).toContain("references no secret field");
        expect(yield* refusedDeploy("({ token }) => bearer(token)", { hosts: false })).toContain(
          "but no hosts",
        );
      }),
    ),
  );

  it.effect(scenarios.credentialOutboundOwn.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, submit, callWith } = yield* harness;
        const target = yield* Target;
        const fs = yield* FileSystem.FileSystem;
        const log = `${target.directory}/server.log`;
        const logged = (yield* fs.readFileString(log)).length;
        const upstream = yield* credentialUpstream;
        const name = `Credential outbound ${randomUUID().slice(0, 8)}`;
        const { path } = yield* deploy(name, outboundApp(name, `127.0.0.1:${upstream.port}`));
        const { id: profile } = yield* createProfile(
          yield* Actors.pipe(Effect.map((actors) => actors.owner)),
          path,
        );
        // Secrets the network cannot send as header values. App code holds handles, which it can.
        const secret = (label: string) => `synthetic-${label}-${randomUUID()}\r\nx-injected: 1`;
        const values = { placed: secret("placed"), anywhere: secret("anywhere") };
        yield* submit(path, "placed", profile, { token: values.placed });
        yield* submit(path, "anywhere", profile, { token: values.anywhere });
        const Ended = Schema.Struct({ status: Schema.Number, message: Schema.String });
        const failed = yield* callWith(
          path,
          Schema.Struct({ placed: Ended, anywhere: Ended }),
          "fail",
          profile,
          { origin: upstream.origin },
        );
        // Neither request was sent, and nothing app code read or the server logged quotes the
        // value the outbound substituted.
        expect(failed.placed.status).not.toBe(200);
        expect(failed.anywhere.status).not.toBe(200);
        const output = (yield* fs.readFileString(log)).slice(logged);
        for (const value of Object.values(values)) {
          const quoted = value.split("\r\n")[0]!;
          expect(JSON.stringify(failed)).not.toContain(quoted);
          expect(output).not.toContain(quoted);
        }
        // TRACE asks the service to send the request back, so no handle is ever sent with it.
        const traced = yield* callWith(
          path,
          Schema.Struct({ placed: Sent, anywhere: Sent }),
          "trace",
          profile,
          { origin: upstream.origin },
        );
        expect(traced.placed.refusal).toEqual({ reason: "credential_method" });
        expect(traced.anywhere.refusal).toEqual({ reason: "credential_method" });
        expect(yield* upstream.received).toEqual([]);
      }),
    ),
  );

  /** Restart the product with the operator's clients set to `clients`, as JSON. */
  const restartWith = (clients: string, clockAdvance?: number) =>
    Effect.gen(function* () {
      yield* serverControl("stop");
      if (clockAdvance !== undefined)
        yield* serverControl("clock/advance", 200, { milliseconds: clockAdvance });
      yield* serverControl("environment", 200, { EXECUTOR_FIRST_PARTY_OAUTH_CLIENTS: clients });
      yield* serverControl("start");
    });

  /**
   * Turn on the operator's OAuth client for the issuer, restarting the product with it. `hosts`
   * replaces the client's hosts, the issuer's and the store's by default.
   */
  const operatorWith = (
    options: Parameters<typeof operatorClients>[2] & {
      readonly hosts?: (origins: { issuerHost: string; storeHost: string }) => readonly string[];
      readonly registration?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      const issuer = yield* oauthSetupIssuer;
      const store = yield* credentialUpstream;
      const issuerHost = new URL(issuer.origin).host;
      const storeHost = `127.0.0.1:${store.port}`;
      // Unless asked, nothing else could sign in: the issuer registers no clients. Its resource
      // and the store serve only the tokens the issuer issued, as real services do, so a request
      // whose handle was never replaced by the token is refused.
      yield* issuer.configure({
        registration: options.registration ?? false,
        refreshTokens: true,
        scopes: ["mail.read"],
        resourceTokens: "issued",
      });
      yield* store.issue([{ in: "header", name: "authorization", value: `Bearer ${token}` }]);
      const hosts = options.hosts?.({ issuerHost, storeHost }) ?? [issuerHost, storeHost];
      yield* restartWith(operatorClients(issuer.origin, hosts, options));
      return { issuer, store, issuerHost, storeHost };
    });
  const operator = operatorWith();

  it.effect(scenarios.credentialManagedOffered.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, deploy, connection } = yield* harness;
        // The operator's client asks for its own user permissions, as Slack's `user_scope` does.
        const { issuer, store, issuerHost, storeHost } = yield* operatorWith({
          authorizationParams: { user_scope: "admin.users:write" },
        });
        const other = yield* oauthSetupIssuer;
        yield* other.configure({ registration: false, scopes: ["mail.read"] });
        const base = {
          name: "Synthetic Mail",
          discover: `${issuer.origin}/mcp`,
          hosts: [issuerHost, storeHost],
          resource: `${issuer.origin}/resource`,
          store: store.origin,
          undeclared: store.undeclaredOrigin,
        };
        /** How setup answers for the app's provider, given a connection to it. */
        const setup = (deployed: { readonly path: string; readonly app: typeof App.Type }) =>
          Effect.gen(function* () {
            const profile = yield* createProfile(actors.owner, deployed.path);
            const id = yield* connection(deployed.path, "mail", profile.id);
            const provider = deployed.app.requirements.accounts.mail!.provider;
            const started = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${id}/oauth/start`,
              { method: "oauth", label: "Mail" },
            );
            const answered = yield* api.request(
              actors.owner,
              "GET",
              `${prefix}/providers/${provider}/oauth/oauth/setup`,
            );
            return { started, setup: yield* body(Setup, answered) };
          });

        const release = yield* publishedRelease("0.0.1-beta.59");
        const pinnedManifest = {
          path: "package.json",
          content: JSON.stringify({ dependencies: { apps: release.url } }),
        };
        // The provider asks for other user permissions than the operator's client does.
        const userRead = { authorizationParams: { user_scope: "users:read" } };
        const variants = {
          matched: mailApp({ ...base, ...userRead }),
          // The provider asks for no user permissions; the operator's client still does.
          unscoped: mailApp(base),
          // The provider asks for no scopes: the operator's default scopes are asked for.
          defaults: mailApp({ ...base, scopes: [] }),
          // The same provider name on another authorization server is not the operator's.
          elsewhere: mailApp({ ...base, ...userRead, discover: `${other.origin}/mcp` }),
          // A scope the operator does not allow.
          wider: mailApp({ ...base, scopes: ["mail.read", "mail.delete"] }),
          // Placements of its own, which the operator's header replaces.
          leaky: mailApp({
            ...base,
            request: '({ access_token }) => header("x-leak", access_token)',
          }),
          // A separator that would smuggle a scope the operator does not allow between the
          // requested ones.
          separator: mailApp({
            ...base,
            scopes: ["mail.read", "mail.compose"],
            scopeSeparator: " mail.delete ",
          }),
        };
        const answers = yield* Effect.all(
          [
            ...Object.entries(variants).map(([key, source]) =>
              deploy(`Mail ${key} ${randomUUID().slice(0, 8)}`, source).pipe(
                Effect.flatMap(setup),
                Effect.map((answer) => [key, answer] as const),
              ),
            ),
            // A build that knows no placements receives sealed handles all the same.
            deploy(
              `Mail protocol 11 ${randomUUID().slice(0, 8)}`,
              mailApp({ ...base, legacy: true }),
              pinnedManifest,
            ).pipe(
              Effect.flatMap(setup),
              Effect.map((answer) => ["protocol11", answer] as const),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map((entries) => Object.fromEntries(entries)));

        const matched = answers["matched"]!;
        expect(matched.setup).toMatchObject({
          mode: "automatic",
          firstParty: { label: "Executor for Synthetic Mail" },
        });
        expect(matched.started.status, JSON.stringify(matched.started.body)).toBe(200);
        const redirect = yield* body(Redirect, matched.started);
        expect(new URL(redirect.authorizationUrl).searchParams.get("client_id")).toBe(
          "first-party-client",
        );
        // Setup shows the user permissions the operator's client will ask for, which sign-in
        // sends, whatever the provider declares; another client asks for the provider's.
        for (const key of ["matched", "unscoped"]) {
          const answer = answers[key]!;
          expect(answer.setup.firstParty, key).toBeDefined();
          expect(answer.setup.userScopes, key).toEqual(["admin.users:write"]);
          expect(answer.started.status, JSON.stringify(answer.started.body)).toBe(200);
          const sent = new URL((yield* body(Redirect, answer.started)).authorizationUrl);
          expect(sent.searchParams.get("user_scope"), key).toBe("admin.users:write");
        }
        expect(answers["elsewhere"]!.setup.userScopes).toEqual(["users:read"]);
        // The operator's client is offered, but the scope parameter is the operator's own joining
        // of exactly the requested scopes; the provider's separator never reaches the wire.
        const separated = answers["separator"]!;
        expect(separated.started.status, JSON.stringify(separated.started.body)).toBe(200);
        const separatedUrl = new URL((yield* body(Redirect, separated.started)).authorizationUrl);
        expect(separatedUrl.searchParams.get("client_id")).toBe("first-party-client");
        expect(separatedUrl.searchParams.get("scope")).toBe("mail.read mail.compose");
        // A provider that asks for no scopes gets the operator's defaults, and setup says so.
        const defaults = answers["defaults"]!;
        expect(defaults.setup.scopes).toEqual(["mail.read"]);
        const defaultsUrl = new URL((yield* body(Redirect, defaults.started)).authorizationUrl);
        expect(defaultsUrl.searchParams.get("client_id")).toBe("first-party-client");
        expect(defaultsUrl.searchParams.get("scope")).toBe("mail.read");
        // App-declared placements and an older framework do not decide whether it is offered.
        for (const key of ["leaky", "protocol11"]) {
          expect(answers[key]!.setup.firstParty, key).toBeDefined();
          const started = new URL((yield* body(Redirect, answers[key]!.started)).authorizationUrl);
          expect(started.searchParams.get("client_id"), key).toBe("first-party-client");
        }
        // Another server, or a scope outside `allowedScopes`, is never offered the client.
        for (const key of ["elsewhere", "wider"]) {
          expect(answers[key]!.setup.firstParty, key).toBeUndefined();
          expect(answers[key]!.started.body, key).toMatchObject({ _tag: "OAuthClientUnavailable" });
        }
      }),
    ),
  );

  /** An app on the operator client's issuer, and an account connected through its client. */
  const managedAccount = (rawToken: boolean, configured = operator) =>
    Effect.gen(function* () {
      const { api, actors, prefix, deploy, connection, consent } = yield* harness;
      const { issuer, store, issuerHost, storeHost } = yield* configured;
      const name = `Synthetic Mail ${randomUUID().slice(0, 8)}`;
      const options = {
        name: "Synthetic Mail",
        discover: `${issuer.origin}/mcp`,
        hosts: [issuerHost, storeHost],
        resource: `${issuer.origin}/resource`,
        store: store.origin,
        undeclared: store.undeclaredOrigin,
        rawToken,
      };
      const { path, app } = yield* deploy(name, mailApp(options));
      const profile = (yield* createProfile(actors.owner, path)).id;
      const id = yield* connection(path, "mail", profile);
      const started = yield* body(
        Redirect,
        yield* api.request(actors.owner, "POST", `${prefix}/connections/${id}/oauth/start`, {
          method: "oauth",
          label: "Mail",
        }),
      );
      yield* issuer.allowClient({
        clientId: "first-party-client",
        clientSecret: "first-party-secret",
        redirect: started.redirectUri,
      });
      const completed = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${id}/oauth/complete`,
        { callbackUrl: yield* consent(started.authorizationUrl) },
      );
      expect(completed.status, JSON.stringify(completed.body)).toBe(200);
      const account = (yield* body(Resource, completed)).id;
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
      );
      // The operator's secret authenticated the exchange; the app never saw it.
      expect((yield* issuer.metrics).tokenChecks).toMatchObject({ authSecret: true });
      return { name, options, path, app, profile, account, store, issuer, issuerHost, storeHost };
    });

  it.effect(scenarios.credentialManagedPlaced.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, call, callWith } = yield* harness;
        // The provider marks the token raw(); a managed account is sealed anyway.
        const { path, app, profile, account, store, issuer, issuerHost, storeHost } =
          yield* managedAccount(true);

        // Tool calls, discovery, workflow steps and account checks all read handles.
        const [fields, listed, stepped, health] = yield* Effect.all(
          [
            call(path, Schema.Struct({ access_token: Schema.String }), "fields", profile),
            api
              .request(actors.owner, "GET", `${path}/tools?profile=${profile}`)
              .pipe(Effect.flatMap((response) => body(Tools, response))),
            Effect.gen(function* () {
              const run = yield* body(
                Run,
                yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
                  profile,
                  workflow: "fields",
                  input: {},
                  key: randomUUID(),
                }),
              );
              return yield* api
                .request(actors.owner, "GET", `${path}/workflow-runs/${run.id}`)
                .pipe(
                  Effect.flatMap((response) => body(Run, response)),
                  Effect.flatMap((current) =>
                    current.status === "complete"
                      ? Effect.succeed(current.output)
                      : ["errored", "terminated"].includes(current.status)
                        ? Effect.die(new Error(JSON.stringify(current)))
                        : Effect.fail(new Error("The workflow run has not finished")),
                  ),
                  Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 150 }),
                );
            }),
            api
              .request(actors.owner, "POST", `${prefix}/accounts/${account}/health`)
              .pipe(Effect.flatMap((response) => body(Health, response))),
          ],
          { concurrency: "unbounded" },
        );
        expect(fields.access_token).toMatch(handle);
        expect(listed.items.map((tool) => tool.name)).toContain("sealedDiscovery");
        expect(stepped).toMatchObject({ access_token: expect.stringMatching(handle) });
        expect(health.apps.find((entry) => entry.app === app.id)?.check).toMatchObject({
          status: "healthy",
        });

        const probe = yield* call(path, Probe, "probe", profile);
        // The operator's header reaches the service with the real token. The service echoed it;
        // app code read the handle instead.
        expect(probe.resource.status).toBe(200);
        expect((yield* issuer.metrics).resourceAuthorizations.at(-1)).toBe(realBearer);
        expect(probe.resource.body.authorization).toMatch(/^Bearer exsec2_[0-9a-f]+_$/);
        // The handle anywhere but the operator's header is refused: other headers, the query,
        // bodies, and altered handles.
        expect(probe.leak.refusal).toEqual({
          reason: "credential_placement",
          location: "x-leak header",
        });
        expect(probe.leakTemplate.refusal).toEqual({
          reason: "credential_placement",
          location: "x-leak header",
        });
        expect(probe.tampered.refusal).toMatchObject({ reason: "credential_app" });
        // A page title the service would store is refused before it is sent.
        expect(probe.pageTitle.refusal).toEqual({
          reason: "credential_placement",
          location: "request body",
        });
        expect(probe.query.refusal).toEqual({ reason: "credential_placement", location: "URL" });
        expect(probe.undeclared.refusal).toMatchObject({ reason: "credential_host" });
        // TRACE asks the service to send the request back, so it never carries a credential.
        expect(probe.trace.refusal).toEqual({ reason: "credential_method" });
        // Whatever the app wrote in the operator's header, and any other credential header it
        // set, the service receives only the operator's value.
        expect(probe.rewritten).toEqual({ status: 200, refusal: null });
        // A body the outbound does not read, such as a mail draft, carries only the handle, and
        // reading it back returns the handle, never the token.
        expect(probe.draft.status).toBe(204);
        expect(probe.stored).toMatch(/exsec2_[0-9a-f]+_$/);
        expect(probe.stored).not.toContain(token);
        expect(yield* store.stored).not.toContain(token);
        const received = yield* store.received;
        const at = (url: string) => received.find((entry) => entry.url === url);
        expect(at("/rewritten")?.authorization).toBe(realBearer);
        expect(at("/rewritten")?.headers["proxy-authorization"]).toBeUndefined();
        expect(at("/trace")).toBeUndefined();
        // Only the account check and the rewritten request, in the operator's header, carried
        // the token.
        expect(at("/check")?.authorization).toBe(realBearer);
        const sent = ["/check", "/rewritten"];
        expect(JSON.stringify(received.filter((entry) => !sent.includes(entry.url)))).not.toContain(
          token,
        );

        // The operator moves the token to another header without a scheme. App code renders it
        // with the account's headers, and the app's own authorization header is removed.
        yield* restartWith(
          operatorClients(issuer.origin, [issuerHost, storeHost], {
            header: "x-mail-token",
            scheme: null,
          }),
        );
        yield* store.issue([{ in: "header", name: "x-mail-token", value: token }]);
        const moved = yield* callWith(path, Sent, "headers", profile, {
          url: `${store.origin}/moved`,
        });
        expect(moved).toEqual({ status: 200, refusal: null });
        const movedTo = (yield* store.received).find((entry) => entry.url === "/moved");
        expect(movedTo?.headers["x-mail-token"]).toBe(token);
        expect(movedTo?.authorization).toBeNull();
        // The handle in `authorization` is now outside the operator's header.
        const elsewhere = yield* callWith(path, Sent, "send", profile, {
          url: `${store.origin}/refused`,
          token: (yield* call(
            path,
            Schema.Struct({ access_token: Schema.String }),
            "fields",
            profile,
          )).access_token,
        });
        expect(elsewhere.refusal).toEqual({
          reason: "credential_placement",
          location: "authorization header",
        });
      }),
    ),
  );

  it.effect(scenarios.credentialManagedKept.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, deploy, call } = yield* harness;
        const { name, options, path, app, profile, account, store, issuer } =
          yield* managedAccount(false);
        const release = yield* publishedRelease("0.0.1-beta.59");
        const Read = Schema.Struct({ token: Schema.String, status: Schema.Number });
        const [widened, placed, pinned] = yield* Effect.all(
          [
            // An update of the app that widens its hosts.
            api.request(actors.owner, "POST", `${path}/deploy`, {
              files: [
                {
                  path: "index.ts",
                  content: mailApp({
                    ...options,
                    hosts: [...options.hosts, `localhost:${store.port}`],
                  }),
                },
                appsManifest,
              ],
            }),
            // The provider with placements of its own, one of them a header the operator's is not.
            deploy(
              `${name} placed`,
              mailApp({
                ...options,
                request:
                  '({ access_token }) => [bearer(access_token), header("x-leak", access_token)]',
              }),
            ),
            // The same provider in a build that knows no placements.
            deploy(`${name} protocol 11`, mailApp({ ...options, legacy: true }), {
              path: "package.json",
              content: JSON.stringify({ dependencies: { apps: release.url } }),
            }),
          ],
          { concurrency: "unbounded" },
        );

        // Widening the app's hosts does not widen where the managed token goes.
        expect(widened.status, JSON.stringify(widened.body)).toBe(200);
        const again = yield* call(path, Probe, "probe", profile);
        expect(again.undeclared.refusal).toMatchObject({ reason: "credential_host" });
        expect(again.resource.status).toBe(200);
        expect((yield* issuer.metrics).resourceAuthorizations.at(-1)).toBe(realBearer);

        // An update that drops the app's hosts leaves the managed token nowhere to go, even though
        // the account was connected with hosts.
        const unhosted = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          files: [
            { path: "index.ts", content: mailApp({ ...options, hosts: undefined }) },
            appsManifest,
          ],
        });
        expect(unhosted.status, JSON.stringify(unhosted.body)).toBe(200);
        const nowhere = yield* call(path, Read, "resource", profile);
        expect(nowhere.token).toMatch(handle);
        expect(nowhere.status).toBe(421);

        // A provider's own placements are ignored for a managed account: signed in through it,
        // only the operator's header carries the token, and the provider's other header is refused.
        const signedIn = yield* startSignIn(placed.path);
        yield* completeSignIn(issuer, signedIn.connection, yield* body(Redirect, signedIn.started));
        const placedProbe = yield* call(placed.path, Probe, "probe", signedIn.profile);
        expect(placedProbe.resource.status).toBe(200);
        expect(placedProbe.leak.refusal).toEqual({
          reason: "credential_placement",
          location: "x-leak header",
        });

        // A build that knows no placements reads the managed account sealed. Its hand-written
        // bearer header is the operator's, so it reaches the service; the handle anywhere else is
        // refused as for any app.
        const provider = (deployed: { readonly app: typeof App.Type }) =>
          deployed.app.requirements.accounts.mail!.provider;
        expect(provider(pinned)).toBe(provider({ app }));
        const oldProfile = yield* createProfile(actors.owner, pinned.path);
        const selected = yield* selectProfileAccounts(actors.owner, pinned.path, oldProfile.id, {
          mail: account,
        });
        expect(selected.status, JSON.stringify(selected.body)).toBe(200);
        const old = yield* call(pinned.path, Read, "resource", oldProfile.id);
        expect(old.token).toMatch(handle);
        expect(old.status).toBe(200);
        expect((yield* issuer.metrics).resourceAuthorizations.at(-1)).toBe(realBearer);
        const oldProbe = yield* call(pinned.path, Probe, "probe", oldProfile.id);
        expect(oldProbe.leak.refusal).toEqual({
          reason: "credential_placement",
          location: "x-leak header",
        });
        expect(oldProbe.pageTitle.refusal).toEqual({
          reason: "credential_placement",
          location: "request body",
        });

        // The operator removes its client: the managed token goes nowhere from the next
        // invocation on.
        yield* restartWith("[]");
        const reads = (yield* issuer.metrics).resourceRequests.GET;
        const removed = yield* call(pinned.path, Read, "resource", oldProfile.id);
        expect(removed.status).toBe(421);
        expect((yield* issuer.metrics).resourceRequests.GET).toBe(reads);
        expect(JSON.stringify(yield* store.received)).not.toContain(`/leak`);
      }),
    ),
  );

  /** Start signing in to `requirement` of a fresh profile of the app at `path`. */
  const startSignIn = (path: string, requirement = "mail") =>
    Effect.gen(function* () {
      const { api, actors, prefix, connection } = yield* harness;
      const profile = (yield* createProfile(actors.owner, path)).id;
      const id = yield* connection(path, requirement, profile);
      const started = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${id}/oauth/start`,
        { method: "oauth", label: "Mail" },
      );
      return { profile, connection: id, started };
    });
  /** Accept the operator's client for `redirect`, finish the started sign-in and answer. */
  const finishSignIn = (
    issuer: Effect.Success<typeof oauthSetupIssuer>,
    connection: string,
    started: typeof Redirect.Type,
  ) =>
    Effect.gen(function* () {
      const { api, actors, prefix, consent } = yield* harness;
      yield* issuer.allowClient({
        clientId: "first-party-client",
        clientSecret: "first-party-secret",
        redirect: started.redirectUri,
      });
      return yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${connection}/oauth/complete`,
        { callbackUrl: yield* consent(started.authorizationUrl) },
      );
    });
  /** Complete the started sign-in with the operator's client and return its account. */
  const completeSignIn = (
    issuer: Effect.Success<typeof oauthSetupIssuer>,
    connection: string,
    started: typeof Redirect.Type,
  ) =>
    Effect.gen(function* () {
      const { api, actors, prefix } = yield* harness;
      const completed = yield* finishSignIn(issuer, connection, started);
      expect(completed.status, JSON.stringify(completed.body)).toBe(200);
      const account = (yield* body(Resource, completed)).id;
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.ignore),
      );
      return account;
    });

  it.effect(scenarios.credentialManagedScopes.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, deploy } = yield* harness;
        const { issuer, store, issuerHost, storeHost } = yield* operatorWith({ revocation: true });
        const hosts = [issuerHost, storeHost];
        yield* issuer.configure({ revocation: "recorded" });
        const base = {
          name: "Synthetic Mail",
          discover: `${issuer.origin}/mcp`,
          hosts,
          resource: `${issuer.origin}/resource`,
          store: store.origin,
          undeclared: store.undeclaredOrigin,
        };
        const scoped = yield* deploy(
          `Mail scoped ${randomUUID().slice(0, 8)}`,
          mailApp({ ...base, scopes: ["mail.read"] }),
        ).pipe(Effect.map(({ path }) => path));
        /** Sign in through the operator's client and return what completing it answered. */
        const signIn = (path: string) =>
          Effect.gen(function* () {
            const attempt = yield* startSignIn(path);
            expect(attempt.started.status, JSON.stringify(attempt.started.body)).toBe(200);
            const redirect = yield* body(Redirect, attempt.started);
            expect(new URL(redirect.authorizationUrl).searchParams.get("client_id")).toBe(
              "first-party-client",
            );
            const completed = yield* finishSignIn(issuer, attempt.connection, redirect);
            if (completed.status === 200) {
              const account = (yield* body(Resource, completed)).id;
              yield* Effect.addFinalizer(() =>
                api
                  .request(actors.owner, "DELETE", `${prefix}/accounts/${account}`)
                  .pipe(Effect.ignore),
              );
            }
            return { ...attempt, redirect, completed };
          });
        /** The refresh-token revocations the operator's server has received, waiting for `count`. */
        const revoked = (count: number) =>
          issuer.metrics.pipe(
            Effect.flatMap((metrics) =>
              metrics.revocations.length >= count
                ? Effect.succeed(metrics.revocations)
                : Effect.fail(new Error("The operator's server has not been asked to revoke")),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );
        const exceeded = { _tag: "OAuthCompletionFailed", reason: "scope_exceeded" };
        const refreshRevoked = {
          token: "refresh",
          hint: "refresh_token",
          clientAuthenticated: true,
        };

        // A server that grants a scope outside `allowedScopes` is refused: nothing is saved, and
        // the tokens are revoked at the operator's server.
        yield* issuer.configure({ scopeGrant: { defaults: [], exchange: ["mail.delete"] } });
        const broader = yield* signIn(scoped);
        expect((yield* issuer.metrics).authorizationScope).toBe("mail.read");
        expect(broader.completed.status, JSON.stringify(broader.completed.body)).toBe(400);
        expect(broader.completed.body).toMatchObject(exceeded);
        expect(yield* revoked(1)).toEqual([refreshRevoked]);
        expect(JSON.stringify(broader.completed.body)).not.toContain("synthetic-");
        const refusal = yield* messageOf(broader.completed);
        expect(refusal).toContain("Executor rejected the sign-in and saved nothing");
        expect(refusal).not.toMatch(claimsRevoked);

        // One within `allowedScopes`, though not asked for, is kept.
        yield* issuer.configure({ scopeGrant: { defaults: [], exchange: ["mail.compose"] } });
        const allowed = yield* signIn(scoped);
        expect(allowed.completed.status, JSON.stringify(allowed.completed.body)).toBe(200);

        // GitHub reports granted scopes separated by commas. Read with the request's separator,
        // `mail.read,mail.compose` is one scope the operator does not allow, and is refused.
        yield* issuer.configure({
          scopeGrant: { defaults: [], exchange: ["mail.compose"], separator: "," },
        });
        const commas = yield* signIn(scoped);
        expect(commas.completed.status, JSON.stringify(commas.completed.body)).toBe(400);
        expect(commas.completed.body).toMatchObject(exceeded);
        expect(yield* revoked(2)).toEqual([refreshRevoked, refreshRevoked]);
        // With the server's `grantedScopeSeparator`, it reads as the two scopes it is.
        yield* restartWith(
          operatorClients(issuer.origin, hosts, { revocation: true, grantedScopeSeparator: "," }),
        );
        const github = yield* signIn(scoped);
        expect(github.completed.status, JSON.stringify(github.completed.body)).toBe(200);
        // The request still joins scopes with a space.
        expect((yield* issuer.metrics).authorizationScope).toBe("mail.read");
        yield* restartWith(operatorClients(issuer.origin, hosts, { revocation: true }));

        // So is a renewal that widens the grant: the account must reconnect, the widened token
        // is never used, and the grant is revoked. The service refuses the current token, so the
        // call renews it.
        yield* issuer.configure({
          scopeGrant: { defaults: [], refresh: ["mail.delete"] },
          expiresIn: 3600,
        });
        const renewing = yield* signIn(scoped);
        expect(renewing.completed.status, JSON.stringify(renewing.completed.body)).toBe(200);
        yield* issuer.expireAccessTokens;
        const read = yield* api.request(actors.owner, "POST", `${scoped}/tools/call`, {
          profile: renewing.profile,
          tool: "resource",
          input: {},
        });
        expect(read.status, JSON.stringify(read.body)).toBe(409);
        expect(read.body).toMatchObject({
          _tag: "OAuthReconnectRequired",
          reason: "scope_exceeded",
        });
        const stopped = yield* messageOf(read);
        expect(stopped).toContain("stopped using");
        expect(stopped).not.toMatch(claimsRevoked);
        expect((yield* issuer.metrics).refreshes).toBeGreaterThan(0);
        expect(yield* revoked(3)).toEqual([refreshRevoked, refreshRevoked, refreshRevoked]);
        const authorizations = (yield* issuer.metrics).resourceAuthorizations;
        expect(authorizations.filter((value) => value?.includes("refreshed"))).toEqual([]);

        // A reconnect can replace the grant while a widening renewal is still waiting for its
        // answer. The widened tokens are revoked all the same, and only they are: the reconnected
        // grant's refresh token, issued at its sign-in, is never revoked and keeps working.
        yield* issuer.configure({
          scopeGrant: { defaults: [] },
          rotateRefreshTokens: true,
          expiresIn: 20,
        });
        const racing = yield* signIn(scoped);
        expect(racing.completed.status, JSON.stringify(racing.completed.body)).toBe(200);
        const raced = (yield* body(Resource, racing.completed)).id;
        const before = (yield* issuer.metrics).revokedRefreshTokens;
        yield* issuer.configure({
          scopeGrant: { defaults: [], refresh: ["mail.delete"] },
          hold: "refresh-issued",
        });
        const use = api.request(actors.owner, "POST", `${scoped}/tools/call`, {
          profile: racing.profile,
          tool: "resource",
          input: {},
        });
        const running = yield* Effect.forkChild(use);
        yield* issuer.metrics.pipe(
          Effect.filterOrFail(
            (metrics) => metrics.held > 0,
            () => new Error("The widening renewal has not reached the operator's server"),
          ),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
        );
        yield* issuer.configure({ scopeGrant: { defaults: [] }, expiresIn: 3600, hold: null });
        const reconnecting = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${scoped}/connections`, {
            requirement: "mail",
            profile: racing.profile,
            account: raced,
          }),
        );
        const restarted = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${reconnecting.id}/oauth/start`,
          { method: "oauth", label: "Mail" },
        );
        const reconnected = yield* finishSignIn(
          issuer,
          reconnecting.id,
          yield* body(Redirect, restarted),
        );
        expect(reconnected.status, JSON.stringify(reconnected.body)).toBe(200);
        yield* issuer.release;
        // The call that lost its renewal reads the reconnected grant.
        const lost = yield* Fiber.join(running);
        expect(lost.status, JSON.stringify(lost.body)).toBe(200);
        const revokedRefreshes = yield* issuer.metrics.pipe(
          Effect.map((metrics) => metrics.revokedRefreshTokens),
          Effect.filterOrFail(
            (revoked) => revoked.length > before.length,
            () => new Error("The widened refresh token was never revoked"),
          ),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
        );
        expect(revokedRefreshes).toEqual([...before, "refresh"]);
        const after = yield* use;
        expect(after.status, JSON.stringify(after.body)).toBe(200);
        expect((yield* issuer.metrics).revokedRefreshTokens).toEqual([...before, "refresh"]);
        const resourceAuthorizations = (yield* issuer.metrics).resourceAuthorizations;
        expect(resourceAuthorizations.filter((value) => value?.includes("refreshed"))).toEqual([]);
      }),
    ),
  );

  it.effect(scenarios.credentialManagedSettingsInvalid.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const fs = yield* FileSystem.FileSystem;
        const log = `${target.directory}/server.log`;
        const secret = `synthetic-operator-secret-${randomUUID()}`;
        const client = {
          id: "synthetic-mail",
          label: "Executor for Synthetic Mail",
          server: {
            authorizationUrl: "https://auth.example.test/authorize",
            tokenUrl: "https://auth.example.test/token",
          },
          clientId: "first-party-client",
          clientSecret: secret,
          tokenEndpointAuthMethod: "client_secret_basic",
          defaultScopes: ["mail.read"],
          placement: { hosts: ["mail.example.test"] },
        };
        /** Start the product with `settings` and return what it logged; it must not start. */
        const refused = (settings: string) =>
          Effect.gen(function* () {
            const before = (yield* fs.readFileString(log)).length;
            yield* serverControl("stop");
            yield* serverControl("environment", 200, {
              EXECUTOR_FIRST_PARTY_OAUTH_CLIENTS: settings,
            });
            yield* serverControl("start", 500);
            const output = (yield* fs.readFileString(log)).slice(before);
            // The operator's secret never reaches the output, whatever is wrong.
            expect(output).not.toContain(secret);
            expect(output).toContain("EXECUTOR_FIRST_PARTY_OAUTH_CLIENTS");
            return output;
          });
        // Whatever happens, the next scenario finds the product running.
        yield* Effect.addFinalizer(() => restartWith("[]").pipe(Effect.orDie));

        // Each problem is named by its client's position and field, with a fixed reason.
        const fields = yield* refused(
          JSON.stringify([
            client,
            {
              ...client,
              id: "second",
              label: 7,
              defaultScopes: ["mail read"],
              placement: { hosts: [], header: "X Bad" },
            },
            { ...client, id: "third", tokenEndpointAuthMethod: "none" },
          ]),
        );
        expect(fields).toContain("[1].label");
        expect(fields).toContain("[1].defaultScopes[0]");
        expect(fields).toContain("[1].placement.hosts");
        expect(fields).toContain("[1].placement.header");
        expect(fields).toContain("[2]");
        // The valid client is not mentioned.
        expect(fields).not.toMatch(/(?:^|\s)\[0\]/u);
        expect(fields).not.toContain("mail read");

        // Text that is not JSON is reported as such, without repeating it.
        const unparsed = yield* refused(`[{"id": "synthetic-mail", "clientSecret": "${secret}"`);
        expect(unparsed).toContain("not valid JSON");

        // Two clients with one ID name both positions.
        const duplicated = yield* refused(JSON.stringify([client, { ...client }]));
        expect(duplicated).toContain("[1].id");
      }),
    ),
  );

  it.effect(scenarios.credentialManagedCloud.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, deploy, call, callWith } = yield* harness;
        const target = yield* Target;
        const fs = yield* FileSystem.FileSystem;
        // This local Cloud started with an operator client whose server is a loopback issuer on
        // a port it reserved; start that issuer there.
        const operator = yield* fs
          .readFileString(`${target.directory}/${operatorOAuthFile}`)
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(OperatorOAuthFixture))),
          );
        const issuer = yield* oauthSetupIssuerOn(operator.port);
        yield* issuer.configure({
          registration: false,
          refreshTokens: true,
          scopes: ["mail.read"],
          resourceTokens: "issued",
        });
        const issuerHost = new URL(issuer.origin).host;
        const options = {
          name: "Synthetic Cloud Mail",
          discover: `${issuer.origin}/mcp`,
          hosts: [issuerHost],
          resource: `${issuer.origin}/resource`,
          store: issuer.origin,
          undeclared: `http://localhost:${operator.port}`,
          check: `${issuer.origin}/resource`,
        };
        const { path } = yield* deploy(
          `Synthetic Cloud Mail ${randomUUID().slice(0, 8)}`,
          mailApp(options),
        );
        const attempt = yield* startSignIn(path);
        expect(attempt.started.status, JSON.stringify(attempt.started.body)).toBe(200);
        const redirect = yield* body(Redirect, attempt.started);
        expect(new URL(redirect.authorizationUrl).searchParams.get("client_id")).toBe(
          operator.clientId,
        );
        yield* issuer.allowClient({
          clientId: operator.clientId,
          clientSecret: operator.clientSecret,
          redirect: redirect.redirectUri,
        });
        const { consent } = yield* harness;
        const completed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${attempt.connection}/oauth/complete`,
          { callbackUrl: yield* consent(redirect.authorizationUrl) },
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const account = (yield* body(Resource, completed)).id;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.ignore),
        );
        // The operator's secret authenticated the exchange.
        expect((yield* issuer.metrics).tokenChecks).toMatchObject({ authSecret: true });
        const authorized = Effect.map(issuer.metrics, (metrics) =>
          metrics.resourceAuthorizations.at(-1),
        );

        // App code reads a handle, and Cloud's outbound sends the real token in the operator's
        // placement: the service, which accepts only tokens it issued, answers.
        const fields = yield* call(
          path,
          Schema.Struct({ access_token: Schema.String }),
          "fields",
          attempt.profile,
        );
        expect(fields.access_token).toMatch(handle);
        // Sent as written, a refusal would say why.
        expect(
          yield* callWith(path, Sent, "send", attempt.profile, {
            url: options.resource,
            token: fields.access_token,
          }),
        ).toEqual({ status: 200, refusal: null });
        expect(yield* authorized).toBe(realBearer);
        const Read = Schema.Struct({ token: Schema.String, status: Schema.Number });
        const read = yield* call(path, Read, "resource", attempt.profile);
        expect(read.token).toMatch(handle);
        expect(read.status).toBe(200);
        expect(yield* authorized).toBe(realBearer);
        // A handle app code kept is sent as long as it lives.
        const replay = yield* callWith(path, Sent, "send", attempt.profile, {
          url: options.resource,
          token: read.token,
        });
        expect(replay.status).toBe(200);
        expect(yield* authorized).toBe(realBearer);
        // The operator's header and hosts bind it on Cloud too.
        const probe = yield* call(path, Probe, "probe", attempt.profile);
        expect(probe.resource.status).toBe(200);
        expect(probe.leak.refusal).toEqual({
          reason: "credential_placement",
          location: "x-leak header",
        });
        expect(probe.pageTitle.refusal).toEqual({
          reason: "credential_placement",
          location: "request body",
        });
        expect(probe.undeclared.refusal).toMatchObject({ reason: "credential_host" });
        expect(
          (yield* issuer.metrics).resourceAuthorizations.filter((value) => value !== realBearer),
        ).toEqual([]);
      }),
    ),
  );

  it.effect(scenarios.credentialManagedEndpoints.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, deploy } = yield* harness;
        const { issuer, issuerHost, storeHost } = yield* operatorWith({ revocation: true });
        yield* issuer.configure({ revocation: "recorded" });
        // A server the app controls, which would accept the operator's client if sent it.
        const attacker = yield* oauthSetupIssuer;
        yield* attacker.configure({ registration: false, revocation: "recorded" });
        yield* attacker.allowClient({
          clientId: "first-party-client",
          clientSecret: "first-party-secret",
          redirect: "http://127.0.0.1/unused",
        });
        const hosts = [issuerHost, storeHost];
        const declaring = (key: string, endpoints: object) =>
          deploy(
            `Mail ${key} ${randomUUID().slice(0, 8)}`,
            endpointsApp("Synthetic Mail", hosts, endpoints),
          ).pipe(Effect.flatMap(({ path }) => startSignIn(path)));
        // The operator's issuer, claimed by a provider whose endpoints are the app's own.
        const forged = yield* declaring("forged", {
          issuer: issuer.origin,
          authorizationUrl: `${attacker.origin}/authorize`,
          tokenUrl: `${attacker.origin}/token`,
        });
        // The operator's issuer and authorization endpoint with the app's token endpoint.
        const tokenElsewhere = yield* declaring("token", {
          issuer: issuer.origin,
          authorizationUrl: `${issuer.origin}/authorize`,
          tokenUrl: `${attacker.origin}/token`,
        });
        for (const [key, attempt] of [
          ["forged", forged],
          ["token", tokenElsewhere],
        ] as const)
          expect(attempt.started.body, key).toMatchObject({ _tag: "OAuthClientUnavailable" });

        // The operator's own endpoints with the app's revocation endpoint: the client is
        // offered, but revocation goes where the operator says.
        const revoking = yield* declaring("revocation", {
          issuer: issuer.origin,
          authorizationUrl: `${issuer.origin}/authorize`,
          tokenUrl: `${issuer.origin}/token`,
          revocationUrl: `${attacker.origin}/revoke`,
        });
        expect(revoking.started.status, JSON.stringify(revoking.started.body)).toBe(200);
        const account = yield* completeSignIn(
          issuer,
          revoking.connection,
          yield* body(Redirect, revoking.started),
        );
        const removed = yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
        const revoked = yield* issuer.metrics.pipe(
          Effect.flatMap((metrics) =>
            metrics.revocations.length > 0
              ? Effect.succeed(metrics.revocations)
              : Effect.fail(new Error("The operator's server has not been asked to revoke")),
          ),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
        );
        expect(revoked).toEqual([
          { token: "refresh", hint: "refresh_token", clientAuthenticated: true },
        ]);
        // The app's server never received the operator's secret or a user's token.
        const seen = yield* attacker.metrics;
        expect(seen.tokenExchanges).toBe(0);
        expect(seen.refreshes).toBe(0);
        expect(seen.revocations).toEqual([]);
      }),
    ),
  );

  it.effect(scenarios.credentialManagedHostPatterns.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, call, callWith } = yield* harness;
        // The operator allows every loopback name on the issuer's and the store's ports.
        const { issuer, store, issuerHost, storeHost } = yield* operatorWith({
          hosts: ({ issuerHost, storeHost }) => [
            `*.0.0.1:${new URL(`http://${issuerHost}`).port}`,
            `*.0.0.1:${new URL(`http://${storeHost}`).port}`,
          ],
        });
        const base = {
          name: "Synthetic Mail",
          discover: `${issuer.origin}/mcp`,
          resource: `${issuer.origin}/resource`,
          store: store.origin,
          undeclared: store.undeclaredOrigin,
        };
        const signedIn = (key: string, hosts: readonly string[]) =>
          Effect.gen(function* () {
            const { path } = yield* deploy(
              `Mail ${key} ${randomUUID().slice(0, 8)}`,
              mailApp({ ...base, hosts }),
            );
            const attempt = yield* startSignIn(path);
            yield* completeSignIn(
              issuer,
              attempt.connection,
              yield* body(Redirect, attempt.started),
            );
            return { path, profile: attempt.profile };
          });
        // Exact hosts within the operator's wildcards stay exact: the token reaches them and no
        // other name.
        const exact = yield* signedIn("exact", [issuerHost, storeHost]);
        const probe = yield* call(exact.path, Probe, "probe", exact.profile);
        expect(probe.resource.status).toBe(200);
        expect((yield* issuer.metrics).resourceAuthorizations.at(-1)).toBe(realBearer);
        expect(probe.undeclared.refusal).toMatchObject({
          reason: "credential_host",
          allowedHosts: [issuerHost, storeHost].toSorted(),
        });
        // A wildcard on a shorter suffix shares none: one label before `.1` is never three labels
        // before `.0.0.1`. The token then goes nowhere.
        const deeper = yield* signedIn("deeper", [`*.1:${new URL(issuer.origin).port}`]);
        const kept = yield* call(
          deeper.path,
          Schema.Struct({ access_token: Schema.String }),
          "fields",
          deeper.profile,
        );
        const refused = yield* callWith(deeper.path, Sent, "send", deeper.profile, {
          url: `${issuer.origin}/resource`,
          token: kept.access_token,
        });
        expect(refused.refusal).toMatchObject({ reason: "credential_host", allowedHosts: [] });
      }),
    ),
  );

  it.effect(scenarios.credentialManagedReconnect.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, deploy, call, consent } = yield* harness;
        const issuer = yield* oauthSetupIssuer;
        const store = yield* credentialUpstream;
        const hosts = [new URL(issuer.origin).host, `127.0.0.1:${store.port}`];
        const twoHours = 2 * 60 * 60 * 1000;
        // The operator has no client yet, so these accounts sign in with a client the product
        // registers for the owner. It expires in ten minutes.
        yield* issuer.configure({
          registration: true,
          refreshTokens: true,
          scopes: ["mail.read"],
          expiresAt: Math.floor(Date.now() / 1000) + 600,
          expiresIn: 3600,
          resourceTokens: "issued",
        });
        yield* restartWith("[]");
        // The provider marks the token raw(): app code reads the user's own token as it is.
        const source = mailApp({
          name: "Synthetic Mail",
          discover: `${issuer.origin}/mcp`,
          hosts,
          resource: `${issuer.origin}/resource`,
          store: store.origin,
          undeclared: store.undeclaredOrigin,
          rawToken: true,
        });
        /** Sign in through the connection and return the account. */
        const signIn = (connection: string, operatorClient: boolean) =>
          Effect.gen(function* () {
            const started = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection}/oauth/start`,
              { method: "oauth", label: "Mail" },
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const redirect = yield* body(Redirect, started);
            expect(
              new URL(redirect.authorizationUrl).searchParams.get("client_id") ===
                "first-party-client",
            ).toBe(operatorClient);
            if (operatorClient) return yield* completeSignIn(issuer, connection, redirect);
            const completed = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection}/oauth/complete`,
              { callbackUrl: yield* consent(redirect.authorizationUrl) },
            );
            expect(completed.status, JSON.stringify(completed.body)).toBe(200);
            return (yield* body(Resource, completed)).id;
          });
        interface Selected {
          readonly path: string;
          readonly profile: string;
          readonly account: string;
        }
        /**
         * A new account the user's own registered client signed in, selected by an app of its
         * own, so completing another account's sign-in never resolves it.
         */
        const ownAccount = Effect.gen(function* () {
          const { path } = yield* deploy(`Synthetic Mail ${randomUUID().slice(0, 8)}`, source);
          const { profile, connection } = yield* startSignIn(path);
          const account = yield* signIn(connection, false);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
          );
          return { path, profile, account } satisfies Selected;
        });
        /** Replace the account's credential with one the operator's client signs in. */
        const reconnect = ({ path, ...selected }: Selected) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${path}/connections`, {
                requirement: "mail",
                ...selected,
              }),
            );
            expect(yield* signIn(connection.id, true)).toBe(selected.account);
          });
        // Two accounts whose tokens will have expired, and one whose token stays valid.
        const renewing = yield* ownAccount;
        const checked = yield* ownAccount;
        yield* issuer.configure({ expiresIn: 36_000 });
        const refused = yield* ownAccount;
        const Fields = Schema.Struct({ access_token: Schema.String });
        expect((yield* call(renewing.path, Fields, "fields", renewing.profile)).access_token).toBe(
          "synthetic-access-token",
        );

        // Two hours later the operator adds its client. The registered client has expired, so
        // reconnecting now signs in with the operator's client.
        yield* restartWith(operatorClients(issuer.origin, hosts), twoHours);
        /**
         * Run `work` until it is renewing its account's grant, which the issuer holds; replace the
         * account's credential with the operator's meanwhile; then let the renewal answer.
         */
        const interleaved = <A, E, R>(selected: Selected, work: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            yield* issuer.configure({ hold: "refresh-issued" });
            const before = (yield* issuer.metrics).held;
            const running = yield* Effect.forkChild(work);
            yield* issuer.metrics.pipe(
              Effect.flatMap((metrics) =>
                metrics.held > before
                  ? Effect.void
                  : Effect.fail(new Error("The renewal has not reached the issuer")),
              ),
              Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
              // Work that ends before renewing never interleaves; report how it ended.
              Effect.raceFirst(
                Fiber.await(running).pipe(
                  Effect.flatMap((exit) =>
                    issuer.metrics.pipe(
                      Effect.flatMap((metrics) =>
                        Effect.die(
                          new Error(
                            `The work ended before renewing: ${String(exit)}; ${JSON.stringify({
                              before,
                              held: metrics.held,
                              refreshes: metrics.refreshes,
                              refreshesIssued: metrics.refreshesIssued,
                              refreshChecks: metrics.refreshChecks,
                            })}`,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            );
            yield* reconnect(selected);
            // This issuer gives every sign-in the same token, so a retry may find the operator's
            // credential equal to the refused one and renew it as well; let that answer at once.
            yield* issuer.configure({ hold: null });
            yield* issuer.release;
            return yield* Fiber.join(running);
          });

        // A tool call that selected the account before the reconnect reads the credential it
        // received, which is now managed: sealed, though the provider marks it raw().
        const read = yield* interleaved(
          renewing,
          call(renewing.path, Fields, "fields", renewing.profile),
        );
        expect(read.access_token).toMatch(handle);

        // So does an account check that read the account before the reconnect.
        const health = yield* interleaved(
          checked,
          api
            .request(actors.owner, "POST", `${prefix}/accounts/${checked.account}/health`)
            .pipe(Effect.flatMap((response) => body(Health, response))),
        );
        expect(health.apps.map((entry) => entry.check?.status)).toEqual(["healthy"]);

        // And a retry after the service refused the user's token: the renewal it waited for
        // returned the operator's credential, which the retry reads sealed and sends placed.
        yield* issuer.expireAccessTokens;
        const retried = yield* interleaved(
          refused,
          call(
            refused.path,
            Schema.Struct({ token: Schema.String, status: Schema.Number }),
            "resource",
            refused.profile,
          ),
        );
        expect(retried.token).toMatch(handle);
        expect(retried.status).toBe(200);
        // The service received a token it issued, never the handle.
        expect((yield* issuer.metrics).resourceAuthorizations.at(-1)).toMatch(
          /^Bearer synthetic-(?:access|refreshed)-token/,
        );
      }),
    ),
  );
});
