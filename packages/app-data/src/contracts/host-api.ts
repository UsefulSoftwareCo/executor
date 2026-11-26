import { Schema } from "effect";

export const HostApiCheck = Schema.Struct({
  revision: Schema.NonEmptyString,
  documents: Schema.Array(Schema.NonEmptyString),
});
export type HostApiCheck = typeof HostApiCheck.Type;
