import type { AuthContext } from "@better-auth/core";
import { Effect } from "effect";
import { AuthenticationUnavailable, type Viewer } from "../contracts/auth.ts";

type Adapter = Pick<AuthContext["adapter"], "delete" | "deleteMany">;

const call = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => new AuthenticationUnavailable() });

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
