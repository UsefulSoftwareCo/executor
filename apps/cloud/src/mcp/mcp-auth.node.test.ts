import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

import { McpJwtVerificationError, verifyMcpAccessToken, verifyWorkOSMcpAccessToken } from "./jwt";

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
