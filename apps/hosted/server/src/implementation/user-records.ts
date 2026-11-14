import type { AuthContext } from "@better-auth/core";
/** Better Auth records a user owns, removed together once their product data is gone. */
import { Effect } from "effect";
import { AuthenticationUnavailable, type Viewer } from "../contracts/auth.ts";

type Adapter = Pick<AuthContext["adapter"], "delete" | "deleteMany">;

const call = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => new AuthenticationUnavailable() });

/**
 * Better Auth's own delete route stays disabled: it cannot remove the product records the user
 * owns, and it leaves API keys behind, because `apikey.referenceId` has no foreign key.
 *
 * There is no transaction across these statements, so the order decides what a mid-flight
 * failure leaves behind. Bearer credentials go first: API keys, then OAuth tokens and the MCP
 * grants and connections they belong to. A failure there leaves the user able to sign in and
 * retry. The user row goes next, in one statement; Better Auth's foreign keys cascade it to
 * sessions, sign-in methods, passkeys, memberships and the invitations they sent. The rows every
 * host has are then swept by user id, so a missing cascade cannot leave a session or a membership
 * for a user who no longer exists; passkeys exist only where a host adds the plugin, and rely on
 * its cascade. Every statement is a no-op on a repeat.
 */
export const deleteUserRecords = (adapter: Adapter, user: Viewer["userId"]) =>
  Effect.gen(function* () {
    yield* call(() =>
      adapter.deleteMany({ model: "apikey", where: [{ field: "referenceId", value: user }] }),
    );
    for (const model of [
      "oauthAccessToken",
      "oauthRefreshToken",
      "oauthConsent",
      "mcpGrant",
      "mcpConnection",
    ] as const)
      yield* call(() => adapter.deleteMany({ model, where: [{ field: "userId", value: user }] }));
    yield* call(() => adapter.delete({ model: "user", where: [{ field: "id", value: user }] }));
    for (const model of ["session", "account", "member"] as const)
      yield* call(() => adapter.deleteMany({ model, where: [{ field: "userId", value: user }] }));
    yield* call(() =>
      adapter.deleteMany({ model: "invitation", where: [{ field: "inviterId", value: user }] }),
    );
  });
