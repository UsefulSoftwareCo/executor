/** Typed database authoring. Declarations are pure; only invocation-scoped methods return Promises. */
import { Effect, Schema as EffectSchema } from "effect";
import { DatabaseSchema, promiseTable, type DatabaseSession } from "@executor-js/app-data";
import { parseDatabaseSchema } from "@executor-js/app-data/schema";
import { AppStorageUnavailable, type AppStorage } from "../contracts/storage.ts";
import type { DatabaseDefinition, Database, Table, Tables } from "../contracts/storage.ts";
import { storageFieldOf, type Fields } from "./schema.ts";
export type {
  DatabaseDefinition,
  Database,
  DatabaseReader,
  Table,
  Tables,
  RowOf,
} from "../contracts/storage.ts";
/** Declare scalar columns using the same schemas as operation inputs. */
export const table = <const F extends Fields>(fields: F): Table<F> => tableWithIndexes(fields, []);
const tableWithIndexes = <F extends Fields, Index extends string>(
  fields: F,
  indexes: Table<F, Index>["indexes"],
): Table<F, Index> => ({
  fields,
  indexes,
  index: (name, fieldsInIndex) =>
    tableWithIndexes(fields, [...indexes, { name, fields: fieldsInIndex }]),
});
const serialize = (tables: Tables): DatabaseSchema => {
  const definitions = Object.fromEntries(
    Object.entries(tables).map(([name, table]) => [
      name,
      {
        fields: Object.fromEntries(
          Object.entries(table.fields).map(([fieldName, schema]) => {
            const field = storageFieldOf(schema);
            if (field === undefined) throw new Error("Database columns must use a scalar schema");
            return [fieldName, field];
          }),
        ),
        indexes: table.indexes,
      },
    ]),
  );
  return Effect.runSync(parseDatabaseSchema(definitions));
};
/** Build a fresh Promise database facade for one authorized invocation. */
export const authorDatabase = <T extends Tables>(
  tables: T,
  session: DatabaseSession,
  signal: AbortSignal,
  writable: boolean,
): Database<T> => {
  // SAFETY: each table name, field decoder and index remains paired below. The facade
  // parses the schema and every transported operation; only mapped generic keys are erased.
  return Object.fromEntries(
    Object.entries(tables).map(([name, table]) => {
      const api = promiseTable(session, name, signal);
      const parseFields = (input: unknown, partial: boolean) => {
        const values = EffectSchema.decodeUnknownSync(
          EffectSchema.Record(EffectSchema.String, EffectSchema.Unknown),
        )(input);
        const fields: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(values)) {
          if (value === undefined) continue;
          const field = Object.hasOwn(table.fields, key) ? table.fields[key] : undefined;
          if (field === undefined) throw new Error("Unknown database column");
          const definition = storageFieldOf(field);
          fields[key] = value === null && definition?.optional ? null : field.parse(value);
        }
        if (!partial)
          for (const [key, field] of Object.entries(table.fields))
            if (!Object.hasOwn(fields, key)) {
              const value = field.parse(undefined);
              if (value !== undefined) fields[key] = value;
            }
        return fields;
      };
      const read = { get: api.get, withIndex: api.withIndex };
      return [
        name,
        writable
          ? {
              ...read,
              insert: (value: unknown) => api.insert(parseFields(value, false)),
              update: (id: string, value: unknown) => api.update(id, parseFields(value, true)),
              delete: api.delete,
            }
          : read,
      ];
    }),
  ) as unknown as Database<T>;
};

/** Declare storage independently of handlers; the host binds each invocation's database. */
export const defineDatabase = <const T extends Tables>(tables: T): DatabaseDefinition<T> => ({
  schema: serialize(tables),
  tables,
});
/** Explicit missing capability, never a fallback to another app's data. */
export const unavailableStorage: AppStorage = {
  read: () => Effect.fail(new AppStorageUnavailable()),
  mutate: () => Effect.fail(new AppStorageUnavailable()),
};
