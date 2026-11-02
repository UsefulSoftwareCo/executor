/** Exercise canonical local checks without committing the mutation or keeping its locks. */
import { Data, Effect } from "effect";
import { transaction, type Query } from "./database.ts";
class ChangeValidated extends Data.TaggedError("InteractiveChangeValidated") {}
export const validateRemovalChange = <A, E, R>(db: Query, change: Effect.Effect<A, E, R>) =>
  transaction(db, () => change.pipe(Effect.andThen(Effect.fail(new ChangeValidated())))).pipe(
    Effect.catchTag("InteractiveChangeValidated", () => Effect.void),
  );
