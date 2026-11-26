import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { fumadb } from "fumadb-effect";
import { column, idColumn, schema, table } from "fumadb-effect/schema";
import { sqlAdapter } from "fumadb-effect/sql";
import {
  AppId,
  OwnerId,
  PackageName,
  Publication,
  RegistryError,
  SourceCommit,
  SourceRevision,
  StoredPublication,
  packageLabel,
  packageScope,
  type RegistryStorage as RegistryStorageContract,
} from "@executor-js/sdk/core";

export interface Publishers {
  readonly owner: (scope: string) => Effect.Effect<OwnerId | null, RegistryError>;
  readonly hold: (scope: string) => Effect.Effect<OwnerId | null, RegistryError>;
  readonly scopes: (
    owners: ReadonlyArray<OwnerId>,
  ) => Effect.Effect<ReadonlyMap<OwnerId, string>, RegistryError>;
}

const legacy = schema({
  version: "1.0.0",
  tables: {
    scopes: table("executor_public_scopes", {
      scope: idColumn("scope", Schema.NonEmptyString, { type: "varchar(80)" }),
      owner: column("owner", OwnerId, { type: "varchar(255)" }),
    }),
    publications: table("executor_public_apps", {
      name: idColumn("name", PackageName, { type: "varchar(255)" }),
      owner: column("owner", OwnerId, { type: "varchar(255)" }),
      app: column("app", AppId, { type: "varchar(255)" }),
      publication: column("publication", Schema.Json),
      source: column("source", Schema.Json),
    }),
  },
});
const layout = schema({
  version: "2.0.0",
  tables: {
    listings: table("executor_public_listings", {
      id: idColumn("id", Schema.NonEmptyString, { type: "varchar(255)" }).generated(),
      owner: column("owner", OwnerId, { type: "varchar(255)" }),
      label: column("label", Schema.NonEmptyString, { type: "varchar(63)" }),
      app: column("app", AppId, { type: "varchar(255)" }),
      release: column("release", Schema.Json),
      source: column("source", Schema.Json),
    }).unique("executor_public_listings_owner_label", ["owner", "label"]),
  },
});
const factory = fumadb({ namespace: "executor_public_apps", schemas: [legacy, layout] });

const Release = Schema.Struct({
  commit: SourceCommit,
  description: Schema.String,
  publishedAt: Schema.String,
});
const Listing = Schema.Struct({
  owner: OwnerId,
  label: Schema.NonEmptyString,
  app: AppId,
  release: Release,
  source: SourceRevision,
});
type Listing = typeof Listing.Type;
const LegacyListing = Schema.Struct({
  name: PackageName,
  owner: OwnerId,
  app: AppId,
  publication: Schema.Union([Schema.fromJsonString(Release), Release]),
  source: Schema.Union([Schema.fromJsonString(SourceRevision), SourceRevision]),
});

const named = (listing: Listing, scope: string): StoredPublication => {
  const name = `@${scope}/${listing.label}` as PackageName;
  return {
    name,
    owner: listing.owner,
    app: listing.app,
    source: listing.source,
    publication: Publication.make({ name, ...listing.release }),
  };
};
const byName = (left: Publication, right: Publication) =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

const moveLegacyListings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`lock table executor_public_apps, executor_public_scopes in access exclusive mode`;
  const rows = yield* sql`select name, owner, app, publication, source from executor_public_apps`;
  const listings = yield* Schema.decodeUnknownEffect(Schema.Array(LegacyListing))(rows);
  const keys = listings.map((legacy) => `${legacy.owner}/${packageLabel(legacy.name)}`);
  const collisions = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (collisions.length > 0) {
    yield* Effect.logError("Public listings share an owner and label", { collisions });
    return yield* new RegistryError({ reason: "conflict" });
  }
  for (const legacy of listings) {
    yield* sql`insert into executor_public_listings ${sql.insert({
      id: crypto.randomUUID(),
      owner: legacy.owner,
      label: packageLabel(legacy.name),
      app: legacy.app,
      release: JSON.stringify(legacy.publication),
      source: JSON.stringify(legacy.source),
    })}`;
  }
  yield* sql`drop table executor_public_apps`;
  yield* sql`drop table executor_public_scopes`;
});

export const makeRegistryStorage = (publishers: Publishers) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const client = factory.client(sqlAdapter({ provider: "postgresql" }));
    const db = client.orm(layout.version);
    const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      work.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((error) =>
          Schema.is(RegistryError)(error) ? error : new RegistryError({ reason: "storage" }),
        ),
      );
    const decode = Schema.decodeUnknownEffect(Listing);
    const find = (owner: OwnerId, label: string) =>
      db
        .findFirst("listings", {
          where: (b) => b.and(b("owner", "=", owner), b("label", "=", label)),
        })
        .pipe(Effect.flatMap((row) => (row === null ? Effect.succeed(null) : decode(row))));
    const get = (name: string) =>
      Effect.gen(function* () {
        if (!Schema.is(PackageName)(name)) return yield* new RegistryError({ reason: "not-found" });
        const scope = packageScope(name);
        const owner = yield* publishers.owner(scope);
        const listing = owner === null ? null : yield* find(owner, packageLabel(name));
        if (listing === null) return yield* new RegistryError({ reason: "not-found" });
        return named(listing, scope);
      });
    const publications = (rows: ReadonlyArray<unknown>) =>
      Effect.gen(function* () {
        const listings = yield* Schema.decodeUnknownEffect(Schema.Array(Listing))(rows);
        const scopes = yield* publishers.scopes([
          ...new Set(listings.map((listing) => listing.owner)),
        ]);
        return listings
          .flatMap((listing) => {
            const scope = scopes.get(listing.owner);
            return scope === undefined ? [] : [named(listing, scope).publication];
          })
          .sort(byName);
      });
    return {
      migrate: run(
        Effect.gen(function* () {
          const migrator = yield* client.createMigrator;
          const version = yield* migrator.version;
          if (Option.isSome(version)) {
            if (version.value === layout.version) return;
            if (version.value !== legacy.version)
              return yield* new RegistryError({ reason: "storage" });
          }
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* (yield* migrator.migrateToLatest()).execute;
              if (Option.isSome(version)) yield* moveLegacyListings;
            }),
          );
        }),
      ),
      get: (name: string) => run(get(name)),
      list: (name?: string) =>
        run(
          name === undefined
            ? db.findMany("listings", {}).pipe(Effect.flatMap(publications))
            : get(name).pipe(
                Effect.map((row) => [row.publication]),
                Effect.catchTag("RegistryError", (error) =>
                  error.reason === "not-found" ? Effect.succeed([]) : Effect.fail(error),
                ),
              ),
        ),
      owned: (owner: OwnerId) =>
        run(
          db
            .findMany("listings", { where: (b) => b("owner", "=", owner) })
            .pipe(Effect.flatMap(publications)),
        ),
      publish: (input: StoredPublication) =>
        run(
          sql.withTransaction(
            Effect.gen(function* () {
              const label = packageLabel(input.name);
              if ((yield* publishers.hold(packageScope(input.name))) !== input.owner)
                return yield* new RegistryError({ reason: "forbidden" });
              yield* sql`select pg_advisory_xact_lock(hashtextextended(${`${input.owner}/${label}`},0))`;
              const previous = yield* find(input.owner, label);
              const release = {
                commit: input.publication.commit,
                description: input.publication.description,
                publishedAt: input.publication.publishedAt,
              };
              if (previous !== null) {
                if (previous.app !== input.app)
                  return yield* new RegistryError({ reason: "conflict" });
                if (previous.release.commit === release.commit)
                  return named(previous, packageScope(input.name)).publication;
                yield* db.updateMany("listings", {
                  where: (b) => b.and(b("owner", "=", input.owner), b("label", "=", label)),
                  set: { release, source: input.source },
                });
              } else
                yield* db.create("listings", {
                  owner: input.owner,
                  label,
                  app: input.app,
                  release,
                  source: input.source,
                });
              return input.publication;
            }),
          ),
        ),
      unpublish: (owner: OwnerId, name: string) =>
        run(
          sql.withTransaction(
            Effect.gen(function* () {
              const current = yield* get(name);
              if (current.owner !== owner) return yield* new RegistryError({ reason: "forbidden" });
              yield* db.deleteMany("listings", {
                where: (b) => b.and(b("owner", "=", owner), b("label", "=", packageLabel(name))),
              });
            }),
          ),
        ),
    };
  });
export type RegistryStorage = Effect.Success<ReturnType<typeof makeRegistryStorage>> &
  RegistryStorageContract;
