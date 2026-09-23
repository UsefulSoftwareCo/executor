/** Validate declarations and write values before touching SQLite. */
import { Effect, Schema } from "effect";
import {
  AppDatabaseError,
  DatabaseSchema,
  RowMetadata,
  type Field,
  type Row,
  type Scalar,
  type Table,
} from "../contracts/database.ts";

const metadata = new Set(["id", "createdAt", "updatedAt"]);
/** Built-in creation ordering and stable tie-breakers apply to every index. */
export const indexesFor = (table: Table) =>
  [{ name: "by_creation", fields: [] as readonly string[] }, ...table.indexes].map((index) => ({
    name: index.name,
    fields: [
      ...index.fields,
      ...["createdAt", "id"].filter((field) => !index.fields.includes(field)),
    ],
  }));
/** Metadata fields have stable string semantics and cannot be overwritten. */
export const fieldFor = (table: Table, name: string): Field | undefined =>
  metadata.has(name)
    ? { kind: "string" }
    : Object.hasOwn(table.fields, name)
      ? table.fields[name]
      : undefined;
/** Finite numbers and well-formed strings keep JSON and index ordering consistent. */
export const validScalar = (field: Field, value: unknown): value is Scalar =>
  field.kind === "number"
    ? typeof value === "number" && Number.isFinite(value)
    : field.kind === "boolean"
      ? typeof value === "boolean"
      : typeof value === "string" &&
        ![...value].some((character) => {
          const point = character.codePointAt(0);
          return point !== undefined && point >= 0xd800 && point <= 0xdfff;
        });

/** Parse the whole schema, including references and composite-index definitions. */
export const parseDatabaseSchema = (input: unknown) =>
  Schema.decodeUnknownEffect(DatabaseSchema)(input).pipe(
    Effect.flatMap((schema) =>
      Effect.gen(function* () {
        for (const table of Object.values(schema)) {
          if (
            Object.keys(table.fields).some((name) => metadata.has(name)) ||
            new Set(table.indexes.map((index) => index.name)).size !== table.indexes.length
          )
            return yield* new AppDatabaseError({ reason: "schema" });
          for (const field of Object.values(table.fields)) {
            if (
              (field.kind === "id"
                ? field.references === undefined
                : field.references !== undefined) ||
              (field.default !== undefined && !validScalar(field, field.default)) ||
              (field.references !== undefined && !Object.hasOwn(schema, field.references))
            )
              return yield* new AppDatabaseError({ reason: "schema" });
          }
          for (const index of table.indexes)
            if (
              index.name === "by_creation" ||
              new Set(index.fields).size !== index.fields.length ||
              index.fields.some((name) => fieldFor(table, name) === undefined)
            )
              return yield* new AppDatabaseError({ reason: "schema" });
        }
        return schema;
      }),
    ),
    Effect.mapError(() => new AppDatabaseError({ reason: "schema" })),
  );

/** Canonical ordering for schema fingerprints and query-bound cursors. */
export const canonicalSchema = (schema: DatabaseSchema) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(schema)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, table]) => [
          name,
          {
            fields: Object.fromEntries(
              Object.entries(table.fields)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([field, definition]) => [
                  field,
                  {
                    kind: definition.kind,
                    optional: definition.optional === true,
                    ...(definition.default === undefined ? {} : { default: definition.default }),
                    ...(definition.references === undefined
                      ? {}
                      : { references: definition.references }),
                  },
                ]),
            ),
            indexes: [...table.indexes].sort((a, b) =>
              a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
            ),
          },
        ]),
    ),
  );

/** Inserts apply declared defaults; updates reject unknown/metadata fields and clear optional values with null. */
export const writeValue = (
  table: Table,
  values: Readonly<Record<string, Scalar | null>>,
  previous: Row | undefined,
  meta: typeof RowMetadata.Type,
) =>
  Effect.gen(function* () {
    if (
      Object.keys(values).some((name) => metadata.has(name) || !Object.hasOwn(table.fields, name))
    )
      return yield* new AppDatabaseError({ reason: "value" });
    const row: Record<string, Scalar> = { ...meta };
    for (const [name, field] of Object.entries(table.fields)) {
      const supplied = Object.hasOwn(values, name) ? values[name] : previous?.[name];
      if (supplied === null && !field.optional)
        return yield* new AppDatabaseError({ reason: "value" });
      const value = supplied === null || supplied === undefined ? field.default : supplied;
      if (value === undefined) {
        if (!field.optional) return yield* new AppDatabaseError({ reason: "value" });
      } else {
        if (!validScalar(field, value)) return yield* new AppDatabaseError({ reason: "value" });
        row[name] = value;
      }
    }
    return row;
  });
