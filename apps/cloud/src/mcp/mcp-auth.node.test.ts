import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

import {
  McpJwtVerificationError,
  verifyMcpAccessToken,
  verifyWorkOSMcpAccessToken,
  verifyWorkosUserManagementToken,
} from "./jwt";

const issuer = "https://test-authkit.example.com";
const resource = "https://test-resource.example.com/mcp";
const otherResource = "https://other-resource.example.com/mcp";
const workosApplicationClientId = "client_workos_application_fixture";
const dynamicOAuthClientId = "client_dynamic_oauth_fixture";

const makeVerifier = async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key" }] });
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT({ org_id: "org_test", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setSubject("user_test")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  return { jwks, sign };
};

describe("MCP AuthKit token verification", () => {
  it.effect("low-level verifier rejects mismatched audience when audience is required", () =>
    Effect.gen(function* () {
      const { jwks, sign } = yield* Effect.promise(() => makeVerifier());
      const token = yield* Effect.promise(() => sign({ aud: otherResource }));

      const error = yield* Effect.flip(
        verifyMcpAccessToken(token, jwks, {
          issuer,
          audience: resource,
        }),
      );

      expect(error).toBeInstanceOf(McpJwtVerificationError);
    }),
  );

  it.effect("low-level verifier accepts a matching resource audience", () =>
    Effect.gen(function* () {
      const { jwks, sign } = yield* Effect.promise(() => makeVerifier());
      const token = yield* Effect.promise(() => sign({ aud: resource }));

      const verified = yield* verifyMcpAccessToken(token, jwks, {
        issuer,
        audience: resource,
      });

      expect(verified).toEqual({
        accountId: "user_test",
        organizationId: "org_test",
      });
    }),
  );

  it.effect("MCP verifier accepts WorkOS application-audience tokens", () =>
    Effect.gen(function* () {
      const { jwks, sign } = yield* Effect.promise(() => makeVerifier());
      const token = yield* Effect.promise(() =>
        sign({ aud: workosApplicationClientId, sid: "app_consent_test" }),
      );

      const verified = yield* verifyWorkOSMcpAccessToken(token, jwks, {
        issuer,
        audience: workosApplicationClientId,
      });

      expect(verified).toEqual({
        accountId: "user_test",
        organizationId: "org_test",
      });
    }),
  );

  it.effect("MCP verifier rejects resource-audience tokens", () =>
    Effect.gen(function* () {
      const { jwks, sign } = yield* Effect.promise(() => makeVerifier());
      const token = yield* Effect.promise(() => sign({ aud: resource }));

      const error = yield* Effect.flip(
        verifyWorkOSMcpAccessToken(token, jwks, {
          issuer,
          audience: workosApplicationClientId,
        }),
      );

      expect(error).toBeInstanceOf(McpJwtVerificationError);
    }),
  );

  it.effect("MCP verifier rejects dynamic OAuth client-audience tokens", () =>
    Effect.gen(function* () {
      const { jwks, sign } = yield* Effect.promise(() => makeVerifier());
      const token = yield* Effect.promise(() =>
        sign({ aud: dynamicOAuthClientId, sid: "app_consent_test" }),
      );

      const error = yield* Effect.flip(
        verifyWorkOSMcpAccessToken(token, jwks, {
          issuer,
          audience: workosApplicationClientId,
        }),
      );

      expect(error).toBeInstanceOf(McpJwtVerificationError);
    }),
  );
});

describe("access token expiry and identity boundaries", () => {
  for (const kind of ["mcp", "user-management"] as const) {
    for (const invalidClaim of ["missing-exp", "missing-iat"] as const) {
      it.effect(`${kind} rejects ${invalidClaim}`, () =>
        Effect.gen(function* () {
          const { publicKey, privateKey } = yield* Effect.promise(() => generateKeyPair("RS256"));
          const jwk = yield* Effect.promise(() => exportJWK(publicKey));
          const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "expiry-key" }] });
          const now = Math.floor(Date.now() / 1000);
          const claims = {
            sub: "user_test",
            org_id: "org_test",
            iss: issuer,
            aud: resource,
            ...(invalidClaim === "missing-exp" ? {} : { exp: now + 300 }),
            ...(invalidClaim === "missing-iat" ? {} : { iat: now }),
          };
          const token = yield* Effect.promise(() =>
            new SignJWT(claims)
              .setProtectedHeader({ alg: "RS256", kid: "expiry-key" })
              .sign(privateKey),
          );
          const error = yield* Effect.flip(
            kind === "mcp"
              ? verifyMcpAccessToken(token, jwks, { issuer, audience: resource })
              : verifyWorkosUserManagementToken(token, jwks),
          );
          expect(error).toBeInstanceOf(McpJwtVerificationError);
          expect(error.reason).not.toBe("system");
        }),
      );
    }
    it.effect(`${kind} accepts a token issued more than a day ago that has not expired`, () =>
      Effect.gen(function* () {
        const { publicKey, privateKey } = yield* Effect.promise(() => generateKeyPair("RS256"));
        const jwk = yield* Effect.promise(() => exportJWK(publicKey));
        const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "expiry-key" }] });
        const now = Math.floor(Date.now() / 1000);
        const token = yield* Effect.promise(() =>
          new SignJWT({
            sub: "user_test",
            org_id: "org_test",
            iss: issuer,
            aud: resource,
            iat: now - 5 * 86400,
            exp: now + 2 * 86400,
          })
            .setProtectedHeader({ alg: "RS256", kid: "expiry-key" })
            .sign(privateKey),
        );
        const verified = yield* kind === "mcp"
          ? verifyMcpAccessToken(token, jwks, { issuer, audience: resource })
          : verifyWorkosUserManagementToken(token, jwks);
        expect(verified).toEqual({ accountId: "user_test", organizationId: "org_test" });
      }),
    );
    it.effect(`${kind} rejects a non-string organization claim`, () =>
      Effect.gen(function* () {
        const { jwks, sign } = yield* Effect.promise(() => makeVerifier());
        const token = yield* Effect.promise(() =>
          sign({ aud: resource, org_id: { id: "org_test" } }),
        );
        const verified = yield* kind === "mcp"
          ? verifyMcpAccessToken(token, jwks, { issuer, audience: resource })
          : verifyWorkosUserManagementToken(token, jwks);
        expect(verified).toBeNull();
      }),
    );
  }
});
