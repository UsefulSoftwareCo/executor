/**
 * Generated identifiers for `idColumn(...).defaultTo$("auto")`.
 */
import { createId } from "@paralleldrive/cuid2";
import { Effect } from "effect";

/** Create a new CUID2 identifier. */
export const generateId: Effect.Effect<string> = Effect.sync(() => createId());

/** Create a new UUID v4 (for `uuid` columns, whose schema rejects a CUID2). */
export const generateUuid: Effect.Effect<string> = Effect.sync(() => crypto.randomUUID());
