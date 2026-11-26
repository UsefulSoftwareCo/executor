import { Array as Arr, Clock, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import {
  Json,
  StorageError,
  type AppId,
  type VersionId,
  type OwnerId,
  type ToolName,
} from "../contracts/shared.ts";
import { ToolRouter, ToolSearchListing, type ToolSearchScope } from "../contracts/tools.ts";
import { query, type Query } from "./database.ts";
import { StoredTool } from "./listing-json.ts";

export interface SearchListingRow {
  readonly listing: ToolSearchListing;
  readonly owner: OwnerId;
  readonly app: AppId;
  readonly version: VersionId;
  readonly target: string;
  readonly at: number;
  readonly digest: string;
  readonly routers: ReadonlyArray<ToolRouter>;
}

export interface SearchToolRow {
  readonly name: ToolName;
  readonly readOnly: boolean;
  readonly terms: ReadonlyArray<string>;
  readonly signature: string;
  readonly tool: StoredTool;
  readonly definitions: ReadonlyArray<number>;
}

export interface RankedTarget {
  readonly listing: ToolSearchListing;
  readonly app: AppId;
  readonly target: string;
  readonly labels: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<ToolSearchScope>;
  readonly below?: string | undefined;
}

const Kept = Schema.Struct({
  at: Schema.Number,
  digest: Schema.String,
  routers: Schema.Array(ToolRouter),
  superseded: Schema.NullOr(Schema.Number),
});
const KeptOf = Schema.Struct({
  ...Kept.fields,
  listing: Schema.String,
  target: Schema.NullOr(Schema.String),
});
const Listed = Schema.Struct({ listing: Schema.String });
const Ranked = Schema.Struct({
  total: Schema.Int,
  missing: Schema.Array(Schema.Int),
  items: Schema.Array(
    Schema.Struct({
      target: Schema.Int,
      ordinals: Schema.Array(Schema.Int),
      listing: Schema.String,
      tool: StoredTool,
      router: Schema.NullOr(ToolRouter),
    }),
  ),
  definitions: Schema.Array(Schema.Tuple([Schema.String, Schema.Int, Json])),
});
export type RankedPage = typeof Ranked.Type;

const batchRows = 500;
const batchChars = 1_000_000;

export const supersededRetentionMillis = 60 * 60_000;

const BM25 = { k1: 1.2, b: 0.75 } as const;

export const makeToolSearchStore = (sql: SqlClient.SqlClient) => {
  const failed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(() => new StorageError()));
  const inScope = (scope: ToolSearchScope) =>
    sql`(${scope.readOnly ? sql`s.read_only` : sql`false`} or ${
      scope.names.length === 0 ? sql`false` : sql`s.name in ${sql.in(scope.names)}`
    })`;
  const targets = (input: ReadonlyArray<RankedTarget>) => ({
    values: sql.csv(
      input.map(
        (target, index) =>
          sql`(${index}::int, ${target.listing}::text, ${target.app}::text, ${target.target}::text, ${target.labels.join(" ")}::text, ${target.labels.length}::int)`,
      ),
    ),
    permitted: sql.or(
      input.map((target, index) =>
        sql.and([
          sql`t.ordinal = ${index}`,
          ...target.scopes.map(inScope),
          ...(target.below === undefined
            ? []
            : [sql`(s.name = ${target.below} or starts_with(s.name, ${`${target.below}.`}))`]),
        ]),
      ),
    ),
  });
  const insertBatched = <A, R extends Record<string, unknown>>(
    items: ReadonlyArray<A>,
    encode: (item: A, index: number) => { readonly row: R; readonly chars: number },
    insert: (rows: Arr.NonEmptyReadonlyArray<R>) => Effect.Effect<unknown, SqlError>,
  ) =>
    Effect.gen(function* () {
      let batch: Array<R> = [];
      let chars = 0;
      for (const [index, item] of items.entries()) {
        const encoded = encode(item, index);
        if (
          Arr.isArrayNonEmpty(batch) &&
          (batch.length >= batchRows || chars + encoded.chars > batchChars)
        ) {
          yield* insert(batch);
          batch = [];
          chars = 0;
        }
        batch.push(encoded.row);
        chars += encoded.chars;
      }
      if (Arr.isArrayNonEmpty(batch)) yield* insert(batch);
    });
  const removeRows = (listings: ReadonlyArray<ToolSearchListing>) =>
    Effect.gen(function* () {
      yield* sql`delete from executor_tool_search where listing in ${sql.in(listings)}`;
      yield* sql`delete from executor_tool_search_definitions where listing in ${sql.in(listings)}`;
    });
  const supersede = (row: SearchListingRow, now: number) =>
    Effect.gen(function* () {
      const target = sql`app = ${row.app} and (target = ${row.target} or target is null)`;
      yield* sql`update executor_tool_search_listings set superseded = ${now}
        where ${target} and listing <> ${row.listing} and superseded is null and at < ${row.at}`;
      const expired = yield* sql`select listing from executor_tool_search_listings
        where ${target} and superseded < ${now - supersededRetentionMillis}
        for update skip locked`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Listed))),
      );
      if (expired.length === 0) return;
      const listings = expired.map((kept) => ToolSearchListing.make(kept.listing));
      yield* removeRows(listings);
      yield* sql`delete from executor_tool_search_listings where listing in ${sql.in(listings)}`;
    });
  const claim = (
    listing: Record<string, unknown> & { readonly listing: ToolSearchListing },
  ): Effect.Effect<typeof Kept.Type | undefined, SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const inserted = yield* sql`insert into executor_tool_search_listings ${sql.insert(listing)}
        on conflict (listing) do nothing returning listing`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Listed))),
      );
      if (inserted.length > 0) return undefined;
      const [kept] = yield* sql`select at::float8 as at, digest, routers,
          superseded::float8 as superseded
        from executor_tool_search_listings where listing = ${listing.listing} for update`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Kept))),
      );
      return kept ?? (yield* claim(listing));
    });
  return {
    listing: (listing: ToolSearchListing, target: string) =>
      sql`select at::float8 as at, digest, routers, superseded::float8 as superseded
        from executor_tool_search_listings where listing = ${listing} and target = ${target}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Kept))),
        Effect.map((rows) => rows[0]),
        failed,
      ),
    listings: (
      wanted: ReadonlyArray<{ readonly listing: ToolSearchListing; readonly target: string }>,
    ) =>
      wanted.length === 0
        ? Effect.succeed([])
        : sql`select listing, target, at::float8 as at, digest, routers,
            superseded::float8 as superseded
          from executor_tool_search_listings
          where listing in ${sql.in([...new Set(wanted.map((entry) => entry.listing))])}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(KeptOf))),
            Effect.map((rows) =>
              wanted.map((entry) => {
                const row = rows.find(
                  (candidate) =>
                    candidate.listing === entry.listing && candidate.target === entry.target,
                );
                return row === undefined
                  ? undefined
                  : {
                      at: row.at,
                      digest: row.digest,
                      routers: row.routers,
                      superseded: row.superseded,
                    };
              }),
            ),
            failed,
          ),
    revive: (listing: ToolSearchListing) =>
      sql`update executor_tool_search_listings set superseded = null
        where listing = ${listing} returning listing`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Listed))),
        Effect.map((rows) => rows.length > 0),
        failed,
      ),
    write: (
      row: SearchListingRow,
      content: {
        readonly tools: ReadonlyArray<SearchToolRow>;
        readonly definitions: ReadonlyArray<Json>;
      },
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const routers = JSON.stringify(row.routers);
        const listing = {
          listing: row.listing,
          owner: row.owner,
          app: row.app,
          deployment: row.version,
          target: row.target,
          at: row.at,
          digest: row.digest,
          routers,
          superseded: null,
        };
        yield* sql`select pg_advisory_xact_lock(
          hashtext(${row.app}::text), hashtext(${row.target}::text))`;
        const kept = yield* claim(listing);
        if (kept !== undefined) {
          if (kept.at >= row.at) {
            if (kept.superseded !== null)
              yield* sql`update executor_tool_search_listings set superseded = null
                where listing = ${row.listing}`;
            return;
          }
          if (kept.digest === row.digest) {
            yield* sql`update executor_tool_search_listings set at = ${row.at}, superseded = null
              where listing = ${row.listing}`;
            return yield* supersede(row, now);
          }
          yield* sql`update executor_tool_search_listings
            set deployment = ${row.version}, at = ${row.at}, digest = ${row.digest},
              routers = ${routers}, superseded = null
            where listing = ${row.listing}`;
          yield* removeRows([row.listing]);
        }
        yield* insertBatched(
          content.definitions,
          (definition, position) => {
            const json = JSON.stringify(definition);
            return {
              row: {
                id: `${row.listing}:${position}`,
                listing: row.listing,
                position,
                definition: json,
              },
              chars: json.length,
            };
          },
          (rows) => sql`insert into executor_tool_search_definitions ${sql.insert(rows)}`,
        );
        yield* insertBatched(
          content.tools,
          (tool, index) => {
            const json = JSON.stringify(tool.tool);
            const terms = tool.terms.join(" ");
            return {
              row: {
                id: `${row.listing}:${index}`,
                listing: row.listing,
                name: tool.name,
                read_only: tool.readOnly,
                terms,
                length: tool.terms.length,
                signature: tool.signature,
                tool: json,
                definitions: JSON.stringify(tool.definitions),
              },
              chars: json.length + terms.length,
            };
          },
          (rows) => sql`insert into executor_tool_search ${sql.insert(rows)}`,
        );
        yield* supersede(row, now);
      }).pipe(sql.withTransaction, failed),
    page: (input: {
      readonly targets: ReadonlyArray<RankedTarget>;
      readonly terms: ReadonlyArray<string>;
      readonly offset: number;
      readonly limit: number;
    }) =>
      Effect.gen(function* () {
        if (input.targets.length === 0)
          return { total: 0, missing: [], items: [], definitions: [] } satisfies RankedPage;
        const { values, permitted } = targets(input.targets);
        const terms = input.terms.join(" ");
        const scored =
          input.terms.length === 0
            ? sql`scored as (select ordinal, id, name, signature, 0::float8 as score from scope)`
            : sql`q(term) as (select distinct unnest(string_to_array(${terms}::text, ' '))),
              stats as materialized (
                select count(*)::float8 as n, coalesce(nullif(avg(length), 0), 1)::float8 as avgdl
                from scope),
              hits as materialized (
                select scope.ordinal, scope.id, scope.name, scope.signature, scope.length, w.term,
                  count(*)::float8 as tf
                from scope, unnest(scope.own || scope.labels) as w(term)
                where (scope.own && string_to_array(${terms}::text, ' ')
                    or scope.labels && string_to_array(${terms}::text, ' '))
                  and w.term in (select term from q)
                group by scope.ordinal, scope.id, scope.name, scope.signature, scope.length, w.term),
              df as materialized (select term, count(*)::float8 as df from hits group by term),
              scored as (
                select hits.ordinal, hits.id, hits.name, hits.signature,
                  sum(ln(1 + (stats.n - df.df + 0.5) / (df.df + 0.5)) * hits.tf * ${BM25.k1 + 1}::float8
                    / (hits.tf + ${BM25.k1}::float8 * (${1 - BM25.b}::float8
                      + ${BM25.b}::float8 * hits.length / stats.avgdl)))::float8 as score
                from hits join df using (term) cross join stats
                group by hits.ordinal, hits.id, hits.name, hits.signature)`;
        const [page] =
          yield* sql`with t(ordinal, listing, app, target, labels, length) as (values ${values}),
          present as (
            select t.ordinal from t
            join executor_tool_search_listings l
              on l.listing = t.listing and l.app = t.app and l.target = t.target),
          scope as materialized (
            select t.ordinal, t.app, s.id, s.name, s.signature, string_to_array(s.terms, ' ') as own,
              string_to_array(t.labels, ' ') as labels, s.length + t.length as length
            from t
            join present using (ordinal)
            join executor_tool_search s on s.listing = t.listing
            where ${permitted}),
          ${scored},
          best as (
            select scope.app, scored.name, scored.signature, max(scored.score) as score
            from scored join scope using (ordinal, id)
            group by scope.app, scored.name, scored.signature),
          merged as (
            select (array_agg(scope.id order by scope.ordinal, scope.id))[1] as id,
              min(scope.ordinal) as target, best.name, best.score,
              array_agg(scope.ordinal order by scope.ordinal, scope.id) as ordinals
            from best
            join scope
              on scope.app = best.app and scope.name = best.name
                and scope.signature = best.signature
            group by best.app, best.name, best.signature, best.score),
          page as (
            select id, target, ordinals,
              row_number() over (order by score desc, target, name collate "C") as rank
            from merged
            order by score desc, target, name collate "C"
            offset ${input.offset} limit ${input.limit}),
          shown as (
            select page.rank, page.target, page.ordinals, s.listing, s.tool, s.definitions,
              l.routers
            from page
            join executor_tool_search s on s.id = page.id
            join executor_tool_search_listings l on l.listing = s.listing)
          select (select count(*) from merged)::int as total,
            coalesce((select json_agg(t.ordinal order by t.ordinal) from t
              where not exists (select 1 from present where present.ordinal = t.ordinal)),
              '[]'::json) as missing,
            coalesce((select json_agg(json_build_object(
                'target', shown.target, 'ordinals', to_json(shown.ordinals),
                'listing', shown.listing, 'tool', shown.tool,
                'router', (select router from json_array_elements(shown.routers) as r(router)
                  where router->>'path' = shown.tool->>'router' limit 1))
              order by shown.rank) from shown), '[]'::json) as items,
            coalesce((select json_agg(json_build_array(d.listing, d.position, d.definition))
              from executor_tool_search_definitions d
              where d.id in (
                select shown.listing || ':' || p.position
                from shown, json_array_elements_text(shown.definitions) as p(position))),
              '[]'::json) as definitions`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Ranked))),
          );
        return page ?? { total: 0, missing: [], items: [], definitions: [] };
      }).pipe(failed),
  };
};
export type ToolSearchStore = ReturnType<typeof makeToolSearchStore>;

export const removeToolSearch = (tx: Query, apps: ReadonlyArray<AppId>) =>
  Effect.gen(function* () {
    if (apps.length === 0) return;
    const listings = yield* query(() =>
      tx.findMany("toolSearchListings", {
        select: ["listing"],
        where: (b) => b("app", "in", apps),
      }),
    );
    if (listings.length > 0) {
      const ids = listings.map((row) => row.listing);
      yield* query(() => tx.deleteMany("toolSearch", { where: (b) => b("listing", "in", ids) }));
      yield* query(() =>
        tx.deleteMany("toolSearchDefinitions", { where: (b) => b("listing", "in", ids) }),
      );
    }
    yield* query(() => tx.deleteMany("toolSearchListings", { where: (b) => b("app", "in", apps) }));
  });
