import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";
import { Data, Effect, Layer } from "effect";

import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { emailResolver } from "./admin-users-api";

// Cloud's REVERSE directory lookup: email -> the WorkOS `user_...` id that the
// subject table records in `external_id`. Production resolves it with one
// tenant-scoped list-users query. The WorkOS emulator lacks that route, so
// tests/dev retain the membership-backed scan exercised below.

const ORG = "org_placeholder";
const OTHER_ORG = "org_other";

class WorkOSUnavailable extends Data.TaggedError("WorkOSUnavailable")<{
  readonly userId: string;
}> {}

const DIRECTORY = [
  // Same email in another tenant must never win either lookup path.
  { id: "user_foreign", email: "ada@placeholder.test", organizationId: OTHER_ORG },
  // WorkOS preserves submitted casing, while the resolver seam is normalized.
  { id: "user_ada", email: "Ada@Placeholder.test", organizationId: ORG },
  { id: "user_grace", email: "grace@placeholder.test", organizationId: ORG },
  { id: "user_nameless", email: null, organizationId: ORG },
] as const;

const stubWorkOS = (calls: string[], unreadableUserIds: ReadonlySet<string>) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) => {
        if (prop === "listUsers") {
          return (params: { email: string; organizationId: string }) => {
            calls.push(`listUsers:${params.organizationId}:${params.email}`);
            return Effect.succeed({
              data: DIRECTORY.filter(
                (user) =>
                  user.organizationId === params.organizationId &&
                  user.email?.toLowerCase() === params.email,
              ),
            });
          };
        }
        if (prop === "listOrgMembers") {
          return (organizationId: string) => {
            calls.push(`listOrgMembers:${organizationId}`);
            return Effect.succeed({
              data: DIRECTORY.filter((user) => user.organizationId === organizationId).map(
                (user) => ({ userId: user.id, organizationId }),
              ),
            });
          };
        }
        if (prop === "getUser") {
          return (userId: string) => {
            calls.push(`getUser:${userId}`);
            if (unreadableUserIds.has(userId)) {
              return Effect.fail(new WorkOSUnavailable({ userId }));
            }
            const user = DIRECTORY.find((candidate) => candidate.id === userId);
            if (!user) return Effect.die(`unexpected user ${userId}`);
            return Effect.succeed(user);
          };
        }
        return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
      },
    }),
  );

const resolve = (
  email: string,
  calls: string[],
  emulator = false,
  unreadableUserIds: ReadonlySet<string> = new Set(),
) => {
  const previousApiUrl = env.WORKOS_API_URL;
  return Effect.gen(function* () {
    yield* Effect.sync(() =>
      Object.assign(env, {
        WORKOS_API_URL: emulator ? "http://workos-emulator.invalid" : undefined,
      }),
    );
    const context = yield* Effect.context<WorkOSClient>();
    return yield* emailResolver(ORG, context)(email);
  }).pipe(
    Effect.provide(stubWorkOS(calls, unreadableUserIds)),
    Effect.ensuring(Effect.sync(() => Object.assign(env, { WORKOS_API_URL: previousApiUrl }))),
  );
};

it.effect("resolves an email with one tenant-scoped WorkOS query", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    expect(yield* resolve("ada@placeholder.test", calls)).toBe("user_ada");
    expect(calls).toEqual([`listUsers:${ORG}:ada@placeholder.test`]);
  }),
);

it.effect("returns null from one query when the organization has no matching email", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    expect(yield* resolve("nobody@placeholder.test", calls)).toBeNull();
    expect(calls).toEqual([`listUsers:${ORG}:nobody@placeholder.test`]);
  }),
);

it.effect("keeps the emulator fallback tenant-scoped and case-insensitive", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    expect(yield* resolve("ada@placeholder.test", calls, true)).toBe("user_ada");
    expect(calls).toEqual([`listOrgMembers:${ORG}`, "getUser:user_ada"]);
    expect(calls).not.toContain("getUser:user_foreign");
    expect(calls.some((call) => call.startsWith("listUsers:"))).toBe(false);
  }),
);

it.effect("lets the emulator fallback continue past one unreadable member", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    expect(yield* resolve("grace@placeholder.test", calls, true, new Set(["user_ada"]))).toBe(
      "user_grace",
    );
    expect(calls).toEqual([`listOrgMembers:${ORG}`, "getUser:user_ada", "getUser:user_grace"]);
  }),
);
