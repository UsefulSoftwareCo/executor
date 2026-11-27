import { Schema } from "effect";
import { column, idColumn, schema, table, type AnySchema } from "fumadb-effect/schema";
import { indexOnlyVersion } from "../src/implementation/storage-migrations.ts";

export type Fixture = {
  readonly name: string;
  readonly schemas: ReadonlyArray<AnySchema>;
} & ({ readonly trailing: ReadonlyArray<string> } | { readonly rejects: string });

const notes = table("fixture_notes", {
  id: idColumn("id", Schema.String, { type: "varchar(255)" }),
  owner: column("owner", Schema.String, { type: "varchar(255)" }),
});
const tags = table("fixture_tags", {
  id: idColumn("id", Schema.String, { type: "varchar(255)" }),
});
const ownerIndex = ["CREATE INDEX IF NOT EXISTS fixture_notes_owner ON fixture_notes (owner)"];

const base = schema({ version: "1.0.0", tables: { notes } });
const withTags = schema({ version: "1.0.1", tables: { notes, tags } });
const withTitle = schema({
  version: "1.0.1",
  tables: {
    notes: table("fixture_notes", {
      id: idColumn("id", Schema.String, { type: "varchar(255)" }),
      owner: column("owner", Schema.String, { type: "varchar(255)" }),
      title: column("title", Schema.NullOr(Schema.String), { type: "varchar(255)" }).default(null),
    }),
  },
});

export const fixtures: ReadonlyArray<Fixture> = [
  {
    name: "trailing index-only version",
    schemas: [base, indexOnlyVersion(base, "1.0.1", ownerIndex)],
    trailing: ["1.0.1"],
  },
  {
    name: "two trailing index-only versions",
    schemas: (() => {
      const first = indexOnlyVersion(withTags, "1.0.2", ownerIndex);
      return [base, withTags, first, indexOnlyVersion(first, "1.0.3", ownerIndex)];
    })(),
    trailing: ["1.0.2", "1.0.3"],
  },
  {
    name: "index-only version before a table change is not deferred",
    schemas: [
      base,
      indexOnlyVersion(base, "1.0.1", ownerIndex),
      schema({ version: "1.0.2", tables: { notes, tags } }),
    ],
    trailing: [],
  },
  {
    name: "table change listed as an ordinary version",
    schemas: [base, withTags],
    trailing: [],
  },
  {
    name: "index-only version that adds the previous version's table back",
    schemas: [
      base,
      withTags,
      schema({ version: "1.0.2", tables: { notes } }),
      indexOnlyVersion(withTags, "1.0.3", ownerIndex),
    ],
    rejects: "1.0.3",
  },
  {
    name: "index-only version that drops a table",
    schemas: [base, withTags, indexOnlyVersion(base, "1.0.2", ownerIndex)],
    rejects: "1.0.2",
  },
  {
    name: "index-only version that adds a column",
    schemas: [base, indexOnlyVersion(withTitle, "1.0.1", ownerIndex)],
    rejects: "1.0.1",
  },
  {
    name: "index-only first version",
    schemas: [indexOnlyVersion(base, "1.0.0", ownerIndex)],
    rejects: "1.0.0",
  },
];
