import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Ref, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import {
  OAuthDiscoveryError,
  beginDynamicAuthorization,
  canonicalResourceUrl,
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
  registerDynamicClient,
} from "./oauth-discovery";
import { serveTestHttpApp } from "./testing";

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

type Handler = (request: CapturedRequest, baseUrl: string) => HttpServerResponse.HttpServerResponse;

const DcrRequestBody = Schema.Struct({
  redirect_uris: Schema.Array(Schema.String),
  token_endpoint_auth_method: Schema.String,
  scope: Schema.optional(Schema.String),
  client_uri: Schema.optional(Schema.String),
});
const decodeDcrRequestBody = Schema.decodeUnknownSync(Schema.fromJsonString(DcrRequestBody));

const sendJson = (body: unknown, status = 200): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, { status });

const notFound = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({ status: 404 });

const serveOAuthFixture = (handler: Handler) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<readonly CapturedRequest[]>([]);
    const baseUrlRef = { value: "" };
    const server = yield* serveTestHttpApp((request) =>
      Effect.gen(function* () {
        const body = yield* request.text;
        const captured = {
          method: request.method,
          url: request.url ?? "/",
          headers: request.headers,
          body,
        };
        yield* Ref.update(requests, (all) => [...all, captured]);
        return handler(captured, baseUrlRef.value);
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("oauth fixture failed", { status: 500 })),
        ),
      ),
    );
    baseUrlRef.value = server.baseUrl;

    return {
      baseUrl: baseUrlRef.value,
      requests: Ref.get(requests),
    } as const;
  });

const withOAuthFixture = <A, E>(
  handler: Handler,
  use: (fixture: {
    readonly baseUrl: string;
    readonly requests: Effect.Effect<readonly CapturedRequest[]>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* serveOAuthFixture(handler);
      return yield* use(fixture);
    }),
  );

describe("canonicalResourceUrl", () => {
  it("lowercases scheme + host, drops trailing slash, fragment, and query", () => {
    expect(canonicalResourceUrl("https://API.Example.com/v1/mcp/")).toBe(
      "https://api.example.com/v1/mcp",
    );
    expect(canonicalResourceUrl("HTTPS://api.example.com/v1/mcp?x=1#frag")).toBe(
      "https://api.example.com/v1/mcp",
    );
    expect(canonicalResourceUrl("https://api.example.com/")).toBe("https://api.example.com");
  });
});

describe("discoverProtectedResourceMetadata", () => {
  it.effect("fetches RFC 9728 well-known metadata on the resource's origin", () =>
    withOAuthFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/oauth-protected-resource/graphql") {
          return notFound();
        }
        if (request.url === "/.well-known/oauth-protected-resource") {
          return sendJson({
            resource: baseUrl,
            authorization_servers: [baseUrl],
            scopes_supported: ["read"],
          });
        }
        return notFound();
      },
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const result = yield* discoverProtectedResourceMetadata(`${baseUrl}/graphql`);
          expect(result).not.toBeNull();
          expect(result!.metadata.authorization_servers?.[0]).toBe(baseUrl);
          expect(result!.metadataUrl).toBe(`${baseUrl}/.well-known/oauth-protected-resource`);
        }),
    ),
  );

  it.effect("returns null when every well-known candidate 404s", () =>
    withOAuthFixture(
      () => notFound(),
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const result = yield* discoverProtectedResourceMetadata(`${baseUrl}/graphql`);
          expect(result).toBeNull();
        }),
    ),
  );

  it.effect("surfaces malformed metadata bodies as OAuthDiscoveryError", () =>
    withOAuthFixture(
      () => HttpServerResponse.text("not json", { status: 200, contentType: "application/json" }),
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(discoverProtectedResourceMetadata(baseUrl));
          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          const reason = exit.cause.reasons.find(Cause.isFailReason);
          expect(reason?.error).toBeInstanceOf(OAuthDiscoveryError);
        }),
    ),
  );
});

describe("discoverAuthorizationServerMetadata", () => {
  it.effect("falls back to openid-configuration when oauth-authorization-server is absent", () =>
    withOAuthFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/oauth-authorization-server") {
          return notFound();
        }
        if (request.url === "/.well-known/openid-configuration") {
          return sendJson({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            code_challenge_methods_supported: ["S256"],
            response_types_supported: ["code"],
          });
        }
        return notFound();
      },
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const result = yield* discoverAuthorizationServerMetadata(baseUrl);
          expect(result).not.toBeNull();
          expect(result!.metadata.token_endpoint).toBe(`${baseUrl}/token`);
          expect(result!.metadataUrl.endsWith("openid-configuration")).toBe(true);
        }),
    ),
  );

  it.effect("requires issuer + authorize + token endpoints", () =>
    withOAuthFixture(
      () => sendJson({ issuer: "http://127.0.0.1" }),
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(discoverAuthorizationServerMetadata(baseUrl));
          expect(Exit.isFailure(exit)).toBe(true);
        }),
    ),
  );

  it.effect("rejects unsupported authorization server endpoint URLs", () =>
    withOAuthFixture(
      () =>
        sendJson({
          issuer: "http://example.com",
          authorization_endpoint: "javascript:alert(1)",
          token_endpoint: "http://example.com/token",
          response_types_supported: ["code"],
        }),
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(discoverAuthorizationServerMetadata(baseUrl));
          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          const reason = exit.cause.reasons.find(Cause.isFailReason);
          expect(reason?.error).toEqual(
            expect.objectContaining({
              _tag: "OAuthDiscoveryError",
              message: expect.stringMatching(/must use https: or loopback http:/),
            }),
          );
        }),
    ),
  );

  it.effect("allows HTTP authorization server endpoints when the caller opts into local HTTP", () =>
    withOAuthFixture(
      () =>
        sendJson({
          issuer: "http://example.com",
          authorization_endpoint: "http://example.com/authorize",
          token_endpoint: "http://example.com/token",
          response_types_supported: ["code"],
        }),
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const result = yield* discoverAuthorizationServerMetadata(baseUrl, {
            endpointUrlPolicy: { allowHttp: true },
          });
          expect(result).not.toBeNull();
          expect(result!.metadata.authorization_endpoint).toBe("http://example.com/authorize");
          expect(result!.metadata.token_endpoint).toBe("http://example.com/token");
        }),
    ),
  );
});

describe("registerDynamicClient", () => {
  it.effect("POSTs RFC 7591 metadata and parses the client information response", () =>
    withOAuthFixture(
      (request) => {
        if (request.url !== "/register") {
          return notFound();
        }
        return sendJson(
          {
            client_id: "generated-client-id",
            client_id_issued_at: 1_700_000_000,
            redirect_uris: ["https://app.example.com/cb"],
            token_endpoint_auth_method: "none",
          },
          201,
        );
      },
      ({ baseUrl, requests }) =>
        Effect.gen(function* () {
          const info = yield* registerDynamicClient({
            registrationEndpoint: `${baseUrl}/register`,
            metadata: {
              redirect_uris: ["https://app.example.com/cb"],
              client_name: "Executor",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            },
          });
          expect(info.client_id).toBe("generated-client-id");

          const call = (yield* requests)[0]!;
          expect(call.method).toBe("POST");
          const body = decodeDcrRequestBody(call.body);
          expect(body.redirect_uris).toEqual(["https://app.example.com/cb"]);
          expect(body.token_endpoint_auth_method).toBe("none");
        }),
    ),
  );

  it.effect("treats HTTP 200 as success (Todoist-style non-conformance)", () =>
    withOAuthFixture(
      () =>
        sendJson({
          client_id: "tdd_abc",
          redirect_uris: ["https://app.example.com/cb"],
        }),
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const info = yield* registerDynamicClient({
            registrationEndpoint: `${baseUrl}/register`,
            metadata: { redirect_uris: ["https://app.example.com/cb"] },
          });
          expect(info.client_id).toBe("tdd_abc");
        }),
    ),
  );

  it.effect("surfaces AS error responses with the error body", () =>
    withOAuthFixture(
      () =>
        sendJson(
          {
            error: "invalid_client_metadata",
            error_description: "redirect_uris must be https",
          },
          400,
        ),
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            registerDynamicClient({
              registrationEndpoint: `${baseUrl}/register`,
              metadata: { redirect_uris: ["http://localhost/cb"] },
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          const reason = exit.cause.reasons.find(Cause.isFailReason);
          const error = reason?.error;
          expect(error).toEqual(
            expect.objectContaining({
              _tag: "OAuthDiscoveryError",
              status: 400,
              message: expect.stringMatching(/invalid_client_metadata/),
            }),
          );
        }),
    ),
  );
});

describe("beginDynamicAuthorization", () => {
  it.effect("runs the full discovery + DCR + PKCE chain for a Railway-shaped endpoint", () =>
    withOAuthFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/oauth-protected-resource/graphql/v2") {
          return notFound();
        }
        if (request.url === "/.well-known/oauth-protected-resource") {
          return sendJson({
            resource: baseUrl,
            authorization_servers: [baseUrl],
            scopes_supported: ["openid", "profile", "email", "offline_access", "workspace:member"],
          });
        }
        if (request.url === "/.well-known/oauth-authorization-server") {
          return sendJson({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/oauth/auth`,
            token_endpoint: `${baseUrl}/oauth/token`,
            registration_endpoint: `${baseUrl}/oauth/register`,
            scopes_supported: ["openid", "profile", "email", "offline_access", "workspace:member"],
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (request.url === "/oauth/register") {
          return sendJson(
            {
              client_id: "dyn-client-42",
              redirect_uris: ["https://app.example/cb"],
              token_endpoint_auth_method: "none",
            },
            201,
          );
        }
        return notFound();
      },
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const result = yield* beginDynamicAuthorization({
            endpoint: `${baseUrl}/graphql/v2`,
            redirectUrl: "https://app.example/cb",
            state: "state-xyz",
          });

          const url = new URL(result.authorizationUrl);
          expect(url.origin + url.pathname).toBe(`${baseUrl}/oauth/auth`);
          expect(url.searchParams.get("client_id")).toBe("dyn-client-42");
          expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/cb");
          expect(url.searchParams.get("response_type")).toBe("code");
          expect(url.searchParams.get("state")).toBe("state-xyz");
          expect(url.searchParams.get("code_challenge_method")).toBe("S256");
          expect(url.searchParams.get("resource")).toBe(baseUrl);
          expect(result.state.authorizationServerMetadata.token_endpoint).toBe(
            `${baseUrl}/oauth/token`,
          );
          expect(result.state.resourceMetadata?.resource).toBe(baseUrl);
        }),
    ),
  );

  it.effect("declares requested scopes in the DCR body when caller passes them explicitly", () =>
    withOAuthFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/oauth-protected-resource") {
          return notFound();
        }
        if (request.url === "/.well-known/oauth-authorization-server") {
          return sendJson({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (request.url === "/register") {
          return sendJson(
            {
              client_id: "scope-client",
              redirect_uris: ["https://app/cb"],
              token_endpoint_auth_method: "none",
            },
            201,
          );
        }
        return notFound();
      },
      ({ baseUrl, requests }) =>
        Effect.gen(function* () {
          const result = yield* beginDynamicAuthorization({
            endpoint: baseUrl,
            redirectUrl: "https://app/cb",
            state: "s",
            scopes: ["openid", "email", "offline_access"],
          });

          const dcrCall = (yield* requests).find((request) => request.url === "/register")!;
          const body = decodeDcrRequestBody(dcrCall.body);
          expect(body.scope).toBe("openid email offline_access");

          const authUrl = new URL(result.authorizationUrl);
          expect(authUrl.searchParams.get("scope")).toBe("openid email offline_access");
        }),
    ),
  );

  it.effect("requests only PRM scopes_supported when advertised (RFC 9728 §2 limited scope)", () =>
    withOAuthFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/oauth-protected-resource/mcp") {
          return sendJson({
            resource: `${baseUrl}/mcp`,
            authorization_servers: [baseUrl],
            scopes_supported: ["mcp"],
          });
        }
        if (request.url === "/.well-known/oauth-authorization-server") {
          return sendJson({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            scopes_supported: ["openid", "profile", "email", "offline_access", "mcp"],
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (request.url === "/register") {
          return sendJson(
            {
              client_id: "prm-scope-client",
              redirect_uris: ["https://app/cb"],
              token_endpoint_auth_method: "none",
            },
            201,
          );
        }
        return notFound();
      },
      ({ baseUrl, requests }) =>
        Effect.gen(function* () {
          const result = yield* beginDynamicAuthorization({
            endpoint: `${baseUrl}/mcp`,
            redirectUrl: "https://app/cb",
            state: "s",
          });

          const dcrCall = (yield* requests).find((request) => request.url === "/register")!;
          const body = decodeDcrRequestBody(dcrCall.body);
          expect(body.scope).toBe("mcp");

          const authUrl = new URL(result.authorizationUrl);
          expect(authUrl.searchParams.get("scope")).toBe("mcp");
        }),
    ),
  );

  it.effect("omits scope when only AS-level scopes_supported is advertised", () =>
    withOAuthFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/oauth-protected-resource") {
          return notFound();
        }
        if (request.url === "/.well-known/oauth-authorization-server") {
          return sendJson({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            scopes_supported: ["openid", "profile", "email", "offline_access"],
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (request.url === "/register") {
          return sendJson(
            {
              client_id: "as-scope-client",
              redirect_uris: ["https://app/cb"],
              token_endpoint_auth_method: "none",
            },
            201,
          );
        }
        return notFound();
      },
      ({ baseUrl, requests }) =>
        Effect.gen(function* () {
          const result = yield* beginDynamicAuthorization({
            endpoint: baseUrl,
            redirectUrl: "https://app/cb",
            state: "s",
          });

          const dcrCall = (yield* requests).find((request) => request.url === "/register")!;
          const body = decodeDcrRequestBody(dcrCall.body);
          expect(body.scope).toBeUndefined();

          const authUrl = new URL(result.authorizationUrl);
          expect(authUrl.searchParams.has("scope")).toBe(false);
        }),
    ),
  );

  it.effect("rejects protected-resource metadata for a different resource", () =>
    withOAuthFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/oauth-protected-resource/v1/mcp") {
          return sendJson({
            resource: `${baseUrl}/canonical-id`,
            authorization_servers: [baseUrl],
          });
        }
        if (request.url === "/.well-known/oauth-authorization-server") {
          return sendJson({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (request.url === "/register") {
          return sendJson(
            {
              client_id: "res-client",
              redirect_uris: ["https://app/cb"],
              token_endpoint_auth_method: "none",
            },
            201,
          );
        }
        return notFound();
      },
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            beginDynamicAuthorization({
              endpoint: `${baseUrl}/v1/mcp`,
              redirectUrl: "https://app/cb",
              state: "s",
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          const reason = exit.cause.reasons.find(Cause.isFailReason);
          expect(reason?.error).toEqual(
            expect.objectContaining({
              _tag: "OAuthDiscoveryError",
              message: expect.stringMatching(/resource does not match requested endpoint/),
            }),
          );
        }),
    ),
  );

  it.effect(
    "falls back to canonical endpoint URL for the resource parameter when PRM is absent",
    () =>
      withOAuthFixture(
        (request, baseUrl) => {
          if (request.url === "/.well-known/oauth-protected-resource/v1/mcp") {
            return notFound();
          }
          if (request.url === "/.well-known/oauth-protected-resource") {
            return notFound();
          }
          if (request.url === "/.well-known/oauth-authorization-server") {
            return sendJson({
              issuer: baseUrl,
              authorization_endpoint: `${baseUrl}/authorize`,
              token_endpoint: `${baseUrl}/token`,
              registration_endpoint: `${baseUrl}/register`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            });
          }
          if (request.url === "/register") {
            return sendJson(
              {
                client_id: "ep-client",
                redirect_uris: ["https://app/cb"],
                token_endpoint_auth_method: "none",
              },
              201,
            );
          }
          return notFound();
        },
        ({ baseUrl }) =>
          Effect.gen(function* () {
            const result = yield* beginDynamicAuthorization({
              endpoint: `${baseUrl}/v1/mcp/`,
              redirectUrl: "https://app/cb",
              state: "s",
            });

            const authUrl = new URL(result.authorizationUrl);
            expect(authUrl.searchParams.get("resource")).toBe(`${baseUrl}/v1/mcp`);
          }),
      ),
  );

  it.effect("includes client_uri in the DCR body", () =>
    withOAuthFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/oauth-protected-resource") {
          return notFound();
        }
        if (request.url === "/.well-known/oauth-authorization-server") {
          return sendJson({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (request.url === "/register") {
          return sendJson(
            {
              client_id: "uri-client",
              redirect_uris: ["https://app/cb"],
              token_endpoint_auth_method: "none",
            },
            201,
          );
        }
        return notFound();
      },
      ({ baseUrl, requests }) =>
        Effect.gen(function* () {
          yield* beginDynamicAuthorization({
            endpoint: baseUrl,
            redirectUrl: "https://app/cb",
            state: "s",
          });

          const dcrCall = (yield* requests).find((request) => request.url === "/register")!;
          const body = decodeDcrRequestBody(dcrCall.body);
          expect(body.client_uri).toBe("https://executor.sh");
        }),
    ),
  );

  it.effect("negotiates client_secret_post when the AS does not advertise none", () =>
    withOAuthFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/oauth-protected-resource/v3/mcp") {
          return sendJson({
            resource: `${baseUrl}/v3/mcp`,
            authorization_servers: [baseUrl],
            scopes_supported: ["mcp"],
          });
        }
        if (request.url === "/.well-known/oauth-authorization-server") {
          return sendJson({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (request.url === "/register") {
          return sendJson(
            {
              client_id: "clay-id",
              client_secret: "clay-secret",
              redirect_uris: ["https://app/cb"],
              token_endpoint_auth_method: "client_secret_post",
            },
            201,
          );
        }
        return notFound();
      },
      ({ baseUrl, requests }) =>
        Effect.gen(function* () {
          yield* beginDynamicAuthorization({
            endpoint: `${baseUrl}/v3/mcp`,
            redirectUrl: "https://app/cb",
            state: "s",
          });

          const dcrCall = (yield* requests).find((request) => request.url === "/register")!;
          const body = decodeDcrRequestBody(dcrCall.body);
          expect(body.token_endpoint_auth_method).toBe("client_secret_post");
        }),
    ),
  );

  it.effect("fails with a clear error when the AS advertises only unsupported auth methods", () =>
    withOAuthFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/oauth-protected-resource") {
          return notFound();
        }
        if (request.url === "/.well-known/oauth-authorization-server") {
          return sendJson({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            token_endpoint_auth_methods_supported: ["private_key_jwt"],
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        return notFound();
      },
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            beginDynamicAuthorization({
              endpoint: baseUrl,
              redirectUrl: "https://app/cb",
              state: "s",
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          const reason = exit.cause.reasons.find(Cause.isFailReason);
          expect(reason?.error).toEqual(
            expect.objectContaining({
              _tag: "OAuthDiscoveryError",
              message: expect.stringMatching(/usable token_endpoint_auth_method/),
            }),
          );
        }),
    ),
  );

  it.effect(
    "falls through to a later authorization_servers entry when the first has no metadata",
    () =>
      withOAuthFixture(
        (request, baseUrl) => {
          if (request.url === "/.well-known/oauth-protected-resource/api") {
            return sendJson({
              resource: `${baseUrl}/api`,
              authorization_servers: [`${baseUrl}/primary`, `${baseUrl}/backup`],
            });
          }
          if (request.url === "/.well-known/oauth-authorization-server/primary") {
            return notFound();
          }
          if (request.url === "/.well-known/openid-configuration/primary") {
            return notFound();
          }
          if (request.url === "/.well-known/oauth-authorization-server/backup") {
            return sendJson({
              issuer: `${baseUrl}/backup`,
              authorization_endpoint: `${baseUrl}/backup/authorize`,
              token_endpoint: `${baseUrl}/backup/token`,
              registration_endpoint: `${baseUrl}/backup/register`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            });
          }
          if (request.url === "/backup/register") {
            return sendJson(
              {
                client_id: "backup-client",
                redirect_uris: ["https://app/cb"],
                token_endpoint_auth_method: "none",
              },
              201,
            );
          }
          return notFound();
        },
        ({ baseUrl }) =>
          Effect.gen(function* () {
            const result = yield* beginDynamicAuthorization({
              endpoint: `${baseUrl}/api`,
              redirectUrl: "https://app/cb",
              state: "s",
            });

            expect(result.state.authorizationServerUrl).toBe(`${baseUrl}/backup`);
            expect(result.state.clientInformation.client_id).toBe("backup-client");
          }),
      ),
  );

  it.effect("propagates AS error code + description on DCR failure", () =>
    withOAuthFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/oauth-protected-resource") {
          return notFound();
        }
        if (request.url === "/.well-known/oauth-authorization-server") {
          return sendJson({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (request.url === "/register") {
          return sendJson(
            {
              error: "invalid_redirect_uri",
              error_description: "redirect is not allowed",
            },
            400,
          );
        }
        return notFound();
      },
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            beginDynamicAuthorization({
              endpoint: baseUrl,
              redirectUrl: "https://app/cb",
              state: "s",
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          const reason = exit.cause.reasons.find(Cause.isFailReason);
          expect(reason?.error).toEqual(
            expect.objectContaining({
              _tag: "OAuthDiscoveryError",
              status: 400,
              error: "invalid_redirect_uri",
              errorDescription: "redirect is not allowed",
            }),
          );
        }),
    ),
  );

  it.effect("skips discovery + DCR when previousState is provided", () =>
    withOAuthFixture(
      () => notFound(),
      ({ baseUrl, requests }) =>
        Effect.gen(function* () {
          const result = yield* beginDynamicAuthorization({
            endpoint: `${baseUrl}/mcp`,
            redirectUrl: "https://app/cb",
            state: "s",
            previousState: {
              authorizationServerUrl: baseUrl,
              authorizationServerMetadataUrl: `${baseUrl}/.well-known/oauth-authorization-server`,
              authorizationServerMetadata: {
                issuer: baseUrl,
                authorization_endpoint: `${baseUrl}/authorize`,
                token_endpoint: `${baseUrl}/token`,
                registration_endpoint: `${baseUrl}/register`,
              },
              resourceMetadata: {
                resource: `${baseUrl}/mcp`,
                authorization_servers: [baseUrl],
              },
              resourceMetadataUrl: `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
              clientInformation: {
                client_id: "cached-client",
              },
            },
          });

          expect((yield* requests).length).toBe(0);
          expect(new URL(result.authorizationUrl).searchParams.get("client_id")).toBe(
            "cached-client",
          );
        }),
    ),
  );

  it.effect("rejects servers that don't support PKCE S256", () =>
    withOAuthFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/oauth-protected-resource") {
          return notFound();
        }
        if (request.url === "/.well-known/oauth-authorization-server") {
          return sendJson({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["plain"],
          });
        }
        return notFound();
      },
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            beginDynamicAuthorization({
              endpoint: baseUrl,
              redirectUrl: "https://app/cb",
              state: "s",
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          const reason = exit.cause.reasons.find(Cause.isFailReason);
          expect(reason?.error).toEqual(
            expect.objectContaining({
              _tag: "OAuthDiscoveryError",
              message: expect.stringMatching(/PKCE S256/),
            }),
          );
        }),
    ),
  );

  it.effect(
    "fails when the authorization server has no registration_endpoint and no previous client",
    () =>
      withOAuthFixture(
        (request, baseUrl) => {
          if (request.url === "/.well-known/oauth-protected-resource") {
            return notFound();
          }
          if (request.url === "/.well-known/oauth-authorization-server") {
            return sendJson({
              issuer: baseUrl,
              authorization_endpoint: `${baseUrl}/authorize`,
              token_endpoint: `${baseUrl}/token`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            });
          }
          return notFound();
        },
        ({ baseUrl }) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              beginDynamicAuthorization({
                endpoint: baseUrl,
                redirectUrl: "https://app/cb",
                state: "s",
              }),
            );
            expect(Exit.isFailure(exit)).toBe(true);
            if (!Exit.isFailure(exit)) return;
            const reason = exit.cause.reasons.find(Cause.isFailReason);
            expect(reason?.error).toEqual(
              expect.objectContaining({
                _tag: "OAuthDiscoveryError",
                message: expect.stringMatching(/registration_endpoint/),
              }),
            );
          }),
      ),
  );
});
