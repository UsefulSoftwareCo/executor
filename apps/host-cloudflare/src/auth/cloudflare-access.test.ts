import { describe, expect, it } from "@effect/vitest";

import type { CloudflareConfig } from "../config";
import { principalFromAccessClaims } from "./cloudflare-access";

const config: CloudflareConfig = {
  accessTeamDomain: "team.cloudflareaccess.com",
  accessAud: "aud-tag",
  accessNameClaim: "name",
  accessGroupsClaim: "groups",
  adminEmails: ["admin@example.com"],
  accessServiceTokenSubjects: {},
  organizationId: "default",
  organizationName: "Default",
  organizationSlug: "default",
  secretKey: "x".repeat(32),
  allowLocalNetwork: false,
  webBaseUrl: "https://localhost",
  enableDevAuth: false,
};

describe("principalFromAccessClaims", () => {
  it("maps a human identity (email + sub + groups)", () => {
    const p = principalFromAccessClaims(
      { sub: "user-123", email: "person@example.com", name: "Person", groups: ["eng"] },
      config,
    );
    expect(p?.accountId).toBe("user-123");
    expect(p?.email).toBe("person@example.com");
    expect(p?.name).toBe("Person");
    expect(p?.roles).toEqual(["eng"]);
    expect(p?.organizationId).toBe("default");
  });

  it("grants admin when the email is in the allowlist", () => {
    const p = principalFromAccessClaims({ sub: "u", email: "ADMIN@example.com" }, config);
    expect(p?.roles).toContain("admin");
  });

  it("gives a SERVICE TOKEN (common_name, no email/sub) a stable identity", () => {
    // Cloudflare Access service-token JWT: common_name set, email/sub absent.
    const p = principalFromAccessClaims({ common_name: "df8a20db.access", type: "app" }, config);
    expect(p?.accountId).toBe("df8a20db.access"); // not empty — stable per token
    expect(p?.name).toBe("df8a20db.access");
    expect(p?.email).toBe("");
    expect(p?.roles).toEqual(["member"]); // a token is a member, not an admin
    expect(p?.organizationId).toBe("default");
  });

  it("maps a dedicated SERVICE TOKEN to the human's stable subject without copying privileges", () => {
    const mappedConfig: CloudflareConfig = {
      ...config,
      adminEmails: ["person@example.com"],
      accessServiceTokenSubjects: { "df8a20db.access": "user-123" },
    };
    const human = principalFromAccessClaims(
      { sub: "user-123", email: "Person@Example.com", name: "Person" },
      mappedConfig,
    );
    const service = principalFromAccessClaims(
      {
        common_name: "df8a20db.access",
        email: "person@example.com",
        groups: ["admin", "eng"],
        type: "app",
      },
      mappedConfig,
    );

    expect(service?.accountId).toBe(human?.accountId);
    expect(service?.email).toBe("");
    expect(service?.roles).toEqual(["member"]);
  });

  it("rejects verified claims without a human or service-token identity", () => {
    expect(principalFromAccessClaims({ type: "app" }, config)).toBeNull();
  });

  it("defaults to member when there are no groups and no admin match", () => {
    const p = principalFromAccessClaims({ sub: "u", email: "nobody@other.com" }, config);
    expect(p?.roles).toEqual(["member"]);
  });
});
