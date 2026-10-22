import { describe, expect, it } from "@effect/vitest";

import {
  authContextFromPrincipal,
  isDelegatedPrincipal,
  type DelegatedPrincipal,
} from "./identity";
import { isDelegatedExecutionPath, isDelegatedManagementPath } from "./execution-stack-middleware";

const delegated: DelegatedPrincipal = {
  kind: "delegated",
  accountId: "human_1",
  organizationId: "org_1",
  organizationName: "Example",
  email: "",
  name: null,
  avatarUrl: null,
  roles: [],
  orgRoleModel: "organization",
  orgRole: "member",
  tenant: "org_1",
  grantId: "grant_1",
  credentialId: "credential_1",
  credentialRef: "ref_1",
  actorSubject: "machine_1",
  effectiveSubject: "human_1",
  scopeVersion: "scope_1",
};

describe("delegated API identity", () => {
  it("keeps grant and actor binding in AuthContext without inheriting target roles", () => {
    expect(isDelegatedPrincipal(delegated)).toBe(true);
    expect(authContextFromPrincipal(delegated)).toMatchObject({
      kind: "delegated",
      accountId: "human_1",
      grantId: "grant_1",
      credentialId: "credential_1",
      credentialRef: "ref_1",
      actorSubject: "machine_1",
      effectiveSubject: "human_1",
      scopeVersion: "scope_1",
      roles: [],
    });
  });
});

describe("delegated HTTP route gate", () => {
  it("classifies account and admin surfaces as management routes", () => {
    expect(isDelegatedManagementPath("/api/account/delegated-credentials")).toBe(true);
    expect(isDelegatedManagementPath("/admin/users")).toBe(true);
    expect(isDelegatedManagementPath("/api/%61dmin/users")).toBe(true);
    expect(isDelegatedManagementPath("/api%2Faccount%2Fapi-keys")).toBe(true);
    expect(isDelegatedManagementPath("/api/%")).toBe(true);
    expect(isDelegatedManagementPath("/apiary/admin/users")).toBe(false);
    expect(isDelegatedManagementPath("/api/tools")).toBe(false);
    expect(isDelegatedManagementPath("/api/executions")).toBe(false);
    expect(isDelegatedManagementPath("/api/artifacts")).toBe(true);
    expect(isDelegatedExecutionPath("GET", "/api/tools")).toBe(true);
    expect(isDelegatedExecutionPath("GET", "/api/tools/schema")).toBe(true);
    expect(isDelegatedExecutionPath("POST", "/api/executions")).toBe(true);
    expect(isDelegatedExecutionPath("POST", "/api/executions/id/resume")).toBe(true);
    expect(isDelegatedExecutionPath("GET", "/api/executions/id")).toBe(true);
    expect(isDelegatedExecutionPath("GET", "/api/organizations/org/tools")).toBe(false);
    expect(isDelegatedExecutionPath("GET", "/api/%")).toBe(false);
  });
});
