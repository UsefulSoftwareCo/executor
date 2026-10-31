/** Shared grants keep their encryption identity and renewal lock after individual bindings disappear. */
import { Effect } from "effect";
import type { StoredAccount } from "../contracts/storage.ts";
import type { AccountId } from "../contracts/shared.ts";
import { accountGrantId } from "./account-identities.ts";
import { query, type Query } from "./database.ts";

export const grantBindings = (db: Query, grant: AccountId) =>
  query(() =>
    db.findMany("accounts", {
      where: (b) =>
        b.or(
          b("oauthGrantId", "=", grant),
          b.and(b("id", "=", grant), b("oauthGrantId", "is", null)),
        ),
    }),
  );

/** Call after the binding was deleted or detached, inside the same transaction. */
export const releaseAccountGrant = (
  db: Query,
  account: Pick<StoredAccount, "id" | "oauthGrantId" | "provider">,
) =>
  Effect.gen(function* () {
    const id = accountGrantId(account);
    // Serializing shared releases makes the last concurrent removal responsible for cleanup.
    if (account.oauthGrantId !== null) {
      const saved = yield* query(() =>
        db.findFirst("oauthGrants", { where: (b) => b("id", "=", id) }),
      );
      if (saved === null) return undefined;
      yield* query(() =>
        db.updateMany("oauthGrants", {
          where: (b) => b("id", "=", id),
          set: { owner: saved.owner },
        }),
      );
    }
    const held = yield* grantBindings(db, id);
    if (held.length !== 0) return undefined;
    const grant = yield* query(() =>
      db.findFirst("oauthGrants", { where: (b) => b("id", "=", id) }),
    );
    yield* query(() => db.deleteMany("oauthGrants", { where: (b) => b("id", "=", id) }));
    return grant === null
      ? undefined
      : { account: id, provider: account.provider, encrypted: grant.encrypted };
  });
