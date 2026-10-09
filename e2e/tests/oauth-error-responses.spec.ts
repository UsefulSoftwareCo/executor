/** Drive real sign-ins against a loopback issuer that answers with standard and nonstandard errors. */
import { expect, layer } from "@effect/vitest";
import { Clock, DateTime, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { oauthMcpAppFiles } from "../support/authored-templates.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
/** The service's own words: an RFC 6749 error response, or the text of any other error body. */
const ServiceError = Schema.Union([
  Schema.Struct({ error: Schema.String, description: Schema.optional(Schema.String) }),
  Schema.Struct({ body: Schema.String }),
]);
const Failure = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  recovery: Schema.optional(Schema.Struct({ action: Schema.String, instructions: Schema.String })),
  serviceError: Schema.optional(ServiceError),
  retryAfter: Schema.optional(Schema.String),
});
/** The connection as an agent reads it through the hosted management API. */
const Connection = Schema.Struct({
  state: Schema.Struct({
    status: Schema.String,
    failure: Schema.optional(
      Schema.Struct({
        at: Schema.String,
        error: Schema.Struct({
          ...Failure.fields,
          cause: Schema.optional(
            Schema.Struct({
              stage: Schema.String,
              status: Schema.optional(Schema.Number),
              providerError: Schema.optional(Schema.String),
            }),
          ),
        }),
      }),
    ),
  }),
});
/** The secret every client the issuer registers authenticates with. */
const registeredSecret = "synthetic-client-secret";
const Echo = Schema.Struct({ authorization: Schema.NullOr(Schema.String) });

/** An authorization-code app whose only query presents the account's token to the issuer. */
const resourceAppFiles = (name: string, origin: string) => [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(origin)}, scopes: ["openid", "read"] }) } });
export default defineApp({ accounts: { service } }, async ({ accounts }) => ({ tools: router({
   read: query({ input: object({}) }, async ({ fetch }) => {
  const result = await fetch(${JSON.stringify(`${origin}/resource`)}, { headers: { authorization: "Bearer " + accounts.service.fields.access_token } });
  return result.json();
}),
 }) }));
`,
  },
  appsManifest,
];

layer(HostedLive, { excludeTestServices: true })("OAuth error responses", (it) => {
  it.effect(scenarios.oauthErrorResponses.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const readConnection = (connection: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "GET",
              `${prefix}/connections/${connection}`,
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return (yield* body(Connection, response)).state;
          });
        /** The service's words stay out of the curated explanation, and no sent secret returns. */
        const curated = (
          label: string,
          failure: typeof Failure.Type,
          serviceError: typeof ServiceError.Type | undefined,
        ) => {
          expect(failure.serviceError, label).toEqual(serviceError);
          expect(JSON.stringify(failure), label).not.toContain(registeredSecret);
          const words =
            serviceError === undefined
              ? undefined
              : "body" in serviceError
                ? serviceError.body
                : serviceError.description;
          if (words !== undefined)
            expect(JSON.stringify([failure.message, failure.recovery]), label).not.toContain(words);
        };
        const standard = {
          scopes: ["read"],
          includeIdToken: false,
          idTokenAlgorithms: ["ES256"],
          openidAlgorithms: null,
          openidMetadata: "served",
          idTokenAlgorithm: "ES256",
          tokenError: null,
          authorizeError: null,
          callbackIssuer: null,
          refreshTokens: false,
          expiresIn: 3600,
          refreshSubject: "synthetic-subject",
          refreshedExpiresIn: null,
        } as const;

        /** Deploy an app, sign in through the issuer and complete the callback. */
        const signIn = (
          files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
          name: string,
          configuration: Parameters<typeof issuer.configure>[0],
        ) =>
          Effect.gen(function* () {
            yield* issuer.configure({ ...standard, ...configuration });
            const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files,
            });
            expect(imported.status, JSON.stringify(imported.body)).toBe(200);
            const app = yield* body(Resource, imported);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
                requirement: "service",
                profile: profile.id,
              }),
            );
            const started = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/start`,
              { method: "oauth", label: "Synthetic error account" },
            );
            expect(started.status, `${name}: ${JSON.stringify(started.body)}`).toBe(200);
            const { authorizationUrl } = yield* body(SignIn, started);
            const callbackUrl = yield* Effect.scoped(
              Effect.gen(function* () {
                const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
                expect(consent.status).toBe(302);
                const location = consent.headers.location;
                if (location === undefined)
                  return yield* Effect.die("Issuer did not return a callback");
                return location;
              }),
            ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
            const exchanges = (yield* issuer.metrics).tokenExchanges;
            const completed = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/complete`,
              { callbackUrl },
            );
            if (completed.status === 200) {
              const account = yield* body(Resource, completed);
              yield* Effect.addFinalizer(() =>
                api
                  .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
                  .pipe(Effect.orDie),
              );
            }
            return {
              app,
              profile,
              connection,
              completed,
              failure: yield* body(Failure, completed),
              exchanged: (yield* issuer.metrics).tokenExchanges - exchanges,
            };
          });

        const mcp = (name: string) => {
          const unique = `${name} ${randomUUID().slice(0, 8)}`;
          return [oauthMcpAppFiles(unique, `${issuer.origin}/mcp`), unique] as const;
        };

        // Token endpoint errors are classified by their RFC 6749 §5.2 body, whatever the status.
        // Each app registers a fresh client, so invalid_client means the service refuses Executor's
        // registrations: the client is discarded and the failure is a configuration problem.
        const tokenErrors: ReadonlyArray<{
          readonly name: string;
          readonly tokenError: {
            readonly status: number;
            readonly body: object;
            readonly challenge?: string;
          };
          readonly reason: string;
          readonly evidence: string;
          /** What the person connecting and agents reading the connection see the service say. */
          readonly serviceError?: typeof ServiceError.Type;
        }> = [
          {
            name: "HTTP 200 invalid_grant",
            tokenError: { status: 200, body: { error: "invalid_grant" } },
            reason: "authorization_code_rejected",
            evidence: "HTTP 200, provider error invalid_grant",
            serviceError: { error: "invalid_grant" },
          },
          {
            // The service repeats the client secret Executor sent; it never comes back out.
            name: "HTTP 200 invalid_client",
            tokenError: {
              status: 200,
              body: {
                error: "invalid_client",
                error_description: `Client secret ${registeredSecret} is not accepted\nfor this client`,
              },
            },
            reason: "registered_client_incompatible",
            evidence: "HTTP 200, provider error invalid_client",
            serviceError: {
              error: "invalid_client",
              description: "Client secret [redacted] is not accepted for this client",
            },
          },
          // Services that reject the client with their own code are read as invalid_client, so a
          // client registered in this sign-in is reported as incompatible.
          {
            name: "GitHub incorrect_client_credentials",
            tokenError: { status: 200, body: { error: "incorrect_client_credentials" } },
            reason: "registered_client_incompatible",
            evidence: "HTTP 200.",
            serviceError: { error: "incorrect_client_credentials" },
          },
          {
            name: "Salesforce invalid_client_id",
            tokenError: { status: 400, body: { error: "invalid_client_id" } },
            reason: "registered_client_incompatible",
            evidence: "HTTP 400.",
            serviceError: { error: "invalid_client_id" },
          },
          {
            name: "Dropbox invalid_client description",
            tokenError: {
              status: 400,
              body: { error: "invalid_client: Invalid client_id or client_secret" },
            },
            reason: "registered_client_incompatible",
            evidence: "HTTP 400.",
            serviceError: { error: "invalid_client: Invalid client_id or client_secret" },
          },
          {
            // Codes outside RFC 6749 are not recorded as evidence, but the service's own words are shown.
            name: "HTTP 200 nonstandard error",
            tokenError: { status: 200, body: { ok: false, error: "private_nonstandard_code" } },
            reason: "exchange_failed",
            evidence: "HTTP 200.",
            serviceError: { error: "private_nonstandard_code" },
          },
          {
            // Ahrefs answers some token requests with a JSON array instead of an RFC 6749 error.
            // Its text is shown as the service's response.
            name: "HTTP 400 JSON array",
            tokenError: {
              status: 400,
              body: [
                "Error",
                [
                  "InvalidInput",
                  "invalid input: expected application/json or application/x-www-form-urlencoded body",
                ],
              ],
            },
            reason: "exchange_failed",
            evidence: "OAuth exchange stage, HTTP 400.",
            serviceError: {
              body: '["Error",["InvalidInput","invalid input: expected application/json or application/x-www-form-urlencoded body"]]',
            },
          },
          {
            // A service that cannot answer: the callback page says Executor could not reach it.
            name: "HTTP 503 without a body",
            tokenError: { status: 503, body: {} },
            reason: "service_unavailable",
            evidence: "OAuth exchange stage, HTTP 503.",
          },
          {
            name: "HTTP 401 Basic challenge",
            tokenError: {
              status: 401,
              body: { error: "invalid_client" },
              challenge: 'Basic realm="synthetic"',
            },
            reason: "registered_client_incompatible",
            evidence: "HTTP 401, provider error invalid_client",
            serviceError: { error: "invalid_client" },
          },
        ];
        for (const scenario of tokenErrors) {
          const [files, name] = mcp(scenario.name);
          const result = yield* signIn(files, name, { tokenError: scenario.tokenError });
          expect(result.completed.status, scenario.name).toBe(400);
          expect(result.failure, scenario.name).toMatchObject({
            _tag: "OAuthCompletionFailed",
            reason: scenario.reason,
          });
          expect(result.failure.recovery?.instructions, scenario.name).toContain(scenario.evidence);
          expect(result.exchanged, scenario.name).toBe(1);
          curated(scenario.name, result.failure, scenario.serviceError);
          // The connection keeps the failure, so an agent that issued the link learns what happened.
          const state = yield* readConnection(result.connection.id);
          expect(state, scenario.name).toMatchObject({
            status: "pending",
            failure: {
              error: {
                _tag: "OAuthCompletionFailed",
                reason: scenario.reason,
                cause: { stage: "exchange", status: scenario.tokenError.status },
              },
            },
          });
          expect(state.failure?.error.serviceError, scenario.name).toEqual(scenario.serviceError);
          expect(state.failure?.error.message, scenario.name).toBe(result.failure.message);
          if (scenario.tokenError.status === 503) {
            // A new sign-in has no outcome yet, so the earlier failure no longer describes it.
            const restarted = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${result.connection.id}/oauth/start`,
              { method: "oauth", label: "Synthetic error account" },
            );
            expect(restarted.status, JSON.stringify(restarted.body)).toBe(200);
            expect(yield* readConnection(result.connection.id)).toEqual({ status: "pending" });
          }
        }

        // An HTML error page that repeats the request, here a 429 of about 6 KB. Only its text is
        // kept, without the code, PKCE verifier or client credentials the request sent, and never
        // more than 500 characters, wherever it is returned or recorded. The service was reached
        // and is limiting requests, so the failure says so, with the time its Retry-After names.
        {
          const escape = (text: string) =>
            text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
          const [files, name] = mcp("HTML 429 page");
          const before = yield* Clock.currentTimeMillis;
          const result = yield* signIn(files, name, {
            tokenError: {
              status: 429,
              retryAfter: "120",
              page: (request) =>
                `<!DOCTYPE html><html><head><title>429 Too Many Requests</title>` +
                `<style>body { font-family: synthetic-style; }</style>` +
                `<script>var syntheticScript = "<p>";</script></head><body>` +
                `<!-- synthetic comment --><h1>Too many requests</h1>` +
                `<p>Request: ${escape(request.body)}</p>` +
                `<p>Authorization: ${escape(request.authorization ?? "")}</p>` +
                `<footer>${"<span>Synthetic footer text.</span> ".repeat(160)}</footer></body></html>`,
            },
          });
          const after = yield* Clock.currentTimeMillis;
          expect(result.completed.status).toBe(400);
          expect(result.failure).toMatchObject({
            _tag: "OAuthCompletionFailed",
            reason: "rate_limited",
            message: "The service asked Executor to wait before sending more sign-in requests.",
          });
          // Retry-After: 120 is two minutes from the answer, and the copy rounds it up to a minute.
          const retryAfter = result.failure.retryAfter;
          if (retryAfter === undefined)
            return yield* Effect.die("Expected the time the service's Retry-After names");
          const retryAt = Date.parse(retryAfter);
          expect(retryAt).toBeGreaterThanOrEqual(before + 120_000);
          expect(retryAt).toBeLessThanOrEqual(after + 120_000);
          // "Www, DD Mmm YYYY HH:MM:SS GMT"
          const utc = DateTime.toDateUtc(
            DateTime.makeUnsafe(Math.ceil(retryAt / 60_000) * 60_000),
          ).toUTCString();
          expect(result.failure.recovery?.action).toBe(
            `Start the connection again after ${utc.slice(17, 22)} UTC on ${Number(utc.slice(5, 7))} ${utc.slice(8, 11)} ${utc.slice(12, 16)}.`,
          );
          expect(result.failure.recovery?.instructions).toContain(
            `Its Retry-After header asked Executor to wait until ${retryAfter}`,
          );
          const serviceError = result.failure.serviceError;
          if (serviceError === undefined || !("body" in serviceError))
            return yield* Effect.die(
              `Expected the page's text, got ${JSON.stringify(serviceError)}`,
            );
          const text = serviceError.body;
          expect(text.startsWith("429 Too Many Requests Too many requests Request: ")).toBe(true);
          expect(text).toContain("code=[redacted]");
          expect(text).toContain("code_verifier=[redacted]");
          expect(text).toContain("Authorization: Basic [redacted]");
          expect(text).toContain("Synthetic footer text.");
          for (const markup of ["<", ">", "&amp;", "synthetic-style", "syntheticScript", "comment"])
            expect(text, markup).not.toContain(markup);
          expect(text).toHaveLength(500);
          expect(text.endsWith("…")).toBe(true);
          curated("HTML 429 page", result.failure, serviceError);
          const state = yield* readConnection(result.connection.id);
          expect(state).toMatchObject({
            status: "pending",
            failure: {
              error: {
                _tag: "OAuthCompletionFailed",
                reason: "rate_limited",
                cause: { stage: "exchange", status: 429 },
                retryAfter: result.failure.retryAfter,
              },
            },
          });
          expect(state.failure?.error.serviceError).toEqual(serviceError);
          expect(state.failure?.error.recovery).toEqual(result.failure.recovery);
        }

        // Registration refused for Executor's callback: the service's own error is returned and
        // recorded on the connection, beside the stage and status.
        {
          const serviceError = {
            error: "invalid_redirect_uri",
            description: "Redirect URIs must be on a host this service has approved",
          };
          yield* issuer.configure({
            registrationStatus: 400,
            registrationError: "invalid_redirect_uri",
            registrationErrorDescription: serviceError.description,
          });
          const [files, name] = mcp("Registration refused");
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name,
            files,
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(Resource, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
              requirement: "service",
              profile: profile.id,
            }),
          );
          const started = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/start`,
            { method: "oauth", label: "Synthetic error account" },
          );
          expect(started.status, JSON.stringify(started.body)).toBe(422);
          const failure = yield* body(Failure, started);
          expect(failure).toMatchObject({
            _tag: "OAuthSetupFailed",
            reason: "client_not_approved",
          });
          expect(failure.message).toContain("doesn’t accept Executor’s callback URL");
          curated("Registration refused", failure, serviceError);
          expect(yield* readConnection(connection.id)).toMatchObject({
            status: "pending",
            failure: {
              error: {
                _tag: "OAuthSetupFailed",
                reason: "client_not_approved",
                cause: { stage: "register", status: 400, providerError: "invalid_redirect_uri" },
                serviceError,
              },
            },
          });
          yield* issuer.configure({
            registrationStatus: 201,
            registrationErrorDescription: "PRIVATE_PROVIDER_ERROR",
          });
        }

        // Callback errors keep their RFC 6749 §4.1.2.1 meaning, after the RFC 9207 issuer check.
        // A callback from another issuer is an issuer mismatch, whatever error it carries. Only
        // access_denied is a cancellation; other and unknown codes are authorization errors.
        const callbackErrors: ReadonlyArray<{
          readonly error: string;
          readonly reason: string;
          readonly callbackIssuer?: string;
        }> = [
          { error: "access_denied", reason: "denied" },
          { error: "invalid_scope", reason: "invalid_scope" },
          { error: "server_error", reason: "service_unavailable" },
          { error: "temporarily_unavailable", reason: "service_unavailable" },
          { error: "invalid_request", reason: "authorization_rejected" },
          { error: "unsupported_response_type", reason: "authorization_rejected" },
          { error: "unauthorized_client", reason: "invalid_client" },
          { error: "private_nonstandard_code", reason: "authorization_rejected" },
          {
            error: "access_denied",
            reason: "issuer_mismatch",
            callbackIssuer: "https://issuer.invalid",
          },
        ];
        for (const scenario of callbackErrors) {
          const label = `Callback ${scenario.error}${scenario.callbackIssuer === undefined ? "" : " from another issuer"}`;
          const [files, name] = mcp(label);
          const result = yield* signIn(files, name, {
            authorizeError: scenario.error,
            ...(scenario.callbackIssuer === undefined
              ? {}
              : { callbackIssuer: scenario.callbackIssuer }),
          });
          expect(result.completed.status, label).toBe(400);
          expect(result.failure, label).toMatchObject({
            _tag: "OAuthCompletionFailed",
            reason: scenario.reason,
          });
          expect(result.exchanged, label).toBe(0);
          // The issuer check runs before the response's `error` is read.
          const serviceError =
            scenario.callbackIssuer === undefined ? { error: scenario.error } : undefined;
          curated(label, result.failure, serviceError);
          expect(yield* readConnection(result.connection.id), label).toMatchObject({
            status: "pending",
            failure: {
              error: {
                _tag: "OAuthCompletionFailed",
                reason: scenario.reason,
                cause: { stage: "authorize" },
                ...(serviceError === undefined ? {} : { serviceError }),
              },
            },
          });
        }

        // An unsigned ID token is rejected even when the service advertises `none`.
        {
          const [files, name] = mcp("Unsigned ID token");
          const result = yield* signIn(files, name, {
            scopes: ["openid", "read"],
            includeIdToken: true,
            idTokenAlgorithms: ["ES256", "none"],
            idTokenAlgorithm: "none",
          });
          expect(result.completed.status, JSON.stringify(result.failure)).toBe(400);
          expect(result.failure).toMatchObject({
            _tag: "OAuthCompletionFailed",
            reason: "incompatible_response",
          });
          expect(result.failure.recovery?.instructions).toContain("response field jwt_alg");
        }

        // OAuth metadata need not list ID token algorithms. Miro lists HS256 only in its OpenID
        // metadata, whose client authentication methods differ; only the algorithms are adopted.
        {
          const [files, name] = mcp("ID token algorithms from OpenID metadata");
          const requests = (yield* issuer.metrics).discoveryRequests.length;
          const result = yield* signIn(files, name, {
            scopes: ["openid", "read"],
            includeIdToken: true,
            idTokenAlgorithms: null,
            openidAlgorithms: ["HS256"],
            idTokenAlgorithm: "HS256",
          });
          expect(result.completed.status, JSON.stringify(result.failure)).toBe(200);
          const metrics = yield* issuer.metrics;
          expect(metrics.discoveryRequests.slice(requests)).toContain(
            "/.well-known/openid-configuration",
          );
          expect(metrics.lastExchangeAuth).toBe("client_secret_basic");
          expect(metrics.nonceRequested).toBe(true);
        }

        // OpenID metadata that is missing, redirected, unavailable or names another issuer adds
        // nothing and never fails the OAuth metadata already found. The RS256 default then still
        // rejects another algorithm at the exchange. The redirect's target lists HS256, so only a
        // client that followed it would accept the token. An issuer that differs only by a
        // trailing slash or letter case is another issuer: the strings must match exactly.
        // Adopted algorithms never widen what the service declares: `none` is still refused, an
        // algorithm the OpenID metadata does not list is refused, and a list in the OAuth metadata
        // wins without reading the OpenID metadata.
        for (const openid of [
          { label: "missing", openidAlgorithms: null, read: true },
          {
            label: "redirect",
            openidAlgorithms: ["HS256"],
            openidMetadata: "redirect",
            read: true,
          },
          {
            label: "unavailable",
            openidAlgorithms: ["HS256"],
            openidMetadata: "unavailable",
            read: true,
          },
          {
            label: "another-issuer",
            openidAlgorithms: ["HS256"],
            openidMetadata: "another-issuer",
            read: true,
          },
          {
            label: "issuer with a trailing slash",
            openidAlgorithms: ["HS256"],
            openidMetadata: "issuer-trailing-slash",
            read: true,
          },
          {
            label: "issuer with an uppercase scheme",
            openidAlgorithms: ["HS256"],
            openidMetadata: "issuer-uppercase-scheme",
            read: true,
          },
          {
            label: "unsigned",
            openidAlgorithms: ["HS256", "none"],
            idTokenAlgorithm: "none",
            read: true,
          },
          { label: "undeclared", openidAlgorithms: ["RS256"], read: true },
          {
            label: "OAuth metadata lists its own",
            idTokenAlgorithms: ["ES256"],
            openidAlgorithms: ["HS256"],
            read: false,
          },
        ] as const) {
          const [files, name] = mcp(`ID token algorithm, OpenID metadata ${openid.label}`);
          const requests = (yield* issuer.metrics).discoveryRequests.length;
          const result = yield* signIn(files, name, {
            scopes: ["openid", "read"],
            includeIdToken: true,
            idTokenAlgorithms: "idTokenAlgorithms" in openid ? openid.idTokenAlgorithms : null,
            openidAlgorithms: openid.openidAlgorithms,
            openidMetadata: "openidMetadata" in openid ? openid.openidMetadata : "served",
            idTokenAlgorithm: "idTokenAlgorithm" in openid ? openid.idTokenAlgorithm : "HS256",
          });
          expect(result.completed.status, openid.label).toBe(400);
          expect(result.failure.recovery?.instructions, openid.label).toContain(
            "response field jwt_alg",
          );
          const requested = (yield* issuer.metrics).discoveryRequests.slice(requests);
          expect(requested.includes("/.well-known/openid-configuration"), openid.label).toBe(
            openid.read,
          );
          expect(requested, openid.label).not.toContain("/redirected/openid-configuration");
        }

        // Without `openid`, no ID token is expected, so the OpenID metadata is never read.
        {
          const [files, name] = mcp("ID token algorithms without openid");
          const requests = (yield* issuer.metrics).discoveryRequests.length;
          const result = yield* signIn(files, name, {
            scopes: ["read"],
            idTokenAlgorithms: null,
            openidAlgorithms: ["HS256"],
          });
          expect(result.completed.status, JSON.stringify(result.failure)).toBe(200);
          expect((yield* issuer.metrics).discoveryRequests.slice(requests)).not.toContain(
            "/.well-known/openid-configuration",
          );
        }

        // A refreshed ID token must keep the subject the first one identified.
        for (const scenario of [
          { name: "Same subject", subject: "synthetic-subject", renewed: true },
          { name: "Different subject", subject: "synthetic-other-subject", renewed: false },
        ]) {
          const unique = `${scenario.name} ${randomUUID().slice(0, 8)}`;
          const result = yield* signIn(resourceAppFiles(unique, issuer.origin), unique, {
            scopes: ["openid", "read"],
            includeIdToken: true,
            refreshTokens: true,
            // Inside the host's refresh window, so the first tool call renews the grant.
            expiresIn: 10,
            // Renewed tokens stay valid, so one tool call renews once.
            refreshedExpiresIn: 3600,
            refreshSubject: scenario.subject,
          });
          expect(result.completed.status, JSON.stringify(result.failure)).toBe(200);
          const refreshes = (yield* issuer.metrics).refreshes;
          const read = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${result.app.id}/tools/call`,
            { profile: result.profile.id, tool: "read", kind: "query", input: {} },
          );
          expect((yield* issuer.metrics).refreshes, scenario.name).toBe(refreshes + 1);
          if (scenario.renewed) {
            expect(read.status, JSON.stringify(read.body)).toBe(200);
            expect((yield* body(Echo, read)).authorization).toMatch(
              /^Bearer synthetic-refreshed-token-\d+$/,
            );
          } else {
            expect(read.status, JSON.stringify(read.body)).not.toBe(200);
            expect(JSON.stringify(read.body)).toContain("OAuthReconnectRequired");
          }
        }
      }),
    ),
  );
});
