import type {
  JsonFilter,
  JsonPath,
  JsonPercentile,
  JsonScalar,
  JsonValueType,
} from "./aggregate";

// ---------------------------------------------------------------------------
// Pure, in-memory evaluation of the JSON-document aggregation primitives.
// Shared by the memory adapter and used as the per-dialect fallback where a
// database can't express an operation natively (e.g. SQLite percentiles). The
// percentile definition matches Postgres `percentile_cont` (continuous, linear
// interpolation) so every backend agrees.
// ---------------------------------------------------------------------------

export const extractJsonPath = (doc: unknown, path: JsonPath): unknown => {
  let current: unknown = doc;
  for (const segment of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

/** Coerce a raw value to a comparable scalar per its declared extraction type. */
export const coerceJsonValue = (
  value: unknown,
  valueType: JsonValueType,
): JsonScalar => {
  if (value == null) return null;
  if (valueType === "number") {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isNaN(numeric) ? null : numeric;
  }
  if (valueType === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === 1) return true;
    if (value === "false" || value === 0) return false;
    return null;
  }
  return typeof value === "string" ? value : String(value);
};

const scalarsEqual = (left: JsonScalar, right: JsonScalar): boolean => left === right;

/** Three-way compare; `null` when either side is null (SQL-like incomparable). */
const compareScalars = (left: JsonScalar, right: JsonScalar): number | null => {
  if (left == null || right == null) return null;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const matchesCompareOperator = (
  operator: string,
  left: JsonScalar,
  right: JsonScalar,
): boolean => {
  switch (operator) {
    // SQL three-valued logic: any comparison with NULL is unknown and excluded
    // from a WHERE clause, so `= NULL` and `!= NULL` both match nothing. Mirror
    // that here so the memory adapter agrees with the SQL adapters.
    case "=":
      return left != null && right != null && scalarsEqual(left, right);
    case "!=":
      return left != null && right != null && !scalarsEqual(left, right);
    case ">": {
      const compared = compareScalars(left, right);
      return compared != null && compared > 0;
    }
    case ">=": {
      const compared = compareScalars(left, right);
      return compared != null && compared >= 0;
    }
    case "<": {
      const compared = compareScalars(left, right);
      return compared != null && compared < 0;
    }
    case "<=": {
      const compared = compareScalars(left, right);
      return compared != null && compared <= 0;
    }
    case "contains":
      return typeof left === "string" && typeof right === "string" && left.includes(right);
    case "starts with":
      return typeof left === "string" && typeof right === "string" && left.startsWith(right);
    case "ends with":
      return typeof left === "string" && typeof right === "string" && left.endsWith(right);
    default:
      return false;
  }
};

export const matchesJsonFilter = (doc: unknown, filter: JsonFilter): boolean => {
  switch (filter.kind) {
    case "and":
      return filter.items.every((item) => matchesJsonFilter(doc, item));
    case "or":
      return filter.items.some((item) => matchesJsonFilter(doc, item));
    case "compare": {
      const left = coerceJsonValue(extractJsonPath(doc, filter.path), filter.valueType);
      const right = coerceJsonValue(filter.value, filter.valueType);
      return matchesCompareOperator(filter.operator, left, right);
    }
    case "array": {
      const left = coerceJsonValue(extractJsonPath(doc, filter.path), filter.valueType);
      // SQL: `NULL IN (...)` and `NULL NOT IN (...)` are both unknown, so the
      // row is excluded either way. Mirror that (the Drizzle adapter does this
      // implicitly via NULL semantics).
      if (left == null) return false;
      const found = filter.values.some((candidate) =>
        scalarsEqual(left, coerceJsonValue(candidate, filter.valueType)),
      );
      return filter.operator === "in" ? found : !found;
    }
  }
};

export const bucketFloor = (value: number, bucketMs: number): number =>
  Math.floor(value / bucketMs) * bucketMs;

/** Percentiles over an ascending-sorted numeric array (Postgres `percentile_cont`). */
export const computePercentiles = (
  sortedAscending: readonly number[],
  fractions: readonly number[],
): JsonPercentile[] => {
  const length = sortedAscending.length;
  if (length === 0) return [];
  return fractions.map((fraction) => {
    const clamped = Math.min(1, Math.max(0, fraction));
    const rank = clamped * (length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    const value =
      lower === upper
        ? sortedAscending[lower]!
        : sortedAscending[lower]! + (sortedAscending[upper]! - sortedAscending[lower]!) * (rank - lower);
    return { fraction, value };
  });
};

/** Null-aware ascending compare (null sorts first). */
export const compareNullableAscending = (left: JsonScalar, right: JsonScalar): number => {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};
