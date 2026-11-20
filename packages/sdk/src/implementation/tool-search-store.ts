/**
 * Tool search rows and their BM25 ranking in the executor's own Postgres database. The SQL client
 * stays inside this module; callers see only these operations.
 */
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

/** One evaluated listing as search rows describe it. */
export interface SearchListingRow {
  readonly listing: ToolSearchListing;
  readonly owner: OwnerId;
  readonly app: AppId;
  readonly version: VersionId;
  /** The digest of the account set the listing was evaluated with; see `toolSearchTarget`. */
  readonly target: string;
  readonly at: number;
  readonly digest: string;
  readonly routers: ReadonlyArray<ToolRouter>;
}

/** One tool of a listing, with the words it ranks by. */
export interface SearchToolRow {
  readonly name: ToolName;
  readonly readOnly: boolean;
  readonly terms: ReadonlyArray<string>;
  readonly signature: string;
  /** The tool as the durable listing text keeps it: shared definitions are positions. */
  readonly tool: StoredTool;
  /** The positions of the definitions its schemas name. */
  readonly definitions: ReadonlyArray<number>;
}

/** A target as the ranking query reads it: its labels are already words. */
export interface RankedTarget {
  readonly listing: ToolSearchListing;
  readonly app: AppId;
  /** The digest of the target's account set; see `toolSearchTarget`. */
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
/**
 * {@link Kept} with the listing and target it belongs to, for a read of several listings. Rows
 * written before targets were recorded have none; they match no wanted target, as `listing`'s
 * `target =` filter skips them.
 */
const KeptOf = Schema.Struct({
  ...Kept.fields,
  listing: Schema.String,
  target: Schema.NullOr(Schema.String),
});
const Listed = Schema.Struct({ listing: Schema.String });
/** A ranked page as one row: every part of it read in the same statement. */
const Ranked = Schema.Struct({
  total: Schema.Int,
  missing: Schema.Array(Schema.Int),
  items: Schema.Array(
    Schema.Struct({
      target: Schema.Int,
      /** Every target the item merges, in order; the first is `target`. */
      ordinals: Schema.Array(Schema.Int),
      listing: Schema.String,
      tool: StoredTool,
      router: Schema.NullOr(ToolRouter),
    }),
  ),
  definitions: Schema.Array(Schema.Tuple([Schema.String, Schema.Int, Json])),
});
export type RankedPage = typeof Ranked.Type;
/** A ranked page with the order of every item it ranked; see {@link Kept}. */
const RankedInOrder = Schema.Struct({
  ...Ranked.fields,
  stamp: Schema.String,
  /**
   * Every item in rank order as `target.position[.ordinal...]`, comma-separated: the target it is
   * at, the position of its first row in that target's listing, and every other target it merges.
   */
  ranking: Schema.NullOr(Schema.String),
});
/** The rows of a page of a kept order, read with the stamp of the listings they belong to. */
const Shown = Schema.Struct({
  stamp: Schema.String,
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      listing: Schema.String,
      tool: StoredTool,
      router: Schema.NullOr(ToolRouter),
    }),
  ),
  definitions: Ranked.fields.definitions,
});

/**
 * A search's order, kept for its later pages. A page past the first reads its rows by the kept
 * order instead of ranking every row the targets hold again, so paging through a catalog of n
 * tools costs one ranking and n rows, not one ranking per page. The order is used only while
 * every listing it ranked still has the digest it had (`stamp`), so a page never mixes two
 * rankings.
 *
 * Items are kept as integers: `cells` holds three per item, its target, the position of its first
 * row in that target's listing (row ids are `listing:position`) and the end of its other merged
 * targets in `extras`. An item takes 12 bytes, so an order of 11,467 tools about 140 KB.
 */
interface Kept {
  readonly total: number;
  readonly missing: ReadonlyArray<number>;
  readonly stamp: string;
  readonly cells: Int32Array;
  readonly extras: Int32Array;
  /** What the entry holds, its key included, as counted against {@link keptBytes}. */
  readonly bytes: number;
}
/** Most searches kept at once, and most searches remembered as too large to keep. */
const keptOrders = 32;
/** Most bytes all kept searches hold together. */
const keptBytes = 6_000_000;
/**
 * Most bytes one kept search holds: about 160,000 tools. A larger one is not kept, and a search
 * whose key alone is larger is neither kept nor remembered: each of its pages ranks, as before.
 */
const keptOrderBytes = 2_000_000;
/** Most bytes the keys of searches remembered as too large to keep hold together. */
const oversizedBytes = 2_000_000;
/**
 * How long a kept search goes unread before a new one may evict it; a search read since is never
 * evicted. While every kept search is being paged, a new one is not kept: its pages rank as
 * before, so more concurrent walks than {@link keptOrders} cost what they did before orders were
 * kept, instead of evicting each other. Once 32 searches have each been read within 30 s, or
 * orders read within 30 s hold more than `keptBytes - keptOrderBytes`, new walks go uncached
 * until one of those orders idles.
 * Times are monotonic, so a wall-clock step neither evicts a search in use nor keeps an idle one.
 */
const keptIdleMillis = 30_000;
/** Milliseconds on the monotonic clock, for {@link keptIdleMillis}. */
const monotonicMillis = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos / 1_000_000n));
/** Bytes an entry takes beyond its arrays: its key, stamp and object headers. */
const entryBytes = (key: string, stamp: string, missing: number) =>
  256 + 2 * (key.length + stamp.length) + 8 * missing;

/** The cells and extras of an order as the ranking statement writes it, or nothing if malformed. */
const parseOrder = (order: string, total: number) => {
  const cells = new Int32Array(total * 3);
  const extras: Array<number> = [];
  let item = 0;
  for (const encoded of order === "" ? [] : order.split(",")) {
    const parts = encoded.split(".");
    if (item >= total || parts.length < 2) return undefined;
    for (const [index, part] of parts.entries()) {
      const value = Number(part);
      if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) return undefined;
      if (index < 2) cells[item * 3 + index] = value;
      else extras.push(value);
    }
    cells[item * 3 + 2] = extras.length;
    item += 1;
  }
  return item === total ? { cells, extras: Int32Array.from(extras) } : undefined;
};

/**
 * Rows per insert statement: nine parameters each stays well inside Postgres's bound. A batch
 * also ends once its JSON reaches `batchChars`, so writing a listing holds the JSON text of one
 * batch at a time, plus at most one row larger than the bound, never the whole listing's.
 */
const batchRows = 500;
const batchChars = 1_000_000;

/**
 * How long a listing stays after a newer one of its app and account set was written. An execution
 * searches the listings discovery named for its whole life: at most five minutes of running
 * (`defaultMcpLimits.timeoutMs`) plus the time it waits on approvals, each of which expires
 * after fifteen minutes. An hour covers the run and three approvals in a row; a search after
 * that reports the app unavailable instead of ranking a listing it cannot read.
 */
export const supersededRetentionMillis = 60 * 60_000;

const BM25 = { k1: 1.2, b: 0.75 } as const;

export const makeToolSearchStore = (sql: SqlClient.SqlClient) => {
  /** Kept orders by search, least recently read first; see {@link Kept}. */
  const orders = new Map<string, { readonly order: Kept; readonly used: number }>();
  let ordersBytes = 0;
  /**
   * Searches whose order is larger than {@link keptOrderBytes}, least recently read first, with
   * the bytes their key takes: their pages rank without the order. They are bounded apart from
   * {@link orders}, so remembering one never evicts a kept order.
   */
  const oversized = new Map<string, number>();
  let oversizedHeld = 0;
  const forget = (key: string) => {
    const kept = orders.get(key);
    if (kept === undefined) return;
    orders.delete(key);
    ordersBytes -= kept.order.bytes;
  };
  /** Mark an order read now, unless it was evicted or replaced while its page was read. */
  const touch = (key: string, order: Kept, used: number) => {
    if (orders.get(key)?.order !== order) return;
    orders.delete(key);
    orders.set(key, { order, used });
  };
  /**
   * The searches to evict for an order of `bytes` to fit, least recently read first, or nothing
   * when it fits only by evicting a search read in the last {@link keptIdleMillis}.
   */
  const evictable = (bytes: number, now: number) => {
    let count = orders.size + 1;
    let held = ordersBytes + bytes;
    const idle: Array<string> = [];
    for (const [key, { order, used }] of orders) {
      if (count <= keptOrders && held <= keptBytes) break;
      if (now - used < keptIdleMillis) continue;
      idle.push(key);
      count -= 1;
      held -= order.bytes;
    }
    return count <= keptOrders && held <= keptBytes ? idle : undefined;
  };
  /**
   * Keep an order if it fits by evicting only idle searches. It is decided when the order is in
   * hand, after the ranking it waited on, since other searches may have been kept meanwhile.
   */
  const admit = (key: string, order: Kept, now: number) => {
    forget(key);
    const idle = evictable(order.bytes, now);
    if (idle === undefined) return;
    for (const old of idle) forget(old);
    orders.set(key, { order, used: now });
    ordersBytes += order.bytes;
  };
  /** Remember a search as too large to keep, dropping the least recently read past the bound. */
  const remember = (key: string, bytes: number) => {
    const held = oversized.get(key);
    if (held !== undefined) {
      oversized.delete(key);
      oversizedHeld -= held;
    }
    oversized.set(key, bytes);
    oversizedHeld += bytes;
    for (const [old, oldBytes] of oversized) {
      if (oversized.size <= keptOrders && oversizedHeld <= oversizedBytes) break;
      oversized.delete(old);
      oversizedHeld -= oldBytes;
    }
  };
  const failed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(() => new StorageError()));
  /** A tool is in a scope when it is read-only under a read-only scope or the scope names it. */
  const inScope = (scope: ToolSearchScope) =>
    sql`(${scope.readOnly ? sql`s.read_only` : sql`false`} or ${
      scope.names.length === 0 ? sql`false` : sql`s.name in ${sql.in(scope.names)}`
    })`;
  /**
   * The targets' rows the scopes permit. Each target's listing must be a row for its app and
   * account set, so a listing named for another target finds nothing.
   */
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
  /**
   * Insert rows in batches bounded by count and JSON size. Each row is encoded only when its
   * batch is built, and a batch is dropped once inserted.
   */
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
  /** Delete the tool and definition rows of the listings. */
  const removeRows = (listings: ReadonlyArray<ToolSearchListing>) =>
    Effect.gen(function* () {
      yield* sql`delete from executor_tool_search where listing in ${sql.in(listings)}`;
      yield* sql`delete from executor_tool_search_definitions where listing in ${sql.in(listings)}`;
    });
  /**
   * Mark the target's other listings evaluated before this one superseded, and delete those
   * superseded for longer than an execution may still search them. Listings without a target were
   * kept per profile before 4.0.13, or by the previous server during its deploy; no target is
   * theirs, so each write of the app supersedes and then removes them like its own.
   *
   * Cleanup locks the expired listing rows first and deletes their rows and them by those ids.
   * `revive` and writers update or lock the same listing row, so each either takes it first, and
   * cleanup skips it, or waits for cleanup and finds the listing gone, and writes it again. A
   * listing row never outlives its tool rows.
   */
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
  /**
   * Insert the listing's row, or lock the one that is kept. A kept row cleanup deletes while this
   * waits for it is gone once the lock is granted; the insert is tried again.
   */
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
    /** The kept rows of a listing of this target, if any. */
    listing: (listing: ToolSearchListing, target: string) =>
      sql`select at::float8 as at, digest, routers, superseded::float8 as superseded
        from executor_tool_search_listings where listing = ${listing} and target = ${target}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Kept))),
        Effect.map((rows) => rows[0]),
        failed,
      ),
    /**
     * The kept rows of each of these listings of its target, in order, read in one statement;
     * undefined where none is kept. Each answers as `listing` would for it alone.
     */
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
    /**
     * Keep a superseded listing that a target resolves to again for as long as a current one,
     * so the executions that search it keep finding it.
     */
    revive: (listing: ToolSearchListing) =>
      sql`update executor_tool_search_listings set superseded = null
        where listing = ${listing} returning listing`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Listed))),
        Effect.map((rows) => rows.length > 0),
        failed,
      ),
    /**
     * Keep a listing's rows unless rows of an evaluation that started no earlier are kept. Rows
     * with the same digest only take the newer time. Writers of one listing wait for each other on
     * its row, so a concurrent writer of the same listing finds the first one's rows. Writers of
     * one target take its transaction lock first: each marks the target's other listings
     * superseded, so two writers that each held their own listing row could otherwise wait for
     * each other's. Success means the listing's row, at this evaluation's time or a later one, is
     * committed.
     */
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
    /**
     * One page of the targets' tools that match any term, ranked by BM25, or of every tool in
     * target and name order when there are no terms, with everything the page shows. Statistics
     * count the rows the scopes permit, each target's labels counted as words of each of its
     * tools. Tools of one app with the same name and signature merge into one item: when any of
     * their rows matches, the item is at their first permitted target, lists every other
     * permitted target with that tool, and ranks by the best matching row.
     *
     * The first page ranks and reads the page's tools, definitions and routers in one statement,
     * so they read one snapshot: a page never holds a row the scopes did not rank, even while
     * another evaluation replaces the listing's rows. A later page reads its rows by the order the
     * search kept (see `keptOrders`) and checks, in the same statement, that every listing still
     * has the digest it was ranked with; a listing written since is ranked again.
     * `missing` names targets whose listing has no rows.
     */
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
            : // Each aggregate is computed once: inlined, Postgres would recount the scope for
              // every matching row.
              sql`q(term) as (select distinct unnest(string_to_array(${terms}::text, ' '))),
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
        const listed = sql`t(ordinal, listing, app, target, labels, length) as (values ${values}),
          present as (
            select t.ordinal, l.digest from t
            join executor_tool_search_listings l
              on l.listing = t.listing and l.app = t.app and l.target = t.target)`;
        const merged = sql`${listed},
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
            group by best.app, best.name, best.signature, best.score)`;
        const missing = sql`coalesce((select json_agg(t.ordinal order by t.ordinal) from t
              where not exists (select 1 from present where present.ordinal = t.ordinal)),
              '[]'::json)`;
        const stamp = sql`coalesce((select json_agg(json_build_array(ordinal, digest)
              order by ordinal) from present), '[]'::json)::text`;
        /** A page's tool's router and the definitions its tools name, from `shown`. */
        const router = sql`(select router from json_array_elements(shown.routers) as r(router)
                  where router->>'path' = shown.tool->>'router' limit 1)`;
        const definitions = sql`coalesce((select json_agg(json_build_array(d.listing, d.position, d.definition))
              from executor_tool_search_definitions d
              where d.id in (
                select shown.listing || ':' || p.position
                from shown, json_array_elements_text(shown.definitions) as p(position))),
              '[]'::json)`;
        const pageOf = (row: typeof Ranked.Type | undefined): RankedPage => ({
          total: row?.total ?? 0,
          missing: row?.missing ?? [],
          items: row?.items ?? [],
          definitions: row?.definitions ?? [],
        });
        /**
         * Rank and read one page in one statement; with `order`, also the stamp and the order of
         * every item ranked, for {@link Kept}.
         */
        const statement = (order: boolean) =>
          sql`with ${merged},
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
          select (select count(*) from merged)::int as total, ${missing} as missing,
            coalesce((select json_agg(json_build_object(
                'target', shown.target, 'ordinals', to_json(shown.ordinals),
                'listing', shown.listing, 'tool', shown.tool, 'router', ${router})
              order by shown.rank) from shown), '[]'::json) as items,
            ${definitions} as definitions${
              order
                ? sql`, ${stamp} as stamp,
            (select string_agg(concat_ws('.', merged.target, substr(merged.id, length(t.listing) + 2),
                nullif(array_to_string(merged.ordinals[2:], '.'), '')), ','
              order by merged.score desc, merged.target, merged.name collate "C")
              from merged join t on t.ordinal = merged.target) as ranking`
                : sql``
            }`;
        const ranked = () =>
          statement(false).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Ranked))),
            Effect.map(([row]) => row),
          );
        const rankedInOrder = () =>
          statement(true).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RankedInOrder))),
            Effect.map(([row]) => row),
          );
        /** A page of a kept order, or nothing when a listing it ranked has changed since. */
        const kept = (order: Kept) =>
          Effect.gen(function* () {
            const from = Math.min(input.offset, order.total);
            const to = Math.min(input.offset + input.limit, order.total);
            const slice: Array<{ id: string; target: number; ordinals: Array<number> }> = [];
            for (let item = from; item < to; item++) {
              const target = order.cells[item * 3]!;
              const listing = input.targets[target]?.listing;
              if (listing === undefined) return undefined;
              const start = item === 0 ? 0 : order.cells[item * 3 - 1]!;
              slice.push({
                id: `${listing}:${order.cells[item * 3 + 1]}`,
                target,
                ordinals: [target, ...order.extras.subarray(start, order.cells[item * 3 + 2])],
              });
            }
            const [shown] = yield* sql`with ${listed},
              shown as (
                select s.id, s.listing, s.tool, s.definitions, l.routers
                from executor_tool_search s
                join executor_tool_search_listings l on l.listing = s.listing
                where s.id in (select value from json_array_elements_text(
                  ${JSON.stringify(slice.map(({ id }) => id))}::json)))
              select ${stamp} as stamp,
                coalesce((select json_agg(json_build_object('id', shown.id,
                    'listing', shown.listing, 'tool', shown.tool, 'router', ${router}))
                  from shown), '[]'::json) as items,
                ${definitions} as definitions`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Shown))),
            );
            if (shown === undefined || shown.stamp !== order.stamp) return undefined;
            const rows = new Map(shown.items.map((item) => [item.id, item]));
            const items: Array<RankedPage["items"][number]> = [];
            for (const { id, target, ordinals } of slice) {
              const row = rows.get(id);
              if (row === undefined) return undefined;
              items.push({
                target,
                ordinals,
                listing: row.listing,
                tool: row.tool,
                router: row.router,
              });
            }
            return {
              total: order.total,
              missing: order.missing,
              items,
              definitions: shown.definitions,
            } satisfies RankedPage;
          });
        // The first page, which most searches end at, ranks and reads in one statement.
        if (input.offset === 0) {
          yield* Effect.annotateCurrentSpan("executor.search.order", "ranked");
          return pageOf(yield* ranked());
        }
        const key = JSON.stringify([input.targets, input.terms]);
        const keyBytes = entryBytes(key, "", 0);
        if (keyBytes > keptOrderBytes || oversized.has(key)) {
          // Too large to keep: each page ranks, as before.
          if (oversized.has(key)) remember(key, keyBytes);
          yield* Effect.annotateCurrentSpan("executor.search.order", "ranked");
          return pageOf(yield* ranked());
        }
        const remembered = orders.get(key)?.order;
        if (remembered !== undefined) {
          const page = yield* kept(remembered);
          if (page !== undefined) {
            touch(key, remembered, yield* monotonicMillis);
            yield* Effect.annotateCurrentSpan("executor.search.order", "kept");
            return page;
          }
          // Only discard the order this read found stale, not one admitted while it waited.
          if (orders.get(key)?.order === remembered) forget(key);
        }
        if (evictable(keptOrderBytes, yield* monotonicMillis) === undefined) {
          // Every kept search is in use: rank this page as before rather than evict one.
          yield* Effect.annotateCurrentSpan("executor.search.order", "ranked");
          return pageOf(yield* ranked());
        }
        // No order kept, or a listing changed since: rank, read the page from that ranking in the
        // same statement, and keep the order for the pages after it.
        const row = yield* rankedInOrder();
        yield* Effect.annotateCurrentSpan("executor.search.order", "ordered");
        if (row === undefined) return pageOf(row);
        const overhead = entryBytes(key, row.stamp, row.missing.length);
        const parsed =
          overhead + 12 * row.total > keptOrderBytes
            ? undefined
            : parseOrder(row.ranking ?? "", row.total);
        const bytes =
          parsed === undefined
            ? undefined
            : overhead + parsed.cells.byteLength + parsed.extras.byteLength;
        if (parsed === undefined || bytes === undefined || bytes > keptOrderBytes)
          remember(key, keyBytes);
        else
          admit(
            key,
            { total: row.total, missing: row.missing, stamp: row.stamp, ...parsed, bytes },
            yield* monotonicMillis,
          );
        return pageOf(row);
      }).pipe(failed),
  };
};
export type ToolSearchStore = ReturnType<typeof makeToolSearchStore>;

/** Delete the apps' search rows with the apps, finding their tools through their listings. */
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
