import { expect, it } from "@effect/vitest";
import { Data, Effect, Layer } from "effect";

import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { emailResolver } from "./admin-users-api";

// Cloud's REVERSE directory lookup: email -> the WorkOS `user_...` id that the
// subject table records in `external_id`.
//
// WHY THIS IS BUILT ON THE MEMBERSHIP LIST. WorkOS's SDK exposes
// `listUsers({ email })`, but the pinned `@executor-js/emulate` WorkOS emulator
// serves no list-users route at all — under `/user_management` it has only
// `users/:id`, `organization_memberships`, the auth/session routes, and
// invitations. A resolver built on `listUsers` would therefore 404 in every
// cloud e2e run. So the lookup reuses the SAME membership read the forward
// identity join already makes, which the emulator does serve, and scans it in
// memory (bounded by org size).
//
// The membership list is also the authority on who belongs to THIS org, so the
// resolver structurally cannot return a user from another tenant — something a
// bare `listUsers({ email })` could do.

const ORG = "org_placeholder";

/** The failure a real WorkOS read raises for one user. Typed rather than a bare
 *  `Error`, so the resolver's skip-and-continue behaviour is exercised against
 *  the shape the client actually fails with. */
class WorkOSUnavailable extends Data.TaggedError("WorkOSUnavailable")<{
  readonly userId: string;
}> {}

/** Members of the org, with the casing WorkOS would have stored. WorkOS
 *  preserves whatever casing a user was created with (and the emulator
 *  compares byte-exact), so the mixed-case entry is the realistic case. */
const DIRECTORY: Record<string, { readonly email: string | null }> = {
  user_ada: { email: "Ada@Placeholder.test" },
  user_grace: { email: "grace@placeholder.test" },
  // A member the directory cannot name: `getUser` succeeds but carries no
  // email. It must never match, and must not break the scan for others.
  user_nameless: { email: null },
};

const stubWorkOS = (calls: string[]) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) => {
        if (prop === "listOrgMembers") {
          return (organizationId: string) => {
            calls.push(`listOrgMembers:${organizationId}`);
            return Effect.succeed({
              data: Object.keys(DIRECTORY).map((userId) => ({ userId, organizationId })),
            });
          };
        }
        if (prop === "getUser") {
          return (userId: string) => {
            calls.push(`getUser:${userId}`);
            const user = DIRECTORY[userId];
            if (!user) return Effect.die(`unexpected user ${userId}`);
            return Effect.succeed(user);
          };
        }
        // A resolver that reaches for any other WorkOS call — notably a
        // `listUsers` the emulator cannot serve — is the failure this catches.
        return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
      },
    }),
  );

const resolve = (email: string, calls: string[]) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<WorkOSClient>();
    return yield* emailResolver(ORG, context)(email);
  }).pipe(Effect.provide(stubWorkOS(calls)));

it.effect("resolves an email to the member's WorkOS user id", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    // The seam hands the resolver an already-normalized address; the STORED
    // value is mixed-case, so this pins that the directory side is normalized
    // too. Without that, `Ada@Placeholder.test` would never match.
    expect(yield* resolve("ada@placeholder.test", calls)).toBe("user_ada");
    expect(calls[0]).toBe(`listOrgMembers:${ORG}`);
  }),
);

it.effect("returns null for an email no member holds", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    expect(yield* resolve("nobody@placeholder.test", calls)).toBeNull();
    // It looked at everyone before saying no, and a member with no email
    // neither matched nor derailed the scan.
    expect(calls).toContain("getUser:user_nameless");
  }),
);

it.effect("stops fetching once it finds the match", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    // `user_ada` is first in the member list, so a short-circuiting scan must
    // never reach the members behind it. This is what keeps the in-memory scan
    // acceptable at the sizes this plane serves.
    expect(yield* resolve("ada@placeholder.test", calls)).toBe("user_ada");
    expect(calls).not.toContain("getUser:user_grace");
    expect(calls).not.toContain("getUser:user_nameless");
  }),
);

it.effect("does not let one unreadable member hide the real match", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const failing = Layer.succeed(
      WorkOSClient,
      new Proxy({} as WorkOSClientService, {
        get: (_target, prop) => {
          if (prop === "listOrgMembers") {
            return () =>
              Effect.succeed({
                data: [{ userId: "user_broken" }, { userId: "user_grace" }],
              });
          }
          if (prop === "getUser") {
            return (userId: string) => {
              calls.push(userId);
              return userId === "user_broken"
                ? Effect.fail(new WorkOSUnavailable({ userId }))
                : Effect.succeed(DIRECTORY[userId]!);
            };
          }
          return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
        },
      }),
    );

    const resolved = yield* Effect.gen(function* () {
      const context = yield* Effect.context<WorkOSClient>();
      return yield* emailResolver(ORG, context)("grace@placeholder.test");
    }).pipe(Effect.provide(failing));

    expect(resolved, "an unreadable member is skipped, not fatal").toBe("user_grace");
    expect(calls).toEqual(["user_broken", "user_grace"]);
  }),
);
