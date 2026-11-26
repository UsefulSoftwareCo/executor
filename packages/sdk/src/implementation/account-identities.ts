import { Effect, Schema } from "effect";
import { Hex } from "effect/encoding";
import { Digest } from "effect/crypto";
import {
  AccountIdentity,
  AccountIdentityId,
  StoredAccountIdentity,
} from "../contracts/account-identity.ts";
import type { Account } from "../contracts/account.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import { StorageError } from "../contracts/shared.ts";
import type { StoredAccount } from "../contracts/storage.ts";
import { query, transaction, type Query } from "./database.ts";
import type { HostCrypto } from "./host-crypto.ts";

export interface VerifiedAccountSubject {
  readonly issuer: string;
  readonly subject: string;
  readonly name: string;
  readonly label: string;
}

export const accountGrantId = (account: Pick<StoredAccount, "id" | "oauthGrantId">) =>
  account.oauthGrantId ?? account.id;

export const identityPlacement = (
  account: Pick<Account, "id" | "owner">,
  lifecycle: ResourceLifecycle | undefined,
) =>
  lifecycle === undefined
    ? Effect.succeed<string | null>(account.owner)
    : (lifecycle.accountIdentityPlacement?.(account) ?? Effect.succeed<string | null>(null));

export const accountIdentity = (
  db: Query,
  account: Pick<StoredAccount, "id" | "owner" | "identityId">,
  lifecycle: ResourceLifecycle | undefined,
) =>
  Effect.gen(function* () {
    if (account.identityId === null) return undefined;
    const placement = yield* identityPlacement(account, lifecycle);
    if (placement === null) return undefined;
    const row = yield* query(() =>
      db.findFirst("accountIdentities", {
        where: (b) =>
          b.and(
            b("id", "=", account.identityId),
            b("owner", "=", account.owner),
            b("placement", "=", placement),
          ),
      }),
    );
    if (row === null) return undefined;
    return yield* Schema.decodeUnknownEffect(AccountIdentity)(row).pipe(
      Effect.mapError(() => new StorageError()),
    );
  });

export const recordAccountIdentity = (
  db: Query,
  crypto: HostCrypto,
  lifecycle: ResourceLifecycle | undefined,
  account: Pick<StoredAccount, "id" | "owner" | "credentialGeneration">,
  verified: VerifiedAccountSubject,
  now: Date,
) =>
  transaction(db, (tx) =>
    Effect.gen(function* () {
      const placement = yield* identityPlacement(account, lifecycle);
      if (placement === null) return undefined;
      const key = JSON.stringify([account.owner, placement, verified.issuer, verified.subject]);
      const digest = yield* crypto.digest
        .digest(Digest.sha256, new TextEncoder().encode(key))
        .pipe(Effect.mapError(() => new StorageError()));
      const id = AccountIdentityId.make(`aid_${Hex.encode(digest)}`);
      const identity = yield* Schema.decodeUnknownEffect(StoredAccountIdentity)({
        id,
        owner: account.owner,
        placement,
        ...verified,
        verifiedAt: now,
        createdAt: now,
      }).pipe(Effect.mapError(() => new StorageError()));
      yield* query(() =>
        tx.upsert("accountIdentities", {
          where: (b) => b("id", "=", id),
          create: identity,
          update: { name: identity.name, label: identity.label, verifiedAt: now },
        }),
      );
      yield* query(() =>
        tx.updateMany("accounts", {
          where: (b) =>
            b.and(
              b("id", "=", account.id),
              b("owner", "=", account.owner),
              b("credentialGeneration", "=", account.credentialGeneration),
            ),
          set: { identityId: id },
        }),
      );
      return id;
    }),
  );
