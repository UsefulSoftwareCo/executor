import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { AccountProvider } from "@executor-js/api/server";
import {
  canCreateWorkspaceConnectionsForHost,
  isTenantAdminMember,
  type TenantMemberRow,
} from "@executor-js/react/lib/admin-access";

import type { CloudflareConfig } from "../config";
import { cloudflareAccountProvider } from "./account-provider";

// Regression for #1958: an empty member list hid admin-only workspace actions.

const baseConfig: CloudflareConfig = {
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
};

const adminConfig: CloudflareConfig = { ...baseConfig, enableDevAuth: true };

const listMembers = (config: CloudflareConfig, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const provider = yield* AccountProvider;
    return yield* provider.listMembers(headers);
  }).pipe(Effect.provide(cloudflareAccountProvider(config)));

describe("cloudflareAccountProvider.listMembers", () => {
  it.effect("reports the current admin principal as an active admin member", () =>
    Effect.gen(function* () {
      const { members } = yield* listMembers(adminConfig);

      expect(members).toHaveLength(1);
      const [member] = members;
      expect(member.isCurrentUser).toBe(true);
      expect(member.status).toBe("active");
      expect(member.role).toBe("admin");
    }),
  );

  it.effect("surfaces the Workspace connection owner option via the real UI admin gate", () =>
    Effect.gen(function* () {
      const { members } = yield* listMembers(adminConfig);

      const rows = members as readonly TenantMemberRow[];
      const isAdmin = isTenantAdminMember(rows);
      expect(isAdmin).toBe(true);

      expect(canCreateWorkspaceConnectionsForHost(baseConfig.organizationId, isAdmin)).toBe(true);
    }),
  );

  it.effect("returns no members when the request carries no Access identity", () =>
    Effect.gen(function* () {
      const { members } = yield* listMembers(baseConfig);
      expect(members).toHaveLength(0);
      expect(isTenantAdminMember(members as readonly TenantMemberRow[])).toBe(false);
    }),
  );
});
