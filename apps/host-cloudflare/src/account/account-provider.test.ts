import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { AccountUnauthorized } from "@executor-js/api";
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

      expect(members).toEqual([
        {
          id: "dev",
          userId: "dev",
          email: "admin@example.com",
          name: "Dev",
          avatarUrl: null,
          role: "admin",
          status: "active",
          lastActiveAt: null,
          isCurrentUser: true,
        },
      ]);
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

  it.effect("refuses when the request carries no Access identity", () =>
    Effect.gen(function* () {
      const error = yield* listMembers(baseConfig).pipe(Effect.flip);
      expect(error).toBeInstanceOf(AccountUnauthorized);
    }),
  );
});
