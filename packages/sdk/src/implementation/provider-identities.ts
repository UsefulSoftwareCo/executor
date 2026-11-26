import { Effect, Option, Schema } from "effect";
import { ProviderDefinition, type ProviderIdentities } from "../contracts/provider.ts";
import { type ProviderId, StorageError } from "../contracts/shared.ts";
import { query, type Query } from "./database.ts";
import { identifyProvider } from "./provider.ts";
import type { HostCrypto } from "./host-crypto.ts";

const storedIdentity = (definition: unknown, crypto: HostCrypto) =>
  Effect.gen(function* () {
    const decoded = Schema.decodeUnknownOption(ProviderDefinition)(definition);
    if (Option.isNone(decoded)) return Option.none<{ name: string; identity: ProviderId }>();
    const { identity } = yield* identifyProvider(decoded.value, crypto);
    return Option.some({ name: decoded.value.name, identity });
  });

const recordIdentity = (db: Query, id: ProviderId, identity: ProviderId) =>
  query(() =>
    db.updateMany("providers", {
      where: (b) => b.and(b("id", "=", id), b("identity", "is", null)),
      set: { identity },
    }),
  );

export const recordStoredIdentities = (db: Query, crypto: HostCrypto, names: ReadonlySet<string>) =>
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

export const makeProviderIdentities = (db: Query, crypto: HostCrypto): ProviderIdentities => ({
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
