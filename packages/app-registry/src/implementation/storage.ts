/** Catalog rows point to retained Git source. Installed copies do not depend on these rows. */
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { fumadb } from "fumadb-effect";
import { column, idColumn, schema, table } from "fumadb-effect/schema";
import { sqlAdapter } from "fumadb-effect/sql";
import { AppId, OwnerId, SourceRevision } from "@executor-js/sdk/core";
import { PackageName, Publication, RegistryError } from "../contracts/registry.ts";

const StoredPublication = Schema.Struct({
  name: PackageName,
  owner: OwnerId,
  app: AppId,
  publication: Publication,
  source: SourceRevision,
});
const layout = schema({
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
const factory = fumadb({ namespace: "executor_public_apps", schemas: [layout] });
/** Capture SQL and initialize the current catalog layout on a fresh host. */
export const makeRegistryStorage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const client = factory.client(sqlAdapter({ provider: "postgresql" }));
  const db = client.orm("1.0.0");
  const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    work.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError((error) =>
        Schema.is(RegistryError)(error) ? error : new RegistryError({ reason: "storage" }),
      ),
    );
  const scopeOwner = (scope: string) =>
    db
      .findFirst("scopes", { where: (b) => b("scope", "=", scope) })
      .pipe(Effect.map((row) => row?.owner ?? null));
  const get = (name: string) =>
    db
      .findFirst("publications", { where: (b) => b("name", "=", name) })
      .pipe(
        Effect.flatMap((row) =>
          row === null
            ? Effect.fail(new RegistryError({ reason: "not-found" }))
            : Schema.decodeUnknownEffect(StoredPublication)(row).pipe(
                Effect.mapError(() => new RegistryError({ reason: "storage" })),
              ),
        ),
      );
  return {
    migrate: run(
      Effect.gen(function* () {
        const migrator = yield* client.createMigrator;
        const version = yield* migrator.version;
        if (Option.isSome(version)) {
          if (version.value !== layout.version)
            return yield* new RegistryError({ reason: "storage" });
          return;
        }
        yield* (yield* migrator.migrateToLatest()).execute;
      }),
    ),
    scopeOwner: (scope: string) => run(scopeOwner(scope)),
    get: (name: string) => run(get(name)),
    list: (name?: string) =>
      run(
        db
          .findMany("publications", {
            where: (b) => (name === undefined ? true : b("name", "=", name)),
            orderBy: ["name", "asc"],
          })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredPublication))),
            Effect.map((rows) => rows.map((row) => row.publication)),
          ),
      ),
    owned: (owner: OwnerId) =>
      run(
        db
          .findMany("publications", {
            where: (b) => b("owner", "=", owner),
            orderBy: ["name", "asc"],
          })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredPublication))),
            Effect.map((rows) => rows.map((row) => row.publication)),
          ),
      ),
    publish: (input: typeof StoredPublication.Type) =>
      run(
        sql.withTransaction(
          Effect.gen(function* () {
            const scope = input.name.slice(1, input.name.indexOf("/"));
            yield* sql`select pg_advisory_xact_lock(hashtextextended(${scope},0))`;
            const owner = yield* scopeOwner(scope);
            if (owner !== null && owner !== input.owner)
              return yield* new RegistryError({ reason: "forbidden" });
            if (owner === null) yield* db.create("scopes", { scope, owner: input.owner });
            const previous = yield* db.findFirst("publications", {
              where: (b) => b("name", "=", input.name),
            });
            if (previous !== null) {
              if (previous.owner !== input.owner)
                return yield* new RegistryError({ reason: "forbidden" });
              if (previous.app !== input.app)
                return yield* new RegistryError({ reason: "conflict" });
              const saved = yield* Schema.decodeUnknownEffect(StoredPublication)(previous);
              if (saved.publication.commit === input.publication.commit) return saved.publication;
              yield* db.updateMany("publications", {
                where: (b) => b("name", "=", input.name),
                set: { publication: input.publication, source: input.source },
              });
            } else yield* db.create("publications", input);
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
            yield* db.deleteMany("publications", {
              where: (b) => b.and(b("name", "=", name), b("owner", "=", owner)),
            });
          }),
        ),
      ),
  };
});
/** Internal persistence capability; public callers only see catalog metadata and selected source. */
export type RegistryStorage = Effect.Success<typeof makeRegistryStorage>;
