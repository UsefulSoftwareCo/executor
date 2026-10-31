/** Reuse creates exact provider bindings only after one grant covers every saved target. */
import { type Crypto, Effect } from "effect";
import { Base64 } from "effect/encoding";
import { StorageError } from "../contracts/shared.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import {
  AccountConnectionRefused,
  type ReuseConnectionOAuth,
} from "../contracts/account-connection.ts";
import type { OAuthOptions } from "../contracts/oauth.ts";
import type { Credentials } from "../contracts/storage.ts";
import { accountGrantId } from "./account-identities.ts";
import { ownedAccount, defaultLabel } from "./accounts.ts";
import {
  lockConnection,
  readConnection,
  requireOpen,
  finishConnection,
} from "./connection-state.ts";
import { requireTargetProvider } from "./connection-target.ts";
import { query, transaction, type Query } from "./database.ts";
import { inspectOAuthConnection } from "./oauth-connection-plan.ts";
import { shareOAuthGrant, createSharedOAuthBinding } from "./oauth-grant-bindings.ts";

export const makeOAuthGrantReuse =
  (
    db: Query,
    credentials: Credentials,
    crypto: Crypto.Crypto,
    options: OAuthOptions | undefined,
    lifecycle: ResourceLifecycle | undefined,
  ) =>
  (input: typeof ReuseConnectionOAuth.Type) =>
    Effect.gen(function* () {
      const request = yield* readConnection(db, input);
      if (request.state.status === "completed")
        return { status: "completed" as const, account: request.state.account };
      const inspected = yield* inspectOAuthConnection(db, credentials, options, lifecycle, {
        ...input,
        sourceAccount: input.account,
      });
      const { plan, entries, source } = inspected;
      const consent = (
        reason: "identity" | "placement" | "client" | "resource" | "scopes" | "busy",
      ) => ({ status: "consent-required" as const, reason });
      if (plan.status !== "reuse" || source?.status !== "ready")
        return consent("reason" in plan ? plan.reason : "scopes");
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          // Every batch takes connection locks in the same order, including overlapping batches.
          for (const entry of [...entries].sort((a, b) => a.row.id.localeCompare(b.row.id))) {
            const locked = yield* lockConnection(
              tx,
              { connection: entry.row.id, owner: request.owner },
              crypto,
            );
            if (entry.row.id === input.connection && locked.state.status === "completed")
              return { status: "completed" as const, account: locked.state.account };
            yield* requireOpen({ connection: entry.row.id }, locked);
          }
          const live = yield* ownedAccount(tx, {
            account: source.account.id,
            owner: request.owner,
          });
          yield* query(() =>
            tx.updateMany("accounts", {
              where: (b) => b.and(b("id", "=", live.id), b("owner", "=", request.owner)),
              set: { owner: live.owner },
            }),
          );
          const current = yield* ownedAccount(tx, { account: live.id, owner: request.owner });
          if (
            accountGrantId(current) !== source.grantId ||
            current.credentialGeneration !== source.account.credentialGeneration ||
            current.identityId !== source.account.identityId
          )
            return consent("busy");
          if (
            lifecycle !== undefined &&
            !(yield* lifecycle.accountsResolving([current])).has(current.id)
          )
            return yield* new AccountConnectionRefused(request.target);
          yield* query(() =>
            tx.updateMany("oauthGrants", {
              where: (b) =>
                b.and(
                  b("id", "=", source.grantId),
                  b("status", "=", source.record.status),
                  b("encrypted", "=", source.record.encrypted),
                ),
              set: { status: source.record.status },
            }),
          );
          const locked = yield* query(() =>
            tx.findFirst("oauthGrants", { where: (b) => b("id", "=", source.grantId) }),
          );
          if (
            locked === null ||
            locked.status !== source.record.status ||
            Base64.encode(locked.encrypted) !== Base64.encode(source.record.encrypted)
          )
            return consent("busy");
          const grant = yield* shareOAuthGrant(
            tx,
            credentials,
            crypto,
            current,
            locked,
            source.grant,
          );
          const accounts = [];
          for (const entry of entries) {
            const row = yield* requireOpen(
              { connection: entry.row.id },
              yield* readConnection(tx, { connection: entry.row.id, owner: request.owner }),
            );
            const target = yield* requireTargetProvider(tx, row);
            const method = target.definition.auth[entry.methodName];
            if (
              method?.type !== "oauth2" ||
              method.grant === "client_credentials" ||
              method.identity?.issuer !== entry.method.identity?.issuer
            )
              return yield* new AccountConnectionRefused(row.target);
            const placement =
              lifecycle === undefined
                ? row.owner
                : yield* lifecycle.connectionIdentityPlacement?.(row) ?? Effect.succeed(null);
            if (placement !== source.proof.placement)
              return yield* new AccountConnectionRefused(row.target);
            const account = yield* createSharedOAuthBinding(
              tx,
              credentials,
              crypto,
              lifecycle,
              current,
              source.identity,
              source.proof.placement,
              {
                provider: row.provider,
                method: entry.methodName,
                label: input.label ?? (yield* defaultLabel(tx, row.owner, row.provider)),
                grant,
              },
            );
            if (account === undefined) return yield* new AccountConnectionRefused(row.target);
            if (lifecycle !== undefined)
              yield* lifecycle.connectionCompleting({
                id: row.id,
                owner: row.owner,
                reconnectAccount: row.reconnectAccount,
                target: row.target,
              });
            yield* finishConnection(tx, row, account, lifecycle);
            accounts.push(account);
          }
          const account = accounts[0];
          if (account === undefined) return yield* new StorageError();
          return { status: "completed" as const, account };
        }),
      );
    }).pipe(Effect.withSpan("sdk.connections.reuseOAuth"));
