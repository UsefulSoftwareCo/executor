import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import {
  CreateConnectionInput,
  OAUTH2_PROVIDER_KEY,
  TokenMaterial,
  createExecutor,
} from "@executor-js/sdk";
import { ConnectionId, ScopeId, SecretId } from "@executor-js/sdk/shared";
import { makeTestConfig, memorySecretsPlugin, serveTestHttpApp } from "@executor-js/sdk/testing";

import { lookupOidcConnectionIdentity, readConnectionIdentity } from "./connection-identity";

type CapturedRequest = {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
};

type Handler = (request: CapturedRequest, baseUrl: string) => HttpServerResponse.HttpServerResponse;

const notFound = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({ status: 404 });

const serveOidcFixture = (handler: Handler) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<readonly CapturedRequest[]>([]);
    const baseUrlRef = { value: "" };
    const server = yield* serveTestHttpApp((request) =>
      Effect.gen(function* () {
        const captured = {
          method: request.method,
          url: request.url ?? "/",
          headers: request.headers,
        };
        yield* Ref.update(requests, (all) => [...all, captured]);
        return handler(captured, baseUrlRef.value);
      }),
    );
    baseUrlRef.value = server.baseUrl;

    return {
      baseUrl: server.baseUrl,
      requests: Ref.get(requests),
    } as const;
  });

const withOidcFixture = <A, E>(
  handler: Handler,
  use: (fixture: {
    readonly baseUrl: string;
    readonly requests: Effect.Effect<readonly CapturedRequest[]>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* serveOidcFixture(handler);
      return yield* use(fixture);
    }),
  );

describe("lookupOidcConnectionIdentity", () => {
  it.effect("reads normalized account claims from OIDC userinfo", () =>
    withOidcFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/openid-configuration") {
          return HttpServerResponse.jsonUnsafe({
            issuer: baseUrl,
            userinfo_endpoint: `${baseUrl}/userinfo`,
          });
        }
        if (request.url === "/userinfo") {
          return HttpServerResponse.jsonUnsafe({
            sub: "account-123",
            email: "rhys@example.com",
            email_verified: true,
            name: "Rhys Sullivan",
            preferred_username: "rhys",
            picture: "https://example.com/avatar.png",
          });
        }
        return notFound();
      },
      ({ baseUrl, requests }) =>
        Effect.gen(function* () {
          const identity = yield* lookupOidcConnectionIdentity({
            issuerUrl: baseUrl,
            accessToken: "token-abc",
          });
          const seenRequests = yield* requests;

          expect(identity).toEqual({
            status: "available",
            source: "detected",
            subject: "account-123",
            email: "rhys@example.com",
            emailVerified: true,
            name: "Rhys Sullivan",
            username: "rhys",
            picture: "https://example.com/avatar.png",
            message: null,
          });
          expect(seenRequests.map((request) => request.url)).toEqual([
            "/.well-known/openid-configuration",
            "/userinfo",
          ]);
          expect(seenRequests[1]?.headers.authorization).toBe("Bearer token-abc");
        }),
    ),
  );

  it.effect("returns unavailable when OIDC metadata has no userinfo endpoint", () =>
    withOidcFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/openid-configuration") {
          return HttpServerResponse.jsonUnsafe({ issuer: baseUrl });
        }
        return notFound();
      },
      ({ baseUrl, requests }) =>
        Effect.gen(function* () {
          const identity = yield* lookupOidcConnectionIdentity({
            issuerUrl: baseUrl,
            accessToken: "token-abc",
          });
          const seenRequests = yield* requests;

          expect(identity).toEqual({
            status: "unavailable",
            source: "unknown",
            subject: null,
            email: null,
            emailVerified: null,
            name: null,
            username: null,
            picture: null,
            message: "This connection does not advertise OIDC userinfo",
          });
          expect(seenRequests.map((request) => request.url)).toEqual([
            "/.well-known/openid-configuration",
          ]);
        }),
    ),
  );

  it.effect("marks the connection as needing reauth when userinfo rejects the token", () =>
    withOidcFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/openid-configuration") {
          return HttpServerResponse.jsonUnsafe({
            issuer: baseUrl,
            userinfo_endpoint: `${baseUrl}/userinfo`,
          });
        }
        if (request.url === "/userinfo") {
          return HttpServerResponse.jsonUnsafe({ error: "invalid_token" }, { status: 401 });
        }
        return notFound();
      },
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const identity = yield* lookupOidcConnectionIdentity({
            issuerUrl: baseUrl,
            accessToken: "expired-token",
          });

          expect(identity).toEqual({
            status: "reauth_required",
            source: "unknown",
            subject: null,
            email: null,
            emailVerified: null,
            name: null,
            username: null,
            picture: null,
            message: "OIDC userinfo rejected the access token",
          });
        }),
    ),
  );

  it.effect("returns unavailable when userinfo is outside the token's granted scopes", () =>
    withOidcFixture(
      (request, baseUrl) => {
        if (request.url === "/.well-known/openid-configuration") {
          return HttpServerResponse.jsonUnsafe({
            issuer: baseUrl,
            userinfo_endpoint: `${baseUrl}/userinfo`,
          });
        }
        if (request.url === "/userinfo") {
          return HttpServerResponse.jsonUnsafe({ error: "insufficient_scope" }, { status: 403 });
        }
        return notFound();
      },
      ({ baseUrl }) =>
        Effect.gen(function* () {
          const identity = yield* lookupOidcConnectionIdentity({
            issuerUrl: baseUrl,
            accessToken: "limited-token",
          });

          expect(identity).toEqual({
            status: "unavailable",
            source: "unknown",
            subject: null,
            email: null,
            emailVerified: null,
            name: null,
            username: null,
            picture: null,
            message: "OIDC userinfo is not permitted by this token",
          });
        }),
    ),
  );
});

describe("readConnectionIdentity", () => {
  it.effect("does not call OIDC userinfo for OAuth connections without identity scopes", () =>
    Effect.gen(function* () {
      const userScope = ScopeId.make("test-scope");
      const connectionId = ConnectionId.make("gmail");
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin()] as const,
        }),
      );

      yield* executor.connections.create(
        CreateConnectionInput.make({
          id: connectionId,
          scope: userScope,
          provider: OAUTH2_PROVIDER_KEY,
          identityLabel: "Gmail API OAuth",
          accessToken: TokenMaterial.make({
            secretId: SecretId.make("gmail.access-token"),
            name: "Gmail access token",
            value: "gmail-token",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: "https://www.googleapis.com/auth/gmail.readonly",
          providerState: {
            kind: "authorization-code",
            tokenEndpoint: "https://oauth2.googleapis.com/token",
            issuerUrl: "https://accounts.google.com",
            clientIdSecretId: "client-id",
            clientIdSecretScopeId: null,
            clientSecretSecretId: null,
            clientSecretSecretScopeId: null,
            clientAuth: "body",
            scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
            scope: "https://www.googleapis.com/auth/gmail.readonly",
          },
        }),
      );

      const identity = yield* readConnectionIdentity({
        executor,
        scopeId: userScope,
        connectionId,
      });

      expect(identity).toEqual({
        status: "unavailable",
        source: "unknown",
        subject: null,
        email: null,
        emailVerified: null,
        name: null,
        username: null,
        picture: null,
        message: "Connection was not granted OIDC identity scopes",
      });
    }),
  );

  it.effect("uses manual account info when OIDC identity is unavailable", () =>
    Effect.gen(function* () {
      const userScope = ScopeId.make("test-scope");
      const connectionId = ConnectionId.make("gmail");
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin()] as const,
        }),
      );

      yield* executor.connections.create(
        CreateConnectionInput.make({
          id: connectionId,
          scope: userScope,
          provider: OAUTH2_PROVIDER_KEY,
          identityLabel: "Gmail API OAuth",
          accessToken: TokenMaterial.make({
            secretId: SecretId.make("manual.access-token"),
            name: "Manual access token",
            value: "manual-token",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: "https://www.googleapis.com/auth/gmail.readonly",
          providerState: {
            kind: "authorization-code",
            tokenEndpoint: "https://oauth2.googleapis.com/token",
            issuerUrl: "https://accounts.google.com",
            clientIdSecretId: "client-id",
            clientIdSecretScopeId: null,
            clientSecretSecretId: null,
            clientSecretSecretScopeId: null,
            clientAuth: "body",
            scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
            scope: "https://www.googleapis.com/auth/gmail.readonly",
          },
        }),
      );
      yield* executor.connections.setIdentityOverride({
        id: connectionId,
        targetScope: userScope,
        identityOverride: {
          displayName: "Manual Account",
          email: "manual@example.com",
          avatarUrl: "https://example.com/manual.png",
        },
      });

      const identity = yield* readConnectionIdentity({
        executor,
        scopeId: userScope,
        connectionId,
      });

      expect(identity).toEqual({
        status: "available",
        source: "manual",
        subject: null,
        email: "manual@example.com",
        emailVerified: null,
        name: "Manual Account",
        username: null,
        picture: "https://example.com/manual.png",
        message: null,
      });
    }),
  );
});
