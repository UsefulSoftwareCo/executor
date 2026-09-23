/** Native app data boundary. Hosts bind a configured app before exposing this capability. */
import { Schema, type Effect } from "effect";
import type { RowMetadata, ReadTable, WriteTable } from "@executor-js/app-data";
import type { Fields, ObjectValue } from "../implementation/schema.ts";
import type {
  DatabaseSchema,
  DatabaseSession,
  AppDatabaseError,
} from "@executor-js/app-data/contracts";

/** Names for authored operations and tables. */
export const StorageName = Schema.NonEmptyString.check(Schema.isMaxLength(200));

/** Storage is not configured on this host. */
export class AppStorageUnavailable extends Schema.TaggedError<AppStorageUnavailable>()(
  "AppStorageUnavailable",
  {},
) {}
/** App storage operations never expose SQL, documents or credentials in failures. */
export class AppStorageError extends Schema.TaggedError<AppStorageError>()("AppStorageError", {}) {}
/** The adapter owns the database connection and transaction for the whole authored invocation. */
export interface AppStorage {
  readonly read: <A, E>(
    schema: DatabaseSchema,
    work: (session: DatabaseSession) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | AppDatabaseError | AppStorageUnavailable | AppStorageError>;
  readonly mutate: <A, E>(
    schema: DatabaseSchema,
    work: (session: DatabaseSession) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | AppDatabaseError | AppStorageUnavailable | AppStorageError>;
}

type InputValue<F extends Fields> = {
  readonly [
    K in keyof F as F[K]["optionalValue"] extends true
      ? never
      : F[K] extends { readonly hasDefault: true }
        ? never
        : K
  ]: Exclude<import("../implementation/schema.ts").Infer<F[K]>, undefined>;
} & {
  readonly [
    K in keyof F as F[K]["optionalValue"] extends true
      ? K
      : F[K] extends { readonly hasDefault: true }
        ? K
        : never
  ]?:
    | Exclude<import("../implementation/schema.ts").Infer<F[K]>, undefined>
    | (F[K]["optionalValue"] extends true
        ? null
        : F[K] extends { readonly inputOptional: true }
          ? null
          : never)
    | undefined;
};
/** Typed table declaration; indexes refer only to authored or host metadata fields. */
export interface Table<F extends Fields, Index extends string = never> {
  readonly fields: F;
  readonly indexes: ReadonlyArray<{ readonly name: string; readonly fields: readonly string[] }>;
  readonly index: <Name extends string>(
    name: Name,
    fields: readonly [
      (keyof F & string) | keyof typeof RowMetadata.Type,
      ...((keyof F & string) | keyof typeof RowMetadata.Type)[],
    ],
  ) => Table<F, Index | Name>;
}
/** Structural table catalog accepted at the author boundary. */
export type Tables = Readonly<
  Record<
    string,
    {
      readonly fields: Fields;
      readonly indexes: ReadonlyArray<{
        readonly name: string;
        readonly fields: readonly string[];
      }>;
    }
  >
>;
/** Generated row metadata is read-only and unavailable on inserts. */
export type RowOf<T extends Tables[string]> = ObjectValue<T["fields"]> & typeof RowMetadata.Type;
type IndexOf<T> = T extends Table<Fields, infer I> ? I : string;
/** Queries receive only read methods. */
export type DatabaseReader<T extends Tables> = {
  readonly [K in keyof T]: ReadTable<RowOf<T[K]>, IndexOf<T[K]>>;
};
/** Mutation methods stay inside one native SQLite transaction. */
export type Database<T extends Tables> = {
  readonly [K in keyof T]: WriteTable<RowOf<T[K]>, InputValue<T[K]["fields"]>, IndexOf<T[K]>>;
};

/** Pure database declaration shared by requirements and derived handler contexts. */
export interface DatabaseDefinition<T extends Tables = Tables> {
  readonly schema: DatabaseSchema;
  readonly tables: T;
}
