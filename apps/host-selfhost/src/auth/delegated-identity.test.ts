import { expect, test } from "@effect/vitest";

import {
  DELEGATED_ACCOUNT_ID_HEADER,
  DELEGATED_ORG_ROLE_HEADER,
  resolveTrustedDelegation,
} from "./identity";

const TOKEN = "trusted-delegation-token-with-32-bytes";
const input = {
  organizationId: "org-1",
  organizationName: "Acme",
  organizationSlug: "acme",
  trustedDelegationToken: TOKEN,
} as const;

const request = (
  token: string,
  accountId: string | null = "clerk-user-1",
  orgRole: string | null = "member",
): Request =>
  new Request("http://localhost/api/connections", {
    headers: {
      authorization: `Bearer ${token}`,
      ...(accountId === null ? {} : { [DELEGATED_ACCOUNT_ID_HEADER]: accountId }),
      ...(orgRole === null ? {} : { [DELEGATED_ORG_ROLE_HEADER]: orgRole }),
    },
  });

test("the trusted machine token binds the request to the delegated account", () => {
  const resolved = resolveTrustedDelegation(request(TOKEN), input);
  expect(resolved).toEqual({
    matched: true,
    principal: {
      kind: "member",
      accountId: "clerk-user-1",
      organizationId: "org-1",
      organizationName: "Acme",
      organizationSlug: "acme",
      email: "",
      name: null,
      avatarUrl: null,
      roles: [],
      orgRoleModel: "organization",
      orgRole: "member",
    },
  });
});

test("an ordinary API key cannot select a delegated account", () => {
  expect(resolveTrustedDelegation(request("ordinary-personal-api-key"), input)).toEqual({
    matched: false,
  });
});

test.each([
  [null, "member"],
  ["", "member"],
  ["user 1", "member"],
  ["user-1", null],
  ["user-1", "owner"],
])("a trusted token with invalid identity headers fails closed", (accountId, role) => {
  expect(resolveTrustedDelegation(request(TOKEN, accountId, role), input)).toEqual({
    matched: true,
    principal: null,
  });
});

test("delegated admin authority is explicit", () => {
  const resolved = resolveTrustedDelegation(request(TOKEN, "clerk-admin", "admin"), input);
  expect(resolved.matched && resolved.principal?.orgRole).toBe("admin");
});
