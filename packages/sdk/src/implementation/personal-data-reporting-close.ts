/** Erase a closed registration's subject copies in one transaction, then revoke their grants. */
import { Effect, Option, Schema } from "effect";
import { OwnerId, StorageError, type AccountId } from "../contracts/shared.ts";
import { StoredAccount, StoredConnectionState } from "../contracts/storage.ts";
import type { makeOAuth } from "./oauth.ts";
import { query, transaction, type Query } from "./database.ts";
import type { ReportRow } from "./personal-data-reporting-state.ts";

const closedMessage =
  "The service closed this account. Stored credentials and identity were removed.";

export const makeCloseReportedSubject = (input: {
  readonly db: Query;
  readonly oauth: Pick<ReturnType<typeof makeOAuth>, "revokeRemoved">;
}) => {
  const closeSubject = (clientFingerprint: string, fingerprint: string, lease: string, now: Date) =>
    Effect.gen(function* () {
      const rows = (yield* query(() =>
        input.db.findMany("accountReports", {
          where: (b) =>
            b.and(
              b("clientFingerprint", "=", clientFingerprint),
              b("externalIdFingerprint", "=", fingerprint),
              b("lease", "=", lease),
            ),
        }),
      )) as ReportRow[];
      const removed: { account: AccountId; provider: string; encrypted: Uint8Array }[] = [];
      yield* transaction(input.db, (tx) =>
        Effect.gen(function* () {
          for (const row of rows) {
            const accountRow = yield* query(() =>
              tx.findFirst("accounts", {
                where: (b) => b.and(b("id", "=", row.id), b("owner", "=", OwnerId.make(row.owner))),
              }),
            );
            if (accountRow === null) continue;
            const account = yield* Schema.decodeUnknownEffect(StoredAccount)(accountRow).pipe(
              Effect.mapError(() => new StorageError()),
            );
            const grant = yield* query(() =>
              tx.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
            );
            const generation = account.credentialGeneration + 1;
            const connections = yield* query(() =>
              tx.findMany("accountConnections", {
                select: ["id", "state"],
                where: (b) => b("reconnectAccount", "=", account.id),
              }),
            );
            const pendingConnections = connections.flatMap((connection) => {
              const state = Schema.decodeUnknownOption(StoredConnectionState)(connection.state);
              return Option.isSome(state) && state.value.status === "pending"
                ? [connection.id]
                : [];
            });
            if (pendingConnections.length > 0)
              yield* query(() =>
                tx.updateMany("accountConnections", {
                  where: (b) => b("id", "in", pendingConnections),
                  set: { state: { status: "cancelled" }, oauthAttempt: null },
                }),
              );
            yield* query(() =>
              tx.updateMany("accounts", {
                where: (b) => b("id", "=", account.id),
                set: {
                  label: "Closed account",
                  description: null,
                  encryptedCredentials: new Uint8Array(),
                  credentialGeneration: generation,
                },
              }),
            );
            yield* query(() =>
              tx.deleteMany("oauthGrants", { where: (b) => b("id", "=", account.id) }),
            );
            yield* query(() =>
              tx.updateMany("accountChecks", {
                where: (b) => b("account", "=", account.id),
                set: {
                  credentialGeneration: generation,
                  status: "credentials_rejected",
                  checkedAt: now,
                  info: null,
                  infoCheckedAt: null,
                  message: closedMessage,
                },
              }),
            );
            yield* query(() =>
              tx.updateMany("accountReports", {
                where: (b) =>
                  b.and(b("id", "=", account.id), b("clientFingerprint", "=", clientFingerprint)),
                set: {
                  credentialGeneration: generation,
                  status: "closed",
                  encryptedExternalId: null,
                  externalIdFingerprint: null,
                  retrievedAt: null,
                  reportedAt: now,
                  nextReportAt: null,
                  retryAt: null,
                  retries: 0,
                  lease: null,
                  leaseUntil: null,
                },
              }),
            );
            if (grant !== null)
              removed.push({
                account: account.id,
                provider: account.provider,
                encrypted: grant.encrypted,
              });
          }
          yield* query(() =>
            tx.updateMany("accountReports", {
              where: (b) =>
                b.and(
                  b("clientFingerprint", "=", clientFingerprint),
                  b("externalIdFingerprint", "=", fingerprint),
                ),
              set: {
                status: "closed",
                encryptedExternalId: null,
                externalIdFingerprint: null,
                retrievedAt: null,
                reportedAt: now,
                nextReportAt: null,
                retryAt: null,
                retries: 0,
                lease: null,
                leaseUntil: null,
              },
            }),
          );
        }),
      );
      yield* Effect.forEach(removed, input.oauth.revokeRemoved, { concurrency: 1, discard: true });
    });

  return closeSubject;
};
