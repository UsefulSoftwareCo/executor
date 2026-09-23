/** Index-prefix equality followed by at most one field's lower and upper bounds. */
import { Effect } from "effect";
import {
  AppDatabaseError,
  type QueryPlan,
  type Scalar,
  type Table,
} from "../contracts/database.ts";
import { encodeIndexKey, prefixEnd } from "./index-key.ts";
import { fieldFor, indexesFor, validScalar } from "./schema.ts";

/** Produce half-open BLOB bounds; absent optional values do not satisfy ordinary range predicates. */
export const queryBounds = (table: Table, plan: QueryPlan, maximum: number) =>
  Effect.gen(function* () {
    const index = indexesFor(table).find((index) => index.name === plan.index);
    if (index === undefined) return yield* new AppDatabaseError({ reason: "index" });
    const equal: Array<Scalar | null> = [];
    let rangeField: string | undefined;
    let lower: Uint8Array | undefined;
    let upper: Uint8Array | undefined;
    let lowerSet = false;
    let upperSet = false;
    for (const clause of plan.clauses) {
      const expected = rangeField === undefined ? index.fields[equal.length] : rangeField;
      const field = fieldFor(table, clause.field);
      if (expected !== clause.field || field === undefined)
        return yield* new AppDatabaseError({ reason: "range" });
      if (clause.op === "eq") {
        if (
          rangeField !== undefined ||
          (clause.value === null ? !field.optional : !validScalar(field, clause.value))
        )
          return yield* new AppDatabaseError({ reason: "range" });
        equal.push(clause.value);
      } else {
        if (!validScalar(field, clause.value))
          return yield* new AppDatabaseError({ reason: "range" });
        rangeField = clause.field;
        const encoded = yield* encodeIndexKey([...equal, clause.value], maximum);
        if (clause.op === "gt" || clause.op === "gte") {
          if (lowerSet) return yield* new AppDatabaseError({ reason: "range" });
          lowerSet = true;
          lower = clause.op === "gt" ? prefixEnd(encoded) : encoded;
        } else {
          if (upperSet) return yield* new AppDatabaseError({ reason: "range" });
          upperSet = true;
          upper = clause.op === "lte" ? prefixEnd(encoded) : encoded;
        }
      }
    }
    const prefix = yield* encodeIndexKey(equal, maximum);
    if (rangeField !== undefined && !lowerSet)
      lower = prefixEnd(yield* encodeIndexKey([...equal, null], maximum));
    return { lower: lower ?? prefix, upper: upper ?? prefixEnd(prefix) };
  });
