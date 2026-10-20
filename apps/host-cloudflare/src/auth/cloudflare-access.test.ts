import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import { orgWriteAccessForPrincipal } from "@executor-js/host-mcp";

import type { CloudflareConfig } from "../config";
import {
  classifyAccessClaims,
  delegatedCredentialFromAccessClaims,
  hasRecentAccessAuthentication,
  makeAccessVerifier,
  principalFromAccessClaims,
} from "./cloudflare-access";

const config: CloudflareConfig = {
  accessTeamDomain: "team.cloudflareaccess.com",
  accessAud: "aud-tag",
  accessNameClaim: "name",
  accessGroupsClaim: "groups",
  adminEmails: ["admin@example.com"],
  organizationId: "default",
  organizationName: "Default",
  organizationSlug: "default",
  secretKey: "x".repeat(32),
  allowLocalNetwork: false,
  webBaseUrl: "https://localhost",
  enableDevAuth: false,
  delegatedIssuanceEnabled: false,
  delegatedRecentAuthMaxAgeMs: 300_000,
  delegatedMaxTtlMs: 90 * 24 * 60 * 60 * 1000,
};

describe("principalFromAccessClaims", () => {
  it("maps a human identity (email + sub + groups)", () => {
    const p = principalFromAccessClaims(
      { sub: "user-123", email: "person@example.com", name: "Person", groups: ["eng"] },
      config,
    );
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.accountId).toBe("user-123");
    expect(p.email).toBe("person@example.com");
    expect(p.name).toBe("Person");
    expect(p.roles).toEqual(["eng"]);
    expect(p.organizationId).toBe("default");
  });

  it("grants admin when the email is in the allowlist", () => {
    const p = principalFromAccessClaims({ sub: "u", email: "ADMIN@example.com" }, config);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.roles).toContain("admin");
    expect(p.orgRoleModel).toBe("organization");
    expect(p.orgRole).toBe("admin");
    expect(orgWriteAccessForPrincipal(p)).toBe("allowed");
  });

  it("gives a SERVICE TOKEN (common_name, no email/sub) a stable identity", () => {
    // Cloudflare Access service-token JWT: common_name set, email/sub absent.
    const p = principalFromAccessClaims({ common_name: "df8a20db.access", type: "app" }, config);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.accountId).toBe("df8a20db.access"); // not empty — stable per token
    expect(p.name).toBe("df8a20db.access");
    expect(p.email).toBe("");
    expect(p.roles).toEqual(["member"]); // a token is a member, not an admin
    expect(p.organizationId).toBe("default");
  });

  it("keeps a signed app assertion machine-only when incidental claims are present", () => {
    const p = principalFromAccessClaims(
      {
        type: "app",
        common_name: "machine-1",
        sub: "incidental-subject",
        email: "machine@example.com",
        groups: ["admin"],
      },
      config,
    );
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.accountId).toBe("machine-1");
    expect(p.email).toBe("");
    expect(p.roles).toEqual(["member"]);
    expect(p.orgRole).toBe("member");
    expect(orgWriteAccessForPrincipal(p)).toBe("denied");
  });

  it("defaults to member when there are no groups and no admin match", () => {
    const p = principalFromAccessClaims({ sub: "u", email: "nobody@other.com" }, config);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.roles).toEqual(["member"]);
    expect(p.orgRoleModel).toBe("organization");
    expect(p.orgRole).toBe("member");
    expect(orgWriteAccessForPrincipal(p)).toBe("denied");
  });

  it("requires positive signed human or service-token claims", () => {
    expect(classifyAccessClaims({ sub: "human", email: "human@example.com" })).toBe("human");
    expect(classifyAccessClaims({ type: "app", common_name: "machine" })).toBe("service-token");
    expect(classifyAccessClaims({ common_name: "client-id-from-a-header" })).toBe("invalid");
    expect(
      principalFromAccessClaims({ common_name: "client-id-from-a-header" }, config),
    ).toBeNull();
  });

  it("builds an external credential tuple only for a signed Access app", () => {
    expect(
      delegatedCredentialFromAccessClaims({ type: "app", common_name: "machine-1" }, config),
    ).toMatchObject({
      kind: "external",
      adapter: "cloudflare-access",
      issuer: "https://team.cloudflareaccess.com",
      audience: "aud-tag",
      subject: "machine-1",
      credentialRef: "machine-1",
    });
    expect(delegatedCredentialFromAccessClaims({ common_name: "machine-1" }, config)).toBeNull();
  });
});

describe("Access recent-auth assurance", () => {
  it("uses auth_time and rejects missing or stale assurance", () => {
    const now = 1_700_000_000_000;
    expect(hasRecentAccessAuthentication({ iat: now / 1000 }, 300_000, now)).toBe(false);
    expect(hasRecentAccessAuthentication({ auth_time: now / 1000 - 60 }, 300_000, now)).toBe(true);
    expect(hasRecentAccessAuthentication({ auth_time: now / 1000 - 301 }, 300_000, now)).toBe(
      false,
    );
    expect(
      hasRecentAccessAuthentication(
        { custom: { login_time: String(now / 1000 - 60) } },
        300_000,
        now,
        "login_time",
      ),
    ).toBe(true);
    expect(
      hasRecentAccessAuthentication({ custom: { login_time: now / 1000 - 60 } }, 300_000, now),
    ).toBe(false);
  });

  it.effect("requires a valid signed issuer, audience, and expiry", () =>
    Effect.promise(async () => {
      const { privateKey, publicKey } = await generateKeyPair("RS256");
      const jwk = await exportJWK(publicKey);
      const keySet = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256", kid: "test-key" }] });
      const verifier = makeAccessVerifier(config, { keySet });
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({
        sub: "human-1",
        email: "human@example.com",
        auth_time: now - 60,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer("https://team.cloudflareaccess.com")
        .setAudience("aud-tag")
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);
      const verified = await Effect.runPromise(
        verifier.verifyWithClaims(
          new Request("https://localhost/", {
            headers: { "Cf-Access-Jwt-Assertion": token },
          }),
        ),
      );
      expect(verified?.principal.accountId).toBe("human-1");
      expect(verified?.claims.auth_time).toBe(now - 60);

      const wrongAudience = await new SignJWT({
        sub: "human-1",
        email: "human@example.com",
        auth_time: now - 60,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer("https://team.cloudflareaccess.com")
        .setAudience("wrong-audience")
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);
      await expect(
        Effect.runPromise(
          verifier.verifyWithClaims(
            new Request("https://localhost/", {
              headers: { "Cf-Access-Jwt-Assertion": wrongAudience },
            }),
          ),
        ),
      ).resolves.toBeNull();
    }),
  );
});
