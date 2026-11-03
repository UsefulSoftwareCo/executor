/**
 * Record the identity of providers stored before SDK storage 4.0.17, so a deploy finds them by it.
 * Deploys record it on the rows they write and on stored rows of the providers they declare; data
 * step `11_provider_identities` records the rest.
 */
import { type Crypto, Effect, Option, Schema } from "effect";
import { ProviderDefinition, type ProviderIdentities } from "../contracts/provider.ts";
import { type ProviderId, StorageError } from "../contracts/shared.ts";
import { query, type Query } from "./database.ts";
import { identifyProvider } from "./provider.ts";

/** A stored definition's name and identity; none when it no longer decodes. */
const storedIdentity = (definition: unknown, crypto: Crypto.Crypto) =>
  Effect.gen(function* () {
    const decoded = Schema.decodeUnknownOption(ProviderDefinition)(definition);
    if (Option.isNone(decoded)) return Option.none<{ name: string; identity: ProviderId }>();
    const { identity } = yield* identifyProvider(decoded.value, crypto);
    return Option.some({ name: decoded.value.name, identity });
  });

/** Record a row's identity unless one was recorded meanwhile; every recorder computes the same. */
const recordIdentity = (db: Query, id: ProviderId, identity: ProviderId) =>
  query(() =>
    db.updateMany("providers", {
      where: (b) => b.and(b("id", "=", id), b("identity", "is", null)),
      set: { identity },
    }),
  );

/**
 * Record the identity of stored providers that have none and are named one of `names`: rows a
 * server before storage 4.0.17 wrote, before the data step runs or after a rollback to such a
 * server. A deploy records them before it chooses IDs. Storage reads only rows whose definition
 * has one of these names as a top-level value. A row that fails to decode, hash or write is
 * skipped and stays for the step; it never fails the deploy.
 */
export const recordStoredIdentities = (
  db: Query,
  crypto: Crypto.Crypto,
  names: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    if (names.size === 0) return;
    const rows = yield* query(() =>
      db.findMany("providers", {
        select: ["id", "definition"],
        where: (b) =>
          b.and(
            b("identity", "is", null),
            b.or(...[...names].map((name) => b("definition", "json contains", name))),
          ),
      }),
    );
    yield* Effect.forEach(
      rows,
      (row) =>
        storedIdentity(row.definition, crypto).pipe(
          Effect.flatMap((stored) =>
            Option.isSome(stored) && names.has(stored.value.name)
              ? recordIdentity(db, row.id, stored.value.identity)
              : Effect.void,
          ),
          Effect.catchTag("StorageError", () => Effect.void),
        ),
      { concurrency: 8, discard: true },
    );
  });

export const makeProviderIdentities = (db: Query, crypto: Crypto.Crypto): ProviderIdentities => ({
  items: query(() =>
    db.findMany("providers", {
      select: ["id"],
      where: (b) => b("identity", "is", null),
      orderBy: ["id", "asc"],
    }),
  ).pipe(
    Effect.map((rows) =>
      rows.map(({ id }) => ({
        id,
        record: (apply: boolean) =>
          Effect.gen(function* () {
            const row = yield* query(() =>
              db.findFirst("providers", { where: (b) => b("id", "=", id) }),
            );
            if (row === null) return "absent" as const;
            if (row.identity !== null) return "already_recorded" as const;
            const stored = yield* storedIdentity(row.definition, crypto);
            if (Option.isNone(stored)) return "unreadable" as const;
            if (!apply) return "would_record" as const;
            yield* recordIdentity(db, id, stored.value.identity);
            return "recorded" as const;
          }).pipe(Effect.catchTag("StorageError", () => Effect.succeed("unavailable" as const))),
      })),
    ),
    Effect.mapError(() => new StorageError()),
  ),
});
