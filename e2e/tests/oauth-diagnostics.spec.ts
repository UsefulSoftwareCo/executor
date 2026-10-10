/** Failed and recovered OAuth flows against a loopback issuer; assertions read delivered spans. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomBytes, randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { oauthMcpAppFiles } from "../support/authored-templates.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});

/**
 * Provider text that must never reach telemetry: an address, a URL, tokens, a realm, a
 * person's name, and secrets short or alphabetic enough to pass for prose or a code.
 */
const privateEmail = "ops.admin@example.com";
const privateUrl = "https://idp.example/help?ticket=PRIVATE_QUERY";
const privateToken = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const privateTenant = "acme_production_workspace";
const privateName = "Margaret Hamilton";
const shortSecret = "Hunter2!";
const embeddedSecret = "Tr0ub4dor&3";
const alphabeticToken = "QwertyUiopAsdfGhjklZxcvBnm";
const shortCode = "Hunter2";
const privateDescription = `Client ${privateEmail} is not allowed in ${privateTenant}; see ${privateUrl} (ref ${privateToken}; secret ${embeddedSecret})`;
const privateMarkers = [
  privateEmail,
  "example.com",
  "idp.example",
  "PRIVATE_QUERY",
  privateToken,
  privateTenant,
  privateName,
  "Hamilton",
  shortSecret,
  embeddedSecret,
  alphabeticToken,
  shortCode,
  "PRIVATE_REALM",
  "PRIVATE_ISSUER",
  "wrong-issuer.invalid",
  "synthetic-access-token",
  "synthetic-client-secret",
];

layer(HostedLive, { excludeTestServices: true })("OAuth failure diagnostics", (it) => {
  it.effect(scenarios.oauthFailureDiagnostics.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const standard = {
          scopes: ["read"],
          tokenError: null,
          authorizeError: null,
          callbackIssuer: null,
        } as const;

        /** The delivered trace of the latest request, once the named spans have arrived. */
        const trace = (...operations: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const id = (yield* evidence.requests).at(-1)?.traceId;
            if (id === undefined) return yield* Effect.die("Missing request trace");
            return yield* telemetry.query(id).pipe(
              Effect.flatMap((result) =>
                operations.every((operation) =>
                  result.data.some(({ span }) => span.operationName === operation),
                ) && result.data.some(({ span }) => span.operationName.startsWith("http.server"))
                  ? Effect.succeed(result)
                  : Effect.fail(new Error(`${operations.join(", ")} have not arrived`)),
              ),
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
            );
          });
        type Trace = Effect.Success<ReturnType<typeof trace>>;
        const tags = (result: Trace, operation: string) =>
          result.data.find(({ span }) => span.operationName === operation)?.span.tags;
        /**
         * No secret, code, token, name, address or URL anywhere in the delivered trace: span
         * attributes, and exception events with their messages and stacks. The failed span must
         * deliver an exception event, so the check reads the channel that carries error messages.
         */
        const assertPrivate = (
          result: Trace,
          secrets: ReadonlyArray<string>,
          failedSpan = "oauth.exchange",
        ) => {
          const delivered = JSON.stringify(result);
          for (const marker of [...privateMarkers, ...secrets])
            for (const form of new Set([marker, encodeURIComponent(marker)]))
              expect(delivered, `delivered telemetry contains ${form}`).not.toContain(form);
          expect(
            result.data
              .filter(({ span }) => span.operationName === failedSpan)
              .flatMap(({ span }) => span.events)
              .some(
                ({ name, attributes }) =>
                  name === "exception" && (attributes["exception.message"] ?? "") !== "",
              ),
            `${failedSpan} delivers an exception event`,
          ).toBe(true);
          for (const { span } of result.data)
            for (const [key, value] of Object.entries(span.tags))
              if (key.startsWith("oauth."))
                expect(value, `${span.operationName} ${key}`).not.toMatch(/:\/\/|@/);
        };

        /** Deploy an MCP app and start a sign-in; return the callback the issuer redirects to. */
        const begin = (label: string, configuration: Parameters<typeof issuer.configure>[0]) =>
          Effect.gen(function* () {
            yield* issuer.configure({ ...standard, ...configuration });
            const name = `${label} ${randomUUID().slice(0, 8)}`;
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files: oauthMcpAppFiles(name, `${issuer.origin}/mcp`),
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
              { method: "oauth", label: "Synthetic diagnostics account" },
            );
            expect(started.status, `${label}: ${JSON.stringify(started.body)}`).toBe(200);
            const { authorizationUrl } = yield* body(SignIn, started);
            const location = yield* Effect.scoped(
              Effect.gen(function* () {
                const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
                expect(consent.status).toBe(302);
                const header = consent.headers.location;
                if (header === undefined)
                  return yield* Effect.die("Issuer did not return a callback");
                return header;
              }),
            ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
            const callback = new URL(location);
            return {
              connection,
              callback,
              secrets: [callback.searchParams.get("code"), callback.searchParams.get("state")]
                .filter((value) => value !== null)
                .concat(new URL(authorizationUrl).searchParams.get("code_challenge") ?? []),
            };
          });
        const complete = (
          connection: typeof Resource.Type,
          callback: URL,
          span = "oauth.exchange",
        ) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/complete`,
              { callbackUrl: callback.href },
            );
            expect(response.status, JSON.stringify(response.body)).toBe(400);
            return yield* trace("oauth.completeOAuth", span);
          });

        /** Provider free text is never recorded; only its length is. */
        const withoutFreeText = (result: Trace, span: string) => {
          const recorded = Object.keys(tags(result, span) ?? {});
          expect(recorded).not.toContain("oauth.error.description");
          expect(recorded).not.toContain("oauth.error.raw_provider_code");
        };

        // The service rejects the request and explains why in private terms. Codes outside the
        // known vocabulary and every description are recorded only as fixed labels and sizes.
        const rejections: ReadonlyArray<{
          readonly name: string;
          readonly configuration: Parameters<typeof issuer.configure>[0];
          readonly span?: string;
          readonly expected: Readonly<Record<string, string>>;
          readonly absent?: ReadonlyArray<string>;
        }> = [
          {
            name: "Invalid client",
            configuration: {
              tokenError: {
                status: 400,
                body: { error: "invalid_client", error_description: privateDescription },
              },
            },
            expected: {
              "oauth.error.reason": "invalid_client",
              "oauth.error.code": "OAUTH_RESPONSE_BODY_ERROR",
              "oauth.error.detail": "response_body_error",
              "oauth.error.provider_code": "invalid_client",
              "oauth.error.known_provider_code": "invalid_client",
              "oauth.error.description_length": String(privateDescription.length),
              "oauth.response.content_type": "application/json",
              "http.response.status_code": "400",
            },
            absent: ["oauth.error.unrecognized_code.length"],
          },
          {
            name: "Short secret in description",
            configuration: {
              tokenError: {
                status: 400,
                body: {
                  error: "invalid_client",
                  error_description: `Invalid client_secret: ${shortSecret}`,
                },
              },
            },
            expected: {
              "oauth.error.known_provider_code": "invalid_client",
              "oauth.error.description_length": String(
                `Invalid client_secret: ${shortSecret}`.length,
              ),
            },
          },
          {
            name: "Name in description",
            configuration: {
              tokenError: {
                status: 400,
                body: {
                  error: "access_denied",
                  error_description: `${privateName} is not allowed to authorize this client`,
                },
              },
            },
            expected: {
              "oauth.error.provider_code": "access_denied",
              "oauth.error.known_provider_code": "access_denied",
            },
          },
          {
            name: "Nonstandard code",
            configuration: {
              tokenError: {
                status: 200,
                body: {
                  error: "incorrect_client_credentials",
                  error_description: privateDescription,
                },
              },
            },
            expected: {
              "oauth.error.detail": "response_body_error",
              "oauth.error.known_provider_code": "incorrect_client_credentials",
              "http.response.status_code": "200",
            },
          },
          {
            name: "Alphabetic token as code",
            configuration: {
              tokenError: { status: 400, body: { error: alphabeticToken } },
            },
            expected: {
              "oauth.error.detail": "response_body_error",
              "oauth.error.known_provider_code": "unrecognized",
              "oauth.error.unrecognized_code.length": String(alphabeticToken.length),
              "oauth.error.unrecognized_code.charset": "code",
            },
            absent: ["oauth.error.provider_code", "oauth.error.description_length"],
          },
          {
            name: "Short secret as code",
            configuration: {
              tokenError: {
                status: 400,
                body: { error: shortCode, error_description: `Retry as ${privateName}` },
              },
            },
            expected: {
              "oauth.error.known_provider_code": "unrecognized",
              "oauth.error.unrecognized_code.length": String(shortCode.length),
              "oauth.error.unrecognized_code.charset": "code",
            },
            absent: ["oauth.error.provider_code"],
          },
          {
            // A 401 challenge without an error body names its scheme and error parameter.
            name: "Challenge",
            configuration: {
              tokenError: {
                status: 401,
                body: {},
                challenge: `Bearer realm="PRIVATE_REALM", error="invalid_token", error_description="Token for ${privateName} <${privateEmail}> expired"`,
              },
            },
            expected: {
              "oauth.error.code": "OAUTH_WWW_AUTHENTICATE_CHALLENGE",
              "oauth.error.detail": "www_authenticate_challenge",
              "oauth.error.challenge.scheme": "bearer",
              "oauth.error.challenge.error": "invalid_token",
              "oauth.error.description_length": String(
                `Token for ${privateName} <${privateEmail}> expired`.length,
              ),
              "http.response.status_code": "401",
            },
          },
          {
            name: "Unrecognized challenge",
            configuration: {
              tokenError: {
                status: 401,
                body: {},
                challenge: `${shortCode} realm="PRIVATE_REALM", error="${alphabeticToken}"`,
              },
            },
            expected: {
              "oauth.error.detail": "www_authenticate_challenge",
              "oauth.error.challenge.scheme": "unrecognized",
              "oauth.error.challenge.error": "unrecognized",
            },
          },
          {
            name: "Authorization error",
            configuration: { authorizeError: shortCode },
            span: "oauth.authorize",
            expected: {
              "oauth.error.detail": "authorization_response_error",
              "oauth.error.callback_field": "error",
              "oauth.error.known_provider_code": "unrecognized",
              "oauth.error.unrecognized_code.length": String(shortCode.length),
            },
            absent: ["oauth.error.provider_code"],
          },
        ];
        for (const rejection of rejections) {
          const span = rejection.span ?? "oauth.exchange";
          const started = yield* begin(rejection.name, rejection.configuration);
          const failed = yield* complete(started.connection, started.callback, span);
          const recorded = tags(failed, span);
          expect(recorded, rejection.name).toMatchObject(rejection.expected);
          for (const name of rejection.absent ?? [])
            expect(Object.keys(recorded ?? {}), rejection.name).not.toContain(name);
          withoutFreeText(failed, span);
          assertPrivate(failed, started.secrets, span);
          yield* evidence.json(`${rejection.name.toLowerCase().replaceAll(" ", "-")}.json`, failed);
        }

        // Each rejected callback records the part of the response that failed.
        {
          const started = yield* begin("Callback checks", {});
          /** The returned callback with some parameters replaced or removed. */
          const edited = (changes: Readonly<Record<string, string | null>>) => {
            const url = new URL(started.callback);
            for (const [name, value] of Object.entries(changes))
              if (value === null) url.searchParams.delete(name);
              else url.searchParams.set(name, value);
            return url;
          };
          const callbacks: ReadonlyArray<{
            readonly name: string;
            readonly callback: URL;
            readonly reason: string;
            readonly field: string;
            readonly detail: string;
            readonly span: string;
          }> = [
            {
              name: "Short state",
              callback: edited({ state: "PRIVATE_STATE" }),
              reason: "callback_malformed",
              field: "state",
              detail: "callback_state_short",
              span: "oauth.completeOAuth",
            },
            {
              name: "Unknown state",
              callback: edited({ state: randomBytes(32).toString("base64url") }),
              reason: "sign_in_not_found",
              field: "state",
              detail: "callback_attempt_not_found",
              span: "oauth.completeOAuth",
            },
            {
              name: "Other callback path",
              callback: Object.assign(new URL(started.callback), {
                pathname: `${started.callback.pathname}/other`,
              }),
              reason: "redirect_mismatch",
              field: "redirect_uri",
              detail: "callback_redirect_mismatch",
              span: "oauth.completeOAuth",
            },
            {
              name: "Missing code",
              callback: edited({ code: null }),
              reason: "callback_malformed",
              field: "code",
              detail: "callback_code_missing",
              span: "oauth.authorize",
            },
          ];
          for (const check of callbacks) {
            const failed = yield* complete(started.connection, check.callback, check.span);
            expect(tags(failed, "oauth.completeOAuth"), check.name).toMatchObject({
              "oauth.completion.reason": check.reason,
            });
            expect(tags(failed, check.span), check.name).toMatchObject({
              "oauth.error.callback_field": check.field,
              "oauth.error.detail": check.detail,
            });
            assertPrivate(
              failed,
              [...started.secrets, ...check.callback.searchParams.values(), "PRIVATE_STATE"],
              check.span,
            );
            yield* evidence.json(`callback-${check.field}-${check.detail}.json`, failed);
          }
        }

        // Discovery that finds metadata only at the origin succeeds without an error span.
        {
          yield* issuer.configure({ ...standard, pathDiscovery: "atlassian" });
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Path discovery ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, oauth2 } from "apps";
const service=defineProvider({name:"Path service",auth:{oauth:oauth2({discover:${JSON.stringify(`${issuer.origin}/v1/mcp`)}})}});
export default defineApp({accounts:{service}},async()=>({}));`,
              },
              appsManifest,
            ],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const setup = yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/providers/${app.requirements.accounts.service.provider}/oauth/oauth/setup`,
          );
          expect(setup.status, JSON.stringify(setup.body)).toBe(200);
          const discovered = yield* trace("oauth.discover");
          expect(tags(discovered, "oauth.discover")).toMatchObject({
            "oauth.discovery.fallback": "origin",
          });
          const requests = discovered.data.filter(
            ({ span }) => span.operationName === "oauth.request",
          );
          expect(
            requests.some(({ span }) => span.tags["http.response.status_code"] === "401"),
            "The refused path metadata request is traced",
          ).toBe(true);
          expect(
            discovered.data
              .filter(({ span }) => span.operationName.startsWith("oauth."))
              .filter(({ span }) => span.status === "error")
              .map(({ span }) => span.operationName),
            "A fallback that succeeded records no OAuth error",
          ).toEqual([]);
          yield* evidence.json("discovery-fallback.json", discovered);
        }

        // A served metadata document that fails validation is remembered while discovery tries
        // the OpenID location, and its failure keeps the evidence of what was wrong.
        for (const [discovery, expected] of [
          [
            "invalid-metadata",
            { "oauth.error.detail": "body_property_mismatch", "oauth.error.attribute": "issuer" },
          ],
          ["invalid-json", { "oauth.error.detail": "body_not_json" }],
        ] as const) {
          yield* issuer.configure({ ...standard, discovery });
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Unusable discovery ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Unusable metadata service",auth:{oauth:oauth2({discover:${JSON.stringify(`${issuer.origin}/mcp`)}})}});
export default defineApp({accounts:{service}},async()=>({tools:router({})}));`,
              },
              appsManifest,
            ],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const setup = yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/providers/${app.requirements.accounts.service.provider}/oauth/oauth/setup`,
          );
          expect(setup.status, JSON.stringify(setup.body)).toBe(422);
          const failed = yield* trace("oauth.discover");
          expect(
            failed.data.some(
              ({ span }) =>
                span.operationName.startsWith("http.client") &&
                span.tags["http.response.status_code"] === "404",
            ),
            "Discovery tried the OpenID location after the unusable document",
          ).toBe(true);
          expect(tags(failed, "oauth.discover"), `${discovery} discovery`).toMatchObject({
            "oauth.error.reason": "invalid_response",
            "http.response.status_code": "200",
            ...expected,
          });
          assertPrivate(failed, [], "oauth.discover");
          yield* evidence.json(`discovery-${discovery}.json`, failed);
        }
      }),
    ),
  );
});
