import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AccountUnauthorized } from "@executor-js/api";
import { AccountProvider } from "@executor-js/api/server";

import type { CloudflareConfig } from "../config";
import { cloudflareAccountProvider } from "./account-provider";

const config = (overrides: Partial<CloudflareConfig> = {}): CloudflareConfig => ({
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
  enableDevAuth: true,
  ...overrides,
});

describe("cloudflareAccountProvider.listMembers", () => {
  it.effect("reports the Access principal so the console can see ADMIN_EMAILS", () =>
    Effect.gen(function* () {
      const provider = yield* AccountProvider;
      const { members } = yield* provider.listMembers({});
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
    }).pipe(Effect.provide(cloudflareAccountProvider(config()))),
  );

  it.effect("refuses when Access did not authenticate the request", () =>
    Effect.gen(function* () {
      const provider = yield* AccountProvider;
      const error = yield* provider.listMembers({}).pipe(Effect.flip);
      expect(error).toBeInstanceOf(AccountUnauthorized);
    }).pipe(Effect.provide(cloudflareAccountProvider(config({ enableDevAuth: false })))),
  );
});
