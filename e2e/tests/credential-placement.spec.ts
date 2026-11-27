import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { publishedRelease } from "../support/app-package.ts";
import { appsManifest, unscopedAccounts } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { credentialUpstream, type ReceivedRequest } from "../support/credential-upstream.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import type { OperatorSettings } from "../support/managed-server.ts";
import {
  OperatorOAuthFixture,
  operatorOAuthFile,
  syntheticCloudGoogle,
} from "../support/operator-oauth.ts";
import {
  oauthSetupIssuer,
  oauthSetupIssuerOn,
  type TokenShape,
} from "../support/oauth-setup-issuer.ts";
import { Target } from "../support/platform.ts";
import { connectionsPath, linkAccount } from "../support/app-accounts.ts";
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
  operatorScopeRefusal: Schema.optional(
    Schema.Struct({
      client: Schema.String,
      scopes: Schema.Array(Schema.String),
      instead: Schema.Array(
        Schema.Struct({ scope: Schema.String, scopes: Schema.Array(Schema.String) }),
      ),
    }),
  ),
});
const ScopeRefused = Schema.Struct({
  _tag: Schema.Literal("OAuthSetupFailed"),
  reason: Schema.Literal("operator_scope_refused"),
  message: Schema.String,
  recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
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
const handle = /^exsec2_[0-9a-f]+_$/;
const Failure = Schema.Struct({ _tag: Schema.String, message: Schema.String });
const claimsRevoked = /\b(was|were|been|is|are) revoked\b/u;
const messageOf = (response: { readonly body: unknown }) =>
  Schema.decodeUnknownEffect(Failure)(response.body).pipe(
    Effect.map((failure) => failure.message),
    Effect.orElseSucceed(() => JSON.stringify(response.body)),
  );

const SignInFailure = Schema.Struct({
  _tag: Schema.String,
  reason: Schema.String,
  message: Schema.String,
  cause: Schema.optional(
    Schema.Struct({
      stage: Schema.String,
      status: Schema.optional(Schema.Number),
      providerError: Schema.optional(Schema.String),
    }),
  ),
  serviceError: Schema.optional(Schema.Unknown),
  retryAfter: Schema.optional(Schema.String),
});
const FailedConnection = Schema.Struct({
  state: Schema.Struct({
    status: Schema.String,
    failure: Schema.optional(Schema.Struct({ at: Schema.String, error: SignInFailure })),
  }),
});

const sendSource = `const send = async (url, init) => {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, refusal: response.status === 421 ? JSON.parse(text).refusal : null };
};`;

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
export default defineApp({ user: { accounts: { bearerService, basicService, pairs: pairService.many(), keyService, encodedService, insecureService } } }, {
  tools: router({
    fields: query({ input: object({}) }, async ({ user: { accounts } }) => ({
      encoded: accounts.encodedService.fields,
      bearer: accounts.bearerService.fields,
      basic: accounts.basicService.fields,
      pairs: accounts.pairs.map((account) => account.fields),
      key: accounts.keyService.fields,
    })),
    probe: query({ input: object({ origin: string() }) }, async ({ user: { accounts } }, { origin }) => {
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
export default defineApp({ user: { accounts: { service } } }, { tools: router({}) });`;

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
export default defineApp({ user: { accounts: { placed, anywhere } } }, {
  tools: router({
    fail: query({ input: object({ origin: string() }) }, async ({ user: { accounts } }, { origin }) => ({
      placed: await ended(origin + "/placed", { headers: accounts.placed.headers() }),
      anywhere: await ended(origin + "/anywhere", { headers: { "x-key": accounts.anywhere.fields.token } }),
    })),
    trace: query({ input: object({ origin: string() }) }, async ({ user: { accounts } }, { origin }) => ({
      placed: await send(origin + "/trace", { method: "TRACE", headers: accounts.placed.headers() })
        .catch((error) => ({ status: 0, refusal: { reason: "fetch rejected: " + error.message } })),
      anywhere: await send(origin + "/trace", { method: "TRACE", headers: { "x-key": accounts.anywhere.fields.token } })
        .catch((error) => ({ status: 0, refusal: { reason: "fetch rejected: " + error.message } })),
    })),
  }),
});`;

const endpointsApp = (
  name: string,
  hosts: readonly string[],
  endpoints: object,
  scopes: readonly string[] = ["mail.read"],
) => `import { defineApp, defineProvider, oauth2, object, query, router } from "apps";
const mail = defineProvider({ name: ${JSON.stringify(name)}, hosts: ${JSON.stringify(hosts)}, auth: {
  oauth: oauth2({ ...${JSON.stringify(endpoints)}, scopes: ${JSON.stringify(scopes)} }),
} });
export default defineApp({ user: { accounts: { mail } } }, {
  tools: router({ fields: query({ input: object({}) }, async ({ user: { accounts } }) => accounts.mail.fields) }),
});`;

const token = "synthetic-access-token";
const realBearer = `Bearer ${token}`;

const operatorDefinition = (
  issuerOrigin: string,
  hosts: readonly string[],
  options: {
    readonly revocation?: boolean;
    readonly defaultScopes?: readonly string[];
    readonly allowedScopes?: readonly string[];
    readonly heldScopes?: ReadonlyArray<{
      readonly scope: string;
      readonly instead: readonly string[];
    }>;
    readonly grantedScopeSeparator?: string;
    readonly authorizationParams?: Readonly<Record<string, string>>;
    readonly header?: string;
    readonly scheme?: string | null;
    /** A path on the issuer the operator sends as its own RFC 8707 resource, as Slack's is. */
    readonly resourcePath?: string;
    readonly tokenResponse?: { readonly path: string };
    readonly unlisted?: boolean;
  } = {},
) => ({
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
    ...(options.resourcePath === undefined
      ? {}
      : { resource: `${issuerOrigin}${options.resourcePath}` }),
    ...(options.tokenResponse === undefined ? {} : { tokenResponse: options.tokenResponse }),
  },
  tokenEndpointAuthMethod: "client_secret_basic",
  defaultScopes: options.defaultScopes ?? ["mail.read"],
  allowedScopes: options.allowedScopes ?? ["mail.read", "mail.compose"],
  ...(options.heldScopes === undefined ? {} : { heldScopes: options.heldScopes }),
  placement: {
    hosts,
    ...(options.header === undefined ? {} : { header: options.header }),
    ...(options.scheme === undefined ? {} : { scheme: options.scheme }),
  },
  ...(options.unlisted === undefined ? {} : { unlisted: options.unlisted }),
});
const operatorClients = (...definition: Parameters<typeof operatorDefinition>) => ({
  EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify([operatorDefinition(...definition)]),
  EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_ID: "first-party-client",
  EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_SECRET: "first-party-secret",
});

const noOperatorClients = {
  EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_ID: "",
  EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_SECRET: "",
};

const mailApp = (options: Parameters<typeof mailSource>[0]) =>
  options.legacy === true ? unscopedAccounts(mailSource(options)) : mailSource(options);
const mailSource = (options: {
  readonly name: string;
  readonly discover: string;
  readonly hosts: readonly string[] | undefined;
  readonly scopes?: readonly string[] | null;
  readonly scopeSeparator?: string;
  readonly authorizationParams?: Readonly<Record<string, string>>;
  readonly request?: string;
  readonly resource: string;
  readonly store: string;
  readonly undeclared: string;
  readonly check?: string;
  readonly legacy?: boolean;
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
      ${options.scopes === null ? "" : `scopes: ${JSON.stringify(options.scopes ?? ["mail.read"])},`}
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
export default defineApp({ user: { accounts: { mail } } }, async ({ user: { accounts } }) => ({
  workflows: { fields: workflow({ input: object({}) }, async (ctx) =>
    ctx.step.do("fields", async (step) => step.user.accounts.mail.fields)) },
  tools: router({
    // Discovery evaluates the app with the account too; the tool's name says what it read.
    [/^exsec2_[0-9a-f]+_$/.test(accounts.mail.fields.access_token) ? "sealedDiscovery" : "realDiscovery"]:
      query({ input: object({}) }, async () => null),
    fields: query({ input: object({}) }, async ({ user: { accounts } }) => accounts.mail.fields),
    // Send the account's headers, with the app's own authorization beside them.
    headers: query({ input: object({ url: string() }) }, async ({ user: { accounts } }, { url }) =>
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
    resource: query({ input: object({}) }, async ({ user: { accounts } }) => {
      const account = accounts.mail;
      const token = account.fields.access_token;
      const response = await fetch(${JSON.stringify(options.resource)}, { headers: { authorization: "Bearer " + token } });
      if (response.status === 401) throw new ProviderError({ reason: "unauthorized", status: 401, accountId: account.id });
      return { token, status: response.status };
    }),
    probe: query({ input: object({}) }, async ({ user: { accounts } }) => {
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
  const connection = (path: string, requirement: string) =>
    api.request(actors.owner, "POST", connectionsPath(path, "user", requirement), {}).pipe(
      Effect.tap((response) =>
        Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
      ),
      Effect.flatMap((response) => body(Resource, response)),
      Effect.map((resource) => resource.id),
    );
  const submit = (path: string, requirement: string, fields: object) =>
    Effect.gen(function* () {
      const id = yield* connection(path, requirement);
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
  const call = <A>(path: string, output: Schema.Decoder<A>, tool: string) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
        tool,
        kind: "query",
        input: tool === "probe" ? { origin: "" } : {},
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return yield* body(output, response);
    });
  const callWith = <A>(path: string, output: Schema.Decoder<A>, tool: string, input: object) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
        tool,
        input,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return yield* body(output, response);
    });
  const list = (path: string) =>
    Effect.gen(function* () {
      const listed = yield* api.request(actors.owner, "GET", `${path}/tools`);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    });
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
  return { api, actors, prefix, deploy, connection, submit, call, callWith, list, consent };
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
        yield* submit(path, "bearerService", { token: values.token });
        yield* submit(path, "basicService", { email: values.email, token: values.basic });
        for (const pair of values.pairs) yield* submit(path, "pairs", pair);
        yield* submit(path, "keyService", { key: values.key });
        yield* submit(path, "encodedService", { key: values.encoded });
        yield* submit(path, "insecureService", { token: values.insecure });
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
          {},
        );
        expect(fields.bearer.token).toMatch(handle);
        expect(fields.basic.email).toBe(values.email);
        expect(fields.basic.token).toMatch(handle);
        const pairFields = fields.pairs.flatMap((pair) => [pair.user, pair.password]);
        expect(pairFields).toHaveLength(4);
        for (const value of pairFields) expect(value).toMatch(handle);
        expect(fields.key.key).toMatch(handle);
        expect(fields.encoded.key).toMatch(handle);

        const probe = yield* callWith(path, Schema.Record(Schema.String, Sent), "probe", {
          origin: upstream.origin,
        });
        const sent = (key: string) => probe[key]?.status;
        const refused = (key: string) => probe[key]?.refusal;
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
        const placement = (location: string) => ({ reason: "credential_placement", location });
        expect(refused("bearerPrefixed")).toEqual(placement("authorization header"));
        expect(refused("bearerTwice")).toEqual(placement("authorization header"));
        expect(refused("bearerExtra")).toEqual(placement("authorization header"));
        expect(refused("otherHeader")).toEqual(placement("x-note header"));
        expect(refused("jsonBody")).toEqual(placement("request body"));
        expect(refused("formBody")).toEqual(placement("request body"));
        expect(refused("urlPath")).toEqual(placement("URL"));
        expect(refused("queryParameter")).toEqual(placement("token query parameter"));
        expect(refused("basicSecretAsUser")).toEqual(placement("authorization header"));
        expect(refused("bearerAsBasic")).toEqual(placement("authorization header"));
        expect(refused("pairSwapped")).toEqual(placement("authorization header"));
        expect(refused("pairAcrossAccounts")).toEqual(placement("authorization header"));
        expect(refused("keyWrongName")).toEqual(placement("apikey query parameter"));
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
        expect(basicDecoded(at("/basic-other-user"))).toBe(`someone@example.test:${values.basic}`);
        expect(values.pairs.map((pair) => `${pair.user}:${pair.password}`)).toContain(
          basicDecoded(at("/pair-helper")),
        );
        const encodedQuery = new URL(at("/encoded-query").url, upstream.origin);
        expect(encodedQuery.searchParams.get("auth")).toBe(
          Buffer.from(`k:${values.encoded}`).toString("base64"),
        );
        expect(at("/encoded-header").headers["x-auth"]).toBe(
          `Token${Buffer.from(values.encoded).toString("base64")}`,
        );
        const keyRequests = received.filter((entry) => entry.url.startsWith("/key-"));
        expect(keyRequests).toHaveLength(2);
        expect(at("/key-header").headers["x-goog-api-key"]).toBe(values.key);
        const keyUrl = new URL(at("/key-url").url, upstream.origin);
        expect(keyUrl.searchParams.get("key")).toBe(values.key);
        expect(keyUrl.searchParams.get("q")).toBe("a b");
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
        const refusedDeploy = (request: string, options?: { readonly hosts?: boolean }) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `Declared placements ${randomUUID().slice(0, 8)}`,
              files: [{ path: "index.ts", content: declaredApp(request, options) }, appsManifest],
            });
            expect(response.status, JSON.stringify(response.body)).not.toBe(200);
            return JSON.stringify(response.body);
          });
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
        const secret = (label: string) => `synthetic-${label}-${randomUUID()}\r\nx-injected: 1`;
        const values = { placed: secret("placed"), anywhere: secret("anywhere") };
        yield* submit(path, "placed", { token: values.placed });
        yield* submit(path, "anywhere", { token: values.anywhere });
        const Ended = Schema.Struct({ status: Schema.Number, message: Schema.String });
        const failed = yield* callWith(
          path,
          Schema.Struct({ placed: Ended, anywhere: Ended }),
          "fail",
          { origin: upstream.origin },
        );
        expect(failed.placed.status).not.toBe(200);
        expect(failed.anywhere.status).not.toBe(200);
        const output = (yield* fs.readFileString(log)).slice(logged);
        for (const value of Object.values(values)) {
          const quoted = value.split("\r\n")[0]!;
          expect(JSON.stringify(failed)).not.toContain(quoted);
          expect(output).not.toContain(quoted);
        }
        const traced = yield* callWith(
          path,
          Schema.Struct({ placed: Sent, anywhere: Sent }),
          "trace",
          { origin: upstream.origin },
        );
        expect(traced.placed.refusal).toEqual({ reason: "credential_method" });
        expect(traced.anywhere.refusal).toEqual({ reason: "credential_method" });
        expect(yield* upstream.received).toEqual([]);
      }),
    ),
  );

  const restartWith = (settings: typeof OperatorSettings.Type, clockAdvance?: number) =>
    Effect.gen(function* () {
      yield* serverControl("stop");
      if (clockAdvance !== undefined)
        yield* serverControl("clock/advance", 200, { milliseconds: clockAdvance });
      yield* serverControl("environment", 200, settings);
      yield* serverControl("start");
    });

  const operatorWith = (
    options: Parameters<typeof operatorDefinition>[2] & {
      readonly hosts?: (origins: { issuerHost: string; storeHost: string }) => readonly string[];
      readonly registration?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      const issuer = yield* oauthSetupIssuer;
      const store = yield* credentialUpstream;
      const issuerHost = new URL(issuer.origin).host;
      const storeHost = `127.0.0.1:${store.port}`;
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
        const setup = (deployed: { readonly path: string; readonly app: typeof App.Type }) =>
          Effect.gen(function* () {
            const id = yield* connection(deployed.path, "mail");
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
        const userRead = { authorizationParams: { user_scope: "users:read" } };
        const variants = {
          matched: mailApp({ ...base, ...userRead }),
          unscoped: mailApp(base),
          defaults: mailApp({ ...base, scopes: [] }),
          elsewhere: mailApp({ ...base, ...userRead, discover: `${other.origin}/mcp` }),
          wider: mailApp({ ...base, scopes: ["mail.read", "mail.delete"] }),
          leaky: mailApp({
            ...base,
            request: '({ access_token }) => header("x-leak", access_token)',
          }),
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
        for (const key of ["matched", "unscoped"]) {
          const answer = answers[key]!;
          expect(answer.setup.firstParty, key).toBeDefined();
          expect(answer.setup.userScopes, key).toEqual(["admin.users:write"]);
          expect(answer.started.status, JSON.stringify(answer.started.body)).toBe(200);
          const sent = new URL((yield* body(Redirect, answer.started)).authorizationUrl);
          expect(sent.searchParams.get("user_scope"), key).toBe("admin.users:write");
        }
        expect(answers["elsewhere"]!.setup.userScopes).toEqual(["users:read"]);
        const separated = answers["separator"]!;
        expect(separated.started.status, JSON.stringify(separated.started.body)).toBe(200);
        const separatedUrl = new URL((yield* body(Redirect, separated.started)).authorizationUrl);
        expect(separatedUrl.searchParams.get("client_id")).toBe("first-party-client");
        expect(separatedUrl.searchParams.get("scope")).toBe("mail.read mail.compose");
        const defaults = answers["defaults"]!;
        expect(defaults.setup.scopes).toEqual(["mail.read"]);
        const defaultsUrl = new URL((yield* body(Redirect, defaults.started)).authorizationUrl);
        expect(defaultsUrl.searchParams.get("client_id")).toBe("first-party-client");
        expect(defaultsUrl.searchParams.get("scope")).toBe("mail.read");
        for (const key of ["leaky", "protocol11"]) {
          expect(answers[key]!.setup.firstParty, key).toBeDefined();
          const started = new URL((yield* body(Redirect, answers[key]!.started)).authorizationUrl);
          expect(started.searchParams.get("client_id"), key).toBe("first-party-client");
        }
        for (const key of ["elsewhere", "wider"]) {
          expect(answers[key]!.setup.firstParty, key).toBeUndefined();
          expect(answers[key]!.started.body, key).toMatchObject({ _tag: "OAuthClientUnavailable" });
        }
      }),
    ),
  );

  const google = {
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
  };
  const calendar = "https://www.googleapis.com/auth/calendar";
  const gmail = "https://mail.google.com/";
  const gmailModify = "https://www.googleapis.com/auth/gmail.modify";
  const drive = "https://www.googleapis.com/auth/drive";
  const cloudPlatform = "https://www.googleapis.com/auth/cloud-platform";
  const signInGoogle = (key: string, scopes: readonly string[]) =>
    Effect.gen(function* () {
      const { api, actors, prefix, deploy, connection } = yield* harness;
      const name = `Google ${key} ${randomUUID().slice(0, 8)}`;
      const { path, app } = yield* deploy(
        name,
        endpointsApp(name, ["www.googleapis.com"], google, scopes),
      );
      const id = yield* connection(path, "mail");
      const started = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${id}/oauth/start`,
        { method: "oauth", label: "Google" },
      );
      const provider = app.requirements.accounts.mail!.provider;
      const answered = yield* api.request(
        actors.owner,
        "GET",
        `${prefix}/providers/${provider}/oauth/oauth/setup`,
      );
      return { started, setup: yield* body(Setup, answered) };
    });

  it.effect(scenarios.credentialManagedGoogle.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const clientId = "synthetic-google-client.apps.googleusercontent.com";
        const signIn = signInGoogle;
        const cleared = {
          EXECUTOR_OAUTH_GOOGLE_CLIENT_ID: "",
          EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET: "",
        };
        yield* Effect.addFinalizer(() => restartWith(cleared).pipe(Effect.orDie));

        yield* restartWith(cleared);
        const unset = yield* signIn("unset", [calendar]);
        expect(unset.setup.firstParty).toBeUndefined();

        yield* restartWith({
          EXECUTOR_OAUTH_GOOGLE_CLIENT_ID: clientId,
          EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
        });
        const [allowed, defaults, wider, modify, fullGmail, mixed] = yield* Effect.all(
          [
            signIn("calendar", [calendar]),
            signIn("defaults", []),
            signIn("wider", [calendar, cloudPlatform]),
            signIn("modify", [gmailModify, drive, calendar]),
            signIn("gmail", [gmail, drive, calendar]),
            signIn("mixed", [gmailModify, cloudPlatform]),
          ],
          { concurrency: "unbounded" },
        );
        expect(allowed.setup).toMatchObject({
          firstParty: { label: "Executor for Google" },
          scopes: [calendar, "openid", "email"],
        });
        expect(allowed.started.status, JSON.stringify(allowed.started.body)).toBe(200);
        const sent = new URL((yield* body(Redirect, allowed.started)).authorizationUrl);
        expect(`${sent.origin}${sent.pathname}`).toBe(google.authorizationUrl);
        expect(sent.searchParams.get("client_id")).toBe(clientId);
        expect(sent.searchParams.get("scope")).toBe(`${calendar} openid email`);
        expect(sent.searchParams.get("access_type")).toBe("offline");
        expect(sent.searchParams.get("prompt")).toBe("consent");
        expect(sent.searchParams.get("include_granted_scopes")).toBe("true");
        expect(defaults.setup).toMatchObject({
          firstParty: { label: "Executor for Google" },
          scopes: ["openid", "email"],
        });
        expect(defaults.started.status, JSON.stringify(defaults.started.body)).toBe(200);
        const defaultsUrl = new URL((yield* body(Redirect, defaults.started)).authorizationUrl);
        expect(defaultsUrl.searchParams.get("scope")).toBe("openid email");
        for (const [key, scopes] of [
          ["youtube", ["youtube", "youtube.force-ssl"]],
          ["ads", ["adwords"]],
          ["bigquery", ["bigquery"]],
          [
            "apps-script",
            ["script.projects", "script.deployments", "script.processes", "script.metrics"],
          ],
        ] as const) {
          const requested = scopes.map((scope) => `https://www.googleapis.com/auth/${scope}`);
          const product = yield* signIn(key, requested);
          expect(product.setup.firstParty, key).toEqual({ label: "Executor for Google" });
          expect(product.started.status, key).toBe(200);
          const url = new URL((yield* body(Redirect, product.started)).authorizationUrl);
          expect(url.searchParams.get("client_id"), key).toBe(clientId);
          expect(url.searchParams.get("scope")?.split(" "), key).toEqual([
            ...requested,
            "openid",
            "email",
          ]);
        }
        expect(fullGmail.setup.firstParty).toEqual({ label: "Executor for Google" });
        expect(fullGmail.started.status, JSON.stringify(fullGmail.started.body)).toBe(200);
        const approved = new URL((yield* body(Redirect, fullGmail.started)).authorizationUrl);
        expect(approved.searchParams.get("client_id")).toBe(clientId);
        expect(approved.searchParams.get("scope")?.split(" ")).toEqual([
          gmail,
          drive,
          calendar,
          "openid",
          "email",
        ]);

        expect(modify.setup.operatorScopeRefusal).toBeUndefined();
        expect(modify.setup).toMatchObject({
          mode: "automatic",
          firstParty: { label: "Executor for Google" },
          scopes: [gmailModify, drive, calendar, "openid", "email"],
        });
        expect(modify.started.status, JSON.stringify(modify.started.body)).toBe(200);
        const modifySent = new URL((yield* body(Redirect, modify.started)).authorizationUrl);
        expect(`${modifySent.origin}${modifySent.pathname}`).toBe(google.authorizationUrl);
        expect(modifySent.searchParams.get("client_id")).toBe(clientId);
        expect(modifySent.searchParams.get("scope")?.split(" ")).toEqual([
          gmailModify,
          drive,
          calendar,
          "openid",
          "email",
        ]);
        expect(mixed.setup.firstParty).toBeUndefined();
        expect(mixed.setup.operatorScopeRefusal).toBeUndefined();
        expect(mixed.started.body).toMatchObject({ _tag: "OAuthClientUnavailable" });

        expect(wider.setup.firstParty).toBeUndefined();
        expect(wider.setup.operatorScopeRefusal).toBeUndefined();
        expect(wider.started.body).toMatchObject({ _tag: "OAuthClientUnavailable" });
      }),
    ),
  );

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
      const id = yield* connection(path, "mail");
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
      expect((yield* issuer.metrics).tokenChecks).toMatchObject({ authSecret: true });
      return { name, options, path, app, account, store, issuer, issuerHost, storeHost };
    });

  it.effect(scenarios.credentialManagedPlaced.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, call, callWith } = yield* harness;
        const { path, app, account, store, issuer, issuerHost, storeHost } =
          yield* managedAccount(true);

        const [fields, listed, stepped, health] = yield* Effect.all(
          [
            call(path, Schema.Struct({ access_token: Schema.String }), "fields"),
            api
              .request(actors.owner, "GET", `${path}/tools`)
              .pipe(Effect.flatMap((response) => body(Tools, response))),
            Effect.gen(function* () {
              const run = yield* body(
                Run,
                yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
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

        const probe = yield* call(path, Probe, "probe");
        expect(probe.resource.status).toBe(200);
        expect((yield* issuer.metrics).resourceAuthorizations.at(-1)).toBe(realBearer);
        expect(probe.resource.body.authorization).toMatch(/^Bearer exsec2_[0-9a-f]+_$/);
        expect(probe.leak.refusal).toEqual({
          reason: "credential_placement",
          location: "x-leak header",
        });
        expect(probe.leakTemplate.refusal).toEqual({
          reason: "credential_placement",
          location: "x-leak header",
        });
        expect(probe.tampered.refusal).toMatchObject({ reason: "credential_app" });
        expect(probe.pageTitle.refusal).toEqual({
          reason: "credential_placement",
          location: "request body",
        });
        expect(probe.query.refusal).toEqual({ reason: "credential_placement", location: "URL" });
        expect(probe.undeclared.refusal).toMatchObject({ reason: "credential_host" });
        expect(probe.trace.refusal).toEqual({ reason: "credential_method" });
        expect(probe.rewritten).toEqual({ status: 200, refusal: null });
        expect(probe.draft.status).toBe(204);
        expect(probe.stored).toMatch(/exsec2_[0-9a-f]+_$/);
        expect(probe.stored).not.toContain(token);
        expect(yield* store.stored).not.toContain(token);
        const received = yield* store.received;
        const at = (url: string) => received.find((entry) => entry.url === url);
        expect(at("/rewritten")?.authorization).toBe(realBearer);
        expect(at("/rewritten")?.headers["proxy-authorization"]).toBeUndefined();
        expect(at("/trace")).toBeUndefined();
        expect(at("/check")?.authorization).toBe(realBearer);
        const sent = ["/check", "/rewritten"];
        expect(JSON.stringify(received.filter((entry) => !sent.includes(entry.url)))).not.toContain(
          token,
        );

        yield* restartWith(
          operatorClients(issuer.origin, [issuerHost, storeHost], {
            header: "x-mail-token",
            scheme: null,
          }),
        );
        yield* store.issue([{ in: "header", name: "x-mail-token", value: token }]);
        const moved = yield* callWith(path, Sent, "headers", {
          url: `${store.origin}/moved`,
        });
        expect(moved).toEqual({ status: 200, refusal: null });
        const movedTo = (yield* store.received).find((entry) => entry.url === "/moved");
        expect(movedTo?.headers["x-mail-token"]).toBe(token);
        expect(movedTo?.authorization).toBeNull();
        const elsewhere = yield* callWith(path, Sent, "send", {
          url: `${store.origin}/refused`,
          token: (yield* call(path, Schema.Struct({ access_token: Schema.String }), "fields"))
            .access_token,
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
        const { name, options, path, app, account, store, issuer } = yield* managedAccount(false);
        const release = yield* publishedRelease("0.0.1-beta.59");
        const Read = Schema.Struct({ token: Schema.String, status: Schema.Number });
        const [widened, placed, pinned] = yield* Effect.all(
          [
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
            deploy(
              `${name} placed`,
              mailApp({
                ...options,
                request:
                  '({ access_token }) => [bearer(access_token), header("x-leak", access_token)]',
              }),
            ),
            deploy(`${name} protocol 11`, mailApp({ ...options, legacy: true }), {
              path: "package.json",
              content: JSON.stringify({ dependencies: { apps: release.url } }),
            }),
          ],
          { concurrency: "unbounded" },
        );

        expect(widened.status, JSON.stringify(widened.body)).toBe(200);
        const again = yield* call(path, Probe, "probe");
        expect(again.undeclared.refusal).toMatchObject({ reason: "credential_host" });
        expect(again.resource.status).toBe(200);
        expect((yield* issuer.metrics).resourceAuthorizations.at(-1)).toBe(realBearer);

        const unhosted = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          files: [
            { path: "index.ts", content: mailApp({ ...options, hosts: undefined }) },
            appsManifest,
          ],
        });
        expect(unhosted.status, JSON.stringify(unhosted.body)).toBe(200);
        const nowhere = yield* call(path, Read, "resource");
        expect(nowhere.token).toMatch(handle);
        expect(nowhere.status).toBe(421);

        const signedIn = yield* startSignIn(placed.path);
        yield* completeSignIn(issuer, signedIn.connection, yield* body(Redirect, signedIn.started));
        const placedProbe = yield* call(placed.path, Probe, "probe");
        expect(placedProbe.resource.status).toBe(200);
        expect(placedProbe.leak.refusal).toEqual({
          reason: "credential_placement",
          location: "x-leak header",
        });

        const provider = (deployed: { readonly app: typeof App.Type }) =>
          deployed.app.requirements.accounts.mail!.provider;
        expect(provider(pinned)).toBe(provider({ app }));
        yield* linkAccount(actors.owner, pinned.path, "mail", account);
        const old = yield* call(pinned.path, Read, "resource");
        expect(old.token).toMatch(handle);
        expect(old.status).toBe(200);
        expect((yield* issuer.metrics).resourceAuthorizations.at(-1)).toBe(realBearer);
        const oldProbe = yield* call(pinned.path, Probe, "probe");
        expect(oldProbe.leak.refusal).toEqual({
          reason: "credential_placement",
          location: "x-leak header",
        });
        expect(oldProbe.pageTitle.refusal).toEqual({
          reason: "credential_placement",
          location: "request body",
        });

        yield* restartWith(noOperatorClients);
        const reads = (yield* issuer.metrics).resourceRequests.GET;
        const removed = yield* call(pinned.path, Read, "resource");
        expect(removed.status).toBe(421);
        expect((yield* issuer.metrics).resourceRequests.GET).toBe(reads);
        expect(JSON.stringify(yield* store.received)).not.toContain(`/leak`);
      }),
    ),
  );

  const startSignIn = (path: string, requirement = "mail") =>
    Effect.gen(function* () {
      const { api, actors, prefix, connection } = yield* harness;
      const id = yield* connection(path, requirement);
      const started = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${id}/oauth/start`,
        { method: "oauth", label: "Mail" },
      );
      return { connection: id, started };
    });
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
        const { api, actors, prefix, deploy, list } = yield* harness;
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

        yield* issuer.configure({ scopeGrant: { defaults: [], exchange: ["mail.compose"] } });
        const allowed = yield* signIn(scoped);
        expect(allowed.completed.status, JSON.stringify(allowed.completed.body)).toBe(200);

        yield* issuer.configure({
          scopeGrant: { defaults: [], exchange: ["mail.compose"], separator: "," },
        });
        const commas = yield* signIn(scoped);
        expect(commas.completed.status, JSON.stringify(commas.completed.body)).toBe(400);
        expect(commas.completed.body).toMatchObject(exceeded);
        expect(yield* revoked(2)).toEqual([refreshRevoked, refreshRevoked]);
        yield* restartWith(
          operatorClients(issuer.origin, hosts, { revocation: true, grantedScopeSeparator: "," }),
        );
        const github = yield* signIn(scoped);
        expect(github.completed.status, JSON.stringify(github.completed.body)).toBe(200);
        expect((yield* issuer.metrics).authorizationScope).toBe("mail.read");
        yield* restartWith(operatorClients(issuer.origin, hosts, { revocation: true }));

        yield* issuer.configure({
          scopeGrant: { defaults: [], refresh: ["mail.delete"] },
          expiresIn: 3600,
        });
        const renewing = yield* signIn(scoped);
        expect(renewing.completed.status, JSON.stringify(renewing.completed.body)).toBe(200);
        yield* list(scoped);
        yield* issuer.expireAccessTokens;
        const read = yield* api.request(actors.owner, "POST", `${scoped}/tools/call`, {
          tool: "resource",
          kind: "query",
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
          yield* api.request(actors.owner, "POST", connectionsPath(scoped, "user", "mail"), {
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
        const lost = yield* Fiber.join(running);
        expect(lost.status, JSON.stringify(lost.body)).toBe(200);
        const telemetry = yield* Telemetry;
        const lostClaims = yield* telemetry.search("oauth.renewal", { account: raced }).pipe(
          Effect.map((found) =>
            found.data.filter(
              ({ span }) => span.tags["oauth.renewal.lost_claim_result"] !== undefined,
            ),
          ),
          Effect.filterOrFail(
            (found) => found.length > 0,
            () => new Error("The lost renewal's span has not arrived"),
          ),
          Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
        );
        expect(lostClaims.map(({ span }) => span.tags)).toEqual([
          expect.objectContaining({
            "executor.account.credential_generation": "0",
            "executor.account.credential_generation_source": "grant",
            "oauth.renewal.takeover": "false",
            "oauth.renewal.lost_claim_result": "tokens",
          }),
        ]);
        for (const { traceId, span } of lostClaims) {
          const resolve = yield* telemetry.query(traceId).pipe(
            Effect.map((result) =>
              result.data.find(
                ({ span: parent }) =>
                  parent.spanId === span.parentSpanId && parent.operationName === "oauth.resolve",
              ),
            ),
            Effect.filterOrFail(
              (found) => found !== undefined,
              () => new Error("The lost renewal's resolve span has not arrived"),
            ),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
          );
          const claimedAt = Number(span.tags["oauth.renewal.claimed_at_ms"]);
          const start = Date.parse(resolve.span.startTime);
          expect(claimedAt).toBeGreaterThanOrEqual(start);
          expect(claimedAt).toBeLessThanOrEqual(start + Math.ceil(resolve.span.durationMs) + 1);
        }
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

  it.effect(scenarios.credentialManagedHeld.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, deploy, list, connection, consent } = yield* harness;
        const { issuer, store, issuerHost, storeHost } = yield* operatorWith({
          allowedScopes: ["mail.read", "mail.compose", "mail.full"],
        });
        const hosts = [issuerHost, storeHost];
        yield* issuer.configure({ scopeGrant: { defaults: [] }, expiresIn: 3600 });
        const base = {
          name: "Synthetic Mail",
          discover: `${issuer.origin}/mcp`,
          hosts,
          resource: `${issuer.origin}/resource`,
          store: store.origin,
          undeclared: store.undeclaredOrigin,
        };
        const asking = mailApp({ ...base, scopes: ["mail.read", "mail.compose"] });
        const [operatorApp, ownApp, approvedApp] = yield* Effect.all(
          [
            deploy(`Mail operator ${randomUUID().slice(0, 8)}`, asking),
            deploy(`Mail own ${randomUUID().slice(0, 8)}`, asking),
            deploy(
              `Mail approved ${randomUUID().slice(0, 8)}`,
              mailApp({ ...base, scopes: ["mail.read", "mail.full"] }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        const removed = (account: string) =>
          Effect.addFinalizer(() =>
            api
              .request(actors.owner, "DELETE", `${prefix}/accounts/${account}`)
              .pipe(Effect.ignore),
          );
        const reconnect = (path: string, account: string) =>
          Effect.gen(function* () {
            const replacing = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "mail"), {
                account,
              }),
            );
            return yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${replacing.id}/oauth/start`,
              { method: "oauth", label: "Mail" },
            );
          });
        const Read = Schema.Struct({ token: Schema.String, status: Schema.Number });
        const renewedRead = (path: string) =>
          Effect.gen(function* () {
            const before = (yield* issuer.metrics).refreshes;
            yield* issuer.expireAccessTokens;
            const read = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
              tool: "resource",
              kind: "query",
              input: {},
            });
            expect(read.status, JSON.stringify(read.body)).toBe(200);
            expect((yield* body(Read, read)).status).toBe(200);
            expect((yield* issuer.metrics).refreshes).toBeGreaterThan(before);
          });

        const first = yield* startSignIn(operatorApp.path);
        expect(first.started.status, JSON.stringify(first.started.body)).toBe(200);
        const firstRedirect = yield* body(Redirect, first.started);
        expect(new URL(firstRedirect.authorizationUrl).searchParams.get("client_id")).toBe(
          "first-party-client",
        );
        const firstCompleted = yield* finishSignIn(issuer, first.connection, firstRedirect);
        expect(firstCompleted.status, JSON.stringify(firstCompleted.body)).toBe(200);
        const operatorAccount = (yield* body(Resource, firstCompleted)).id;
        yield* removed(operatorAccount);

        const own = { clientId: "own-mail-client", clientSecret: "own-mail-secret" };
        const ownConnection = yield* connection(ownApp.path, "mail");
        const ownStarted = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${ownConnection}/oauth/start`,
          { method: "oauth", label: "Mail", client: own },
        );
        expect(ownStarted.status, JSON.stringify(ownStarted.body)).toBe(200);
        const ownRedirect = yield* body(Redirect, ownStarted);
        expect(new URL(ownRedirect.authorizationUrl).searchParams.get("client_id")).toBe(
          own.clientId,
        );
        yield* issuer.allowClient({ ...own, redirect: ownRedirect.redirectUri });
        const ownCompleted = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${ownConnection}/oauth/complete`,
          { callbackUrl: yield* consent(ownRedirect.authorizationUrl) },
        );
        expect(ownCompleted.status, JSON.stringify(ownCompleted.body)).toBe(200);
        const ownAccount = (yield* body(Resource, ownCompleted)).id;
        yield* removed(ownAccount);

        yield* restartWith(
          operatorClients(issuer.origin, hosts, {
            allowedScopes: ["mail.read", "mail.full"],
            heldScopes: [{ scope: "mail.compose", instead: ["mail.full"] }],
          }),
        );

        yield* list(operatorApp.path);
        yield* renewedRead(operatorApp.path);

        const provider = operatorApp.app.requirements.accounts.mail!.provider;
        const setup = yield* body(
          Setup,
          yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/providers/${provider}/oauth/oauth/setup`,
          ),
        );
        expect(setup.firstParty).toBeUndefined();
        expect(setup).toMatchObject({
          mode: "client-required",
          operatorScopeRefusal: {
            client: "Executor for Synthetic Mail",
            scopes: ["mail.compose"],
            instead: [{ scope: "mail.compose", scopes: ["mail.full"] }],
          },
        });
        const fresh = yield* startSignIn(operatorApp.path);
        expect(fresh.started.status, JSON.stringify(fresh.started.body)).toBe(422);
        expect(fresh.started.body).not.toHaveProperty("authorizationUrl");
        const refused = yield* body(ScopeRefused, fresh.started);
        expect(refused.message).toContain("mail.compose");
        expect(refused.recovery.action).toBe(
          "Enter your own OAuth client for this service. Or, if broader access is acceptable, change the app to ask for mail.full instead, which grants more than mail.compose.",
        );
        const browser = yield* Browser;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the new connection", (page) =>
          page.goto(`/org/${actors.organization.slug}/connections/${fresh.connection}`),
        );
        yield* browser.use("The form explains why Executor's client is not offered", (page) =>
          page
            .getByRole("heading", {
              name: "Executor for Synthetic Mail can’t ask for this permission",
            })
            .waitFor({ state: "visible" })
            .then(() =>
              page
                .getByText("This app asks for mail.compose", { exact: false })
                .waitFor({ state: "visible" }),
            )
            .then(() =>
              page
                .getByText(
                  "Enter your own OAuth client for this service. Or, if broader access is acceptable, change the app to ask for mail.full instead, which grants more than mail.compose.",
                  { exact: false },
                )
                .waitFor({ state: "visible" }),
            ),
        );
        yield* browser.checkpoint("Operator client refused for a held scope");

        const operatorReconnect = yield* reconnect(operatorApp.path, operatorAccount);
        expect(operatorReconnect.status, JSON.stringify(operatorReconnect.body)).toBe(422);
        expect(operatorReconnect.body).not.toHaveProperty("authorizationUrl");
        expect((yield* body(ScopeRefused, operatorReconnect)).message).toContain("mail.compose");
        yield* renewedRead(operatorApp.path);

        const ownReconnect = yield* reconnect(ownApp.path, ownAccount);
        expect(ownReconnect.status, JSON.stringify(ownReconnect.body)).toBe(200);
        expect(
          new URL((yield* body(Redirect, ownReconnect)).authorizationUrl).searchParams.get(
            "client_id",
          ),
        ).toBe(own.clientId);

        const approved = yield* startSignIn(approvedApp.path);
        expect(approved.started.status, JSON.stringify(approved.started.body)).toBe(200);
        const approvedRedirect = yield* body(Redirect, approved.started);
        const approvedUrl = new URL(approvedRedirect.authorizationUrl);
        expect(approvedUrl.searchParams.get("client_id")).toBe("first-party-client");
        expect(approvedUrl.searchParams.get("scope")).toBe("mail.read mail.full");
        const approvedCompleted = yield* finishSignIn(
          issuer,
          approved.connection,
          approvedRedirect,
        );
        expect(approvedCompleted.status, JSON.stringify(approvedCompleted.body)).toBe(200);
        yield* removed((yield* body(Resource, approvedCompleted)).id);
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
        const clientId = `synthetic-operator-client-${randomUUID()}`;
        const secret = `synthetic-operator-secret-${randomUUID()}`;
        const refused = (settings: typeof OperatorSettings.Type) =>
          Effect.gen(function* () {
            const before = (yield* fs.readFileString(log)).length;
            yield* serverControl("stop");
            yield* serverControl("environment", 200, settings);
            yield* serverControl("start", 500);
            const output = (yield* fs.readFileString(log)).slice(before);
            expect(output).not.toContain(secret);
            expect(output).not.toContain(clientId);
            return output;
          });
        const cleared = {
          ...noOperatorClients,
          EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: "",
          EXECUTOR_OAUTH_GOOGLE_CLIENT_ID: "",
          EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET: "",
        };
        yield* Effect.addFinalizer(() => restartWith(cleared).pipe(Effect.orDie));

        const secretOnly = yield* refused({
          ...cleared,
          EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET: secret,
        });
        expect(secretOnly).toContain(
          "EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET is set without EXECUTOR_OAUTH_GOOGLE_CLIENT_ID",
        );
        const idOnly = yield* refused({ ...cleared, EXECUTOR_OAUTH_GOOGLE_CLIENT_ID: clientId });
        expect(idOnly).toContain(
          "EXECUTOR_OAUTH_GOOGLE_CLIENT_ID is set without EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET",
        );

        const synthetic = operatorClients("https://auth.example.test", ["mail.example.test"]);
        const several = yield* refused({
          ...synthetic,
          EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_ID: "",
          EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_SECRET: secret,
          EXECUTOR_OAUTH_GOOGLE_CLIENT_ID: clientId,
          EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET: "",
        });
        expect(several).toContain(
          "EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_SECRET is set without EXECUTOR_OAUTH_SYNTHETIC_MAIL_CLIENT_ID",
        );
        expect(several).toContain(
          "EXECUTOR_OAUTH_GOOGLE_CLIENT_ID is set without EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET",
        );
        const oneProblem = yield* refused({
          ...synthetic,
          EXECUTOR_OAUTH_GOOGLE_CLIENT_ID: clientId,
          EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET: "",
        });
        expect(oneProblem).not.toContain("SYNTHETIC_MAIL");

        const replaced = yield* refused({
          ...cleared,
          EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify([
            {
              ...operatorDefinition("https://auth.example.test", ["mail.example.test"]),
              id: "google",
            },
          ]),
        });
        expect(replaced).toContain("Two clients have the ID google");
      }),
    ),
  );

  it.effect(scenarios.credentialManagedGoogleCloud.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { clientId } = syntheticCloudGoogle;
        const [fullGmail, modify, mixed, wider] = yield* Effect.all(
          [
            signInGoogle("gmail", [gmail, drive, calendar]),
            signInGoogle("modify", [gmailModify, drive, calendar]),
            signInGoogle("mixed", [gmailModify, cloudPlatform]),
            signInGoogle("wider", [calendar, cloudPlatform]),
          ],
          { concurrency: "unbounded" },
        );

        expect(fullGmail.setup.firstParty).toEqual({ label: "Executor for Google" });
        expect(fullGmail.started.status, JSON.stringify(fullGmail.started.body)).toBe(200);
        const approved = new URL((yield* body(Redirect, fullGmail.started)).authorizationUrl);
        expect(`${approved.origin}${approved.pathname}`).toBe(google.authorizationUrl);
        expect(approved.searchParams.get("client_id")).toBe(clientId);
        expect(approved.searchParams.get("scope")?.split(" ")).toEqual([gmail, drive, calendar]);

        expect(modify.setup).toMatchObject({
          mode: "client-required",
          operatorScopeRefusal: {
            client: "Executor for Google",
            scopes: [gmailModify],
            instead: [{ scope: gmailModify, scopes: [gmail] }],
          },
        });
        expect(modify.setup.firstParty).toBeUndefined();
        expect(modify.started.status, JSON.stringify(modify.started.body)).toBe(422);
        expect(modify.started.body).not.toHaveProperty("authorizationUrl");
        const refused = yield* body(ScopeRefused, modify.started);
        expect(refused.message).toContain(gmailModify);
        expect(refused.message).toContain("Executor for Google");
        expect(refused.recovery.action).toMatch(/^Enter your own OAuth client for this service\./u);
        expect(refused.recovery.action).toContain(
          `if broader access is acceptable, change the app to ask for ${gmail} instead, which grants more than ${gmailModify}.`,
        );
        expect(refused.recovery.instructions).toMatch(/First choice: Create an OAuth client/u);
        expect(refused.recovery.instructions).toContain(
          `Second choice, only if the person accepts broader access: change the provider's declared scopes to ask for ${gmail} instead of ${gmailModify}.`,
        );
        expect(refused.recovery.instructions.indexOf("First choice")).toBeLessThan(
          refused.recovery.instructions.indexOf(gmail),
        );
        expect(JSON.stringify(modify.started.body)).not.toContain(clientId);

        expect(mixed.setup.operatorScopeRefusal).toEqual({
          client: "Executor for Google",
          scopes: [gmailModify, cloudPlatform],
          instead: [{ scope: gmailModify, scopes: [gmail] }],
        });
        expect(mixed.started.status, JSON.stringify(mixed.started.body)).toBe(422);
        const unreplaced = yield* body(ScopeRefused, mixed.started);
        expect(unreplaced.message).toContain(cloudPlatform);
        expect(unreplaced.recovery.action).toMatch(/^Enter your own OAuth client/u);
        expect(unreplaced.recovery.action).not.toContain(gmail);

        expect(wider.setup.firstParty).toBeUndefined();
        expect(wider.setup.operatorScopeRefusal).toBeUndefined();
        expect(wider.started.body).toMatchObject({ _tag: "OAuthClientUnavailable" });
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
        expect((yield* issuer.metrics).tokenChecks).toMatchObject({ authSecret: true });
        const authorized = Effect.map(issuer.metrics, (metrics) =>
          metrics.resourceAuthorizations.at(-1),
        );

        const fields = yield* call(path, Schema.Struct({ access_token: Schema.String }), "fields");
        expect(fields.access_token).toMatch(handle);
        expect(
          yield* callWith(path, Sent, "send", {
            url: options.resource,
            token: fields.access_token,
          }),
        ).toEqual({ status: 200, refusal: null });
        expect(yield* authorized).toBe(realBearer);
        const Read = Schema.Struct({ token: Schema.String, status: Schema.Number });
        const read = yield* call(path, Read, "resource");
        expect(read.token).toMatch(handle);
        expect(read.status).toBe(200);
        expect(yield* authorized).toBe(realBearer);
        const replay = yield* callWith(path, Sent, "send", {
          url: options.resource,
          token: read.token,
        });
        expect(replay.status).toBe(200);
        expect(yield* authorized).toBe(realBearer);
        const probe = yield* call(path, Probe, "probe");
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
        const forged = yield* declaring("forged", {
          issuer: issuer.origin,
          authorizationUrl: `${attacker.origin}/authorize`,
          tokenUrl: `${attacker.origin}/token`,
        });
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
        const seen = yield* attacker.metrics;
        expect(seen.tokenExchanges).toBe(0);
        expect(seen.refreshes).toBe(0);
        expect(seen.revocations).toEqual([]);
      }),
    ),
  );

  it.effect(scenarios.credentialManagedTelemetry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, deploy, connection, consent, call } = yield* harness;
        const evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const { issuer, issuerHost, storeHost } = yield* operatorWith({ revocation: true });
        yield* issuer.configure({ revocation: "recorded", expiresIn: 20 });
        const { path } = yield* deploy(
          `Mail telemetry ${randomUUID().slice(0, 8)}`,
          endpointsApp("Synthetic Mail", [issuerHost, storeHost], {
            issuer: issuer.origin,
            authorizationUrl: `${issuer.origin}/authorize`,
            tokenUrl: `${issuer.origin}/token`,
          }),
        );
        const id = yield* connection(path, "mail");
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
        const callback = new URL(yield* consent(started.authorizationUrl));
        const completed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${id}/oauth/complete`,
          { callbackUrl: callback.href },
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const account = (yield* body(Resource, completed)).id;
        yield* call(path, Schema.Struct({ access_token: Schema.String }), "fields");
        expect((yield* issuer.metrics).refreshes).toBeGreaterThan(0);
        const removed = yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);

        const requested = yield* telemetry.settled(
          evidence.requests.pipe(Effect.map((requests) => requests.map((sent) => sent.traceId))),
          (delivered) =>
            ["oauth.exchange", "oauth.revoke"].every((operation) =>
              delivered.some((span) => span.operationName === operation),
            ),
        );
        const renewals = yield* telemetry.search("oauth.renewal", { account }).pipe(
          Effect.filterOrFail(
            (found) => found.data.length > 0,
            () => new Error("The renewal's span has not arrived"),
          ),
          Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
        );
        const renewed = yield* telemetry.settled(
          [...new Set(renewals.data.map(({ traceId }) => traceId))],
          (delivered) => delivered.some((span) => span.operationName === "oauth.refresh"),
        );
        const spans = [...requested, ...renewed];
        const tagsOf = (operation: string) =>
          spans.filter((span) => span.operationName === operation).map((span) => span.tags);
        const client = {
          "oauth.client.kind": "first_party",
          "oauth.first_party.id": "synthetic-mail",
          "oauth.client.auth_method": "client_secret_basic",
        };
        const host = new URL(issuer.origin).hostname;
        for (const operation of [
          "oauth.exchange",
          "oauth.refresh",
          "oauth.renewal",
          "oauth.revoke",
        ])
          expect(tagsOf(operation).length, operation).toBeGreaterThan(0);
        for (const operation of ["oauth.exchange", "oauth.refresh", "oauth.renewal"])
          for (const tags of tagsOf(operation))
            expect(tags, operation).toMatchObject({
              ...client,
              "oauth.token_endpoint.host": host,
            });
        for (const tags of tagsOf("oauth.revoke"))
          expect(tags, "oauth.revoke").toMatchObject({
            ...client,
            "oauth.revocation_endpoint.host": host,
          });

        const sent = [
          callback.searchParams.get("code"),
          callback.searchParams.get("state"),
          new URL(started.authorizationUrl).searchParams.get("code_challenge"),
        ];
        expect(sent).not.toContain(null);
        const delivered = JSON.stringify(spans);
        for (const secret of [
          "first-party-secret",
          "first-party-client",
          Buffer.from("first-party-client:first-party-secret").toString("base64"),
          token,
          "synthetic-refreshed-token",
          "synthetic-refresh-",
          ...sent,
        ])
          expect(delivered, `telemetry contains ${secret}`).not.toContain(secret);
        for (const span of spans)
          for (const [key, value] of Object.entries(span.tags))
            if (key.startsWith("oauth."))
              expect(value, `${span.operationName} ${key}`).not.toMatch(/:\/\/|[?@]/u);
      }),
    ),
  );

  it.effect(scenarios.credentialManagedServiceWords.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, deploy } = yield* harness;
        const { issuer, issuerHost, storeHost } = yield* operatorWith();
        const secret = "first-party-secret";
        const encoded = Buffer.from(secret).toString("base64");
        const hex = Buffer.from(secret).toString("hex");
        const minted = "ya29.synthetic-minted-token-7c41e09b";
        const { path } = yield* deploy(
          `Mail service words ${randomUUID().slice(0, 8)}`,
          endpointsApp("Synthetic Mail", [issuerHost, storeHost], {
            issuer: issuer.origin,
            authorizationUrl: `${issuer.origin}/authorize`,
            tokenUrl: `${issuer.origin}/token`,
          }),
        );
        const cases: ReadonlyArray<{
          readonly name: string;
          readonly configure: Parameters<typeof issuer.configure>[0];
          readonly markers: readonly string[];
          readonly failure: object;
        }> = [
          {
            name: "callback description",
            configure: {
              authorizeError: {
                error: "access_denied",
                description: `Refused for the client whose secret is ${secret}`,
              },
            },
            markers: [secret],
            failure: { reason: "denied", cause: { stage: "authorize" } },
          },
          {
            // A prefix of the secret in an RFC 6749 error's description.
            name: "secret prefix",
            configure: {
              tokenError: {
                status: 401,
                body: {
                  error: "invalid_client",
                  error_description: `The secret beginning ${secret.slice(0, 16)} is not this client's`,
                },
              },
            },
            markers: [secret.slice(0, 16)],
            failure: {
              reason: "invalid_client",
              cause: { stage: "exchange", status: 401, providerError: "invalid_client" },
            },
          },
          {
            // The secret base64- and hex-encoded, in a code outside RFC 6749 and in a body that is
            // not an OAuth error.
            name: "alternate encodings",
            configure: {
              tokenError: {
                status: 400,
                body: { error: `bad_client_${hex}`, error_description: `Expected ${encoded}` },
              },
            },
            markers: [encoded, hex],
            failure: { reason: "exchange_failed", cause: { stage: "exchange", status: 400 } },
          },
          {
            name: "minted token",
            configure: {
              tokenError: { status: 502, body: { detail: `Upstream answered with ${minted}` } },
            },
            markers: [minted],
            failure: { reason: "service_unavailable", cause: { stage: "exchange", status: 502 } },
          },
          {
            name: "rate limit",
            configure: {
              tokenError: {
                status: 429,
                body: {
                  error: "temporarily_unavailable",
                  error_description: `Slow down ${encoded}`,
                },
                retryAfter: "120",
              },
            },
            markers: [encoded],
            failure: {
              reason: "rate_limited",
              cause: { stage: "exchange", status: 429, providerError: "temporarily_unavailable" },
            },
          },
        ];
        for (const check of cases) {
          yield* issuer.configure({ tokenError: null, authorizeError: null, ...check.configure });
          const attempt = yield* startSignIn(path);
          expect(attempt.started.status, JSON.stringify(attempt.started.body)).toBe(200);
          const completed = yield* finishSignIn(
            issuer,
            attempt.connection,
            yield* body(Redirect, attempt.started),
          );
          expect(completed.status, `${check.name}: ${JSON.stringify(completed.body)}`).toBe(400);
          const answered = yield* body(SignInFailure, completed);
          const read = yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/connections/${attempt.connection}`,
          );
          expect(read.status, JSON.stringify(read.body)).toBe(200);
          const kept = (yield* body(FailedConnection, read)).state.failure?.error;
          // The failure keeps only its reason, status, an RFC 6749 code and Retry-After.
          for (const [where, failure] of [
            ["answer", answered],
            ["connection", kept],
          ] as const) {
            expect(failure, `${check.name} ${where}`).toMatchObject({
              _tag: "OAuthCompletionFailed",
              ...check.failure,
            });
            expect(failure?.serviceError, `${check.name} ${where}`).toBeUndefined();
            if (check.name === "rate limit")
              expect(failure?.retryAfter, `${check.name} ${where}`).toBeDefined();
          }
          for (const marker of check.markers)
            for (const [where, response] of [
              ["answer", completed.body],
              ["connection", read.body],
            ] as const)
              expect(JSON.stringify(response), `${check.name} ${where}`).not.toContain(marker);
        }
      }),
    ),
  );

  it.effect(scenarios.credentialManagedHostPatterns.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, call, callWith } = yield* harness;
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
            return { path };
          });
        const exact = yield* signedIn("exact", [issuerHost, storeHost]);
        const probe = yield* call(exact.path, Probe, "probe");
        expect(probe.resource.status).toBe(200);
        expect((yield* issuer.metrics).resourceAuthorizations.at(-1)).toBe(realBearer);
        expect(probe.undeclared.refusal).toMatchObject({
          reason: "credential_host",
          allowedHosts: [issuerHost, storeHost].toSorted(),
        });
        const deeper = yield* signedIn("deeper", [`*.1:${new URL(issuer.origin).port}`]);
        const kept = yield* call(
          deeper.path,
          Schema.Struct({ access_token: Schema.String }),
          "fields",
        );
        const refused = yield* callWith(deeper.path, Sent, "send", {
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
        const { api, actors, prefix, deploy, call, list, consent } = yield* harness;
        const issuer = yield* oauthSetupIssuer;
        const store = yield* credentialUpstream;
        const hosts = [new URL(issuer.origin).host, `127.0.0.1:${store.port}`];
        const twoHours = 2 * 60 * 60 * 1000;
        yield* issuer.configure({
          registration: true,
          refreshTokens: true,
          scopes: ["mail.read"],
          expiresAt: Math.floor(Date.now() / 1000) + 600,
          expiresIn: 3600,
          resourceTokens: "issued",
        });
        yield* restartWith(noOperatorClients);
        const source = mailApp({
          name: "Synthetic Mail",
          discover: `${issuer.origin}/mcp`,
          hosts,
          resource: `${issuer.origin}/resource`,
          store: store.origin,
          undeclared: store.undeclaredOrigin,
          rawToken: true,
        });
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
          readonly account: string;
        }
        const ownAccount = Effect.gen(function* () {
          const { path } = yield* deploy(`Synthetic Mail ${randomUUID().slice(0, 8)}`, source);
          const { connection } = yield* startSignIn(path);
          const account = yield* signIn(connection, false);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
          );
          return { path, account } satisfies Selected;
        });
        const reconnect = ({ path, ...selected }: Selected) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "mail"), {
                ...selected,
              }),
            );
            expect(yield* signIn(connection.id, true)).toBe(selected.account);
          });
        const renewing = yield* ownAccount;
        const checked = yield* ownAccount;
        yield* issuer.configure({ expiresIn: 36_000 });
        const refused = yield* ownAccount;
        const Fields = Schema.Struct({ access_token: Schema.String });
        expect((yield* call(renewing.path, Fields, "fields")).access_token).toBe(
          "synthetic-access-token",
        );

        yield* restartWith(operatorClients(issuer.origin, hosts), twoHours);
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
            yield* issuer.configure({ hold: null });
            yield* issuer.release;
            return yield* Fiber.join(running);
          });

        const read = yield* interleaved(renewing, call(renewing.path, Fields, "fields"));
        expect(read.access_token).toMatch(handle);

        const health = yield* interleaved(
          checked,
          api
            .request(actors.owner, "POST", `${prefix}/accounts/${checked.account}/health`)
            .pipe(Effect.flatMap((response) => body(Health, response))),
        );
        expect(health.apps.map((entry) => entry.check?.status)).toEqual(["healthy"]);

        yield* list(refused.path);
        yield* issuer.expireAccessTokens;
        const retried = yield* interleaved(
          refused,
          call(
            refused.path,
            Schema.Struct({ token: Schema.String, status: Schema.Number }),
            "resource",
          ),
        );
        expect(retried.token).toMatch(handle);
        expect(retried.status).toBe(200);
        expect((yield* issuer.metrics).resourceAuthorizations.at(-1)).toMatch(
          /^Bearer synthetic-(?:access|refreshed)-token/,
        );
      }),
    ),
  );

  it.effect(scenarios.credentialManagedUnlisted.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, deploy, call } = yield* harness;
        const twoHours = 2 * 60 * 60 * 1000;
        const slack = {
          resourcePath: "/operator-resource",
          tokenResponse: { path: "authed_user" },
        };
        const { issuer, store, issuerHost, storeHost } = yield* operatorWith({
          ...slack,
          grantedScopeSeparator: ",",
        });
        const hosts = [issuerHost, storeHost];
        const resource = `${issuer.origin}/operator-resource`;
        const slackEnvelope: TokenShape = (tokens) => ({
          ok: true,
          app_id: "A0SYNTHETIC",
          authed_user: { id: "U0SYNTHETIC", ...tokens, token_type: "user" },
          team: { id: "T0SYNTHETIC" },
        });
        yield* issuer.configure({
          scopes: ["mail.read", "mail.compose", "mail.delete"],
          tokenShape: slackEnvelope,
          scopeGrant: { defaults: [], separator: "," },
          rotateRefreshTokens: true,
        });
        const source = mailApp({
          name: "Synthetic Mail",
          discover: `${issuer.origin}/mcp`,
          hosts,
          scopes: null,
          resource: `${issuer.origin}/resource`,
          store: store.origin,
          undeclared: store.undeclaredOrigin,
        });
        const Called = Schema.Struct({ token: Schema.String, status: Schema.Number });
        const deployed = Effect.gen(function* () {
          const app = yield* deploy(`Synthetic Mail ${randomUUID().slice(0, 8)}`, source);
          const provider = app.app.requirements.accounts.mail!.provider;
          const setup = yield* body(
            Setup,
            yield* api.request(
              actors.owner,
              "GET",
              `${prefix}/providers/${provider}/oauth/oauth/setup`,
            ),
          );
          return { ...app, setup };
        });
        const sent = (started: { readonly status: number; readonly body: unknown }) =>
          Effect.gen(function* () {
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const redirect = yield* body(Redirect, started);
            return { redirect, url: new URL(redirect.authorizationUrl) };
          });
        const expectOperatorRequest = (url: URL) => {
          expect(url.searchParams.get("client_id")).toBe("first-party-client");
          expect(url.searchParams.get("scope")).toBe("mail.read mail.compose");
          expect(url.searchParams.get("resource")).toBe(resource);
        };

        const first = yield* deployed;
        expect(first.setup).toMatchObject({
          mode: "automatic",
          firstParty: { label: "Executor for Synthetic Mail" },
          scopes: ["mail.read", "mail.compose"],
        });
        const signIn = yield* startSignIn(first.path);
        const firstSent = yield* sent(signIn.started);
        expectOperatorRequest(firstSent.url);
        const originalRedirectUri = firstSent.redirect.redirectUri;
        const account = yield* completeSignIn(issuer, signIn.connection, firstSent.redirect);
        yield* issuer.configure({ requireRefreshRedirectUri: originalRedirectUri });
        expect((yield* issuer.metrics).exchangeResource).toBe(resource);
        const used = yield* call(first.path, Called, "resource");
        expect(used.token).toMatch(handle);
        expect(used.status).toBe(200);
        expect((yield* issuer.metrics).resourceAuthorizations.at(-1)).toBe(realBearer);

        const refreshed = (yield* issuer.metrics).refreshesIssued;
        yield* restartWith(
          operatorClients(issuer.origin, hosts, { ...slack, unlisted: true }),
          twoHours,
        );
        const renewalResponse = yield* api.request(
          actors.owner,
          "POST",
          `${first.path}/tools/call`,
          { tool: "resource", kind: "query", input: {} },
        );
        const metrics = yield* issuer.metrics;
        expect(metrics.refreshRedirectUri, "refresh request redirect_uri").toBe(
          originalRedirectUri,
        );
        expect(renewalResponse.status, "managed account renewal failed").toBe(200);
        const renewed = yield* body(Called, renewalResponse);
        expect(renewed.status).toBe(200);
        expect(metrics.refreshesIssued).toBeGreaterThan(refreshed);
        expect(metrics.refreshChecks).toMatchObject({
          issued: true,
          authSecret: true,
          redirect: true,
        });
        expect(metrics.refreshResource).toBe(resource);
        expect(metrics.resourceAuthorizations.at(-1)).toMatch(/^Bearer synthetic-refreshed-token-/);

        const second = yield* deployed;
        expect(second.setup.firstParty).toBeUndefined();
        const refused = yield* startSignIn(second.path);
        expect(refused.started.body).toMatchObject({ _tag: "OAuthClientUnavailable" });

        const reconnecting = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", connectionsPath(first.path, "user", "mail"), {
            account,
          }),
        );
        const again = yield* sent(
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${reconnecting.id}/oauth/start`,
            { method: "oauth", label: "Mail" },
          ),
        );
        expectOperatorRequest(again.url);
        expect(yield* completeSignIn(issuer, reconnecting.id, again.redirect)).toBe(account);
        expect((yield* issuer.metrics).exchangeResource).toBe(resource);

        yield* Effect.addFinalizer(() =>
          restartWith({
            EXECUTOR_OAUTH_SLACK_CLIENT_ID: "",
            EXECUTOR_OAUTH_SLACK_CLIENT_SECRET: "",
          }).pipe(Effect.orDie),
        );
        yield* restartWith({
          ...noOperatorClients,
          EXECUTOR_OAUTH_SLACK_CLIENT_ID: "synthetic-slack-client",
          EXECUTOR_OAUTH_SLACK_CLIENT_SECRET: "synthetic-slack-secret",
        });
        const name = `Slack ${randomUUID().slice(0, 8)}`;
        const slackApp = yield* deploy(
          name,
          endpointsApp(
            name,
            ["mcp.slack.com"],
            {
              authorizationUrl: "https://slack.com/oauth/v2_user/authorize",
              tokenUrl: "https://slack.com/api/oauth.v2.user.access",
            },
            ["chat:write"],
          ),
        );
        const slackSetup = yield* body(
          Setup,
          yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/providers/${slackApp.app.requirements.accounts.mail!.provider}/oauth/oauth/setup`,
          ),
        );
        expect(slackSetup.firstParty).toBeUndefined();
        const slackStarted = yield* startSignIn(slackApp.path);
        expect(slackStarted.started.body).toMatchObject({ _tag: "OAuthClientUnavailable" });
      }),
    ),
  );
});
