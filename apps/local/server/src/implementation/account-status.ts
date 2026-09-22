/** Project saved sign-in state without refreshing tokens or contacting a provider. */
import {
  OAuthGrant,
  type Account,
  type Credentials,
  type ExecutorDatabase,
  type ProviderDefinition,
} from "@executor-js/sdk";
import { Clock, Effect, Redacted, Schema } from "effect";
import type { AccountSignIn } from "../contracts/dashboard.ts";

/** Only status and a non-refreshable expiry leave the trusted host. */
export const accountSignIn =
  (storage: ExecutorDatabase, credentials: Credentials) =>
  (account: Account, provider: ProviderDefinition): Effect.Effect<AccountSignIn> =>
    Effect.gen(function* () {
      const method = provider.auth[account.method];
      if (method === undefined) return { state: "unavailable" } as const;
      if (method.type === "secrets") return { state: "saved", reconnectAt: null } as const;
      const row = yield* storage
        .orm("1.12.0")
        .findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) });
      if (row === null || row.status === "reconnect") return { state: "reconnect" } as const;
      const now = yield* Clock.currentTimeMillis;
      if (!row.status.startsWith("ready_") && now - row.updatedAt.getTime() > 60_000)
        return { state: "reconnect" } as const;
      const encrypted = yield* credentials.decrypt(account.id, Redacted.make(row.encrypted));
      const grant = yield* Schema.decodeUnknownEffect(OAuthGrant)(Redacted.value(encrypted));
      const reconnectAt =
        grant.grant !== "client_credentials" &&
        grant.refreshToken === undefined &&
        grant.expiresAt !== undefined
          ? new Date(grant.expiresAt)
          : null;
      return reconnectAt !== null && reconnectAt.getTime() <= now
        ? ({ state: "reconnect" } as const)
        : ({ state: "saved", reconnectAt } as const);
    }).pipe(Effect.catch(() => Effect.succeed({ state: "unavailable" } as const)));
