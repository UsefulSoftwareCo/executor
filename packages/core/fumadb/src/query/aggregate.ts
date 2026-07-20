import type { AnyColumn } from "../schema/create";
import type { Condition, ConditionBuilder } from "./condition-builder";

// ---------------------------------------------------------------------------
// JSON-document aggregation + keyset pagination.
//
// These operate over values addressed *inside* a JSON document column (e.g.
// `plugin_storage.data`), not over real typed columns. The addressing model is
// therefore path-based and carries an explicit extraction type so adapters can
// emit correct per-dialect SQL (Postgres `->>` returns text and needs casts;
// SQLite `json_extract` is natively typed). Only adapters that implement the
// matching `ORMAdapter` hooks support these; others throw loudly.
// ---------------------------------------------------------------------------

export type JsonValueType = "text" | "number" | "boolean";

export type JsonScalar = string | number | boolean | null;

/** A non-empty path into a JSON document column, e.g. `["status"]`. */
export type JsonPath = readonly [string, ...string[]];

export type JsonCompareOperator =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "contains"
  | "starts with"
  | "ends with";

export type JsonArrayOperator = "in" | "not in";

/** A predicate tree over JSON-document paths, ANDed into the real-column where. */
export type JsonFilter =
  | {
      readonly kind: "compare";
      readonly path: JsonPath;
      readonly valueType: JsonValueType;
      readonly operator: JsonCompareOperator;
      readonly value: JsonScalar;
    }
  | {
      readonly kind: "array";
      readonly path: JsonPath;
      readonly valueType: JsonValueType;
      readonly operator: JsonArrayOperator;
      readonly values: readonly JsonScalar[];
    }
  | { readonly kind: "and"; readonly items: readonly JsonFilter[] }
  | { readonly kind: "or"; readonly items: readonly JsonFilter[] };

// --- Adapter-facing options (column/keyColumn resolved to AnyColumn, where
// compiled to a Condition with read policies already applied) ---------------

export interface JsonAdapterBase {
  /** The JSON document column the paths address. */
  readonly column: AnyColumn;
  /** Real-column scoping condition (read policies already applied). */
  readonly where?: Condition;
  /** JSON-path predicates, conjoined with `where`. */
  readonly filter?: JsonFilter;
}

export type JsonCountAdapterOptions = JsonAdapterBase;

export interface JsonGroupCountAdapterOptions extends JsonAdapterBase {
  readonly path: JsonPath;
  /** Extraction type for the group key; defaults to "text". */
  readonly valueType?: JsonValueType;
}

export interface JsonGroupCountRow {
  readonly value: JsonScalar;
  readonly count: number;
}

export interface JsonTimeBucketAdapterOptions extends JsonAdapterBase {
  /** Numeric (epoch-ms) path the buckets are computed from. */
  readonly path: JsonPath;
  readonly bucketMs: number;
}

export interface JsonTimeBucketRow {
  /** Bucket floor: `floor(value / bucketMs) * bucketMs`. */
  readonly bucket: number;
  readonly count: number;
}

export interface JsonStatsAdapterOptions extends JsonAdapterBase {
  /** Numeric path the stats are computed over. */
  readonly path: JsonPath;
  /**
   * Percentile fractions in [0, 1] (e.g. 0.5, 0.95).
   *
   * SQLite adapters compute percentiles from all matching numeric values after
   * projection because SQLite has no native percentile aggregate. Count, min,
   * and max still run as SQL aggregates.
   */
  readonly percentiles?: readonly number[];
}

export interface JsonPercentile {
  readonly fraction: number;
  readonly value: number;
}

export interface JsonStats {
  readonly count: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly percentiles: readonly JsonPercentile[];
}

export interface JsonKeysetOrder {
  readonly path: JsonPath;
  readonly valueType: JsonValueType;
  readonly direction: "asc" | "desc";
}

export interface JsonKeysetCursor {
  /** One value per `orderBy` entry, in order. */
  readonly values: readonly JsonScalar[];
  /** Tiebreak value of the `keyColumn` for the cursor row. */
  readonly key: string;
}

export interface JsonPageAdapterOptions extends JsonAdapterBase {
  readonly orderBy: readonly JsonKeysetOrder[];
  /** Real column used as a stable tiebreak (e.g. the storage key). */
  readonly keyColumn: AnyColumn;
  readonly keyDirection: "asc" | "desc";
  readonly cursor?: JsonKeysetCursor;
  readonly limit: number;
}

// --- Public (AbstractQuery) options: name strings + a where builder --------

export interface JsonPublicBase<TColumns extends Record<string, AnyColumn>> {
  readonly column: keyof TColumns & string;
  readonly where?: (eb: ConditionBuilder<TColumns>) => Condition | boolean;
  readonly filter?: JsonFilter;
}

export type JsonCountOptions<TColumns extends Record<string, AnyColumn>> =
  JsonPublicBase<TColumns>;

export interface JsonGroupCountOptions<TColumns extends Record<string, AnyColumn>>
  extends JsonPublicBase<TColumns> {
  readonly path: JsonPath;
  readonly valueType?: JsonValueType;
}

export interface JsonTimeBucketOptions<TColumns extends Record<string, AnyColumn>>
  extends JsonPublicBase<TColumns> {
  readonly path: JsonPath;
  readonly bucketMs: number;
}

export interface JsonStatsOptions<TColumns extends Record<string, AnyColumn>>
  extends JsonPublicBase<TColumns> {
  readonly path: JsonPath;
  /**
   * Percentile fractions in [0, 1] (e.g. 0.5, 0.95).
   *
   * SQLite adapters compute percentiles from all matching numeric values after
   * projection because SQLite has no native percentile aggregate. Count, min,
   * and max still run as SQL aggregates.
   */
  readonly percentiles?: readonly number[];
}

export interface JsonPageOptions<TColumns extends Record<string, AnyColumn>>
  extends JsonPublicBase<TColumns> {
  readonly orderBy: readonly JsonKeysetOrder[];
  readonly keyColumn: keyof TColumns & string;
  readonly keyDirection?: "asc" | "desc";
  readonly cursor?: JsonKeysetCursor;
  readonly limit: number;
}
